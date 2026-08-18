// LiveMt5：MT5 live 适配器 —— 真实行情 + 真实 MT5 挂单
// 订单通过 Python 桥发送到 MT5（order_send），行情/K线/账户来自 MT5 终端。
// 成交检测：MT5 无推送接口，用轮询 diff —— 跟踪的挂单从交易所消失（且非主动撤销）
// 即判定成交，emit fill 驱动网格替换。
import { Mt5Base } from './base.js';

export class LiveMt5 extends Mt5Base {
  /**
   * @param {object} opts
   *   opts.magic  该槽位的 magic 号（标识网格单，避免误撤用户手动单）
   */
  constructor(opts = {}) {
    super({ ...opts, mode: 'live' });
    this.magic = Number(opts.magic) || 0;
    this.orders = new Map();       // orderId(ticket) -> tracked order
    this._cancelPending = new Set(); // 主动撤销中（不判成交）
    this._lastOrderIds = new Set();  // 上次轮询到的真实挂单 ticket 集合
    this._posCache = null;
    this._firstDiff = true;          // 首次快照不判成交（避免误报历史挂单）
  }

  async init() {
    await this.refreshMarket();
    await this.refreshAccount();
    await this.refreshPrice();
    // 同步一次真实挂单到跟踪表（续跑/对账的基础）
    await this._diffOrders().catch(() => {});
    this.start();
    return true;
  }

  async reconnect() {
    this.lastError = null;
    await this.refreshMarket();
    await this.refreshAccount();
    await this.refreshPrice();
    this.start();
    this.lastOkAt = Date.now();
    return true;
  }

  // ── 订单（真实 MT5） ────────────────────────────────────────────────────
  async placeLimitOrder(o) {
    const r = await this.bridge.call('place_limit', {
      symbol: this.symbol,
      side: o.side === 'sell' ? 'sell' : 'buy',
      price: Number(o.price),
      volume: Number(o.sizeBase),
      magic: this.magic,
      comment: 'GRID',
    }, 30000);
    if (!r?.ok) throw new Error(r?.error || 'MT5 挂单失败');
    const orderId = String(r.ticket);
    this.orders.set(orderId, {
      orderId, marketId: Number(o.marketId), levelIndex: o.levelIndex,
      side: o.side, price: Number(o.price), sizeBase: Number(o.sizeBase),
      opening: o.opening !== false, reduceOnly: !!o.reduceOnly, placedAt: Date.now(),
    });
    this._lastOrderIds.add(orderId);
    return { orderId };
  }

  async cancelOrder(_m, orderId) {
    const id = String(orderId);
    this._cancelPending.add(id);
    try {
      const r = await this.bridge.call('cancel', { symbol: this.symbol, ticket: Number(id) }, 30000);
      if (!r?.ok) throw new Error(r?.error || 'MT5 撤单失败');
      this.orders.delete(id);
      this._lastOrderIds.delete(id);
      return true;
    } finally {
      this._cancelPending.delete(id);
    }
  }

  async cancelAll(marketId) {
    const r = await this.bridge.call('cancel_all', { symbol: this.symbol, magic: this.magic }, 60000);
    if (!r?.ok) throw new Error(r?.errors?.join('; ') || 'MT5 批量撤单失败');
    // 清除本地跟踪（真实快照由 fetchOpenOrders 权威确认）
    for (const [id, o] of this.orders) if (o.marketId === Number(marketId)) { this._lastOrderIds.delete(id); this.orders.delete(id); }
    return true;
  }

  async fetchOpenOrders(marketId) {
    const list = await this.bridge.call('open_orders', { symbol: this.symbol, magic: this.magic }, 30000);
    return (Array.isArray(list) ? list : []).map((o) => ({
      orderId: String(o.ticket),
      price: Number(o.price_open),
      side: o.type === 2 || o.type === 4 || o.type === 6 ? 'buy' : 'sell', // BUY_LIMIT/STOP/STOP_LIMIT
      sizeBase: Number(o.volume_current || o.volume_initial),
      magic: Number(o.magic),
    }));
  }

  adoptOrder({ orderId, marketId, levelIndex, side, price, sizeBase }) {
    const id = String(orderId);
    this.orders.set(id, {
      orderId: id, marketId: Number(marketId), levelIndex,
      side, price: Number(price), sizeBase: Number(sizeBase),
      opening: true, placedAt: Date.now(),
    });
    this._lastOrderIds.add(id);
  }

  forgetOrders(marketId) {
    for (const [id, o] of this.orders) if (o.marketId === Number(marketId)) { this._lastOrderIds.delete(id); this.orders.delete(id); }
  }

  forgetOrder(orderId) {
    const id = String(orderId);
    this._lastOrderIds.delete(id);
    this.orders.delete(id);
  }

  // ── 持仓（真实 MT5） ─────────────────────────────────────────────────────
  async _syncPositions() {
    try {
      const list = await this.bridge.call('positions', { symbol: this.symbol }, 30000);
      if (!Array.isArray(list)) return null;
      this._posCache = list;
      return list;
    } catch { return this._posCache; }
  }

  getPosition(marketId) {
    const mId = Number(marketId);
    const pos = (this._posCache || []).find((p) => p.symbol === this.symbol);
    if (!pos || Number(pos.volume) === 0) return null;
    const unrealizedPnl = Number(pos.profit) + Number(pos.swap || 0);
    return {
      sizeBase: Number(pos.volume) * (pos.type === 0 ? 1 : -1), // 0=buy,1=sell
      entryPrice: Number(pos.price_open),
      unrealizedPnl,
      leverage: this.leverage ?? null,
      liquidationPrice: null,
    };
  }

  async closePosition(marketId) {
    const r = await this.bridge.call('close_position', { symbol: this.symbol }, 60000);
    if (!r?.ok) throw new Error(r?.errors?.join('; ') || 'MT5 平仓失败');
    return true;
  }

  // ── 价格 tick → 订单 diff → 成交检测 ────────────────────────────────────
  async _tick() {
    const t = await this.bridge.call('get_price', { symbol: this.symbol }, 15000).catch(() => null);
    if (t && Number.isFinite(t.bid) && t.bid > 0 && Number.isFinite(t.ask) && t.ask > 0) {
      const mid = (t.bid + t.ask) / 2;
      this._lastKnownPrice = mid;
      this.prices.set(this._marketId, mid);
      this.lastOkAt = Date.now();
      if (this.dataSource === 'synthetic' && this._specs) this.dataSource = 'real';
      this.emit('price', { marketId: this._marketId, price: mid });
    }
    await this._syncPositions();
    await this._diffOrders();
    // 周期性刷新账户（余额/权益），10 秒一次避免过度调用
    if (!this._lastAcctAt || Date.now() - this._lastAcctAt > 10000) {
      this._lastAcctAt = Date.now();
      await this.refreshAccount();
    }
  }

  /** 轮询真实挂单，diff 出消失的跟踪单 -> 成交事件。 */
  async _diffOrders() {
    let real;
    try { real = await this.fetchOpenOrders(this._marketId); }
    catch { return; }
    const realIds = new Set(real.map((o) => o.orderId));
    // 快照非空才更新基线；空快照可能是接口异常（对账有 massVanish 防护，这里同样保守）
    if (realIds.size === 0 && this._lastOrderIds.size >= 3) return;
    if (this._firstDiff) {
      this._firstDiff = false;
      this._lastOrderIds = realIds;
      // 同步跟踪表：真实存在的单补进 orders（adopt 语义）
      for (const o of real) {
        if (!this.orders.has(o.orderId)) this.adoptOrder({ orderId: o.orderId, marketId: this._marketId, side: o.side, price: o.price, sizeBase: o.sizeBase });
      }
      return;
    }
    const gone = [...this._lastOrderIds].filter((id) => !realIds.has(id) && !this._cancelPending.has(id));
    for (const id of gone) {
      const tracked = this.orders.get(id);
      this.orders.delete(id);
      if (!tracked) continue;
      // 成交价：最近价格（无精确成交价，MT5 无推送；对账/恢复时会校准）
      const price = this.prices.get(this._marketId) ?? tracked.price;
      this.emit('fill', {
        orderId: id, marketId: this._marketId, side: tracked.side, price,
        sizeBase: tracked.sizeBase, levelIndex: tracked.levelIndex,
      });
    }
    this._lastOrderIds = realIds;
  }

  /** 供 GridBot 对账时获取真实挂单数（bridge 侧）。 */
  async _realOrderCount() {
    try {
      const list = await this.fetchOpenOrders(this._marketId);
      return Array.isArray(list) ? list.length : null;
    } catch { return null; }
  }
}
