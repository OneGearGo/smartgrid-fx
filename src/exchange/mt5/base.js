// Mt5Base：MT5 适配器共享基类（行情、品种规格、K线、价格轮询）
// paper（本地模拟撮合）与 live（真实订单）都继承本类，差异仅在订单执行。
// 行情数据全部来自 MT5 真实终端（通过 Python 桥），K线用 copy_rates 拉真实历史。
import { EventEmitter } from 'node:events';

// 终端离线时的兜底规格（保证程序能启动、能显示界面）
const FALLBACK_SPECS = {
  XAUUSD: { digits: 2, point: 0.01, volume_min: 0.01, volume_step: 0.01, spread: 20, trade_tick_size: 0.01 },
  EURUSD: { digits: 5, point: 0.00001, volume_min: 0.01, volume_step: 0.01, spread: 8, trade_tick_size: 0.00001 },
  GBPUSD: { digits: 5, point: 0.00001, volume_min: 0.01, volume_step: 0.01, spread: 12, trade_tick_size: 0.00001 },
  USDJPY: { digits: 3, point: 0.001, volume_min: 0.01, volume_step: 0.01, spread: 10, trade_tick_size: 0.001 },
  NAS100: { digits: 2, point: 0.01, volume_min: 0.1, volume_step: 0.1, spread: 100, trade_tick_size: 0.01 },
};

export class Mt5Base extends EventEmitter {
  /**
   * @param {object} opts
   *   opts.bridge       Mt5BridgeClient 实例（5 槽位共享同一个）
   *   opts.symbol       品种，如 'XAUUSD'
   *   opts.startBalance paper 模式初始余额
   *   opts.feeRate      手续费率（paper 撮合用，默认 0.00005 ≈ 5$/百万）
   *   opts.pollMs       价格轮询间隔（毫秒）
   *   opts.mode         'paper' | 'live'
   */
  constructor(opts = {}) {
    super();
    this.bridge = opts.bridge;
    this.symbol = String(opts.symbol || '').toUpperCase();
    this.mode = opts.mode || 'paper';
    this.startBalance = opts.startBalance ?? 10000;
    this.feeRate = Number(opts.feeRate) || 0.00005;
    this.pollMs = Number(opts.pollMs) || 1000;
    this.dataSource = 'connecting'; // 'real' | 'synthetic'
    this.network = 'mt5';
    this.apiUrl = null;
    this.lastOkAt = Date.now();
    this.lastError = null;
    this.operationalIssue = null;
    this.apiWalletAddress = null;
    this.balance = this.startBalance;
    this.equity = this.startBalance;
    this.realizedPnl = 0;
    this.markets = new Map();       // marketId -> market spec
    this.prices = new Map();        // marketId -> price (mid)
    this._specs = null;             // 原始 MT5 规格
    this._tickTimer = null;
    this._seq = 1;
    this._account = null;
    this._marketId = 1;
    this._lastKnownPrice = null;
    this._priceListenersActive = false;
  }

  get marketId() { return this._marketId; }

  /** 从桥读取品种规格 + 价格，构建 markets 表。终端离线时用兜底规格 + 合成行情。 */
  async refreshMarket() {
    try {
      const specs = await this.bridge.call('get_symbols', { symbols: [this.symbol] }, 30000);
      if (specs && specs.length) {
        this._specs = specs[0];
        this.dataSource = 'real';
        this.network = 'mt5';
        this._setMarketFromSpec(this._specs);
        this.lastError = null;
        return;
      }
    } catch (e) {
      this.lastError = e?.message || String(e);
    }
    // 终端离线：兜底规格 + 合成行情
    this.dataSource = 'synthetic';
    this._setMarketFromSpec(FALLBACK_SPECS[this.symbol] || {
      digits: 5, point: 0.00001, volume_min: 0.01, volume_step: 0.01, spread: 10, trade_tick_size: 0.00001,
    });
  }

  _setMarketFromSpec(spec) {
    this._specs = spec;
    const stepPrice = spec.trade_tick_size || spec.point || 0.00001;
    const price = this._lastKnownPrice || 100; // 由 refreshPrice 覆盖
    const m = {
      marketId: this._marketId,
      name: this.symbol,
      displayName: this.symbol,
      symbol: this.symbol,
      lastPrice: price,
      stepSize: spec.volume_step || 0.01,
      stepPrice,
      maxLeverage: 100,
      minOrderSize: spec.volume_min || 0.01,
      volumeStep: spec.volume_step || 0.01,
      digits: spec.digits ?? 5,
      point: spec.point ?? 0.00001,
      spread: spec.spread ?? 0,
      tickSize: stepPrice,
    };
    this.markets.set(m.marketId, m);
  }

  async getMarkets() {
    if (this.markets.size === 0) await this.refreshMarket();
    return [...this.markets.values()];
  }

  /** 读取实时价格（桥 get_price -> bid/ask 取中价）。离线时返回 null。 */
  async refreshPrice() {
    try {
      const t = await this.bridge.call('get_price', { symbol: this.symbol }, 15000);
      if (t && Number.isFinite(t.bid) && t.bid > 0 && Number.isFinite(t.ask) && t.ask > 0) {
        const mid = (t.bid + t.ask) / 2;
        this._lastKnownPrice = mid;
        this.prices.set(this._marketId, mid);
        this.lastOkAt = Date.now();
        if (this.dataSource === 'synthetic' && this._specs) {
          // 行情恢复：从合成升级为真实（不重编 marketId）
          this.dataSource = 'real';
        }
        return mid;
      }
      return null;
    } catch (e) {
      this.lastError = e?.message || String(e);
      return null;
    }
  }

  async getPrice(marketId) {
    const mId = Number(marketId ?? this._marketId);
    const cached = this.prices.get(mId);
    // 尽力实时读取，失败用缓存
    const fresh = await this.refreshPrice().catch(() => null);
    return fresh ?? cached ?? null;
  }

  async getCandles(marketId, intervalSec = 3600, n = 200) {
    try {
      const r = await this.bridge.call('get_candles', { symbol: this.symbol, intervalSec, n }, 30000);
      if (r && Array.isArray(r.candles) && r.candles.length >= 2) {
        this.lastOkAt = Date.now();
        return r.candles.map((c) => ({
          time: Number(c.time), open: Number(c.open), high: Number(c.high),
          low: Number(c.low), close: Number(c.close), volume: Number(c.volume ?? 0),
        }));
      }
    } catch { /* fall through to synthetic */ }
    return synthCandles(this.prices.get(Number(marketId)) || this._lastKnownPrice || 100, n);
  }

  async setLeverage() { return false; } // MT5 杠杆是账户级，无法按品种设置

  /** 启动价格轮询。 */
  start() {
    if (this._tickTimer) return;
    this._tickTimer = setInterval(() => this._tick().catch(() => {}), this.pollMs);
    this._tickTimer.unref?.();
  }

  stop() {
    if (this._tickTimer) { clearInterval(this._tickTimer); this._tickTimer = null; }
  }

  async _tick() {
    const price = await this.refreshPrice();
    if (price == null) return;
    this.emit('price', { marketId: this._marketId, price });
    this._onPriceTick(price);
  }

  /** 子类实现：每个价格 tick 的撮合/处理。 */
  _onPriceTick(_price) { /* override */ }

  /** 刷新账户信息（余额/权益）。live 模式从桥读；paper 用本地模拟值。 */
  async refreshAccount() {
    try {
      const a = await this.bridge.call('get_account', {}, 15000);
      if (a && Number.isFinite(a.equity)) {
        this._account = a;
        this.balance = a.balance;
        this.equity = a.equity;
        this.leverage = a.leverage;
        this.lastOkAt = Date.now();
      }
    } catch { /* keep cached */ }
  }
}

/** 合成K线（终端离线时兜底，对齐原版 paper.js 的 synthCandles）。 */
export function synthCandles(start, n) {
  const out = [];
  let price = start;
  let t = Math.floor(Date.now() / 1000) - n * 3600;
  const regime = Math.random() < 0.34 ? 0.0012 : Math.random() < 0.5 ? -0.0012 : 0;
  for (let i = 0; i < n; i++) {
    const open = price;
    const close = price * (1 + regime + (Math.random() * 2 - 1) * 0.006);
    out.push({ time: t, open, high: Math.max(open, close) * 1.001, low: Math.min(open, close) * 0.999, close, volume: 100 });
    price = close;
    t += 3600;
  }
  return out;
}
