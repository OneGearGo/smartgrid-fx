// MT5 适配器集成测试：FakeBridge 驱动，验证 paper 撮合逻辑 + GridBot 全流程。
// 不依赖真实 MT5 终端（终端可能被回测占用）；行情由 FakeBridge 编程驱动。
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { GridBot } from '../src/bot.js';
import { PaperMt5 } from '../src/exchange/mt5/paper.js';
import { LiveMt5 } from '../src/exchange/mt5/mt5.js';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + '\n    ' + (e?.stack || e)); }
}

/** FakeBridge：模拟 MT5 桥。价格由测试设置；订单/持仓本地模拟。 */
class FakeBridge extends EventEmitter {
  constructor() {
    super();
    this.symbols = {
      XAUUSD: { name: 'XAUUSD', digits: 2, point: 0.01, volume_min: 0.01, volume_step: 0.01, spread: 20, trade_tick_size: 0.01 },
      EURUSD: { name: 'EURUSD', digits: 5, point: 0.00001, volume_min: 0.01, volume_step: 0.01, spread: 8, trade_tick_size: 0.00001 },
    };
    this.price = { bid: 2400.00, ask: 2400.20 };
    this.orders = [];
    this.positions = [];
    this.calls = [];
  }
  async call(method, params = {}) {
    this.calls.push(method);
    if (method === 'get_symbols') return [this.symbols[params.symbols[0]]].filter(Boolean);
    if (method === 'get_price') return { bid: this.price.bid, ask: this.price.ask };
    if (method === 'get_candles') return { candles: makeCandles(200, (this.price.bid + this.price.ask) / 2) };
    if (method === 'get_account') return { login: 61564223, server: 'Fake', balance: 10000, equity: 10000, leverage: 100 };
    if (method === 'open_orders') return this.orders.filter((o) => !params.magic || o.magic === params.magic);
    if (method === 'positions') return this.positions;
    if (method === 'place_limit') {
      const o = { ticket: 1000 + this.orders.length + 1, symbol: params.symbol, type: params.side === 'buy' ? 2 : 3, price_open: params.price, volume_current: params.volume, volume_initial: params.volume, magic: params.magic || 0, sl: params.sl || 0, tp: params.tp || 0, comment: params.comment || '' };
      this.orders.push(o);
      return { ok: true, ticket: o.ticket, retcode: 10009 };
    }
    if (method === 'cancel') {
      this.orders = this.orders.filter((o) => o.ticket !== Number(params.ticket));
      return { ok: true };
    }
    if (method === 'cancel_all') {
      this.orders = this.orders.filter((o) => o.symbol !== params.symbol);
      return { ok: true, cancelled: 0, errors: [] };
    }
    if (method === 'close_position') {
      this.positions = [];
      return { ok: true, closed: 0, errors: [] };
    }
    throw new Error('unknown method: ' + method);
  }
  /** 测试辅助：直接设置价格并推动适配器撮合。 */
  async setPrice(bid, ask) {
    this.price = { bid, ask };
  }
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

function makeAdapter(cls, bridge, opts = {}) {
  return new cls({
    bridge, symbol: opts.symbol || 'XAUUSD', startBalance: 10000,
    pollMs: 1000, magic: 42, ...opts,
  });
}

console.log('PaperMt5 · 撮合逻辑');

await test('paper place/fetch/cancel 订单生命周期', async () => {
  const bridge = new FakeBridge();
  const ex = makeAdapter(PaperMt5, bridge);
  await ex.init();
  ex.stop();
  const markets = await ex.getMarkets();
  assert.equal(markets.length, 1);
  assert.equal(markets[0].displayName, 'XAUUSD');

  const r = await ex.placeLimitOrder({ marketId: 1, side: 'buy', price: 2390, sizeBase: 0.1, levelIndex: 1 });
  assert.ok(r.orderId);
  let open = await ex.fetchOpenOrders(1);
  assert.equal(open.length, 1);
  await ex.cancelOrder(1, r.orderId);
  open = await ex.fetchOpenOrders(1);
  assert.equal(open.length, 0);
});

await test('paper 买单在 ask 触及挂单价时成交并 emit fill', async () => {
  const bridge = new FakeBridge();
  const ex = makeAdapter(PaperMt5, bridge);
  await ex.init();
  ex.stop();
  const fills = [];
  ex.on('fill', (f) => fills.push(f));
  await ex.placeLimitOrder({ marketId: 1, side: 'buy', price: 2400, sizeBase: 0.1, levelIndex: 3 });
  // 初始 ask=2400.20 未触及；压低 ask 到 2399.90 -> 穿越
  await bridge.setPrice(2399.70, 2399.90);
  await ex._tick();
  assert.equal(fills.length, 1);
  assert.equal(fills[0].side, 'buy');
  assert.equal(fills[0].levelIndex, 3);
  const pos = ex.getPosition(1);
  assert.ok(pos);
  assert.equal(pos.sizeBase, 0.1);
});

await test('paper 卖单在 bid 触及挂单价时成交', async () => {
  const bridge = new FakeBridge();
  const ex = makeAdapter(PaperMt5, bridge);
  await ex.init();
  ex.stop();
  const fills = [];
  ex.on('fill', (f) => fills.push(f));
  await ex.placeLimitOrder({ marketId: 1, side: 'sell', price: 2410, sizeBase: 0.1, levelIndex: 7 });
  await bridge.setPrice(2410.20, 2410.40);
  await ex._tick();
  assert.equal(fills.length, 1);
  assert.equal(fills[0].side, 'sell');
  const pos = ex.getPosition(1);
  assert.ok(pos);
  assert.equal(pos.sizeBase, -0.1); // 空头
});

await test('paper reduceOnly 买单在无空头持仓时不成交', async () => {
  const bridge = new FakeBridge();
  const ex = makeAdapter(PaperMt5, bridge);
  await ex.init();
  ex.stop();
  const fills = [];
  ex.on('fill', (f) => fills.push(f));
  await ex.placeLimitOrder({ marketId: 1, side: 'buy', price: 2400, sizeBase: 0.1, levelIndex: 3, reduceOnly: true });
  await bridge.setPrice(2399.70, 2399.90);
  await ex._tick();
  assert.equal(fills.length, 0);
  // 无多头持仓，reduceOnly 买单被丢弃
  const open = await ex.fetchOpenOrders(1);
  assert.equal(open.length, 0);
});

await test('paper 手续费计入盈亏', async () => {
  const bridge = new FakeBridge();
  const ex = makeAdapter(PaperMt5, bridge, { feeRate: 0.0005 });
  await ex.init();
  ex.stop();
  const bal0 = ex.balance;
  await ex.placeLimitOrder({ marketId: 1, side: 'buy', price: 2400, sizeBase: 0.1, levelIndex: 3 });
  await bridge.setPrice(2399.70, 2399.90);
  await ex._tick();
  // 成交后 balance = bal0 - fee(2399.90*0.1*0.0005=0.119995，fill 用触及价)
  assert.ok(Math.abs(ex.balance - (bal0 - 2399.90 * 0.1 * 0.0005)) < 1e-6, `balance=${ex.balance} expected=${bal0 - 2399.90 * 0.1 * 0.0005}`);
});

console.log('PaperMt5 + GridBot · 全流程（模拟撮合）');

await test('GridBot 启动 -> 成交 -> 自动替换 -> 停止/撤单', async () => {
  const bridge = new FakeBridge();
  const ex = makeAdapter(PaperMt5, bridge);
  await ex.init();
  ex.stop(); // 关掉轮询，测试里手动 tick
  const bot = new GridBot(ex, {
    cancelVerifyAttempts: 2, cancelVerifyDelayMs: 0, cancelVerifyStableReads: 2,
  });
  // 价格 2400.10，网格 [2350, 2450] 10 格 -> 间距 10
  await bridge.setPrice(2400.00, 2400.20);
  await bot.start({
    marketId: 1, mode: 'neutral', lower: 2350, upper: 2450,
    gridCount: 10, sizeBase: 0.1, leverage: 10,
  });
  assert.equal(bot.running, true);
  const nOrders = bot.active.size;
  assert.ok(nOrders >= 8, `启动挂单数 ${nOrders}`);
  assert.equal(bot.getState().openOrders, nOrders);

  // 价格下跌到 2389 -> 触及 2390 买单（level 4）
  await bridge.setPrice(2388.70, 2388.90);
  await ex._tick();
  // 等待替换单挂出
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(bot.stats.buys >= 1, '应有买单成交');
  assert.ok(bot.stats.completedRungs === 0, '买入还差卖出才完成一格');
  const pos = ex.getPosition(1);
  assert.ok(pos && pos.sizeBase > 0, '应持有多头');

  // 价格上涨 2390+10=2400 卖出替换单触及 -> 完成一格
  await bridge.setPrice(2400.30, 2400.50);
  await ex._tick();
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(bot.stats.completedRungs >= 1, '应完成至少一格');
  assert.ok(bot.stats.sells >= 1, '应有卖单成交');
  assert.ok(bot.stats.gridProfit > 0, `网格利润为正 ${bot.stats.gridProfit}`);

  // 停止（带平仓）：撤单 + 平仓
  await bot.stop({ closePosition: true });
  assert.equal(bot.running, false);
  assert.equal(bot.active.size, 0);
  const openAfter = await ex.fetchOpenOrders(1);
  assert.equal(openAfter.length, 0);
});

console.log('LiveMt5 · 真实订单走桥');

await test('live place/cancel 走桥并维护跟踪', async () => {
  const bridge = new FakeBridge();
  const ex = makeAdapter(LiveMt5, bridge);
  await ex.init();
  ex.stop();
  const r = await ex.placeLimitOrder({ marketId: 1, side: 'buy', price: 2390, sizeBase: 0.1, levelIndex: 1 });
  assert.ok(r.orderId);
  assert.ok(bridge.calls.includes('place_limit'));
  const open = await ex.fetchOpenOrders(1);
  assert.equal(open.length, 1);
  assert.equal(ex.orders.size, 1);
  await ex.cancelOrder(1, r.orderId);
  assert.equal(ex.orders.size, 0);
  const open2 = await ex.fetchOpenOrders(1);
  assert.equal(open2.length, 0);
});

await test('live 订单从交易所消失(非主动撤) -> emit fill', async () => {
  const bridge = new FakeBridge();
  const ex = makeAdapter(LiveMt5, bridge);
  await ex.init();
  ex.stop();
  const fills = [];
  ex.on('fill', (f) => fills.push(f));
  const r = await ex.placeLimitOrder({ marketId: 1, side: 'buy', price: 2390, sizeBase: 0.1, levelIndex: 1 });
  // 模拟：交易所上订单消失了（成交）
  bridge.orders = [];
  await ex._tick();
  assert.equal(fills.length, 1);
  assert.equal(fills[0].side, 'buy');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
