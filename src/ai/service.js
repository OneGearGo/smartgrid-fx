// AI 服务：风控哨兵 / 每日复盘 / 市况分析 / 对话操控 / 出区间建议。
//
// 设计原则（安全第一）：
//  1. AI 永远不进交易快回路 —— 下单/补单/对账全部保持纯规则。
//  2. AI 永远不直接执行写操作 —— 对话操控里 AI 只能"提议"动作，由前端弹确认框、
//     用户点确认后走【现有 REST 接口】执行；保证金/杠杆等硬约束仍在 bot 里卡死。
//  3. 所有 AI 调用失败均安全降级（记录错误、不影响交易）。
import { aiChat, extractJson, notify, getAiConfig } from './provider.js';
import { analyzeTrend } from '../trend.js';
import { loadSnapshot, saveSnapshot } from '../persist.js';

const EXNAMES = { eur: 'EURUSD', gbp: 'GBPUSD', jpy: 'USDJPY', xau: 'XAUUSD', nas: 'NAS100' };
const EXCHANGE_KEYS = ['eur', 'gbp', 'jpy', 'xau', 'nas'];

export function createAiService({ bots, exchanges }) {
  return new AiService(bots, exchanges);
}

class AiService {
  constructor(bots, exchanges) {
    this.bots = bots;             // { de, ex, rs } -> GridBot
    this.exchanges = exchanges;   // { de, ex, rs } -> adapter
    this.sentinel = null;         // 最近一次巡检 {t, level, summary, detail, advice}
    this.sentinelHistory = [];    // 最近 20 条
    this.sentinelError = null;
    this.report = null;           // 最近一次日报 {t, text}
    this.market = null;           // 最近一次 BTC 市况报告 {t, source, market, price, regime, ...}
    this.marketError = null;
    this.oorAdvice = {};          // key -> {t, suggestion, reasoning} 出区间建议
    this._busy = { sentinel: false, report: false, market: false };
    this._lastPushLevel = 'ok';
    this._lastPushAt = 0;
    this._prevOor = {};           // 出区间跳变检测
    this._reportDoneDay = null;
    const saved = loadSnapshot('ai');
    if (saved) {
      this.report = saved.report ?? null;
      this.market = saved.market ?? null;
      this._baseline = saved.baseline ?? null; // 日报基线 {t, per: {de:{equity,stats}}}
      this._reportDoneDay = saved.reportDoneDay ?? null;
    }
    this._baseline = this._baseline || null;
  }

  start() {
    // 哨兵主循环：间隔从 env 实时读取（0 = 关闭）；用 1 分钟节拍器驱动，
    // 修改间隔后无需重启。
    this._lastSentinelAt = 0;
    this._timer = setInterval(() => this._tick().catch(() => {}), 60_000);
    this._timer.unref?.();
    // 出区间跳变检测：30s 一次，纯本地比对，只有跳变才调 AI
    this._oorTimer = setInterval(() => this._checkOutOfRange().catch(() => {}), 30_000);
    this._oorTimer.unref?.();
    // 日报基线：若从未建立，以当前状态为基线
    if (!this._baseline) this._rebaseline();
  }

  async _tick() {
    const cfg = getAiConfig();
    if (!cfg.apiKey) return;
    const now = Date.now();
    if (cfg.sentinelMin > 0 && now - this._lastSentinelAt >= cfg.sentinelMin * 60_000) {
      this._lastSentinelAt = now;
      await this.runSentinel().catch(() => {});
    }
    // BTC 市况报告：按设定间隔（重启后若上一份还"新鲜"则等到到期再出，避免重启即刷一次）
    const lastMkt = Math.max(this._lastMarketAt || 0, this.market?.t || 0);
    if (cfg.marketMin > 0 && now - lastMkt >= cfg.marketMin * 60_000) {
      this._lastMarketAt = now;
      await this.runMarketAnalysis().catch(() => {});
    }
    // 日报：到点且今天没生成过
    const d = new Date();
    const day = d.toISOString().slice(0, 10);
    if (cfg.reportHour >= 0 && d.getHours() === cfg.reportHour && this._reportDoneDay !== day) {
      this._reportDoneDay = day;
      this._save();
      await this.makeReport().catch(() => {});
    }
  }

  // ---------- 状态快照（喂给 AI 的紧凑上下文） ----------
  _snapshot() {
    const out = {};
    for (const key of EXCHANGE_KEYS) {
      const s = this.bots[key].getState();
      out[key] = {
        exchange: EXNAMES[key], tradeMode: s.mode,
        running: s.running, recovery: s.recovery,
        market: s.config?.displayName ?? null,
        health: s.health ? { status: s.health.status, reason: s.health.reason } : null,
        lastPrice: s.lastPrice, outOfRange: s.outOfRange,
        equity: s.equity, balance: s.balance,
        realizedPnl: s.realizedPnl, unrealizedPnl: s.unrealizedPnl, returnPct: s.returnPct,
        position: s.position,
        trackedOrders: s.openOrders, exchangeOpenOrders: s.exchangeOpenOrders,
        completedRungs: s.stats?.completedRungs, volume: s.volume,
        gridConfig: s.config ? {
          mode: s.config.mode, lower: s.config.lower, upper: s.config.upper,
          gridCount: s.config.gridCount, sizeBase: s.config.sizeBase,
          leverage: s.config.leverage, outOfRangeAction: s.config.outOfRangeAction,
        } : null,
        recentAlerts: (s.alerts || []).slice(0, 5).map((a) => `${new Date(a.t).toLocaleTimeString('zh-CN')} ${a.message}`),
      };
    }
    return out;
  }

  // ---------- 1) 风控哨兵 ----------
  async runSentinel() {
    if (this._busy.sentinel) return this.sentinel;
    this._busy.sentinel = true;
    try {
      const snap = this._snapshot();
      const text = await aiChat({
        small: true, json: true, maxTokens: 2000, temperature: 0.1,
        system: [
          '你是外汇网格交易机器人的风控值守 AI（管理 EURUSD/GBPUSD/USDJPY/XAUUSD/NAS100 五个品种）。根据状态快照，对每个品种分别给出巡检结论，并给一句整体结论。',
          '重点关注：health.status 为 error/warn 及其 reason；trackedOrders 与 exchangeOpenOrders 明显不一致（挂单同步漂移）；',
          '保证金/权益吃紧（未实现亏损占权益比例大、returnPct 恶化）；outOfRange=true（价格冲出网格区间）；',
          '告警里的关键词（保证金不足、频繁取消、未确认成交、接口异常、暂停补单）；数据长时间未更新。',
          '注意：paper 是模拟盘，问题降级处理；未运行的品种 level 用 ok、summary 写"未运行"即可。回复 JSON：',
          '{"overall":{"level":"ok|warn|critical","summary":"整体一句话(中文)"},',
          '"per":{"eur":{"level":"ok|warn|critical","summary":"该品种结论(中文,50字内)","advice":"操作建议(中文,无则空)"},"gbp":{...},"jpy":{...},"xau":{...},"nas":{...}}}',
          '注意：per 的 key 必须是 eur/gbp/jpy/xau/nas 五个之一，不要用其他名称。',
        ].join('\n'),
        messages: [{ role: 'user', content: '状态快照：\n' + JSON.stringify(snap) }],
      });
      const j = extractJson(text) || {};
      const overall = j.overall || { level: j.level || 'warn', summary: j.summary || 'AI 返回无法解析：' + text.slice(0, 120) };
      this.sentinel = {
        t: Date.now(),
        level: overall.level || 'ok', summary: overall.summary || '',
        detail: j.detail || '', advice: j.advice || '',
        per: (j.per && typeof j.per === 'object') ? j.per : null,
      };
      this.sentinelHistory.unshift(this.sentinel);
      if (this.sentinelHistory.length > 20) this.sentinelHistory.pop();
      this.sentinelError = null;
      // 推送策略：非 ok 且（级别变化 或 距上次推送>30分钟）才推，避免刷屏
      const lv = this.sentinel.level;
      if (lv !== 'ok' && (lv !== this._lastPushLevel || Date.now() - this._lastPushAt > 30 * 60_000)) {
        this._lastPushAt = Date.now(); this._lastPushLevel = lv;
        const perTxt = this.sentinel.per
          ? Object.entries(this.sentinel.per)
              .filter(([, v]) => v && v.level && v.level !== 'ok')
              .map(([k, v]) => `${EXNAMES[k]}：${v.summary}${v.advice ? `（建议：${v.advice}）` : ''}`)
              .join('\n')
          : this.sentinel.detail;
        notify(`【网格机器人·${lv === 'critical' ? '严重' : '注意'}】${this.sentinel.summary}\n${perTxt}`).catch(() => {});
      }
      if (lv === 'ok') this._lastPushLevel = 'ok';
      return this.sentinel;
    } catch (e) {
      this.sentinelError = e?.message || String(e);
      return null;
    } finally { this._busy.sentinel = false; }
  }

  // ---------- 2) 每日复盘 ----------
  _rebaseline() {
    const per = {};
    for (const key of EXCHANGE_KEYS) {
      const s = this.bots[key].getState();
      per[key] = { equity: s.equity, realizedPnl: s.realizedPnl, completedRungs: s.stats?.completedRungs || 0, volume: s.volume || 0 };
    }
    this._baseline = { t: Date.now(), per };
    this._save();
  }

  async makeReport() {
    if (this._busy.report) return this.report;
    this._busy.report = true;
    try {
      const snap = this._snapshot();
      const base = this._baseline;
      const diff = {};
      for (const key of EXCHANGE_KEYS) {
        const b = base?.per?.[key] || {};
        const s = snap[key];
        diff[key] = {
          equityChange: (s.equity != null && b.equity != null) ? Math.round((s.equity - b.equity) * 100) / 100 : null,
          realizedChange: (s.realizedPnl != null && b.realizedPnl != null) ? Math.round((s.realizedPnl - b.realizedPnl) * 100) / 100 : null,
          rungsDone: (s.completedRungs || 0) - (b.completedRungs || 0),
          volumeDone: Math.round(((s.volume || 0) - (b.volume || 0)) * 100) / 100,
        };
      }
      const sinceHrs = base ? Math.round((Date.now() - base.t) / 3600_000 * 10) / 10 : null;
      const text = await aiChat({
        json: false, maxTokens: 2500, temperature: 0.4,
        system: [
          '你是网格交易机器人的复盘分析师。用简洁的中文写一份运行日报（纯文本，不用 markdown 标题符号）。',
          '内容：1)五所各自的盈亏归因（网格已实现 vs 持仓浮动）；2)成交活跃度与网格参数是否匹配（完成格数、间距）；',
          '3)风险点（保证金、区间边缘、挂单异常）；4)下一步的 1-3 条可执行建议。',
          '数字保留两位小数；paper 为模拟盘要注明；没跑的交易所一句话带过。总长 300 字以内。',
        ].join('\n'),
        messages: [{ role: 'user', content: `统计周期：${sinceHrs != null ? '近 ' + sinceHrs + ' 小时' : '本期'}\n当前快照：${JSON.stringify(snap)}\n周期增量：${JSON.stringify(diff)}` }],
      });
      this.report = { t: Date.now(), text: text.trim() };
      this._rebaseline(); // 下一期从现在起算
      notify('【网格机器人·日报】\n' + this.report.text).catch(() => {});
      return this.report;
    } finally { this._busy.report = false; }
  }

  // ---------- 3) 市况分析 ----------
  /** 核心分析：给定交易所+市场，多周期指标 -> AI 市况判断（analyze 与定时 BTC 报告共用）。 */
  async _regime(key, marketId, ctx = {}) {
    const ex = this.exchanges[key];
    const market = (await ex.getMarkets()).find((m) => m.marketId === Number(marketId));
    const frames = {};
    for (const [label, sec] of [['4小时', 14400], ['1小时', 3600], ['15分钟', 900]]) {
      try {
        const candles = await ex.getCandles(marketId, sec, 200);
        if (candles?.length >= 30) {
          const a = analyzeTrend(candles);
          frames[label] = { trend: a.trend, slopePct: a.slopePct, atrPct: a.atrPct, emaGap: a.emaFast && a.emaSlow ? Math.round((a.emaFast - a.emaSlow) / a.emaSlow * 10000) / 100 : null };
        }
      } catch { /* 单周期失败可容忍 */ }
    }
    if (!Object.keys(frames).length) throw new Error('拿不到足够的K线数据，无法分析。');
    const price = await ex.getPrice(marketId).catch(() => null);
    const text = await aiChat({
      json: true, maxTokens: 2000, temperature: 0.3,
      system: [
        '你是网格交易策略顾问。根据多周期技术指标判断当前市况，并给出网格参数建议。',
        '牢记网格策略的数学本质：震荡市赚钱、单边市亏钱（持仓积累+浮亏）。你的首要任务是判断"当前适不适合跑网格"。',
        '回复 JSON：{"regime":"震荡|上升趋势|下降趋势|剧烈波动","suitable":true/false,',
        '"recommendMode":"neutral|long|short","confidence":0到1,',
        '"suggestedRange":{"lower":数字,"upper":数字},"suggestedGridCount":数字,"suggestedSpacingPct":数字,',
        '"reasoning":"中文分析(150字内)","caution":"中文风险提示(80字内)"}',
        '建议区间要贴合当前价格与波动率（ATR），间距要能覆盖约 0.1% 的往返手续费。',
      ].join('\n'),
      messages: [{
        role: 'user',
        content: `交易所：${EXNAMES[key]}；市场：${market?.displayName}；当前价：${price}\n多周期指标：${JSON.stringify(frames)}`
          + (ctx.gridCfg ? `\n当前网格（若在跑）：${JSON.stringify(ctx.gridCfg)}；运行中：${ctx.running}` : ''),
      }],
    });
    const j = extractJson(text);
    if (!j) throw new Error('AI 返回无法解析：' + text.slice(0, 150));
    return { t: Date.now(), source: EXNAMES[key], market: market?.displayName, price, frames, ...j };
  }

  /** 按需触发：分析某交易所当前配置的市场。 */
  async analyze(key) {
    const bot = this.bots[key], ex = this.exchanges[key];
    if (!bot || !ex) throw new Error('未知交易所: ' + key);
    let marketId = bot.config?.marketId;
    if (marketId == null) marketId = (await ex.getMarkets())[0]?.marketId;
    if (marketId == null) throw new Error('该交易所没有可分析的市场。');
    const st = bot.getState();
    return this._regime(key, marketId, { gridCfg: st.config, running: st.running });
  }

  /** 定时市况报告：自动挑一个有真实行情的外汇品种做数据源（默认 XAUUSD）。 */
  async runMarketAnalysis() {
    if (this._busy.market) return this.market;
    this._busy.market = true;
    try {
      let src = null, marketId = null;
      // 优先 XAUUSD（黄金，波动特征适合市况分析），否则任一真实行情品种
      const prefer = 'xau';
      const ordered = [prefer, ...EXCHANGE_KEYS.filter((k) => k !== prefer)];
      for (const key of ordered) {
        const ex = this.exchanges[key];
        if (ex.dataSource !== 'real') continue; // 合成行情分析没有意义
        try {
          const ms = await ex.getMarkets();
          if (ms && ms.length) { src = key; marketId = ms[0].marketId; break; }
        } catch { /* 换下一个所 */ }
      }
      if (!src) throw new Error('没有可用的真实行情来源（五品种均未连接）。');
      this.market = await this._regime(src, marketId, {});
      this.marketError = null;
      this._save();
      return this.market;
    } catch (e) {
      this.marketError = e?.message || String(e);
      throw e;
    } finally { this._busy.market = false; }
  }

  // ---------- 4) 对话操控（AI 只提议，前端确认后走现有 REST 执行） ----------
  async chatControl(message, history = []) {
    const snap = this._snapshot();
    const text = await aiChat({
      json: true, maxTokens: 2000, temperature: 0.3,
      system: [
        '你是网格交易机器人的操作助手。用户会用中文和你对话，你可以直接回答（基于提供的实时状态快照），',
        '也可以在需要执行操作时提出一个 action 提议（由用户在界面上确认后才会执行，你自己无法执行任何操作）。',
        '可用 action.type：adjust_range(params:{lower,upper}) | stop_grid(params:{closePosition:true/false}) |',
        'cancel_orders | close_position | reconnect | start_recovery(params:{aboveEntryOnly}) |',
        'start_grid(params:{marketId,mode,lower,upper,gridCount,sizeBase,leverage,outOfRangeAction}) | none',
        'action.exchange 取 de|ex|rs|ar|lr。一次最多提议一个 action；用户没有明确要操作时 type 用 none。',
        '涉及平仓/停止等不可逆操作时，在 reply 里先说明后果。',
        '回复 JSON：{"reply":"给用户的中文回复","action":{"type":"none","exchange":"de","params":{}}}',
      ].join('\n'),
      messages: [
        ...history.slice(-8).map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content).slice(0, 2000) })),
        { role: 'user', content: `【实时状态快照】${JSON.stringify(snap)}\n\n【用户】${String(message).slice(0, 2000)}` },
      ],
    });
    const j = extractJson(text);
    if (!j) return { reply: text.slice(0, 1000), action: { type: 'none' } };
    // 白名单过滤：任何未知 action 一律置为 none
    const ALLOWED = ['adjust_range', 'stop_grid', 'cancel_orders', 'close_position', 'reconnect', 'start_recovery', 'start_grid', 'none'];
    if (!j.action || !ALLOWED.includes(j.action.type)) j.action = { type: 'none' };
    if (j.action.type !== 'none' && !EXCHANGE_KEYS.includes(j.action.exchange)) j.action = { type: 'none' };
    return { reply: j.reply || '', action: j.action };
  }

  // ---------- 5) 出区间建议（跳变触发） ----------
  async _checkOutOfRange() {
    const cfg = getAiConfig();
    for (const key of EXCHANGE_KEYS) {
      const bot = this.bots[key];
      const cur = !!(bot.running && bot.outOfRange);
      const prev = !!this._prevOor[key];
      this._prevOor[key] = cur;
      if (!cur || prev || !cfg.apiKey) continue; // 只在 false->true 跳变且配了 AI 时触发
      this._adviseOutOfRange(key).catch(() => {});
    }
  }

  async _adviseOutOfRange(key) {
    const bot = this.bots[key], ex = this.exchanges[key];
    const st = bot.getState();
    let frames = {};
    try {
      const candles = await ex.getCandles(bot.config.marketId, 3600, 120);
      if (candles?.length >= 30) { const a = analyzeTrend(candles); frames = { trend: a.trend, slopePct: a.slopePct, atrPct: a.atrPct }; }
    } catch { /* ignore */ }
    const text = await aiChat({
      json: true, maxTokens: 1200, temperature: 0.2,
      system: [
        '网格价格刚冲出区间。根据趋势强度判断最优处置，回复 JSON：',
        '{"suggestion":"close|recover|extend|hold","suggestionText":"中文一句话","reasoning":"中文理由(100字内)"}',
        'close=止损平仓（强单边趋势）；recover=挂只减仓回收阶梯等回调（趋势可能衰竭）；',
        'extend=扩大区间继续跑（假突破/波动放大）；hold=已配置的策略合理无需干预。',
        `注意：该网格已配置的自动策略是 ${st.config?.outOfRangeAction === 'recover' ? '只减仓回收阶梯' : '冲破区间平仓'}，正在自动执行；你的建议是给人工复核参考。`,
      ].join('\n'),
      messages: [{ role: 'user', content: `状态：${JSON.stringify({ market: st.config?.displayName, lastPrice: st.lastPrice, lower: st.config?.lower, upper: st.config?.upper, position: st.position, unrealizedPnl: st.unrealizedPnl, trend: frames })}` }],
    });
    const j = extractJson(text);
    if (!j) return;
    this.oorAdvice[key] = { t: Date.now(), ...j };
    notify(`【网格机器人·出区间】${EXNAMES[key]} ${st.config?.displayName} 价格冲出区间（现价 ${st.lastPrice}）。\nAI 建议：${j.suggestionText || j.suggestion}\n理由：${j.reasoning || ''}\n（已配置的自动策略正在执行，此建议供复核）`).catch(() => {});
  }

  // ---------- 状态/测试 ----------
  async test() {
    const t0 = Date.now();
    const text = await aiChat({ small: false, maxTokens: 50, temperature: 0, messages: [{ role: 'user', content: '回复"连接正常"四个字。' }] });
    return { ok: true, ms: Date.now() - t0, model: getAiConfig().model, provider: getAiConfig().provider, reply: text.slice(0, 50) };
  }

  status() {
    const cfg = getAiConfig();
    return {
      configured: !!cfg.apiKey,
      provider: cfg.provider, model: cfg.model, modelSmall: cfg.modelSmall,
      baseUrl: cfg.baseUrl,
      // 表单回显用：密钥只回传掩码（绝不回传明文），其余配置原样回传
      apiKeyMasked: cfg.apiKey ? cfg.apiKey.slice(0, 3) + '…' + cfg.apiKey.slice(-4) : '',
      telegramTokenMasked: cfg.telegramToken ? cfg.telegramToken.slice(0, 4) + '…' + cfg.telegramToken.slice(-4) : '',
      telegramChat: cfg.telegramChat, webhook: cfg.webhook,
      sentinelMin: cfg.sentinelMin, marketMin: cfg.marketMin, reportHour: cfg.reportHour,
      notifyChannels: [cfg.telegramToken && cfg.telegramChat ? 'telegram' : null, cfg.webhook ? 'webhook' : null].filter(Boolean),
      sentinel: this.sentinel, sentinelError: this.sentinelError,
      sentinelHistory: this.sentinelHistory.slice(0, 10),
      report: this.report,
      market: this.market, marketError: this.marketError,
      oorAdvice: this.oorAdvice,
    };
  }

  _save() {
    try { saveSnapshot('ai', { report: this.report, market: this.market, baseline: this._baseline, reportDoneDay: this._reportDoneDay }); } catch { /* ignore */ }
  }
}
