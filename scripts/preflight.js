// 配置预检：启动前检查 .env 与 MT5 通道配置，不连接交易所、不输出密钥。
// 运行：npm run check:config
import fs from 'node:fs';
import path from 'node:path';
import { getConfig, ROOT } from '../src/config.js';

let errors = 0;
const warn = (msg) => console.warn('  ⚠ ' + msg);
const err = (msg) => { errors++; console.error('  ✗ ' + msg); };
const ok = (msg) => console.log('  ✓ ' + msg);

console.log('外汇网格总控台 · 配置预检\n');

// 1. .env 存在性
const envFile = path.join(ROOT, '.env');
if (!fs.existsSync(envFile)) {
  err('.env 不存在。请先复制 .env.example 为 .env（一键启动会自动生成）。');
  console.log(`\n预检结束：${errors} 个错误`);
  process.exit(1);
}
ok('.env 存在');

// 2. 槽位配置
const cfg = getConfig();
const SLOT_NAMES = { eur: 'EURUSD', gbp: 'GBPUSD', jpy: 'USDJPY', xau: 'XAUUSD', nas: 'NAS100' };
console.log('\n[5 品种槽位]');
for (const [key, name] of Object.entries(SLOT_NAMES)) {
  const s = cfg.slots[key];
  const modeTxt = s.mode === 'live' ? '实盘 LIVE' : '模拟 paper';
  const platform = s.platform;
  console.log(`  ${name.padEnd(8)} ${modeTxt.padEnd(12)} platform=${platform}`);
  if (s.mode === 'live' && platform !== 'mt5') {
    warn(`${name} 是实盘但 platform=${platform} 不是 mt5（当前仅支持 mt5）。`);
  }
}

// 3. MT5 通道
console.log('\n[MT5 通道]');
const m = cfg.mt5;
if (!fs.existsSync(m.terminalPath)) {
  err(`MT5 终端不存在: ${m.terminalPath}（可在 .env 改 MT5_TERMINAL）`);
} else {
  ok(`MT5 终端: ${m.terminalPath}`);
}
if (m.login && Number.isFinite(m.login)) {
  ok(`登录账号: ${m.login} @ ${m.server || '(未填服务器)'}`);
  if (!m.password && !m.server) warn('未填 MT5_PASSWORD/MT5_SERVER——若终端已登录可留空（用终端当前账户）。');
} else {
  ok('未配置 MT5_LOGIN——将使用终端已登录的账户。');
}

// 4. 实盘风险提示
const live = Object.values(cfg.slots).filter((s) => s.mode === 'live');
if (live.length) {
  console.log(`\n⚠ 检测到 ${live.length} 个实盘槽位。实盘会发送真实订单到 MT5 账户，请确认：`);
  console.log('   1) MT5 终端已登录正确的实盘账户；');
  console.log('   2) 杠杆/保证金已按计划设置；');
  console.log('   3) 只对确定要实盘的品种开启 live，其余保持 paper。');
}

console.log(`\n预检结束：${errors} 个错误`);
process.exit(errors ? 1 : 0);
