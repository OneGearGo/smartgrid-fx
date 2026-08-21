// 设置服务：品种槽位管理 / 策略模板库 / 系统运行状态
// 1) 槽位配置：读写 .env 中的 *_SYMBOL / *_MODE / *_PLATFORM / *_PROXY（改动需重启生效，
//    但这里提供"写入 + 提示重启"的完整流程，网页上不用再手动编辑 .env）
// 2) 策略模板：多套网格参数模板（保守/稳健/激进/自定义），存 .strategies.json，可增删改查、
//    一键套用到指定槽位（套用结果 = 网页"启动"时的参数预填）
// 3) 系统状态：桥连接 / EA 上报 / 端口 / 运行时长 / 最近日志摘要（只读）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = path.join(root, '.env');
const STRATEGIES_FILE = path.join(root, '.strategies.json');

const SLOT_KEYS = ['eur', 'gbp', 'jpy', 'xau', 'nas'];

// ── .env 读写（沿用 /api/env 的字段命名规则） ────────────────────────────────
function readEnvFile() {
  return fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';
}

function writeEnvKey(key, val) {
  let content = readEnvFile();
  const regex = new RegExp(`^\\s*${key}\\s*=.*$`, 'm');
  const line = val ? `${key}=${val}` : `# ${key}=`;
  if (regex.test(content)) content = content.replace(regex, line);
  else content = content.trimEnd() + '\n' + line + '\n';
  fs.writeFileSync(ENV_FILE, content, 'utf8');
  // 同步到当前进程（后续 getConfig/重启前临时生效）
  if (val) process.env[key] = val; else delete process.env[key];
}

const SLOT_FIELD_ENV = {
  symbol: (k) => `${k.toUpperCase()}_SYMBOL`,
  mode: (k) => `${k.toUpperCase()}_MODE`,
  platform: (k) => `${k.toUpperCase()}_PLATFORM`,
  proxy: (k) => `${k.toUpperCase()}_PROXY`,
};

/** 读取一个槽位当前配置（来自进程 env，与 config.js 口径一致）。 */
function getSlotConfig(key) {
  const prefix = key.toUpperCase();
  return {
    key,
    symbol: (process.env[`${prefix}_SYMBOL`] || '').toUpperCase(),
    mode: (process.env[`${prefix}_MODE`] || 'paper').toLowerCase(),
    platform: (process.env[`${prefix}_PLATFORM`] || 'mt5').toLowerCase(),
    proxy: process.env[`${prefix}_PROXY`] || '',
  };
}

/** 校验 + 写入槽位字段。返回 {ok} 或抛错。 */
export function updateSlotConfig(key, patch) {
  if (!SLOT_KEYS.includes(key)) throw new Error('未知槽位: ' + key);
  const fields = {};
  if (patch.symbol != null) {
    const s = String(patch.symbol).trim().toUpperCase();
    if (!/^[A-Z0-9._-]{2,20}$/.test(s)) throw new Error('品种格式无效（如 EURUSD / XAUUSD）。');
    fields.symbol = s;
  }
  if (patch.mode != null) {
    const m = String(patch.mode).trim().toLowerCase();
    if (!['paper', 'live'].includes(m)) throw new Error('模式只能是 paper（模拟）或 live（实盘）。');
    fields.mode = m;
  }
  if (patch.platform != null) {
    const pl = String(patch.platform).trim().toLowerCase();
    if (!['mt5'].includes(pl)) throw new Error('当前仅支持 mt5 平台。');
    fields.platform = pl;
  }
  if (patch.proxy != null) {
    const p = String(patch.proxy).trim();
    if (p && !/^(https?|socks[45]?):\/\//i.test(p)) throw new Error('代理格式无效，如 http://127.0.0.1:7890 或 socks5://user:pass@host:1080');
    fields.proxy = p;
  }
  if (!Object.keys(fields).length) throw new Error('没有可更新的字段。');
  for (const [field, val] of Object.entries(fields)) writeEnvKey(SLOT_FIELD_ENV[field](key), val);
  return { ok: true, config: getSlotConfig(key) };
}

/** 读取全部槽位配置。 */
export function getSlotsConfig() {
  return SLOT_KEYS.map(getSlotConfig);
}

// ── 策略模板库 ───────────────────────────────────────────────────────────────
const DEFAULT_STRATEGIES = [
  {
    id: 'steady', name: '稳健（保守）', builtin: true,
    gridCount: 12, spacingPct: 0.35, leverage: 50, sizeBasePct: 0.01,
    outOfRangeAction: 'close', desc: '格数少、间距宽，成交少更安全，适合震荡行情长期挂机。',
  },
  {
    id: 'balanced', name: '均衡（推荐）', builtin: true,
    gridCount: 20, spacingPct: 0.25, leverage: 100, sizeBasePct: 0.01,
    outOfRangeAction: 'close', desc: '默认参数：20 格、间距约 0.2-0.3%，覆盖常见震荡区间。',
  },
  {
    id: 'aggressive', name: '激进（高频）', builtin: true,
    gridCount: 30, spacingPct: 0.15, leverage: 100, sizeBasePct: 0.01,
    outOfRangeAction: 'recover', desc: '格数多、间距窄，成交频繁，收益与风险都更高。',
  },
];

function loadStrategies() {
  if (!fs.existsSync(STRATEGIES_FILE)) return DEFAULT_STRATEGIES.map((s) => ({ ...s }));
  try {
    const list = JSON.parse(fs.readFileSync(STRATEGIES_FILE, 'utf8'));
    if (!Array.isArray(list)) return DEFAULT_STRATEGIES.map((s) => ({ ...s }));
    // 内置模板始终保留在首位（不允许删除），用户自定义追加在后
    const builtins = DEFAULT_STRATEGIES.map((s) => ({ ...s }));
    const custom = list.filter((s) => s && !s.builtin);
    return [...builtins, ...custom];
  } catch { return DEFAULT_STRATEGIES.map((s) => ({ ...s })); }
}

function saveStrategies(list) {
  const custom = list.filter((s) => !s.builtin);
  fs.writeFileSync(STRATEGIES_FILE, JSON.stringify(custom, null, 2), 'utf8');
}

export function getStrategies() { return loadStrategies(); }

export function addStrategy(spec) {
  const name = String(spec?.name || '').trim();
  if (!name) throw new Error('模板名称不能为空。');
  const gridCount = Number(spec.gridCount);
  const spacingPct = Number(spec.spacingPct);
  const leverage = Number(spec.leverage);
  const sizeBasePct = Number(spec.sizeBasePct);
  if (!Number.isFinite(gridCount) || gridCount < 2 || gridCount > 100) throw new Error('格数必须是 2-100。');
  if (!Number.isFinite(spacingPct) || spacingPct <= 0 || spacingPct > 5) throw new Error('间距必须在 0-5% 之间。');
  if (!Number.isFinite(leverage) || leverage <= 0 || leverage > 1000) throw new Error('杠杆必须是 1-1000。');
  if (!Number.isFinite(sizeBasePct) || sizeBasePct <= 0 || sizeBasePct > 1) throw new Error('每格量占比必须是 0-1。');
  const list = loadStrategies();
  const entry = {
    id: 'c' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36),
    name, builtin: false,
    gridCount, spacingPct, leverage, sizeBasePct,
    outOfRangeAction: spec.outOfRangeAction === 'recover' ? 'recover' : 'close',
    desc: String(spec?.desc || '').slice(0, 120),
  };
  list.push(entry);
  saveStrategies(list);
  return entry;
}

export function deleteStrategy(id) {
  const list = loadStrategies();
  const target = list.find((s) => s.id === id);
  if (!target) throw new Error('模板不存在: ' + id);
  if (target.builtin) throw new Error('内置模板不允许删除。');
  saveStrategies(list.filter((s) => s.id !== id));
  return { ok: true };
}

// ── 系统运行状态（只读） ─────────────────────────────────────────────────────
export function getSystemStatus({ exchanges, sharedBridge, startedAt }) {
  const out = {
    startedAt, uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    port: Number(process.env.PORT || 8283),
    host: process.env.HOST || '127.0.0.1',
    mt5: {
      terminal: process.env.MT5_TERMINAL || '',
      login: process.env.MT5_LOGIN ? String(process.env.MT5_LOGIN) : 'auto',
      server: process.env.MT5_SERVER || '',
      bridge: (process.env.MT5_BRIDGE || 'python').toLowerCase(),
      eaPort: Number(process.env.EA_BRIDGE_PORT || 8383),
      pollMs: Number(process.env.MT5_POLL_MS || 1000),
    },
    bridge: null,
    slots: {},
    circuitBreakers: {
      maxDrawdownPct: Number(process.env.MAX_DRAWDOWN_PCT || 0),
      dailyLossLimitPct: Number(process.env.DAILY_LOSS_LIMIT_PCT || 0),
    },
  };

  // 桥连接状态
  if (sharedBridge) {
    const b = sharedBridge;
    out.bridge = {
      kind: b.constructor?.name === 'EaBridgeServer' ? 'ea' : 'python',
      connected: !!b.connected,
      lastStateAt: b.lastStateAt ?? null,
      lastStateAgeMs: b.lastStateAt ? Date.now() - b.lastStateAt : null,
      pendingCommands: Array.isArray(b._cmdQueue) ? b._cmdQueue.length : null,
      account: b.account ? {
        login: b.account.login, server: b.account.server,
        balance: b.account.balance, equity: b.account.equity,
        margin: b.account.margin, marginFree: b.account.margin_free,
        leverage: b.account.leverage,
      } : null,
    };
  }

  // 各槽位健康（dataSource / 最近成功时间）
  for (const key of Object.keys(exchanges)) {
    const ex = exchanges[key];
    out.slots[key] = {
      symbol: ex?.symbol ?? key.toUpperCase(),
      dataSource: ex?.dataSource ?? null,
      lastOkAgeMs: ex?.lastOkAt ? Date.now() - ex.lastOkAt : null,
    };
  }
  return out;
}
