// GridBot 扩展流程测试：adjustRange / refillGrid / startRecovery / resetStats / 出区间处理
// 使用 FakeBridge + PaperMt5（合成行情），不依赖真实 MT5 终端。
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { GridBot } from '../src/bot.js';
import { PaperMt5 } from '../src/exchange/mt5/paper.js';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + '\n    ' + (e?.stack || e)); }
}

/** FakeBridge：与 exchange-mt5.test.js 相同的结构，价格可编程驱动。 */
class FakeBridge extends EventEmitter {
  constructor() {
    super();
    this.symbols = { XAUUSD: { name: 'XAUUSD', digits: 2, point: 0.01, volume_min: 0.01, volume_step: 0.01, spread: 20, trade_tick_size: 0.01 } };
    this.price = { bid: 2400.00, ask: 2400.20 };
    this.orders = [];
    this.positions = [];
  }
  async call(method, params = {}) {
    if (method === 'get_symbols') return [this.symbols[params.symbols[0]]].filter(Boolean);
    if (method === 'get_price') return { bid: this.price.bid, ask: this.price.ask };
    if (method === 'get_candles') return { candles: makeCandles(200, (this.price.bid + this.price.ask) / 2) };
    if (method === 'get_account') return { login: 12345678, server: 'Fake', balance: 10000, equity: 10000, leverage: 100 };
    if (method === 'open_orders') return this.orders;
    if (method === 'positions') return this.positions;
    if (method === 'place_limit') {
      const o = { ticket: 1000 + this.orders.length + 1, symbol: params.symbol, type: params.side === 'buy' ? 2 : 3, price_open: params.price, volume_current: params.volume, volume_initial: params.volume, magic: params.magic || 0, sl: params.sl || 0, tp: params.tp || 0, comment: params.comment || '' };
      this.orders.push(o);
      return { ok: true, ticket: o.ticket, retcode: 10009 };
    }
    if (method === 'cancel') { this.orders = this.orders.filter((o) => o.ticket !== Number(params.ticket)); return { ok: true }; }
    if (method === 'cancel_all') { this.orders = this.orders.filter((o) => o.symbol !== params.symbol); return { ok: true, cancelled: 0, errors: [] }; }
    if (method === 'close_position') { this.positions = []; return { ok: true, closed: 0, errors: [] }; }
    throw new Error('unknown method: ' + method);
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
  return new PaperMt5({ bridge, symbol: 'XAUUSD', startBalance: 10000, pollMs: 1000, magic: 42 });
}

async function startBot(ex, opts = {}) {
  const bot = new GridBot(ex, { cancelVerifyAttempts: 2, cancelVerifyDelayMs: 0, cancelVerifyStableReads: 2 });
  await ex.bridge.setPrice(opts.priceBid ?? 2400.00, opts.priceAsk ?? 2400.20);
  await bot.start({
    marketId: 1, mode: 'neutral',
    lower: opts.lower ?? 2350, upper: opts.upper ?? 2450,
    gridCount: 10, sizeBase: 0.1, leverage: 10,
    outOfRangeAction: opts.oorAction ?? 'close',
  });
  return bot;
}

console.log('GridBot · 扩展流程');

await test('adjustRange 不停机调整区间并重挂', async () => {
  const bridge = new FakeBridge();
  const ex = makeEx(bridge);
  await ex.init(); ex.stop();
  const bot = await startBot(ex);
  const before = bot.active.size;
  const beforePrice = bot.lastPrice;

  const r = await bot.adjustRange({ lower: beforePrice - 15, upper: beforePrice + 15 });
  assert.equal(r.running, true, '调整后仍在运行');
  assert.equal(r.config.lower, beforePrice - 15);
  assert.equal(r.config.upper, beforePrice + 15);
  assert.ok(r.openOrders > 0, '重挂出订单');
  // 区间 [p-15, p+15]，价格在中间 -> 应该有买卖双侧挂单
  assert.ok(r.openOrders >= 6, `新区间挂单 ${r.openOrders}`);
  await bot.stop({ closePosition: false });
  bot._stopReconcileTimer();
});

await test('adjustRange 区间偏离现价过大时拒绝', async () => {
  const bridge = new FakeBridge();
  const ex = makeEx(bridge);
  await ex.init(); ex.stop();
  const bot = await startBot(ex);
  await assert.rejects(() => bot.adjustRange({ lower: 100, upper: 200 }), /偏离过大/);
  assert.equal(bot.running, true);
  bot._stopReconcileTimer();
});

await test('refillGrid 只补空格位，已占格位跳过', async () => {
  const bridge = new FakeBridge();
  const ex = makeEx(bridge);
  await ex.init(); ex.stop();
  const bot = await startBot(ex);
  const occupied = bot.active.size;

  // 手动清掉几个挂单（模拟成交后未替换）
  const ids = [...bot.active.keys()].slice(0, 3);
  for (const id of ids) bot.active.delete(id);
  const beforeRefill = bot.active.size;

  const r = await bot.refillGrid();
  assert.ok(r.openOrders > beforeRefill, '补格后挂单数增加');
  // 空格位是 3 个，但补格后不应超过原始占用 + 3
  assert.ok(r.openOrders <= occupied, `补格后 ${r.openOrders} <= 原占用 ${occupied}`);
  await bot.stop({ closePosition: false });
  bot._stopReconcileTimer();
});

await test('resetStats 清零统计并以当前权益为新基准', async () => {
  const bridge = new FakeBridge();
  const ex = makeEx(bridge);
  await ex.init(); ex.stop();
  const bot = await startBot(ex);
  // 制造一些成交
  await bridge.setPrice(2388.70, 2388.90);
  await ex._tick();
  assert.ok(bot.stats.buys >= 1);
  await bot.resetStats();
  assert.equal(bot.stats.buys, 0);
  assert.equal(bot.stats.sells, 0);
  assert.equal(bot.stats.completedRungs, 0);
  assert.equal(bot.stats.gridProfit, 0);
  assert.equal(bot.stats.volume, 0);
  await bot.stop({ closePosition: true });
  bot._stopReconcileTimer();
});

await test('startRecovery 对未托管持仓挂只减仓阶梯', async () => {
  const bridge = new FakeBridge();
  const ex = makeEx(bridge);
  await ex.init(); ex.stop();
  // 模拟一笔已存在持仓（多单 0.5）
  await ex.placeLimitOrder({ marketId: 1, side: 'buy', price: 2400, sizeBase: 0.5, levelIndex: 3 });
  await bridge.setPrice(2399.70, 2399.90);
  await ex._tick();
  assert.ok(ex.getPosition(1), '应持有多头');
  await bridge.setPrice(2400.00, 2400.20);
  const bot = new GridBot(ex, { cancelVerifyAttempts: 2, cancelVerifyDelayMs: 0, cancelVerifyStableReads: 2 });
  const r = await bot.startRecovery({ marketId: 1, spacing: 5, sizeBase: 0.1, aboveEntryOnly: false });
  assert.equal(r.running, true);
  assert.equal(r.recovery, true);
  assert.equal(r.config.mode, 'recovery');
  // 现价 2400.10，多头 -> 上方挂 reduce-only 卖单
  await new Promise((res) => setTimeout(res, 50)); // 等异步 _place 完成
  assert.ok(bot.active.size >= 2, `回收阶梯 ${bot.active.size} 单`);
  // 全部为卖出 recovery（reduce-only 标志在适配器订单里）
  for (const o of bot.active.values()) {
    assert.equal(o.side, 'sell');
    assert.equal(o.recovery, true, '阶梯单应标记 recovery');
  }
  // 适配器侧订单带 reduceOnly
  const exOrders = [...ex.orders.values()];
  assert.ok(exOrders.length >= 2, `适配器订单 ${exOrders.length}`);
  for (const o of exOrders) assert.equal(o.reduceOnly, true);
  await bot.stop({ closePosition: false });
  bot._stopReconcileTimer();
});

await test('startRecovery 无持仓时拒绝', async () => {
  const bridge = new FakeBridge();
  const ex = makeEx(bridge);
  await ex.init(); ex.stop();
  const bot = new GridBot(ex, { cancelVerifyAttempts: 2, cancelVerifyDelayMs: 0, cancelVerifyStableReads: 2 });
  await assert.rejects(() => bot.startRecovery({ marketId: 1 }), /没有持仓/);
  bot._stopReconcileTimer();
});

await test('价格跌破下边界触发 outOfRangeAction=close 自动停止', async () => {
  const bridge = new FakeBridge();
  const ex = makeEx(bridge);
  await ex.init(); ex.stop();
  const bot = await startBot(ex, { lower: 2350, upper: 2450 });
  // 直接跌破下边界
  await bridge.setPrice(2300.00, 2300.20);
  await ex._tick();
  // 等待自动停止流程完成（平仓确认轮询，最长 8s）
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(bot.outOfRange, true);
  await new Promise((r) => setTimeout(r, 3000));
  assert.equal(bot.running, false, '冲破区间后应自动停止');
  bot._stopReconcileTimer();
});

await test('价格跌破下边界 + outOfRangeAction=recover 挂只减仓回收阶梯', async () => {
  const bridge = new FakeBridge();
  const ex = makeEx(bridge);
  await ex.init(); ex.stop();
  // 先持有多头
  await ex.placeLimitOrder({ marketId: 1, side: 'buy', price: 2400, sizeBase: 0.1, levelIndex: 3 });
  await bridge.setPrice(2399.70, 2399.90);
  await ex._tick();
  assert.ok(ex.getPosition(1), '应持有多头');

  const bot = await startBot(ex, { lower: 2350, upper: 2450, oorAction: 'recover' });
  // 跌破下边界（远离边界，确保触发阶梯）
  await bridge.setPrice(2300.00, 2300.20);
  await ex._tick();
  await new Promise((res) => setTimeout(res, 100)); // 等异步 _place 完成
  assert.equal(bot.outOfRange, true);
  // recover 模式不停止，而是挂 reduce-only 卖单
  assert.equal(bot.running, true, 'recover 模式不停止');
  const recoveryOrders = [...bot.active.values()].filter((o) => o.recovery);
  assert.ok(recoveryOrders.length >= 1, `回收阶梯 ${recoveryOrders.length} 单`);
  for (const o of recoveryOrders) {
    assert.equal(o.side, 'sell');
  }
  await bot.stop({ closePosition: true });
  bot._stopReconcileTimer();
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
