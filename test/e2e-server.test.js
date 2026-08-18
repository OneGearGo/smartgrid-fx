// 服务器 E2E 测试：启动真实 server（合成行情模式）-> 验证 5 槽位 API 全链路。
// 需要端口空闲（默认 8284 测试端口）；不依赖真实 MT5 终端（桥离线自动合成行情）。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, '..', 'src', 'server.js');
const PORT = 8284;
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + '\n    ' + (e?.stack || e)); }
}

const post = (url, body) => fetch(BASE + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then((r) => r.json());
const get = (url) => fetch(BASE + url).then((r) => r.json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 启动服务器（禁用浏览器/不阻塞）
const server = spawn('node', [SERVER], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });

// 等待服务器就绪（最多 15s）
async function waitReady() {
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(BASE + '/api/overview', { signal: AbortSignal.timeout(3000) });
      if (r.ok) return true;
    } catch { /* not ready */ }
    await sleep(500);
  }
  console.error('服务器未就绪，日志：\n' + serverLog.slice(-2000));
  return false;
}

const ready = await waitReady();
if (!ready) {
  console.error('SERVER FAILED TO START');
  try { server.kill(); } catch { /* ignore */ }
  process.exit(1);
}

console.log('E2E · 服务器 API');

await test('overview 返回 5 槽位', async () => {
  const j = await get('/api/overview');
  const keys = Object.keys(j);
  assert.deepEqual(keys, ['eur', 'gbp', 'jpy', 'xau', 'nas']);
  for (const k of keys) assert.equal(j[k].mode, 'paper');
});

await test('各槽位 markets 返回品种规格', async () => {
  const expected = { eur: 'EURUSD', gbp: 'GBPUSD', jpy: 'USDJPY', xau: 'XAUUSD', nas: 'NAS100' };
  for (const [key, sym] of Object.entries(expected)) {
    const j = await get(`/api/${key}/markets`);
    assert.equal(j.markets[0].displayName, sym, `${key} 品种应为 ${sym}`);
    assert.ok(j.markets[0].minOrderSize > 0);
  }
});

await test('xau trend 返回趋势分析', async () => {
  const j = await get('/api/xau/trend?marketId=1&intervalSec=3600');
  assert.ok(['up', 'down', 'range'].includes(j.analysis?.trend));
  assert.ok(['long', 'short', 'neutral'].includes(j.analysis?.recommended));
  assert.ok(Array.isArray(j.candles) && j.candles.length > 0);
});

await test('xau 启动网格 -> 状态 -> 停止', async () => {
  const mk = await get('/api/xau/markets');
  const price = mk.markets[0]?.lastPrice || 2400;
  const lower = Math.round((price - 20) * 100) / 100;
  const upper = Math.round((price + 20) * 100) / 100;
  const start = await post('/api/xau/start', {
    marketId: 1, mode: 'neutral', lower, upper,
    gridCount: 10, sizeBase: 0.1, leverage: 10, outOfRangeAction: 'close',
  });
  assert.equal(start.error, undefined, 'start 不应报错: ' + start.error);
  assert.equal(start.running, true);
  assert.ok(start.openOrders >= 8, `挂单数 ${start.openOrders}`);

  const st = await get('/api/xau/state');
  assert.equal(st.running, true);
  assert.ok(st.lastPrice > 0, '应有价格');

  const stop = await post('/api/xau/stop', { closePosition: true });
  assert.equal(stop.running, false);
  assert.equal(stop.openOrders, 0);
});

await test('其他槽位也能启动/停止（eur）', async () => {
  const mk = await get('/api/eur/markets');
  const price = mk.markets[0]?.lastPrice || 1.08;
  const lower = price - 0.02, upper = price + 0.02;
  const start = await post('/api/eur/start', {
    marketId: 1, mode: 'neutral', lower, upper,
    gridCount: 8, sizeBase: 0.01, leverage: 10, outOfRangeAction: 'close',
  });
  assert.equal(start.error, undefined, 'eur start 不应报错: ' + start.error);
  assert.equal(start.running, true);
  await post('/api/eur/stop', { closePosition: true });
});

await test('静态首页返回 HTML', async () => {
  const r = await fetch(BASE + '/');
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.ok(html.includes('外汇网格交易'), '首页应含标题');
  assert.ok(html.includes('EURUSD') && html.includes('NAS100'), '首页应含 5 品种');
});

try { server.kill(); } catch { /* ignore */ }
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
