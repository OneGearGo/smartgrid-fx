import assert from 'node:assert/strict';
import { dashboardExchangeState } from '../src/overview.js';

{
  const source = { running: true, stats: { completedRungs: 223 }, fills: [{ orderId: '1' }] };
  const state = dashboardExchangeState(source, 'live');
  assert.equal(state.completedRungs, 223);
  assert.equal(state.mode, 'live');
  assert.equal(state.stats, source.stats, 'the complete control-panel state must be preserved');
  assert.equal(state.fills, source.fills);
}

{
  assert.equal(dashboardExchangeState({ stats: { completedRungs: 0 } }, 'paper').completedRungs, 0);
  assert.equal(dashboardExchangeState({ stats: {} }, 'live').completedRungs, 0);
  assert.equal(dashboardExchangeState({}, 'live').completedRungs, 0);
}

console.log('overview tests passed');
