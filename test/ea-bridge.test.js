// EA 桥协议自测：模拟 EA 客户端（Node fetch）验证全链路
//   /state 上报 -> 缓存更新
//   /cmd   拉取命令 -> 模拟执行 -> /result 回报 -> call() 的 Promise resolve
import assert from 'node:assert/strict';
import { EaBridgeServer } from '../src/exchange/mt5/ea_bridge.js';

let passed = 0, failed = 0;
let portSeq = 8399;
const nextPort = () => portSeq++;

async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + '\n    ' + (e?.stack || e)); }
}

/** 创建独立端口的桥实例（每个测试独立端口，避免 TIME_WAIT 冲突）。 */
function makeServer(symbols) {
  return new EaBridgeServer({ port: nextPort(), symbols: symbols || ['XAUUSD', 'EURUSD'] });
}

/** 模拟 EA 上报 /state。 */
async function postState(srv, overrides = {}) {
  const body = JSON.stringify({
    account: { login: 12345678, server: 'Fake-Demo', balance: 10000, equity: 10050, margin: 100, margin_free: 9900, leverage: 100, trade_mode: 0 },
    prices: overrides.prices || [
      { symbol: 'XAUUSD', bid: 2400.0, ask: 2400.2, time: Date.now() },
      { symbol: 'EURUSD', bid: 1.0850, ask: 1.0852, time: Date.now() },
    ],
    orders: overrides.orders || [],
    positions: overrides.positions || [],
    ts: Math.floor(Date.now() / 1000),
  });
  const r = await fetch(`http://127.0.0.1:${srv.port}/state`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  assert.equal(r.status, 200);
}

/** 模拟 EA 拉一条命令。 */
async function pollCmd(srv) {
  const r = await fetch(`http://127.0.0.1:${srv.port}/cmd`);
  return (await r.text()).trim();
}

/** 模拟 EA 回报命令结果。 */
async function postResult(srv, body) {
  const r = await fetch(`http://127.0.0.1:${srv.port}/result`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(r.status, 200);
}

console.log('EaBridgeServer · 协议');

await test('/state 上报后缓存可读', async () => {
  const srv = makeServer();
  srv.start();
  await postState(srv);
  assert.equal(srv.connected, true);
  assert.equal(srv.account.login, 12345678);
  const px = await srv.call('get_price', { symbol: 'XAUUSD' });
  assert.equal(px.bid, 2400.0);
  assert.equal(px.ask, 2400.2);
  const acct = await srv.call('get_account');
  assert.equal(acct.balance, 10000);
  await srv.stop();
});

await test('挂单命令经 /cmd->/result 全链路', async () => {
  const srv = makeServer();
  srv.start();
  const placePromise = srv.call('place_limit', { symbol: 'XAUUSD', side: 'buy', price: 2390, volume: 0.1, magic: 30001 });
  const cmd = await pollCmd(srv);
  assert.ok(cmd.startsWith('PLACE|XAUUSD|buy|2390|0.1|30001|GRID|0|0'), '命令格式: ' + cmd);
  await postResult(srv, { ok: true, ticket: '98765', retcode: 10009, price: 2390, volume: 0.1 });
  const placed = await placePromise;
  assert.equal(placed.ticket, '98765');
  await srv.stop();
});

await test('撤单命令全链路', async () => {
  const srv = makeServer();
  srv.start();
  const cancelPromise = srv.call('cancel', { symbol: 'XAUUSD', ticket: '98765' });
  const cmd = await pollCmd(srv);
  assert.ok(cmd.startsWith('CANCEL|XAUUSD|98765'), '命令: ' + cmd);
  await postResult(srv, { ok: true, ticket: '98765' });
  const r2 = await cancelPromise;
  assert.equal(r2.ok, true);
  await srv.stop();
});

await test('K线命令返回蜡烛数据', async () => {
  const srv = makeServer();
  srv.start();
  const cdlPromise = srv.call('get_candles', { symbol: 'XAUUSD', intervalSec: 3600, n: 50 });
  const cmd = await pollCmd(srv);
  assert.ok(cmd.startsWith('GET_CANDLES|XAUUSD|3600|50'), '命令: ' + cmd);
  const candles = [{ time: 1, open: 100, high: 101, low: 99, close: 100.5, volume: 10 }];
  await postResult(srv, { ok: true, symbol: 'XAUUSD', candles });
  const got = await cdlPromise;
  assert.equal(got.candles.length, 1);
  assert.equal(got.candles[0].close, 100.5);
  await srv.stop();
});

await test('EA 执行失败 -> call 拒绝', async () => {
  const srv = makeServer();
  srv.start();
  const placePromise = srv.call('place_limit', { symbol: 'XAUUSD', side: 'buy', price: 2390, volume: 0.1, magic: 30001 });
  // 先挂上 catch，避免 rejection 变 unhandled
  const catcher = placePromise.then(() => null, (e) => e);
  await pollCmd(srv);
  await postResult(srv, { ok: false, error: 'retcode 10027 交易被禁用' });
  const err = await catcher;
  assert.ok(err, '应拒绝');
  assert.ok(err.message.includes('10027'));
  await srv.stop();
});

await test('无命令时 /cmd 返回 NONE', async () => {
  const srv = makeServer();
  srv.start();
  const cmd = await pollCmd(srv);
  assert.equal(cmd, 'NONE');
  await srv.stop();
});

await test('health 接口', async () => {
  const srv = makeServer();
  srv.start();
  const r = await fetch(`http://127.0.0.1:${srv.port}/health`);
  const j = await r.json();
  assert.equal(j.ok, true);
  await srv.stop();
});

await test('挂单成功后 EA 上报订单出现在 open_orders', async () => {
  const srv = makeServer();
  srv.start();
  // 模拟 EA 执行挂单后，下一次 /state 带上这笔订单
  await postState(srv, {
    orders: [{ ticket: '98765', symbol: 'XAUUSD', type: 2, price_open: 2390, volume: '0.10', volume_initial: '0.10', magic: 30001, comment: 'GRID', sl: 0, tp: 0 }],
  });
  const orders = await srv.call('open_orders', { magic: 30001 });
  assert.equal(orders.length, 1);
  assert.equal(orders[0].ticket, '98765');
  const filtered = await srv.call('open_orders', { magic: 99999 });
  assert.equal(filtered.length, 0, '不同 magic 应过滤');
  await srv.stop();
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
