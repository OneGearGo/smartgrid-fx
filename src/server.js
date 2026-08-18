// 外汇多品种网格总控台服务器
// 路由规则：
//   /api/eur|gbp|jpy|xau|nas/*  → 各品种槽位（每个槽位一个 GridBot）
//   /api/overview              → 五品种总览（余额+盈亏）
// 所有槽位共享同一个 MT5 通道（单终端登入），通过 Python 桥通信。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { getConfig, ROOT } from './config.js';
import { createExchange, getSharedBridge, _resetSharedBridge } from './exchange/mt5/index.js';
import { GridBot } from './bot.js';
import { analyzeTrend } from './trend.js';
import { setupProxies, checkProxy } from './proxy.js';
import { loadSnapshot, saveSnapshot } from './persist.js';
import { createAiService } from './ai/service.js';
import { dashboardExchangeState } from './overview.js';

// ── 启动配置 ─────────────────────────────────────────────────────────────────
const cfg = getConfig();

// ── 代理设置 ─────────────────────────────────────────────────────────────────
const proxyResult = await setupProxies(cfg);
if (proxyResult.used) {
  console.log('[代理] 已启用: ' + proxyResult.used);
  console.log('[代理检测] 正在验证代理可用性...');
  const chk = await checkProxy();
  if (chk.ok) {
    console.log('[代理检测] ✓ 代理正常，当前出口 IP: ' + chk.ip);
  } else {
    console.error('[代理检测] ✗ 代理无法联网：' + chk.error);
    const hasLive = Object.values(cfg.slots).some((s) => s.mode === 'live');
    if (hasLive) {
      console.error('  实盘模式已中止启动，以免在断网状态下运行造成挂单失控。');
      process.exit(1);
    } else {
      console.error('  模拟模式将继续运行，但可能拿不到真实行情。');
    }
  }
} else {
  console.log('[代理] 未配置（直连模式）');
}

// ── 槽位定义 ────────────────────────────────────────────────────────────────
const SLOT_ORDER = ['eur', 'gbp', 'jpy', 'xau', 'nas'];
const SLOT_NAMES = { eur: 'EURUSD', gbp: 'GBPUSD', jpy: 'USDJPY', xau: 'XAUUSD', nas: 'NAS100' };

// 共享 MT5 桥（单终端登入）
const sharedBridge = getSharedBridge(cfg.mt5);

const bots = {};
const exchanges = {};
const exCfgs = {};
const clients = {};   // 每槽位 SSE 客户端集合

for (const key of SLOT_ORDER) {
  const slotCfg = cfg.slots[key];
  // 每个槽位分配独立 magic 号（live 模式标识网格单，避免误撤手动单）
  const magic = 30000 + SLOT_ORDER.indexOf(key);
  const ex = createExchange(slotCfg, cfg.mt5, magic);
  const bot = new GridBot(ex, { onChange: (s) => saveSnapshot(key, s) });
  // 状态恢复（仅显示连续性，不自动续跑）
  bot.restore(loadSnapshot(key));
  bots[key] = bot;
  exchanges[key] = ex;
  exCfgs[key] = slotCfg;
  clients[key] = new Set();
}

// Belt-and-suspenders: 确保每个适配器都有 error 监听器
for (const ex of Object.values(exchanges)) {
  if (ex.listenerCount('error') === 0) {
    ex.on('error', (e) => { try { console.error('[交易所错误] ' + (e?.message || e)); } catch {} });
  }
}

// ── AI 服务（哨兵/日报/分析/对话/出区间建议）────────────────────────────────
const aiService = createAiService({ bots, exchanges });
aiService.start();

// ── 工具函数 ──────────────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};
const PUBLIC_ROOT = path.join(ROOT, 'public');

function send(res, code, obj) {
  const body = JSON.stringify(obj, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  if (res.headersSent) { try { res.end(); } catch { /* ignore */ } return; }
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function readBody(req, maxBytes = 1_000_000) {
  return new Promise((resolve) => {
    let b = '', n = 0, done = false;
    req.on('data', (c) => {
      if (done) return;
      n += c.length;
      if (n > maxBytes) { done = true; try { req.destroy(); } catch { /* ignore */ } resolve({}); return; }
      b += c;
    });
    req.on('end', () => { if (done) return; done = true; try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
  });
}

// ── 槽位路由处理器工厂 ───────────────────────────────────────────────────────
function makeExchangeHandler(prefix, bot, exchange, exCfg, clientSet, name) {
  return async (req, res, subPath, url) => {
    if (subPath === '/markets') {
      return send(res, 200, {
        exchange: name,
        mode: exCfg.mode,
        dataSource: exchange.dataSource || (exCfg.mode === 'live' ? 'real' : 'synthetic'),
        network: exchange.network || 'mt5',
        apiUrl: exchange.apiUrl || 'MT5',
        markets: await exchange.getMarkets(),
      });
    }

    if (subPath === '/trend') {
      const marketId = Number(url.searchParams.get('marketId') || 1);
      const intervalSec = Number(url.searchParams.get('intervalSec') || 3600);
      let candles = [];
      try { candles = await exchange.getCandles(marketId, intervalSec, 200); } catch { /* tolerate */ }
      let price = null;
      try { price = await exchange.getPrice(marketId); } catch {}
      const analysis = (candles && candles.length >= 20)
        ? analyzeTrend(candles)
        : {
            trend: 'range', recommended: 'neutral', strength: 0, atrPct: null, price,
            detail: '暂时拿不到足够K线数据，已默认中性网格。可手动设置上下边界后启动；不影响下单。',
          };
      return send(res, 200, { analysis, candles: (candles || []).slice(-120) });
    }

    if (subPath === '/state') return send(res, 200, bot.getState());

    if (subPath === '/start' && req.method === 'POST') {
      try { return send(res, 200, await bot.start(await readBody(req))); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }

    if (subPath === '/stop' && req.method === 'POST') {
      try { return send(res, 200, await bot.stop(await readBody(req))); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }

    if (subPath === '/adjust' && req.method === 'POST') {
      try { return send(res, 200, await bot.adjustRange(await readBody(req))); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }

    if (subPath === '/reset' && req.method === 'POST') {
      try { return send(res, 200, await bot.resetStats()); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }

    if (subPath === '/cancel-orders' && req.method === 'POST') {
      try { return send(res, 200, await bot.cancelAllOrders()); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }

    if (subPath === '/refill' && req.method === 'POST') {
      try { return send(res, 200, await bot.refillGrid()); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }

    if (subPath === '/start-recovery' && req.method === 'POST') {
      try { return send(res, 200, await bot.startRecovery(await readBody(req))); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }

    if (subPath === '/reconnect' && req.method === 'POST') {
      try {
        if (typeof exchange.reconnect === 'function') await exchange.reconnect();
        else if (typeof exchange.init === 'function') await exchange.init();
        let resumed = false, resumeError = null;
        if (!bot.running) {
          const key = prefix.split('/').pop();
          const snap = loadSnapshot(key);
          if (snap?.running && snap?.config) {
            try {
              await bot.resume(snap);
              resumed = true;
              console.log(`[恢复] ${key.toUpperCase()} 重连成功后已自动续跑，接管挂单并完成对账。`);
            } catch (e) {
              resumeError = e?.message || String(e);
              console.error(`[恢复] ${key.toUpperCase()} 重连后续跑失败（${resumeError}），挂单保留未动。`);
            }
          }
        }
        if (bot.running) await bot.reconcileOpenOrders().catch(() => {});
        return send(res, 200, { ok: true, resumed, resumeError, state: bot.getState() });
      } catch (e) {
        return send(res, 500, { error: e?.message || String(e) });
      }
    }

    if (subPath === '/close-position' && req.method === 'POST') {
      try { const b = await readBody(req); return send(res, 200, await bot.closePositionNow(b && b.marketId)); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }

    if (subPath === '/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(`data: ${JSON.stringify(bot.getState())}\n\n`);
      clientSet.add(res);
      req.on('close', () => clientSet.delete(res));
      return;
    }

    send(res, 404, { error: 'not found: ' + subPath });
  };
}

// ── HTTP 服务器 ───────────────────────────────────────────────────────────────
const server = http.createServer(async (request, res) => {
  const url = new URL(request.url, 'http://localhost');
  const p = url.pathname;

  try {
    // ── 总览 API ──────────────────────────────────────────────────────────
    if (p === '/api/overview') {
      const out = {};
      for (const key of SLOT_ORDER) out[key] = pick(bots[key].getState(), exCfgs[key].mode, key);
      return send(res, 200, out);
    }

    // ── 总览 SSE 流 ───────────────────────────────────────────────────────
    if (p === '/api/overview/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      const initial = dashboardState();
      res.write(`data: ${JSON.stringify(initial, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}\n\n`);
      const overviewClients = server._overviewClients;
      overviewClients.add(res);
      request.on('close', () => overviewClients.delete(res));
      return;
    }

    // ── AI 助手 API ───────────────────────────────────────────────────────
    if (p === '/api/ai/status') {
      return send(res, 200, aiService.status());
    }
    if (p === '/api/ai/test' && request.method === 'POST') {
      try { return send(res, 200, await aiService.test()); }
      catch (e) { return send(res, 200, { ok: false, error: e?.message || String(e) }); }
    }
    if (p === '/api/ai/sentinel-run' && request.method === 'POST') {
      try {
        const r = await aiService.runSentinel();
        return send(res, 200, r || { error: aiService.sentinelError || '巡检失败' });
      } catch (e) { return send(res, 500, { error: e?.message || String(e) }); }
    }
    if (p === '/api/ai/market-run' && request.method === 'POST') {
      try { return send(res, 200, await aiService.runMarketAnalysis()); }
      catch (e) { return send(res, 500, { error: e?.message || String(e) }); }
    }
    if (p === '/api/ai/report' && request.method === 'POST') {
      try { return send(res, 200, await aiService.makeReport()); }
      catch (e) { return send(res, 500, { error: e?.message || String(e) }); }
    }
    if (p === '/api/ai/analyze' && request.method === 'POST') {
      try {
        const b = await readBody(request);
        return send(res, 200, await aiService.analyze(String(b.ex || 'xau')));
      } catch (e) { return send(res, 500, { error: e?.message || String(e) }); }
    }
    if (p === '/api/ai/chat' && request.method === 'POST') {
      try {
        const b = await readBody(request);
        if (!b.message) return send(res, 400, { error: '消息为空' });
        return send(res, 200, await aiService.chatControl(b.message, Array.isArray(b.history) ? b.history : []));
      } catch (e) { return send(res, 500, { error: e?.message || String(e) }); }
    }

    // ── 代理配置 API ──────────────────────────────────────────────────────
    if (p === '/api/proxy-check') {
      const result = await checkProxy();
      return send(res, 200, result);
    }

    if (p === '/api/proxy-config') {
      return send(res, 200, {
        global: process.env.GLOBAL_PROXY || '',
        eur: process.env.EUR_PROXY || '',
        gbp: process.env.GBP_PROXY || '',
        jpy: process.env.JPY_PROXY || '',
        xau: process.env.XAU_PROXY || '',
        nas: process.env.NAS_PROXY || '',
        // Boolean only
        windowsSystem: proxyResult.source === 'windows-system',
      });
    }

    if (p === '/api/env' && request.method === 'POST') {
      try {
        const { key, value } = await readBody(request);
        const PROXY_KEYS = ['GLOBAL_PROXY', 'EUR_PROXY', 'GBP_PROXY', 'JPY_PROXY', 'XAU_PROXY', 'NAS_PROXY'];
        const AI_KEYS = ['AI_PROVIDER', 'AI_API_KEY', 'AI_BASE_URL', 'AI_MODEL', 'AI_MODEL_SMALL', 'AI_SENTINEL_MINUTES', 'AI_MARKET_MINUTES', 'AI_REPORT_HOUR', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'NOTIFY_WEBHOOK'];
        if (!PROXY_KEYS.includes(key) && !AI_KEYS.includes(key)) return send(res, 400, { error: '不允许修改该字段: ' + key });
        const val = value == null ? '' : String(value).trim();
        if (val) {
          if (/\s/.test(val) || [...val].some((c) => c.charCodeAt(0) < 32) || val.length > 500) {
            return send(res, 400, { error: '值包含非法字符（空白/换行/控制字符）或过长。' });
          }
          if (PROXY_KEYS.includes(key)) {
            const ok = /^[\w.-]+:\d{1,5}(:[^:\s@]+:[^:\s@]+)?$/.test(val)
              || /^(https?|socks[45]?):\/\/([^:@/\s]+(:[^@/\s]+)?@)?[\w.-]+:\d{1,5}\/?$/i.test(val);
            if (!ok) return send(res, 400, { error: '代理地址格式无效。示例：http://127.0.0.1:7890 或 socks5://user:pass@host:1080' });
          } else if (key === 'AI_PROVIDER') {
            if (!/^(openai|anthropic|gemini)$/i.test(val)) return send(res, 400, { error: 'AI_PROVIDER 只能是 openai / anthropic / gemini（OpenAI 兼容协议的服务商选 openai）。' });
          } else if (key === 'AI_SENTINEL_MINUTES' || key === 'AI_MARKET_MINUTES') {
            if (!/^\d{1,4}$/.test(val)) return send(res, 400, { error: '间隔必须是数字（分钟，0=关闭）。' });
          } else if (key === 'AI_REPORT_HOUR') {
            if (!/^\d{1,2}$/.test(val) || Number(val) > 23) return send(res, 400, { error: '日报时间必须是 0-23 的整点小时。' });
          } else if (key === 'AI_BASE_URL' || key === 'NOTIFY_WEBHOOK') {
            if (!/^https?:\/\/\S+$/i.test(val)) return send(res, 400, { error: '必须是 http(s):// 开头的 URL。' });
          }
        }
        if (val) process.env[key] = val; else delete process.env[key];
        const envFile = path.join(ROOT, '.env');
        let content = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
        const regex = new RegExp(`^\\s*${key}\\s*=.*$`, 'm');
        const line = val ? `${key}=${val}` : `# ${key}=`;
        if (regex.test(content)) {
          content = content.replace(regex, line);
        } else {
          content = content.trimEnd() + '\n' + line + '\n';
        }
        fs.writeFileSync(envFile, content, 'utf8');
        return send(res, 200, { ok: true });
      } catch (e) {
        return send(res, 500, { error: e.message });
      }
    }

    // ── 槽位子路由 ────────────────────────────────────────────────────────
    for (const key of SLOT_ORDER) {
      if (p === `/api/${key}` || p.startsWith(`/api/${key}/`)) {
        const handler = makeExchangeHandler(`/api/${key}`, bots[key], exchanges[key], exCfgs[key], clients[key], SLOT_NAMES[key]);
        return await handler(request, res, p.slice(`/api/${key}`.length), url);
      }
    }

    // ── 静态文件 ──────────────────────────────────────────────────────────
    const relativeFile = p === '/' ? 'index.html' : p.replace(/^[/\\]+/, '');
    const full = path.resolve(PUBLIC_ROOT, relativeFile);
    const insidePublic = full === PUBLIC_ROOT || full.startsWith(PUBLIC_ROOT + path.sep);
    if (insidePublic && fs.existsSync(full) && fs.statSync(full).isFile()) {
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(full)] || 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      });
      return fs.createReadStream(full).pipe(res);
    }

    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
});

server._overviewClients = new Set();

// ── SSE 推送定时器 ────────────────────────────────────────────────────────────
setInterval(() => {
  const stringify = (obj) =>
    JSON.stringify(obj, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  for (const key of SLOT_ORDER) {
    const cs = clients[key];
    if (cs.size > 0) {
      const data = `data: ${stringify(bots[key].getState())}\n\n`;
      for (const r of cs) { try { r.write(data); } catch { cs.delete(r); } }
    }
  }
  if (server._overviewClients.size > 0) {
    const data = `data: ${stringify(dashboardState())}\n\n`;
    for (const r of server._overviewClients) { try { r.write(data); } catch { server._overviewClients.delete(r); } }
  }
}, 1000);

function dashboardState() {
  const out = {};
  for (const key of SLOT_ORDER) out[key] = dashboardExchangeState(bots[key].getState(), exCfgs[key].mode);
  return out;
}

function pick(s, mode, key) {
  return {
    slot: key,
    running: s.running,
    mode,
    balance: s.balance,
    equity: s.equity,
    totalPnl: s.totalPnl,
    realizedPnl: s.realizedPnl,
    unrealizedPnl: s.unrealizedPnl,
    returnPct: s.returnPct,
    volume: s.volume,
    completedRungs: s.stats?.completedRungs ?? 0,
    openOrders: s.openOrders ?? 0,
    exchangeOpenOrders: s.exchangeOpenOrders ?? null,
    outOfRange: s.outOfRange ?? false,
    health: s.health ?? null,
    lastPrice: s.lastPrice,
    config: s.config,
    position: s.position ?? null,
    operationalIssue: s.operationalIssue ?? null,
    apiWalletAddress: s.apiWalletAddress ?? null,
  };
}

// ── 错误处理 ──────────────────────────────────────────────────────────────────
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n[启动失败] 端口 ${cfg.port} 已被占用。`);
    console.error('请先关闭占用该端口的程序，或在 .env 里改 PORT=8284 用别的端口。\n');
  } else {
    console.error('[服务器错误] ' + (e?.message || e));
  }
  process.exit(1);
});

server.listen(cfg.port, cfg.host);

// ── 初始化各槽位 ────────────────────────────────────────────────────────────
async function initSlot(exchange, name, slotCfg) {
  try {
    await exchange.init();
    const ds = exchange.dataSource;
    console.log(`[${name}] ✓ 连接成功 [${slotCfg.mode.toUpperCase()} 模式${ds === 'synthetic' ? ' · 合成行情(终端离线)' : ''}]`);
  } catch (e) {
    console.error(`\n[${name}] ✗ 初始化失败：${e?.message || e}`);
    console.error(`  目标: MT5 ${slotCfg.symbol}`);
    console.error(`  该槽位将以离线模式运行（行情可能使用合成数据）。\n`);
  }
}

await Promise.all(SLOT_ORDER.map((key) => initSlot(exchanges[key], SLOT_NAMES[key], exCfgs[key])));

// 预检查：共享桥是否连上 MT5
const bridgeStatus = sharedBridge.connected;
if (!bridgeStatus) {
  console.warn('\n[MT5] ⚠ 当前未能连接 MT5 终端（可能正在回测或终端未打开）。');
  console.warn('[MT5]   桥会在后台持续重试，行情将暂时使用合成数据；');
  console.warn('[MT5]   终端空闲后会自动切换到真实行情，无需重启本程序。\n');
}

// ── 启动横幅 ──────────────────────────────────────────────────────────────────
const banner = `
${'─'.repeat(52)}
  外汇网格交易总控台  v${process.env.npm_package_version || '0.1.0'}
  ${'─'.repeat(52)}
  MT5 终端: ${cfg.mt5.terminalPath}
  账    户: ${cfg.mt5.login || '(未配置)'} @ ${cfg.mt5.server || '(未配置)'}
  ${'─'.repeat(52)}
${SLOT_ORDER.map((key) => {
  const s = exCfgs[key];
  return `  ${SLOT_NAMES[key].padEnd(8)} [${s.mode.toUpperCase()}]  platform=${s.platform}  symbol=${s.symbol}`;
}).join('\n')}
  ${'─'.repeat(52)}
  ⚠ paper 为模拟盘，不涉及真实资金。切换 live 需在 .env 设置对应槽位 MODE=live。
  控制台: http://127.0.0.1:${cfg.port}
${'─'.repeat(52)}`;
console.log(banner);

process.on('exit', () => { try { _resetSharedBridge(); } catch { /* ignore */ } });
