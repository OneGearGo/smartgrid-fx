// PaperMt5：MT5 paper 适配器 —— 真实行情 + 本地模拟撮合（含手续费）
// 行情（价格/K线/品种规格）全部来自 MT5 真实终端；只有订单*成交*是本地模拟的。
// 对齐原版 src/exchange/de/paper.js 的设计：tick 驱动撮合、持仓/盈亏/手续费模拟。
import { Mt5Base } from './base.js';

export class PaperMt5 extends Mt5Base {
  constructor(opts = {}) {
    super({ ...opts, mode: 'paper' });
    this.orders = new Map();      // orderId -> order
    this.positions = new Map();   // marketId -> {sizeBase, entryPrice}
    this._prevTicks = new Map();  // marketId -> {bid, ask} 用于穿越检测
    this.balance = this.startBalance;
    this.equity = this.startBalance;
    this.realizedPnl = 0;
  }

  async init() {
    await this.refreshMarket();
    await this.refreshPrice();
    this.start();
    return true;
  }

  async reconnect() {
    // 桥自带重试；这里刷新行情并保持轮询
    this.lastError = null;
    await this.refreshMarket();
    await this.refreshPrice();
    this.start();
    this.lastOkAt = Date.now();
    return true;
  }

  // ── 订单（本地模拟） ─────────────────────────────────────────────────────
  async placeLimitOrder(o) {
    const id = `paper-${this.symbol}-${this._seq++}`;
    this.orders.set(id, {
      orderId: id, marketId: Number(o.marketId), side: o.side, price: Number(o.price),
      sizeBase: Number(o.sizeBase), reduceOnly: !!o.reduceOnly,
      levelIndex: o.levelIndex, clientOrderId: o.clientOrderId,
    });
    return { orderId: id };
  }

  async cancelOrder(_m, orderId) {
    this.orders.delete(String(orderId));
    return true;
  }

  async cancelAll(marketId) {
    const mId = Number(marketId);
    for (const [id, o] of this.orders) if (o.marketId === mId) this.orders.delete(id);
    return true;
  }

  async fetchOpenOrders(marketId) {
    const mId = Number(marketId);
    return [...this.orders.values()]
      .filter((o) => o.marketId === mId)
      .map((o) => ({ orderId: String(o.orderId), price: Number(o.price), side: o.side, sizeBase: o.sizeBase }));
  }

  getOpenOrders(marketId) {
    const mId = Number(marketId);
    return [...this.orders.values()].filter((o) => o.marketId === mId);
  }

  adoptOrder({ orderId, marketId, levelIndex, side, price, sizeBase }) {
    this.orders.set(String(orderId), {
      orderId: String(orderId), marketId: Number(marketId), levelIndex,
      side, price: Number(price), sizeBase: Number(sizeBase), reduceOnly: false,
    });
  }

  forgetOrders(marketId) {
    this.cancelAll(marketId);
  }

  forgetOrder(orderId) {
    this.orders.delete(String(orderId));
  }

  // ── 持仓（本地模拟） ─────────────────────────────────────────────────────
  getPosition(marketId) {
    const p = this.positions.get(Number(marketId));
    if (!p || p.sizeBase === 0) return null;
    const price = this.prices.get(Number(marketId)) ?? 0;
    const unrealizedPnl = p.sizeBase * (price - p.entryPrice);
    return { sizeBase: p.sizeBase, entryPrice: p.entryPrice, unrealizedPnl };
  }

  async closePosition(marketId) {
    const mId = Number(marketId);
    const pos = this.positions.get(mId);
    if (!pos || pos.sizeBase === 0) return true;
    const price = this.prices.get(mId);
    if (price) this._applyFill(mId, pos.sizeBase > 0 ? 'sell' : 'buy', price, Math.abs(pos.sizeBase));
    return true;
  }

  // ── 价格 tick → 撮合 ────────────────────────────────────────────────────
  async _tick() {
    // 真实价格走桥；桥离线时 refreshPrice 自动生成合成价格兜底
    const mid = await this.refreshPrice();
    if (mid == null) return;
    // 撮合用真实 bid/ask（合成模式下无 tick，用 mid 近似）
    let bid = mid, ask = mid;
    if (this.dataSource === 'real') {
      const t = await this.bridge.call('get_price', { symbol: this.symbol }, 15000).catch(() => null);
      if (t && Number.isFinite(t.bid) && t.bid > 0 && Number.isFinite(t.ask) && t.ask > 0) {
        bid = t.bid; ask = t.ask;
      }
    }
    this.emit('price', { marketId: this._marketId, price: mid });
    this._match(bid, ask);
  }

  _match(bid, ask) {
    const mId = this._marketId;
    const prev = this._prevTicks.get(mId);
    this._prevTicks.set(mId, { bid, ask });
    for (const o of [...this.orders.values()]) {
      if (o.marketId !== mId) continue;
      // 买单：ask 下穿到 <= 挂单价；卖单：bid 上穿到 >= 挂单价
      const crossedBuy = prev ? (prev.ask > o.price && ask <= o.price) : ask <= o.price;
      const crossedSell = prev ? (prev.bid < o.price && bid >= o.price) : bid >= o.price;
      if (!crossedBuy && !crossedSell) continue;
      if (o.reduceOnly && !this._reduces(mId, o.side)) { this.orders.delete(o.orderId); continue; }
      this.orders.delete(o.orderId);
      const fillPrice = o.side === 'buy' ? Math.min(o.price, ask) : Math.max(o.price, bid);
      this._applyFill(mId, o.side, fillPrice, o.sizeBase);
      this.emit('fill', {
        orderId: o.orderId, marketId: mId, side: o.side, price: fillPrice,
        sizeBase: o.sizeBase, levelIndex: o.levelIndex, clientOrderId: o.clientOrderId,
      });
    }
  }

  _reduces(marketId, side) {
    const p = this.positions.get(Number(marketId));
    if (!p || p.sizeBase === 0) return false;
    return side === 'sell' ? p.sizeBase > 0 : p.sizeBase < 0;
  }

  _applyFill(marketId, side, price, qty) {
    const fee = price * qty * this.feeRate;
    this.balance -= fee;
    this.realizedPnl -= fee;
    const p = this.positions.get(marketId) || { sizeBase: 0, entryPrice: 0 };
    const signed = side === 'buy' ? qty : -qty;
    if (p.sizeBase === 0 || Math.sign(p.sizeBase) === Math.sign(signed)) {
      const newSize = p.sizeBase + signed;
      p.entryPrice = (Math.abs(p.sizeBase) * p.entryPrice + Math.abs(signed) * price) / Math.abs(newSize);
      p.sizeBase = newSize;
    } else {
      const closeQty = Math.min(Math.abs(p.sizeBase), Math.abs(signed));
      const pnl = p.sizeBase > 0 ? closeQty * (price - p.entryPrice) : closeQty * (p.entryPrice - price);
      this.realizedPnl += pnl;
      this.balance += pnl;
      const remaining = p.sizeBase + signed;
      if (Math.sign(remaining) === Math.sign(p.sizeBase) || remaining === 0) {
        p.sizeBase = remaining;
        if (remaining === 0) p.entryPrice = 0;
      } else {
        p.sizeBase = remaining;
        p.entryPrice = price;
      }
    }
    this.positions.set(marketId, p);
    this.equity = this.balance + (this.getPosition(marketId)?.unrealizedPnl ?? 0);
  }
}
