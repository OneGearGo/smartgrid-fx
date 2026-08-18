/**
 * Add the flattened metrics consumed by the overview while preserving the
 * complete exchange state needed by each control panel.
 */
export function dashboardExchangeState(state, mode) {
  const completedRungs = Number(state?.completedRungs ?? state?.stats?.completedRungs ?? 0);
  return {
    ...state,
    mode,
    completedRungs: Number.isFinite(completedRungs) ? completedRungs : 0,
  };
}
