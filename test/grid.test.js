// 核心纯函数测试：网格数学（src/grid.js）+ 代理工具（src/proxy.js）
// Run with: npm test
import assert from 'node:assert/strict';
import { buildGrid, seedOrders, replacementFor, isReduceOnly, rungProfit } from '../src/grid.js';
import { normalizeProxy, selectWinInetProxy } from '../src/proxy.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + '\n    ' + (e?.message || e)); }
}

console.log('grid.js');

test('buildGrid: levels/spacing/count', () => {
  const g = buildGrid({ lower: 100, upper: 200, gridCount: 10 });
  assert.equal(g.count, 10);
  assert.equal(g.spacing, 10);
  assert.equal(g.levels.length, 11);
  assert.equal(g.levels[0], 100);
  assert.equal(g.levels[10], 200);
});

test('buildGrid: rejects bad input', () => {
  assert.throws(() => buildGrid({ lower: 200, upper: 100, gridCount: 10 }));
  assert.throws(() => buildGrid({ lower: 100, upper: 200, gridCount: 1 }));
});

test('buildGrid: float spacing is rounded sanely', () => {
  const g = buildGrid({ lower: 0.1, upper: 0.4, gridCount: 3 });
  assert.equal(g.spacing, 0.1);
  assert.equal(g.levels[1], 0.2);
});

test('seedOrders neutral: buys below, sells above, skip band near price', () => {
  const g = buildGrid({ lower: 100, upper: 200, gridCount: 10 });
  const orders = seedOrders({ levels: g.levels, price: 151, mode: 'neutral', spacing: g.spacing });
  for (const o of orders) {
    if (o.price < 151) assert.equal(o.side, 'buy');
    else assert.equal(o.side, 'sell');
    assert.equal(o.reduceOnly, false);
  }
  // 150 is within 0.25*spacing(=2.5) of 151 -> skipped
  assert.ok(!orders.some((o) => o.price === 150));
  assert.ok(orders.some((o) => o.price === 140));
  assert.ok(orders.some((o) => o.price === 160));
});

test('seedOrders long: only buys, none reduce-only', () => {
  const g = buildGrid({ lower: 100, upper: 200, gridCount: 10 });
  const orders = seedOrders({ levels: g.levels, price: 150, mode: 'long', spacing: g.spacing });
  assert.ok(orders.length > 0);
  assert.ok(orders.every((o) => o.side === 'buy' && o.price < 150 && !o.reduceOnly));
});

test('seedOrders short: only sells, none reduce-only', () => {
  const g = buildGrid({ lower: 100, upper: 200, gridCount: 10 });
  const orders = seedOrders({ levels: g.levels, price: 150, mode: 'short', spacing: g.spacing });
  assert.ok(orders.length > 0);
  assert.ok(orders.every((o) => o.side === 'sell' && o.price > 150 && !o.reduceOnly));
});

test('replacementFor: buy@i -> sell@i+1, sell@i -> buy@i-1, edges -> null', () => {
  const g = buildGrid({ lower: 100, upper: 200, gridCount: 10 });
  const r1 = replacementFor({ side: 'buy', levelIndex: 3 }, g.levels, 'neutral');
  assert.deepEqual({ side: r1.side, levelIndex: r1.levelIndex, price: r1.price }, { side: 'sell', levelIndex: 4, price: 140 });
  const r2 = replacementFor({ side: 'sell', levelIndex: 4 }, g.levels, 'neutral');
  assert.deepEqual({ side: r2.side, levelIndex: r2.levelIndex, price: r2.price }, { side: 'buy', levelIndex: 3, price: 130 });
  assert.equal(replacementFor({ side: 'buy', levelIndex: 10 }, g.levels, 'neutral'), null);
  assert.equal(replacementFor({ side: 'sell', levelIndex: 0 }, g.levels, 'neutral'), null);
});

test('replacementFor: long-mode sell replacement is reduce-only', () => {
  const g = buildGrid({ lower: 100, upper: 200, gridCount: 10 });
  const r = replacementFor({ side: 'buy', levelIndex: 3 }, g.levels, 'long');
  assert.equal(r.reduceOnly, true);
  const r2 = replacementFor({ side: 'sell', levelIndex: 4 }, g.levels, 'short');
  assert.equal(r2.reduceOnly, true);
});

test('isReduceOnly matrix', () => {
  assert.equal(isReduceOnly('sell', 'long'), true);
  assert.equal(isReduceOnly('buy', 'long'), false);
  assert.equal(isReduceOnly('buy', 'short'), true);
  assert.equal(isReduceOnly('sell', 'short'), false);
  assert.equal(isReduceOnly('buy', 'neutral'), false);
  assert.equal(isReduceOnly('sell', 'neutral'), false);
});

test('rungProfit', () => {
  assert.equal(rungProfit(10, 0.5), 5);
});

console.log('proxy.js');

test('normalizeProxy formats', () => {
  assert.equal(normalizeProxy('127.0.0.1:7890'), 'http://127.0.0.1:7890');
  assert.equal(normalizeProxy('host:1080:user:pass'), 'socks5://user:pass@host:1080');
  assert.equal(normalizeProxy('socks5://u:p@h:1080'), 'socks5://u:p@h:1080');
});

test('selectWinInetProxy prefers HTTPS and ignores unsupported protocol-only entries', () => {
  assert.equal(selectWinInetProxy('proxy.example:8080'), 'proxy.example:8080');
  assert.equal(selectWinInetProxy('http=plain.example:80;https=secure.example:443'), 'secure.example:443');
  assert.equal(selectWinInetProxy('ftp=ftp.example:21'), '');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
