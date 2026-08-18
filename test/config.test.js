// 配置加载测试：5 槽位结构 + MT5 通道参数 + 代理继承
import assert from 'node:assert/strict';
import { getConfig } from '../src/config.js';

const envNames = [
  'GLOBAL_PROXY', 'EUR_SYMBOL', 'EUR_MODE', 'EUR_PLATFORM', 'GBP_SYMBOL', 'XAU_SYMBOL',
  'MT5_TERMINAL', 'MT5_LOGIN', 'MT5_SERVER', 'NAS_SYMBOL', 'NAS_MODE',
];
const previous = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));

try {
  for (const name of envNames) delete process.env[name];

  // 默认值
  const cfg = getConfig();
  assert.equal(cfg.port, 8283);
  assert.equal(cfg.host, '127.0.0.1');
  assert.equal(cfg.mt5.terminalPath, 'F:\\MT5\\terminal64.exe');
  assert.equal(cfg.slots.eur.symbol, 'EURUSD');
  assert.equal(cfg.slots.gbp.symbol, 'GBPUSD');
  assert.equal(cfg.slots.jpy.symbol, 'USDJPY');
  assert.equal(cfg.slots.xau.symbol, 'XAUUSD');
  assert.equal(cfg.slots.nas.symbol, 'NAS100');
  for (const key of ['eur', 'gbp', 'jpy', 'xau', 'nas']) {
    assert.equal(cfg.slots[key].mode, 'paper');
    assert.equal(cfg.slots[key].platform, 'mt5');
    assert.equal(cfg.slots[key].startBalance, 10000);
  }

  // 覆盖
  process.env.EUR_SYMBOL = 'XAUUSD';
  process.env.EUR_MODE = 'live';
  process.env.EUR_PLATFORM = 'oanda'; // 预留平台位可被覆盖
  process.env.NAS_SYMBOL = 'SPX500';
  process.env.NAS_MODE = 'live';
  process.env.MT5_LOGIN = '12345678';
  process.env.MT5_SERVER = 'Pepperstone-Demo';
  process.env.GLOBAL_PROXY = 'socks5://u:p@127.0.0.1:1080';
  const c2 = getConfig();
  assert.equal(c2.slots.eur.symbol, 'XAUUSD');
  assert.equal(c2.slots.eur.mode, 'live');
  assert.equal(c2.slots.eur.platform, 'oanda');
  assert.equal(c2.slots.nas.symbol, 'SPX500');
  assert.equal(c2.slots.nas.mode, 'live');
  assert.equal(c2.mt5.login, 12345678);
  assert.equal(c2.mt5.server, 'Pepperstone-Demo');
  assert.equal(c2.globalProxy, 'socks5://u:p@127.0.0.1:1080');
  // 未单独配置的槽位继承全局代理
  assert.equal(c2.slots.gbp.proxy, 'socks5://u:p@127.0.0.1:1080');
} finally {
  for (const name of envNames) {
    if (previous[name] === undefined) delete process.env[name];
    else process.env[name] = previous[name];
  }
}

console.log('config tests passed');
