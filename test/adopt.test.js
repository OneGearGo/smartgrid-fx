// adopt（重新接管仓位）测试：无快照时从真实挂单反推网格重建
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { GridBot } from '../src/bot.js';
import { PaperMt5 } from '../src/exchange/mt5/paper.js';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + '\n    ' + (e?.stack || e)); }
}

class FakeBridge extends EventEmitter {
  constructor() {
    super();
    this.symbols = { XAUUSD: { name: 'XAUUSD', digits: 2, point: 0.01, volume_min: 0.01, volume_step: 0.01, spread: 20, trade_tick_size: 0.01, contractSize: 100 } };
    this.price = { bid: 2400.00, ask: 2400.20 };
    this.orders = [];
    this.positions = [];
  }
  async call(method, params = {}) {
    if (method === 'get_symbols') return [this.symbols[params.symbols[0]]].filter(Boolean);
    if (method === 'get_price') return { bid: this.price.bid, ask: this.price.ask };
    if (method === 'get_candles') return { candles: [] };
    if (method === 'get_account') return { login: 12345678, server: 'Fake', balance: 10000, equity: 10000, leverage: 100 };
    if (method === 'open_orders') return this.orders;
    if (method === 'positions') return this.positions;
    if (method === 'place_limit') { const o = { ticket: 1000 + this.orders.length + 1, symbol: params.symbol, type: params.side === 'buy' ? 2 : 3, price_open: params.price, volume_current: params.volume, volume_initial: params.volume, magic: params.magic || 0, levelIndex: params.levelIndex }; this.orders.push(o); return { ok: true, ticket: o.ticket }; }
    if (method === 'cancel') { this.orders = this.orders.filter((o) => o.ticket !== Number(params.ticket)); return { ok: true }; }
    if (method === 'cancel_all') { this.orders = []; return { ok: true, cancelled: 0, errors: [] }; }
    if (method === 'close_position') { this.positions = []; return { ok: true, closed: 0, errors: [] }; }
    throw new Error('unknown: ' + method);
  }
  async setPrice(bid, ask) { this.price = { bid, ask }; }
}

console.log('adopt · 重新接管仓位');

await test('无快照：从真实挂单反推网格并接管', async () => {
  const bridge = new FakeBridge();
  const ex = new PaperMt5({ bridge, symbol: 'XAUUSD', startBalance: 10000, pollMs: 1000, magic: 30001 });
  await ex.init();
  ex.stop();
  // 模拟 MT5 上残留的挂单（等距分布）——通过 ex.placeLimitOrder 挂到本地簿
  await ex.placeLimitOrder({ marketId: 1, side: 'buy', price: 2380, sizeBase: 0.1, levelIndex: 0 });
  await ex.placeLimitOrder({ marketId: 1, side: 'buy', price: 2390, sizeBase: 0.1, levelIndex: 1 });
  await ex.placeLimitOrder({ marketId: 1, side: 'sell', price: 2410, sizeBase: 0.1, levelIndex: 3 });
  await ex.placeLimitOrder({ marketId: 1, side: 'sell', price: 2420, sizeBase: 0.1, levelIndex: 4 });
  await bridge.setPrice(2400, 2400.2);
  const bot = new GridBot(ex, { cancelVerifyAttempts: 2, cancelVerifyDelayMs: 0, cancelVerifyStableReads: 2 });
  const r = await bot.adoptExistingOrders(null); // 无快照
  assert.equal(r.running, true, '接管后应运行');
  assert.equal(r.openOrders, 4, `接管 ${r.openOrders} 单`);
  assert.equal(r.config.adopted, true, '标记为接管重建');
  assert.ok(r.config.lower <= 2380 && r.config.upper >= 2420, '区间覆盖真实挂单');
  assert.equal(r.config.gridCount, 3, '3 格（4 单-1）');
  // 挂单方向正确：下方 buy、上方 sell
  for (const o of bot.active.values()) {
    if (o.price < 2400) assert.equal(o.side, 'buy', `${o.price} 应为 buy`);
    else if (o.price > 2400) assert.equal(o.side, 'sell', `${o.price} 应为 sell`);
  }
  await bot.stop({ closePosition: false });
  bot._stopReconcileTimer();
});

await test('有快照：走 resume 恢复原网格', async () => {
  const bridge = new FakeBridge();
  const ex = new PaperMt5({ bridge, symbol: 'XAUUSD', startBalance: 10000, pollMs: 1000, magic: 30001 });
  await ex.init();
  ex.stop();
  await bridge.setPrice(2400, 2400.2);
  const bot = new GridBot(ex, { cancelVerifyAttempts: 2, cancelVerifyDelayMs: 0, cancelVerifyStableReads: 2 });
  // 先正常启动一个网格，生成快照
  await bot.start({ marketId: 1, mode: 'neutral', lower: 2350, upper: 2450, gridCount: 10, sizeBase: 0.01, leverage: 100, outOfRangeAction: 'close' });
  const snap = bot.snapshot();
  assert.equal(snap.running, true);
  assert.ok(Array.isArray(snap.active) && snap.active.length >= 6, `快照挂单 ${snap.active?.length}`);
  await bot.stop({ closePosition: false });
  bot._stopReconcileTimer();

  // 新 bot 用快照接管
  const bot2 = new GridBot(ex, { cancelVerifyAttempts: 2, cancelVerifyDelayMs: 0, cancelVerifyStableReads: 2 });
  const r2 = await bot2.adoptExistingOrders(snap);
  assert.equal(r2.running, true);
  assert.equal(r2.config.adopted, undefined, '快照恢复不标记 adopted');
  assert.equal(r2.config.lower, 2350);
  assert.equal(r2.config.gridCount, 10, '保留原网格参数');
  bot2._stopReconcileTimer();
});

await test('MT5 上无挂单无持仓：报错', async () => {
  const bridge = new FakeBridge();
  const ex = new PaperMt5({ bridge, symbol: 'XAUUSD', startBalance: 10000, pollMs: 1000, magic: 30001 });
  await ex.init();
  ex.stop();
  const bot = new GridBot(ex, { cancelVerifyAttempts: 2, cancelVerifyDelayMs: 0, cancelVerifyStableReads: 2 });
  await assert.rejects(() => bot.adoptExistingOrders(null), /没有.*挂单|无需接管/);
});

await test('正在运行时拒绝重复接管', async () => {
  const bridge = new FakeBridge();
  const ex = new PaperMt5({ bridge, symbol: 'XAUUSD', startBalance: 10000, pollMs: 1000, magic: 30001 });
  await ex.init();
  ex.stop();
  await bridge.setPrice(2400, 2400.2);
  const bot = new GridBot(ex, { cancelVerifyAttempts: 2, cancelVerifyDelayMs: 0, cancelVerifyStableReads: 2 });
  await bot.start({ marketId: 1, mode: 'neutral', lower: 2350, upper: 2450, gridCount: 10, sizeBase: 0.01, leverage: 100, outOfRangeAction: 'close' });
  await assert.rejects(() => bot.adoptExistingOrders(null), /已在运行/);
  await bot.stop({ closePosition: false });
  bot._stopReconcileTimer();
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
