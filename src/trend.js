// Trend detection + strategy recommendation from OHLCV candles.
import { ema, atr, normalizedSlope } from './indicators.js';

/**
 * Analyse candles and recommend a grid strategy.
 * candles: chronological [{time, open, high, low, close, volume}]
 *
 * Logic: combine an EMA(fast) vs EMA(slow) regime filter with a linear-
 * regression slope confirmation. Volatility (ATR%) is reported so the UI can
 * suggest sensible grid spacing.
 *
 * Returns:
 *  trend:        'up' | 'down' | 'range'
 *  recommended:  'long' | 'short' | 'neutral'
 *  strength:     0..1 confidence
 *  atrPct:       ATR as % of price (volatility gauge)
 *  detail:       human-readable explanation (Chinese)
 */
export function analyzeTrend(candles, opts = {}) {
  const fast = opts.fast ?? 20;
  const slow = opts.slow ?? 50;
  const slopeBars = opts.slopeBars ?? 20;
  // Slope above this (fraction/bar) counts as a real trend, not noise.
  const slopeThreshold = opts.slopeThreshold ?? 0.0015;

  const closes = candles.map((c) => c.close).filter((v) => Number.isFinite(v));
  const price = closes[closes.length - 1];

  if (closes.length < slow + 1) {
    return {
      trend: 'range', recommended: 'neutral', strength: 0,
      atrPct: null, price,
      detail: `K线样本不足（需要至少 ${slow + 1} 根，当前 ${closes.length} 根），默认中性网格。`,
    };
  }

  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const slope = normalizedSlope(closes, slopeBars); // fraction per bar
  const a = atr(candles, 14);
  const atrPct = a && price ? (a / price) * 100 : null;

  const emaGapPct = ((emaFast - emaSlow) / emaSlow) * 100;
  const up = emaFast > emaSlow && slope > slopeThreshold;
  const down = emaFast < emaSlow && slope < -slopeThreshold;

  // Strength: blend of slope magnitude and EMA separation, clamped to 0..1.
  const strength = Math.min(
    1,
    (Math.abs(slope) / (slopeThreshold * 4)) * 0.6 +
      (Math.abs(emaGapPct) / 3) * 0.4
  );

  let trend, recommended, detail;
  if (up) {
    trend = 'up'; recommended = 'long';
    detail = `上升趋势：EMA${fast} 在 EMA${slow} 之上（差 ${emaGapPct.toFixed(2)}%），斜率 +${(slope * 100).toFixed(3)}%/根。推荐做多网格（低买、上涨分批止盈）。`;
  } else if (down) {
    trend = 'down'; recommended = 'short';
    detail = `下降趋势：EMA${fast} 在 EMA${slow} 之下（差 ${emaGapPct.toFixed(2)}%），斜率 ${(slope * 100).toFixed(3)}%/根。推荐做空网格（高空、下跌分批止盈）。`;
  } else {
    trend = 'range'; recommended = 'neutral';
    detail = `震荡/无明显趋势：EMA 差 ${emaGapPct.toFixed(2)}%，斜率 ${(slope * 100).toFixed(3)}%/根。推荐中性网格（区间内双向吃波动）。`;
  }

  const volNote = atrPct != null
    ? ` 波动率 ATR≈${atrPct.toFixed(2)}%，建议单格间距不小于该值的一半以覆盖手续费。`
    : '';

  return {
    trend, recommended,
    strength: Number(strength.toFixed(2)),
    atrPct: atrPct != null ? Number(atrPct.toFixed(3)) : null,
    price,
    emaFast, emaSlow,
    slopePct: Number((slope * 100).toFixed(4)),
    detail: detail + volNote,
  };
}
