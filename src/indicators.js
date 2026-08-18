// Technical indicators used for trend detection. Pure functions, no deps.

/** Simple moving average of the last `period` values. */
export function sma(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

/** Exponential moving average over the whole series; returns the final value. */
export function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

/**
 * Average True Range over OHLC candles. Returns ATR in price units.
 * candles: [{high, low, close}]
 */
export function atr(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high, l = candles[i].low, pc = candles[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  return sma(trs, period);
}

/**
 * Linear-regression slope of the last `period` closes, normalised to the mean
 * price and expressed as fractional change per candle (e.g. 0.002 = +0.2%/bar).
 */
export function normalizedSlope(values, period) {
  if (values.length < period) return 0;
  const y = values.slice(-period);
  const n = y.length;
  const xMean = (n - 1) / 2;
  const yMean = y.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * (y[i] - yMean);
    den += (i - xMean) ** 2;
  }
  const slope = den === 0 ? 0 : num / den; // price units per bar
  return yMean === 0 ? 0 : slope / yMean;   // fraction per bar
}
