// 外汇保证金计算测试：验证 contractSize（合约规模）参与保证金预检。
// 加密算法 notional=格数×手数×价格（严重低估外汇）；正确算法要乘合约规模。
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { GridBot } from '../src/bot.js';
import { PaperMt5 } from '../src/exchange/mt5/paper.js';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + '\n    ' + (e?.stack || e)); }
}

/** FakeBridge：get_symbols 返回带 contractSize 的规格（模拟 EA 桥上报）。 */
class FakeBridge extends EventEmitter {
  constructor() {
    super();
    this.specs = { XAUUSD: { name: 'XAUUSD', digits: 2, point: 0.01, volume_min: 0.01, volume_step: 0.01, spread: 20, trade_tick_size: 0.01, contractSize: 100 } };
    this.price = { bid: 2400.00, ask: 2400.20 };
    this.orders = [];
    this.positions = [];
  }
  async call(method, params = {}) {
    if (method === 'get_symbols') return [this.specs[params.symbols[0]]].filter(Boolean);
    if (method === 'get_price') return { bid: this.price.bid, ask: this.price.ask };
    if (method === 'get_candles') return { candles: makeCandles(200, 2400) };
    if (method === 'get_account') return { login: 12345678, server: 'Fake', balance: 10000, equity: 10000, leverage: 100 };
    if (method === 'open_orders') return this.orders;
    if (method === 'positions') return this.positions;
    if (method === 'place_limit') { const o = { ticket: 1000 + this.orders.length + 1, symbol: params.symbol, type: params.side === 'buy' ? 2 : 3, price_open: params.price, volume_current: params.volume, volume_initial: params.volume, magic: params.magic || 0 }; this.orders.push(o); return { ok: true, ticket: o.ticket }; }
    if (method === 'cancel') { this.orders = this.orders.filter((o) => o.ticket !== Number(params.ticket)); return { ok: true }; }
    if (method === 'cancel_all') { this.orders = []; return { ok: true, cancelled: 0, errors: [] }; }
    if (method === 'close_position') { this.positions = []; return { ok: true, closed: 0, errors: [] }; }
    throw new Error('unknown: ' + method);
  }
  async setPrice(bid, ask) { this.price = { bid, ask }; }
}

function makeCandles(n, price) {
  const out = [];
  let p = price;
  let t = Math.floor(Date.now() / 1000) - n * 3600;
  for (let i = 0; i < n; i++) {
    out.push({ time: t, open: p, high: p * 1.002, low: p * 0.998, close: p * (1 + (i % 3 ? 0.0005 : -0.0005)), volume: 100 });
    p = out[out.length - 1].close;
    t += 3600;
  }
  return out;
}

function makeEx(bridge) {
  return new PaperMt5({ bridge, symbol: 'XAUUSD', startBalance: 10000, pollMs: 1000, magic: 30001 });
}

async function startBot(ex, cfg) {
  const bot = new GridBot(ex, { cancelVerifyAttempts: 2, cancelVerifyDelayMs: 0, cancelVerifyStableReads: 2 });
  await ex.bridge.setPrice(cfg.priceBid ?? 2400, cfg.priceAsk ?? 2400.2);
  await bot.start({ marketId: 1, mode: 'neutral', lower: cfg.lower ?? 2350, upper: cfg.upper ?? 2450, gridCount: cfg.gridCount ?? 10, sizeBase: cfg.sizeBase ?? 0.1, leverage: cfg.leverage ?? 10, outOfRangeAction: 'close' });
  return bot;
}

console.log('外汇保证金计算');

await test('contractSize 参与名义敞口计算（XAUUSD 1手=100盎司）', async () => {
  const bridge = new FakeBridge();
  const ex = makeEx(bridge);
  await ex.init(); ex.stop();
  const bot = await startBot(ex, { sizeBase: 0.01, leverage: 100 });
  // 10 格 × 0.01手 × 100盎司 × 2400 = 24,000 名义；/100x = 240 保证金
  assert.equal(bot.risk.notional, 24000);
  assert.equal(bot.risk.requiredMargin, 240);
  bot._stopReconcileTimer();
});

await test('保证金不足时启动被拒（外汇正确计算）', async () => {
  const bridge = new FakeBridge();
  const ex = makeEx(bridge);
  await ex.init(); ex.stop();
  const bot = new GridBot(ex, { cancelVerifyAttempts: 2, cancelVerifyDelayMs: 0, cancelVerifyStableReads: 2 });
  await ex.bridge.setPrice(2400, 2400.2);
  // 10 格 × 0.5手 × 100盎司 × 2400 = 1,200,000 名义；/10x = 120,000 > 10000 余额 -> 拒绝
  await assert.rejects(() => bot.start({
    marketId: 1, mode: 'neutral', lower: 2350, upper: 2450,
    gridCount: 10, sizeBase: 0.5, leverage: 10, outOfRangeAction: 'close',
  }), /保证金不足/);
  bot._stopReconcileTimer();
});

await test('小仓位能通过预检', async () => {
  const bridge = new FakeBridge();
  const ex = makeEx(bridge);
  await ex.init(); ex.stop();
  const bot = await startBot(ex, { sizeBase: 0.01, leverage: 100 });
  // 10 格 × 0.01手 × 100盎司 × 2400 = 24,000 名义；/100x = 240 保证金 << 10000
  assert.equal(bot.risk.requiredMargin, 240);
  assert.equal(bot.running, true);
  bot._stopReconcileTimer();
});

await test('无 contractSize 时兜底为 1（兼容旧测试/规格缺失）', async () => {
  const bridge = new FakeBridge();
  bridge.specs.XAUUSD = { name: 'XAUUSD', digits: 2, point: 0.01, volume_min: 0.01, volume_step: 0.01, spread: 20, trade_tick_size: 0.01 }; // 无 contractSize
  const ex = makeEx(bridge);
  await ex.init(); ex.stop();
  const bot = await startBot(ex, { sizeBase: 0.1 });
  // 兜底 cs=1：10 格 × 0.1 × 1 × 2400 = 2400 名义（旧行为）
  assert.equal(bot.risk.notional, 2400);
  bot._stopReconcileTimer();
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
