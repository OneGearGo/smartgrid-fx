// EA 桥 + PaperMt5 适配器集成测试：模拟 EA 上报行情 -> 适配器取价 -> GridBot 全流程。
// 验证 EA 桥模式（MT5_BRIDGE=ea）下适配器正常工作，不依赖真实 MT5 终端。
import assert from 'node:assert/strict';
import { EaBridgeServer } from '../src/exchange/mt5/ea_bridge.js';
import { PaperMt5 } from '../src/exchange/mt5/paper.js';
import { LiveMt5 } from '../src/exchange/mt5/mt5.js';
import { GridBot } from '../src/bot.js';

let passed = 0, failed = 0;
let portSeq = 8500;
const nextPort = () => portSeq++;

async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + '\n    ' + (e?.stack || e)); }
}

/** 模拟 EA：向桥上报行情/订单/持仓。 */
async function eaReport(srv, { bid = 2400.0, ask = 2400.2, orders = [], positions = [] } = {}) {
  const body = JSON.stringify({
    account: { login: 12345678, server: 'Fake-Demo', balance: 10000, equity: 10050, margin: 0, margin_free: 10050, leverage: 100, trade_mode: 0 },
    prices: [
      { symbol: 'XAUUSD', bid, ask, contract_size: 100, time: Date.now() },
      { symbol: 'EURUSD', bid: 1.0850, ask: 1.0852, contract_size: 100000, time: Date.now() },
    ],
    orders,
    positions,
    ts: Math.floor(Date.now() / 1000),
  });
  const r = await fetch(`http://127.0.0.1:${srv.port}/state`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  assert.equal(r.status, 200);
}

console.log('EA 桥 + PaperMt5 · 集成');

await test('EA 上报行情后 paper 适配器取到真实价格', async () => {
  const srv = new EaBridgeServer({ port: nextPort(), symbols: ['XAUUSD', 'EURUSD'] });
  srv.start();
  const ex = new PaperMt5({ bridge: srv, symbol: 'XAUUSD', startBalance: 10000, pollMs: 1000, magic: 30001 });
  await ex.init();
  ex.stop(); // 关轮询，手动驱动
  await eaReport(srv, { bid: 2399.5, ask: 2399.7 });
  const px = await ex.getPrice(1);
  assert.ok(px > 2399, '应取到 EA 上报的价格: ' + px);
  assert.equal(ex.dataSource, 'real', '有 EA 上报应为真实行情');
  await srv.stop();
});

await test('EA 上报订单 -> live 适配器 fetchOpenOrders', async () => {
  const srv = new EaBridgeServer({ port: nextPort() });
  srv.start();
  const ex = new LiveMt5({ bridge: srv, symbol: 'XAUUSD', startBalance: 10000, pollMs: 1000, magic: 30001 });
  await ex.init();
  ex.stop();
  await eaReport(srv, {
    orders: [{ ticket: '555', symbol: 'XAUUSD', type: 2, price_open: 2390, volume: '0.10', volume_initial: '0.10', magic: 30001, comment: 'GRID' }],
  });
  const open = await ex.fetchOpenOrders(1);
  assert.equal(open.length, 1);
  assert.equal(open[0].orderId, '555');
  assert.equal(open[0].side, 'buy'); // type 2 = BUY_LIMIT
  await srv.stop();
});

await test('EA 桥模式 GridBot 启动 -> 成交 -> 替换全流程', async () => {
  const srv = new EaBridgeServer({ port: nextPort() });
  srv.start();
  const ex = new PaperMt5({ bridge: srv, symbol: 'XAUUSD', startBalance: 10000, pollMs: 1000, magic: 30001 });
  await ex.init();
  ex.stop();
  await eaReport(srv, { bid: 2400.0, ask: 2400.2 });

  const bot = new GridBot(ex, { cancelVerifyAttempts: 2, cancelVerifyDelayMs: 0, cancelVerifyStableReads: 2 });
  await bot.start({ marketId: 1, mode: 'neutral', lower: 2350, upper: 2450, gridCount: 10, sizeBase: 0.01, leverage: 100, outOfRangeAction: 'close' });
  assert.equal(bot.running, true);
  assert.ok(bot.active.size >= 8, `挂单 ${bot.active.size}`);
  assert.ok(bot.lastPrice > 0, '应有价格');

  // EA 行情下跌到触及买单
  await eaReport(srv, { bid: 2388.7, ask: 2388.9 });
  await ex._tick();
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(bot.stats.buys >= 1, 'EA 行情驱动成交');
  assert.ok(ex.getPosition(1), '应持有多头');

  await bot.stop({ closePosition: true });
  assert.equal(bot.running, false);
  await srv.stop();
});

await test('EA 上报持仓 -> live 适配器 getPosition', async () => {
  const srv = new EaBridgeServer({ port: nextPort() });
  srv.start();
  const ex = new LiveMt5({ bridge: srv, symbol: 'XAUUSD', startBalance: 10000, pollMs: 1000, magic: 30001 });
  await ex.init();
  ex.stop();
  await eaReport(srv, {
    positions: [{ ticket: '777', symbol: 'XAUUSD', type: 0, volume: '0.10', price_open: 2400, sl: 0, tp: 0, profit: 12.5, swap: -0.1, magic: 30001 }],
  });
  await ex._tick(); // 触发 _syncPositions
  const pos = ex.getPosition(1);
  assert.ok(pos, '应有持仓');
  assert.equal(pos.sizeBase, 0.1);
  assert.ok(pos.unrealizedPnl > 0, '盈亏应为正: ' + pos.unrealizedPnl);
  await srv.stop();
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
