// 外汇多品种网格 · 配置加载器
// 5 个品种槽位（slot）共享一个 MT5 通道（单终端登入）。
// 每个槽位可独立：品种(symbol) / 运行模式(paper|live) / 平台(platform，预留未来接入
// 其他外汇平台，如 oanda/fxcm/icmarkets，当前只有 mt5)。
// 支持全局代理（GLOBAL_PROXY）+ 各槽位独立代理覆盖。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function optionalNumber(name) {
  const raw = process.env[name];
  return raw == null || String(raw).trim() === '' ? Number.NaN : Number(raw);
}

export function loadEnv() {
  const file = path.join(root, '.env');
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (m && process.env[m[1]] === undefined) {
        let v = m[2].trim();
        const q = v.match(/^"([^"]*)"|^'([^']*)'/); // quoted: take the quoted content
        if (q) v = q[1] ?? q[2];
        else v = v.replace(/\s+#.*$/, '').trim();   // unquoted: strip inline comments
        process.env[m[1]] = v;
      }
    }
  }
}

// 槽位定义：顺序即总览卡片顺序
const SLOTS = [
  { key: 'eur', defaultSymbol: 'EURUSD' },
  { key: 'gbp', defaultSymbol: 'GBPUSD' },
  { key: 'jpy', defaultSymbol: 'USDJPY' },
  { key: 'xau', defaultSymbol: 'XAUUSD' },
  { key: 'nas', defaultSymbol: 'NAS100' },
];

function parseSlot(slot, globalProxy) {
  const prefix = slot.key.toUpperCase();
  return {
    key: slot.key,
    symbol: (process.env[`${prefix}_SYMBOL`] || slot.defaultSymbol).toUpperCase(),
    // 平台接入位：当前仅 mt5；未来实现 oanda/fxcm/icmarkets 适配器后，
    // 在 src/exchange/platforms/ 里注册并在此处切换即可（见 docs/接入新平台.md）。
    platform: (process.env[`${prefix}_PLATFORM`] || 'mt5').toLowerCase(),
    mode: (process.env[`${prefix}_MODE`] || 'paper').toLowerCase() === 'live' ? 'live' : 'paper',
    startBalance: Number(process.env.PAPER_BALANCE || 10000),
    proxy: process.env[`${prefix}_PROXY`] || globalProxy,
  };
}

export function getConfig() {
  loadEnv();

  // 全局代理：作为所有槽位的默认代理
  const globalProxy =
    process.env.GLOBAL_PROXY ||
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    '';

  const slots = {};
  for (const slot of SLOTS) slots[slot.key] = parseSlot(slot, globalProxy);

  return {
    port: Number(process.env.PORT || 8283),
    // SECURITY: bind to loopback by default. Set HOST=0.0.0.0 only if you
    // understand the risk and add your own auth.
    host: process.env.HOST || '127.0.0.1',
    globalProxy,
    // ── MT5 通道（单终端登入） ──────────────────────────────────────────
    mt5: {
      terminalPath: process.env.MT5_TERMINAL || 'F:\\MT5\\terminal64.exe',
      login: optionalNumber('MT5_LOGIN'),
      password: process.env.MT5_PASSWORD || '',
      server: process.env.MT5_SERVER || '',
      python: process.env.MT5_PYTHON || '',
      // 行情轮询间隔（毫秒）：驱动模拟撮合/网格价格
      pollMs: Number(process.env.MT5_POLL_MS || 1000),
      // 初始化失败重试（终端被回测占用时）
      retryBaseMs: Number(process.env.MT5_RETRY_BASE_MS || 5000),
      retryMaxMs: Number(process.env.MT5_RETRY_MAX_MS || 30000),
    },
    slots,
  };
}

export const ROOT = root;
