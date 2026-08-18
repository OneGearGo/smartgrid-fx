// 撤单安全测试：GridBot 的取消确认机制（用 FakeExchange 驱动）
// 原版中针对 Decibel/Extended/RISEx 的适配器跟踪测试已移除——
// 本项目的适配器跟踪测试在 Step 3 之后补上（test/exchange-mt5.test.js）。
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { GridBot } from '../src/bot.js';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + '\n    ' + (e?.stack || e)); }
}

class FakeExchange extends EventEmitter {
  constructor({ cancelResult = true, snapshots = null } = {}) {
    super();
    this.mode = 'paper';
    this.dataSource = 'real';
    this.balance = 10000;
    this.lastOkAt = Date.now();
    this.orders = [{ orderId: 'o-1', price: 90, side: 'buy' }];
    this.cancelResult = cancelResult;
    this.snapshots = snapshots;
    this.fetchCalls = 0;
    this.closeCalls = 0;
    this.forgot = false;
  }
  async cancelAll() {
    if (this.cancelResult === 'throw') throw new Error('cancel transport failed');
    if (this.cancelResult === true && !this.snapshots) this.orders = [];
    return this.cancelResult;
  }
  async fetchOpenOrders() {
    if (this.snapshots) {
      const i = Math.min(this.fetchCalls, this.snapshots.length - 1);
      this.fetchCalls++;
      const v = this.snapshots[i];
      if (v instanceof Error) throw v;
      return v;
    }
    this.fetchCalls++;
    return this.orders.map((o) => ({ ...o }));
  }
  forgetOrders() { this.forgot = true; }
  adoptOrder() {}
  start() {}
  getPosition() { return null; }
  async closePosition() { this.closeCalls++; return true; }
}

function runningBot(ex, attempts = 3) {
  const bot = new GridBot(ex, {
    cancelVerifyAttempts: attempts,
    cancelVerifyDelayMs: 0,
    cancelVerifyStableReads: 2,
  });
  bot.running = true;
  bot.config = {
    marketId: 1, displayName: 'TEST', mode: 'neutral',
    lower: 80, upper: 120, gridCount: 4, sizeBase: 1, leverage: 2,
  };
  bot.active.set('o-1', { levelIndex: 1, side: 'buy', price: 90, sizeBase: 1, opening: true });
  return bot;
}

console.log('cancel safety');

await test('stop aborts and preserves state when cancel request is rejected', async () => {
  const ex = new FakeExchange({ cancelResult: false });
  const bot = runningBot(ex);
  await assert.rejects(() => bot.stop({ closePosition: true }), /未接受撤单请求/);
  assert.equal(bot.running, true);
  assert.equal(bot.active.size, 1);
  assert.equal(ex.closeCalls, 0);
  bot._stopReconcileTimer();
});

await test('stop aborts when exchange still reports the order', async () => {
  const live = [{ orderId: 'o-1', price: 90, side: 'buy' }];
  const ex = new FakeExchange({ cancelResult: true, snapshots: [live, live, live] });
  const bot = runningBot(ex);
  await assert.rejects(() => bot.stop({ closePosition: true }), /仍检测到 1 笔/);
  assert.equal(bot.running, true);
  assert.equal(bot.active.size, 1);
  assert.equal(ex.closeCalls, 0);
  bot._stopReconcileTimer();
});

await test('one transient empty snapshot is not accepted as confirmation', async () => {
  const live = [{ orderId: 'o-1', price: 90, side: 'buy' }];
  const ex = new FakeExchange({ snapshots: [[], live, [], []] });
  const bot = runningBot(ex, 4);
  await bot._confirmOrdersGone(1);
  assert.equal(ex.fetchCalls, 4);
  bot._stopReconcileTimer();
});

await test('malformed snapshots are not treated as zero orders', async () => {
  const ex = new FakeExchange({ snapshots: [null, null, [], []] });
  const bot = runningBot(ex, 4);
  await bot._confirmOrdersGone(1);
  assert.equal(ex.fetchCalls, 4);
  bot._stopReconcileTimer();
});

await test('cancellation waits for an in-flight placement to settle', async () => {
  const ex = new FakeExchange({ cancelResult: true });
  const bot = runningBot(ex);
  bot._pendingLevels.add(2);
  setTimeout(() => bot._pendingLevels.delete(2), 5);
  await bot.stop({ closePosition: false });
  assert.equal(bot.running, false);
  assert.equal(ex.fetchCalls, 2);
});

await test('confirmed cancellation clears state and allows stop to finish', async () => {
  const ex = new FakeExchange({ cancelResult: true });
  const bot = runningBot(ex);
  await bot.stop({ closePosition: false });
  assert.equal(bot.running, false);
  assert.equal(bot.active.size, 0);
  assert.equal(ex.forgot, true);
  assert.equal(ex.fetchCalls, 2);
  assert.equal(ex.closeCalls, 0);
});

await test('market close is not sent when cancellation cannot be confirmed', async () => {
  const live = [{ orderId: 'o-1', price: 90, side: 'buy' }];
  const ex = new FakeExchange({ cancelResult: true, snapshots: [live, live, live] });
  const bot = runningBot(ex);
  await assert.rejects(() => bot.closePositionNow(1), /未能完成确认/);
  assert.equal(ex.closeCalls, 0);
  assert.equal(bot.active.size, 1);
  assert.equal(bot.running, true);
  bot._stopReconcileTimer();
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
