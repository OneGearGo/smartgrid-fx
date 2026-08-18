// 桥客户端生命周期测试：进程启动、请求响应、崩溃自动重启
// 用真实 mt5_bridge.py（协议层不依赖终端连接——ping 永远能响应）。
import assert from 'node:assert/strict';
import { Mt5BridgeClient } from '../src/exchange/mt5/bridge.js';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + '\n    ' + (e?.stack || e)); }
}

console.log('Mt5BridgeClient · 生命周期');

await test('启动后 ping 正常响应', async () => {
  const c = new Mt5BridgeClient({ terminalPath: 'F:\\MT5\\terminal64.exe' });
  c.start();
  await new Promise((r) => setTimeout(r, 500));
  const p = await c.call('ping', {}, 8000).catch((e) => 'ERR:' + e.message);
  assert.equal(p?.pong, true, 'ping 应返回 pong，实际: ' + JSON.stringify(p));
  c.stop();
});

await test('未知方法返回错误但不崩溃', async () => {
  const c = new Mt5BridgeClient({ terminalPath: 'F:\\MT5\\terminal64.exe' });
  c.start();
  await new Promise((r) => setTimeout(r, 500));
  const r = await c.call('no_such_method', {}, 8000).catch((e) => 'ERR:' + e.message);
  assert.ok(String(r).includes('未知方法'), '应返回未知方法错误，实际: ' + JSON.stringify(r));
  c.stop();
});

await test('桥进程崩溃后自动重启并恢复服务', async () => {
  const c = new Mt5BridgeClient({ terminalPath: 'F:\\MT5\\terminal64.exe' });
  c.start();
  await new Promise((r) => setTimeout(r, 500));
  const p1 = await c.call('ping', {}, 8000).catch((e) => 'ERR:' + e.message);
  assert.equal(p1?.pong, true, '第一次 ping OK');
  // 直接杀掉子进程（模拟崩溃）
  try { c.child.kill('SIGKILL'); } catch { /* ignore */ }
  // 等自动重启（_scheduleRestart 3s）
  await new Promise((r) => setTimeout(r, 4500));
  assert.ok(c.child, '应已自动重启子进程');
  const p2 = await c.call('ping', {}, 10000).catch((e) => 'ERR:' + e.message);
  assert.equal(p2?.pong, true, '重启后 ping 应恢复，实际: ' + JSON.stringify(p2));
  c.stop();
});

await test('stop 后不再自动重启', async () => {
  const c = new Mt5BridgeClient({ terminalPath: 'F:\\MT5\\terminal64.exe' });
  c.start();
  await new Promise((r) => setTimeout(r, 400));
  c.stop();
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(c.child, null, 'stop 后子进程应为 null');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
