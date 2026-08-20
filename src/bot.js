// GridBot: orchestrates an arithmetic grid on one market. Places the initial
// ladder of limit orders, and on every fill places the opposite order one rung
// away (buy->sell up, sell->buy down), capturing `spacing * size` per round.
// Risk controls: leverage cap, margin pre-check, fee/spacing check, out-of-range
// alerts (optional auto-stop), periodic open-order reconciliation, crash-safe
// persistence with resume-on-restart, live range adjustment, and a health probe.
import { buildGrid, seedOrders, replacementFor, isReduceOnly } from './grid.js';

const RECONCILE_MS = 30000;   // periodic open-order reconciliation cadence
const PRUNE_GRACE_MS = 20000; // don't prune a tracked order younger than this

export class GridBot {
  constructor(exchange, opts = {}) {
    this.ex = exchange;
    this.running = false;
    this.config = null;
    this.grid = null;
    this.active = new Map();        // orderId -> {levelIndex, side, price, opening, placedAt}
    this.fills = [];                // recent fills (capped)
    this.alerts = [];               // recent alerts (capped)
    this.stats = { buys: 0, sells: 0, completedRungs: 0, gridProfit: 0, volume: 0 };
    this.startBalance = null;
    this.lastPrice = null;
    this.outOfRange = false;
    this.risk = null;
    this._stopping = false;         // re-entrancy guard for auto-stop
    this._coidSeq = 0;              // monotonic client-order-id counter
    this._placeFails = 0;          // cumulative order-placement failures
    this._lastFailAt = 0;
    this._exchangeOpenOrders = null; // last reconciled real open-order count
    this._exchangeOpenOrdersVerifiedAt = null; // authoritative REST snapshot time
    this._pendingLevels = new Set(); // levels with a placement in flight (dedup guard)
    this._recoveryOccupied = new Set(); // recovery: real exchange-occupied levels (from reconcile)
    this._reconTimer = null;
    this.recovery = false;          // standalone reduce-only recovery mode
    this._onChange = typeof opts.onChange === 'function' ? opts.onChange : null; // persistence hook
    this._onFill = (f) => this._handleFill(f);
    this._onPrice = (p) => this._handlePrice(p);
    // CRITICAL: an EventEmitter that emits 'error' with no listener crashes the
    // whole Node process. Adapters emit 'error' on cancelled/rejected orders, so
    // we MUST always have a listener attached for the bot's whole lifetime.
    this._onError = (e) => this._handleExError(e);
    this.ex.on('error', this._onError);
    this._cancelTimes = [];          // timestamps of recent order cancellations
    this._refillPausedUntil = 0;     // back-off window: pause new placements until this time
    this._lastErrAlertAt = 0;
    this._lastErrLogAt = 0;
    this._retryQueue = [];           // failed safe-to-retry placements awaiting authoritative reconciliation
    this._retryDrainInFlight = false;
    this._placementPasses = 0;
    this._placementProgress = null;  // startup/refill target vs confirmed/pending levels
    this._noPosStreak = 0;           // consecutive empty-position observations (recovery finish guard)
    this._pnlBase = null;            // realizedPnl baseline; resetStats uses an offset because some
                                     // adapters (RISEx) re-fetch realizedPnl from the exchange every poll
    // Cancellation is safety-critical: require consecutive exchange snapshots
    // showing target orders gone before local state is cleared or trading moves on.
    this._cancelVerifyAttempts = opts.cancelVerifyAttempts ?? 12;
    this._cancelVerifyDelayMs = opts.cancelVerifyDelayMs ?? 750;
    this._cancelVerifyStableReads = opts.cancelVerifyStableReads ?? 2;
    this._recoveryCancelInFlight = false;
    this._finishingRecovery = false;
  }

  /**
   * Handle an 'error' emitted by the exchange adapter. Never throws (that would
   * crash the process). Records a throttled alert, and — if orders are being
   * cancelled rapidly (the tell-tale of collateral exhaustion or manual
   * intervention) — pauses auto-refill so we stop hammering the exchange and
   * burning gas on orders that just get rejected.
   */
  _handleExError(e) {
    const msg = (e && e.message) ? e.message : String(e);
    const now = Date.now();
    if (now - this._lastErrLogAt > 3000) { this._lastErrLogAt = now; try { console.error('[交易所事件] ' + msg); } catch {} }
    if (now - this._lastErrAlertAt > 5000) { this._lastErrAlertAt = now; this._alert('交易所事件: ' + msg); }

    if (/取消|cancel|collateral|保证金|reject/i.test(msg)) {
      this._cancelTimes.push(now);
      this._cancelTimes = this._cancelTimes.filter((t) => now - t < 60000); // last 60s
      if (this._cancelTimes.length >= 5 && now >= this._refillPausedUntil) {
        this._refillPausedUntil = now + 60000;
        this._alert('⚠️ 检测到 60 秒内多笔订单被取消（疑似保证金不足或手动撤单），已暂停自动补单 60 秒，避免反复被拒、浪费手续费。请检查保证金/减小持仓。');
      }
    }
  }

  /** Notify the persistence layer (if any) that durable state changed. */
  _changed() { try { this._onChange?.(this.snapshot()); } catch { /* never let persistence break trading */ } }

  /** Durable snapshot for crash recovery / resume. Includes resting orders. */
  snapshot() {
    return {
      running: this.running, config: this.config, stats: this.stats,
      recovery: this.recovery, pnlBase: this._pnlBase,
      startBalance: this.startBalance, outOfRange: this.outOfRange, lastPrice: this.lastPrice,
      active: [...this.active.entries()],
      placementProgress: this._placementProgress,
      retryQueue: this._retryQueue,
    };
  }

  /**
   * Restore display/accounting state after a process restart WITHOUT resuming
   * trading (running stays false). Used when we only want continuity of stats.
   */
  restore(snap) {
    if (!snap || !snap.config) return;
    this.config = snap.config;
    this.stats = { buys: 0, sells: 0, completedRungs: 0, gridProfit: 0, volume: 0, ...(snap.stats || {}) };
    this.startBalance = snap.startBalance ?? null;
    this._pnlBase = snap.pnlBase ?? null;
    this._placementProgress = snap.placementProgress ?? null;
    this._retryQueue = Array.isArray(snap.retryQueue) ? snap.retryQueue : [];
    try {
      this.grid = buildGrid({ lower: this.config.lower, upper: this.config.upper, gridCount: this.config.gridCount });
      this._recomputeRisk();
    } catch { /* config may be incomplete */ }
  }

  /**
   * Resume a grid that was running when the process died: re-attach to the
   * orders still resting on the exchange (rebuilding both our tracking and the
   * adapter's), restart listeners, then reconcile against the real book.
   */
  async resume(snap) {
    if (!snap || !snap.config) throw new Error('无可恢复的运行中网格快照');
    if (this.running) throw new Error('已在运行，无法重复恢复');
    // Standalone recovery ladder has no grid (gridCount=null): resume it via its
    // own path — the old code fell into buildGrid, threw, and the fallback then
    // CANCELLED the whole ladder while the position stayed open.
    if (snap.recovery || snap.config.mode === 'recovery') return this._resumeRecovery(snap);
    if (!Array.isArray(snap.active)) throw new Error('无可恢复的运行中网格快照');
    this.config = snap.config;
    this.stats = { buys: 0, sells: 0, completedRungs: 0, gridProfit: 0, volume: 0, ...(snap.stats || {}) };
    this.startBalance = snap.startBalance ?? null;
    this._pnlBase = snap.pnlBase ?? null;
    this._placementProgress = snap.placementProgress ?? null;
    this._retryQueue = (Array.isArray(snap.retryQueue) ? snap.retryQueue : [])
      .map((o) => ({ ...o, _nextAt: Math.max(Number(o._nextAt) || 0, Date.now() + 30_000) }));
    this._restorePendingPlacementRetries();
    this.outOfRange = !!snap.outOfRange;
    this.lastPrice = snap.lastPrice ?? null;
    this.grid = buildGrid({ lower: this.config.lower, upper: this.config.upper, gridCount: this.config.gridCount });
    this._recomputeRisk();

    // Rebuild our active map AND the adapter's order tracking so fills on these
    // pre-existing orders are detected.
    this.active.clear();
    for (const [id, info] of snap.active) {
      const oid = String(id);
      this.active.set(oid, { ...info, placedAt: info.placedAt ?? Date.now() });
      if (typeof this.ex.adoptOrder === 'function') {
        try {
          this.ex.adoptOrder({
            orderId: oid, marketId: this.config.marketId, levelIndex: info.levelIndex,
            side: info.side, price: info.price, sizeBase: info.sizeBase ?? this.config.sizeBase,
          });
        } catch { /* best effort */ }
      }
    }

    this.ex.on('fill', this._onFill);
    this.ex.on('price', this._onPrice);
    if (typeof this.ex.start === 'function') this.ex.start();
    this.running = true;
    this._startReconcileTimer();
    this._alert(`已恢复运行中的 ${this.config.displayName} ${labelMode(this.config.mode)}：接管 ${this.active.size} 个挂单，正在与交易所对账…`);
    this.reconcileOpenOrders().catch(() => {}); // immediate reconcile
    this._changed();
    return this.getState();
  }

  /**
   * 重新接管仓位：程序重启后（bot 未运行），把 MT5 上残留的真实挂单和
   * 持仓接管回跟踪，恢复网格运行。
   *
   * 优先用 .state.json 快照 resume（最准确：含原网格配置）；
   * 快照缺失/过期时，从交易所真实挂单反推网格（价格等距分布）重建。
   *
   * @param {object} snap 可选：.state.json 快照
   * @returns {Promise<object>} bot state
   */
  async adoptExistingOrders(snap = null) {
    if (this.running) throw new Error('已在运行，无需接管。');
    // 1) 快照优先：完整恢复原网格
    if (snap?.running && snap?.config) {
      try {
        const r = await this.resume(snap);
        this._alert(`已重新接管 ${this.config.displayName}：从快照恢复网格，接管 ${this.active.size} 个挂单并完成对账。`);
        return r;
      } catch (e) {
        this._alert(`快照恢复失败（${e?.message || e}），尝试从交易所真实挂单重建…`);
      }
    }
    // 2) 无快照/快照失效：从真实挂单反推网格
    if (typeof this.ex.fetchOpenOrders !== 'function') throw new Error('交易所适配器不支持读取真实挂单，无法接管。');
    const markets = await this.ex.getMarkets();
    const market = markets.find((m) => m.marketId === this.ex.marketId) || markets[0];
    if (!market) throw new Error('找不到市场，无法接管。');
    const real = await this.ex.fetchOpenOrders(market.marketId);
    if (!Array.isArray(real)) throw new Error('无法读取交易所真实挂单。');
    const orders = real.filter((o) => Number.isFinite(Number(o.price)) && Number(o.price) > 0);
    if (!orders.length) {
      // 没有挂单：看有没有持仓
      const pos = this.ex.getPosition?.(market.marketId);
      if (pos?.sizeBase) {
        this._alert(`${market.displayName} 无挂单但有持仓（${pos.sizeBase}），可启动「只减仓回收阶梯」处理。`);
        return this.getState();
      }
      throw new Error('交易所上没有任何挂单或持仓，无需接管。');
    }
    // 反推网格：价格排序，等距拟合
    const prices = orders.map((o) => Number(o.price)).sort((a, b) => a - b);
    const gaps = [];
    for (let i = 1; i < prices.length; i++) gaps.push(prices[i] - prices[i - 1]);
    const spacing = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0;
    if (!(spacing > 0)) throw new Error('无法从挂单价格推断网格间距。');
    const lower = prices[0], upper = prices[prices.length - 1];
    // 现价
    const price = await this.ex.getPrice(market.marketId).catch(() => null);
    // 中性网格：下方 buy、上方 sell
    const mode = 'neutral';
    this.config = {
      marketId: market.marketId, displayName: market.displayName, mode,
      lower, upper,
      gridCount: Math.max(2, prices.length - 1),
      sizeBase: market.minOrderSize || 0.01,
      leverage: this.ex.leverage || 100,
      outOfRangeAction: 'close',
      stepSize: market.stepSize, stepPrice: market.stepPrice,
      contractSize: market.contractSize || 1,
      adopted: true, // 标记为接管重建的网格（非原始配置）
    };
    this.grid = buildGrid({ lower, upper, gridCount: this.config.gridCount });
    this._recomputeRisk();
    this.lastPrice = price;
    this.outOfRange = price != null ? (price < lower || price > upper) : false;
    this.active.clear();
    // 把真实挂单纳入跟踪（levelIndex 由价格推算）
    const lvl0 = this.grid.levels[0];
    for (const o of orders) {
      const px = Number(o.price);
      const idx = Math.round((px - lvl0) / spacing);
      const side = o.side === 'buy' ? 'buy' : 'sell';
      const closing = mode === 'short' ? side === 'buy' : side === 'sell';
      try { this.ex.adoptOrder?.({ orderId: String(o.orderId), marketId: market.marketId, levelIndex: idx, side, price: px, sizeBase: this.config.sizeBase }); } catch { /* best effort */ }
      this.active.set(String(o.orderId), { levelIndex: idx, side, price: px, opening: !closing, recovery: false, placedAt: Date.now() });
    }
    this.ex.on('fill', this._onFill);
    this.ex.on('price', this._onPrice);
    if (typeof this.ex.start === 'function') this.ex.start();
    this.running = true;
    this._startReconcileTimer();
    this._alert(`${market.displayName}：已从交易所真实挂单接管 ${this.active.size} 单（间距≈${round4(spacing)}），恢复网格运行。`);
    this.reconcileOpenOrders().catch(() => {});
    this._changed();
    return this.getState();
  }

  /** Resume a standalone reduce-only recovery ladder after a process restart. */
  async _resumeRecovery(snap) {    this.config = snap.config;
    this.stats = { buys: 0, sells: 0, completedRungs: 0, gridProfit: 0, volume: 0, ...(snap.stats || {}) };
    this.startBalance = snap.startBalance ?? null;
    this._pnlBase = snap.pnlBase ?? null;
    this.grid = null; this.risk = null;
    this.recovery = true; this.outOfRange = false;
    this.lastPrice = snap.lastPrice ?? null;
    this._noPosStreak = 0;
    this._placementProgress = snap.placementProgress ?? null;
    this._retryQueue = (Array.isArray(snap.retryQueue) ? snap.retryQueue : [])
      .map((o) => ({ ...o, _nextAt: Math.max(Number(o._nextAt) || 0, Date.now() + 30_000) }));
    this.active.clear();
    for (const [id, info] of (Array.isArray(snap.active) ? snap.active : [])) {
      const oid = String(id);
      this.active.set(oid, { ...info, placedAt: info.placedAt ?? Date.now() });
      try {
        this.ex.adoptOrder?.({
          orderId: oid, marketId: this.config.marketId, levelIndex: info.levelIndex,
          side: info.side, price: info.price, sizeBase: info.sizeBase ?? this.config.sizeBase,
        });
      } catch { /* best effort */ }
    }
    this.ex.on('fill', this._onFill);
    this.ex.on('price', this._onPrice);
    if (typeof this.ex.start === 'function') this.ex.start();
    this.running = true;
    // seed the adapter's price watch + refresh lastPrice
    const px = await this.ex.getPrice(this.config.marketId).catch(() => null);
    if (px > 0) this.lastPrice = px;
    this._recoveryOccupied = new Set();
    this._alert(`已恢复 ${this.config.displayName} 的「只减仓回收阶梯」：接管 ${this.active.size} 个挂单，正在与交易所对账…`);
    await this.reconcileOpenOrders().catch(() => {});
    this._startReconcileTimer();
    this._changed();
    return this.getState();
  }

  /**
   * Fallback recovery: cancel any resting orders from a previous run (used when
   * resume is not desired or fails).
   */
  async recoverStrayOrders() {
    if (!this.config) return;
    await this._cancelAllConfirmed(this.config.marketId, '恢复失败后清理遗留挂单');
    this._alert('⚠️ 检测到上次运行未正常结束：已撤销该市场遗留挂单。请确认仓位后重新启动网格。');
    this._changed();
  }

  /** Temporarily stop bot-side fill/price handling while cancellation is verified. */
  _pauseTradingRuntime() {
    this._stopReconcileTimer();
    this.ex.off('fill', this._onFill);
    this.ex.off('price', this._onPrice);
  }

  /** Restore tracking after a failed cancellation without duplicating listeners. */
  _resumeTradingRuntime() {
    if (!this.running || !this.config) return;
    for (const [orderId, info] of this.active) {
      try {
        this.ex.adoptOrder?.({
          orderId, marketId: this.config.marketId, levelIndex: info.levelIndex,
          side: info.side, price: info.price, sizeBase: info.sizeBase ?? this.config.sizeBase,
        });
      } catch { /* reconciliation will retry */ }
    }
    this.ex.off('fill', this._onFill);
    this.ex.off('price', this._onPrice);
    this.ex.on('fill', this._onFill);
    this.ex.on('price', this._onPrice);
    if (typeof this.ex.start === 'function') this.ex.start();
    this._startReconcileTimer();
  }

  /**
   * Wait until all market orders (or selected IDs) are absent in consecutive
   * snapshots. A single empty snapshot is not trusted because some APIs
   * transiently return an incorrect empty order list.
   */
  async _confirmOrdersGone(marketId, orderIds = null) {
    if (typeof this.ex.fetchOpenOrders !== 'function') {
      throw new Error('交易所适配器不支持查询真实挂单，无法安全确认撤单。');
    }
    const wanted = orderIds ? new Set([...orderIds].map(String)) : null;
    let stableEmpty = 0, sawValidSnapshot = false, lastRemaining = null, lastError = null;
    for (let attempt = 1; attempt <= this._cancelVerifyAttempts; attempt++) {
      try {
        const real = await this.ex.fetchOpenOrders(marketId);
        if (Array.isArray(real)) {
          this._exchangeOpenOrders = real.length;
          this._exchangeOpenOrdersVerifiedAt = Date.now();
          sawValidSnapshot = true;
          const remaining = wanted
            ? real.filter((o) => wanted.has(String(o.orderId)))
            : real;
          lastRemaining = remaining.length;
          if (remaining.length === 0) {
            stableEmpty++;
            if (stableEmpty >= this._cancelVerifyStableReads) return true;
          } else {
            stableEmpty = 0;
          }
        } else {
          stableEmpty = 0;
        }
      } catch (e) {
        lastError = e;
        stableEmpty = 0;
      }
      if (attempt < this._cancelVerifyAttempts) await sleep(this._cancelVerifyDelayMs);
    }
    if (!sawValidSnapshot) {
      throw new Error('撤单请求已发送，但无法从交易所读取挂单快照进行确认'
        + (lastError ? `：${lastError?.message || lastError}` : '。'));
    }
    throw new Error(`撤单未完成确认：交易所仍检测到 ${lastRemaining ?? '未知'} 笔目标挂单。`);
  }

  /** Refresh the displayed real-order count without turning a successful trade
   * action into a failure when the exchange's read endpoint is temporarily slow. */
  async _refreshExchangeOpenOrderCount() {
    if (!this.config || typeof this.ex.fetchOpenOrders !== 'function') return null;
    try {
      const real = await this.ex.fetchOpenOrders(this.config.marketId);
      if (!Array.isArray(real)) return null;
      this._exchangeOpenOrders = real.length;
      this._exchangeOpenOrdersVerifiedAt = Date.now();
      return real.length;
    } catch {
      return null;
    }
  }

  /** Ensure no order submission can land after the cancellation confirmation. */
  async _waitForPendingPlacements() {
    const deadline = Date.now() + 300_000;
    while (this._pendingLevels.size > 0 || this._placementPasses > 0 || this._retryDrainInFlight) {
      if (Date.now() >= deadline) {
        throw new Error(`仍有下单/安全重试流程未结束（在途 ${this._pendingLevels.size} 笔），无法安全开始撤单。`);
      }
      await sleep(50);
    }
  }

  /** Cancel a whole market and forget local adapter state only after confirmation. */
  async _cancelAllConfirmed(marketId, action = '撤销全部挂单') {
    await this._waitForPendingPlacements();
    let accepted;
    try { accepted = await this.ex.cancelAll(marketId); }
    catch (e) { throw new Error(`${action}失败：${e?.message || e}`); }
    if (accepted === false) throw new Error(`${action}失败：交易所未接受撤单请求。`);
    try { await this._confirmOrdersGone(marketId); }
    catch (e) { throw new Error(`${action}后未能完成确认：${e?.message || e}`); }
    try { this.ex.forgetOrders?.(marketId); } catch { /* remote state is authoritative */ }
    return true;
  }

  /** @param cfg {marketId, mode, lower, upper, gridCount, sizeBase, leverage, outOfRangeAction} */
  async start(cfg) {
    if (this.running || this._starting) throw new Error('机器人已在运行或正在启动，请勿重复点击。');
    // 防重复挂单：即使程序内存显示未运行（如重启后 restore 不续跑），
    // 只要 MT5 上该品种仍挂着本程序的 magic 单，就拒绝再次启动，
    // 避免同一品种重复挂一批网格单。
    if (typeof this.ex.fetchOpenOrders === 'function' && this.config?.marketId != null) {
      let real;
      try { real = await this.ex.fetchOpenOrders(this.config.marketId); }
      catch { real = null; }
      if (Array.isArray(real) && real.length > 0) {
        throw new Error(`MT5 上仍挂有 ${real.length} 个本程序挂单（magic ${this.ex.magic}）。如需重新启动，请先「停止并平仓」或「撤销所有挂单（保留持仓）」。`);
      }
    }
    this._starting = true;
    try { return await this._start(cfg); }
    finally { this._starting = false; }
  }

  async _start(cfg) {
    const market = (await this.ex.getMarkets()).find((m) => m.marketId === Number(cfg.marketId));
    if (!market) throw new Error('找不到该市场 marketId=' + cfg.marketId);

    const leverage = Math.min(Number(cfg.leverage || 3), market.maxLeverage || 50);
    const sizeBase = Math.max(Number(cfg.sizeBase), market.minOrderSize || 0);
    this.config = {
      marketId: market.marketId, displayName: market.displayName,
      mode: cfg.mode || 'neutral',
      lower: Number(cfg.lower), upper: Number(cfg.upper),
      gridCount: Number(cfg.gridCount), sizeBase, leverage,
      // 区间外止损策略：'close'=冲破区间平仓（撤单+平仓+停止）；'recover'=只减仓回收阶梯
      outOfRangeAction: cfg.outOfRangeAction === 'recover' ? 'recover' : 'close',
      stepSize: market.stepSize, stepPrice: market.stepPrice,
      // 合约规模：外汇/CFD 保证金按手数×合约规模计算（1 手 EURUSD=10万、XAUUSD=100盎司）
      contractSize: Number(market.contractSize) > 0 ? Number(market.contractSize) : 1,
    };
    this.grid = buildGrid({ lower: this.config.lower, upper: this.config.upper, gridCount: this.config.gridCount });
    this._recomputeRisk();
    this._refillPausedUntil = 0; this._cancelTimes = []; // fresh start clears any back-off
    this._retryQueue = []; this._noPosStreak = 0;
    this._placementProgress = null;
    this.recovery = false;

    // record the starting equity up front (margin pre-check, returnPct, recovery)
    if (this.startBalance == null) {
      // live 模式优先用账户真实初始余额（EA 上报后锁定），
      // 避免启动瞬间 EA 未上报时把 PAPER_BALANCE 兜底值当基线
      this.startBalance =
        (this.ex.mode === 'live' && Number.isFinite(this.ex._baseBalance))
          ? this.ex._baseBalance
          : (typeof this.ex.equity === 'number' ? this.ex.equity
            : typeof this.ex.balance === 'number' ? this.ex.balance : null);
    }

    // ---- margin pre-check ----
    const requiredMargin = this.risk.requiredMargin;
    const available = typeof this.ex.equity === 'number' ? this.ex.equity
      : typeof this.ex.balance === 'number' ? this.ex.balance : null;
    if (available != null) {
      if (requiredMargin > available) {
        throw new Error(`保证金不足：该网格约需 ${round2(requiredMargin)} USDC（名义敞口 ${this.risk.notional}，${leverage}x），当前可用 ${round2(available)} USDC。请降低每格数量/网格数，或提高杠杆/充值后再启动。`);
      }
      if (requiredMargin > available * 0.8) {
        this._alert(`⚠️ 保证金占用偏高：约 ${round2(requiredMargin)} / 可用 ${round2(available)} USDC（>80%），价格波动时有强平风险。`);
      }
    }

    // ---- fee vs spacing sanity check ----
    const feeRate = Number(this.ex.feeRate) || 0.0005;
    const roundTripFeePct = feeRate * 2 * 100;
    if (this.risk.spacingPct <= roundTripFeePct) {
      this._alert(`⚠️ 网格间距 ${this.risk.spacingPct}% 不足以覆盖往返手续费（约 ${round2(roundTripFeePct)}%），每完成一格可能亏损。建议拉大间距或减少网格数。`);
    }

    const levOk = await this.ex.setLeverage(market.marketId, leverage).catch(() => false);
    if (levOk === false) this._alert(`⚠️ 杠杆设置 ${leverage}x 未生效，将沿用交易所端该市场的当前杠杆，请在交易所网页端核实后再继续。`);
    await this._cancelAllConfirmed(market.marketId, '启动网格前撤销原有挂单');

    this.lastPrice = await this.ex.getPrice(market.marketId);
    if (!Number.isFinite(this.lastPrice) || this.lastPrice <= 0) {
      throw new Error('未能获取有效的最新价（行情中断），已取消启动以免错挂网格单。请稍后重试。');
    }
    if (this.lastPrice < this.config.lower * 0.5 || this.lastPrice > this.config.upper * 2) {
      throw new Error(`最新价 ${this.lastPrice} 与网格区间 [${this.config.lower}, ${this.config.upper}] 偏离过大，已取消启动。请刷新行情后重设区间。`);
    }
    this.outOfRange = this.lastPrice < this.config.lower || this.lastPrice > this.config.upper;

    this.ex.on('fill', this._onFill);
    this.ex.on('price', this._onPrice);
    if (typeof this.ex.start === 'function') this.ex.start();

    // ---- seed the ladder (every seed order is an OPENING leg) ----
    const seeds = seedOrders({ levels: this.grid.levels, price: this.lastPrice, mode: this.config.mode, spacing: this.grid.spacing });
    const placementId = this._beginPlacementProgress('start', seeds);
    // Mark the bot as running before the RHC seed pass. A seed order can fill
    // while later batches are still being submitted; fill
    // handling and crash-safe persistence must already be active at that point.
    this.running = true;
    this._changed();
    await this._placeMany(seeds.map((s) => ({ ...s, opening: true, _placementId: placementId })));
    this._finishPlacementPass();

    await this._refreshExchangeOpenOrderCount();

    if (this.startBalance == null && typeof this.ex.balance === 'number') this.startBalance = this.ex.balance;
    this._startReconcileTimer();
    const progress = this._placementProgressView();
    if (progress?.status === 'complete') {
      this._alert(`启动完成：${this.config.displayName} ${labelMode(this.config.mode)}，${this.grid.count} 格，间距 ${this.grid.spacing}（${this.risk.spacingPct}%），杠杆 ${leverage}x；目标 ${progress.target} 单 / 已确认 ${progress.confirmed} 单 / 待重试 0 单。`);
      this._placementProgress.completionAlerted = true;
    } else {
      this._alert(`网格已进入运行管理，但启动挂单尚未全部确认：目标 ${progress?.target ?? seeds.length} 单 / 已确认 ${progress?.confirmed ?? this.active.size} 单 / 待安全重试 ${progress?.pending ?? 0} 单。程序会先与交易所对账再补挂。`);
    }
    this._changed();
    return this.getState();
  }

  async stop({ closePosition = true } = {}) {
    const wasRunning = this.running;
    this._pauseTradingRuntime();
    try {
      if (this.config) await this._cancelAllConfirmed(this.config.marketId, '停止网格时撤销挂单');
    } catch (e) {
      if (wasRunning) this._resumeTradingRuntime();
      this._alert(`❌ ${e?.message || e} 已中止停止/平仓流程，本地挂单跟踪已保留。`);
      this._changed();
      throw e;
    }
    if (!this.running) {
      if (this.config) {
        if (closePosition && typeof this.ex.closePosition === 'function') {
          await this._closeWithConfirm(this.config.marketId);
        }
        this._alert('已尝试撤销该市场的所有挂单并平仓。');
      }
      this.active.clear();
      this._retryQueue = [];
      this._placementProgress = null;
      this._changed();
      return this.getState();
    }
    this.active.clear();
    let closeRequested = false;
    if (closePosition && typeof this.ex.closePosition === 'function') {
      await this._closeWithConfirm(this.config.marketId);
      closeRequested = true;
    }
    this.running = false;
    this.recovery = false;
    this._retryQueue = [];
    this._placementProgress = null;
    this._alert(closeRequested
      ? '机器人已停止：挂单已撤销，已发送平仓指令（请在交易所确认仓位已平）。'
      : '机器人已停止，挂单已撤销（未平仓）。');
    this._changed();
    return this.getState();
  }

  /**
   * One-click: cancel ALL resting orders for this market WITHOUT touching the
   * open POSITION. Also stops the grid (running=false) and detaches handlers so
   * no later automated action (fill replacements / auto-stop) can affect the
   * position afterwards. To resume trading, start the grid again.
   */
  async cancelAllOrders() {
    if (!this.config) throw new Error('尚未配置市场，没有可撤的挂单。');
    const wasRunning = this.running;
    this._pauseTradingRuntime();
    try {
      await this._cancelAllConfirmed(this.config.marketId, '一键撤销挂单');
    } catch (e) {
      if (wasRunning) this._resumeTradingRuntime();
      this._alert(`❌ ${e?.message || e} 本地跟踪和网格运行状态已保留。`);
      this._changed();
      throw e;
    }
    this.active.clear();
    this.running = false;
    this._refillPausedUntil = 0; this._cancelTimes = []; this._retryQueue = [];
    this._placementProgress = null;
    this._alert(`已一键撤销该市场全部挂单（持仓保留、未平仓），交易所已连续确认当前 ${this._exchangeOpenOrders ?? 0} 单。网格已停止，如需继续请重新启动。`);
    this._changed();
    return this.getState();
  }

  /**
   * Adjust the grid's price range WITHOUT stopping. Margin is re-checked against
   * the new range; if it passes, current orders are cancelled and the ladder is
   * re-seeded around the live price. The open POSITION is left untouched.
   */
  async adjustRange({ lower, upper }) {
    if (!this.running || !this.config) throw new Error('网格未在运行，无法调整区间。');
    const lo = Number(lower), hi = Number(upper);
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || !(hi > lo)) throw new Error('上边界必须大于下边界。');
    const price = this.lastPrice;
    if (Number.isFinite(price) && (price < lo * 0.5 || price > hi * 2)) {
      throw new Error(`新区间 [${lo}, ${hi}] 与当前价 ${round2(price)} 偏离过大，已取消调整。`);
    }
    const newGrid = buildGrid({ lower: lo, upper: hi, gridCount: this.config.gridCount });
    const mid = (lo + hi) / 2;
    const cs = Number(this.config.contractSize) > 0 ? Number(this.config.contractSize) : 1;
    const notional = newGrid.count * this.config.sizeBase * cs * mid;
    const requiredMargin = notional / this.config.leverage;
    const available = typeof this.ex.equity === 'number' ? this.ex.equity
      : typeof this.ex.balance === 'number' ? this.ex.balance : null;
    if (available != null && requiredMargin > available) {
      throw new Error(`保证金不足以支持新区间：约需 ${round2(requiredMargin)} USDC，当前可用 ${round2(available)} USDC。请缩小区间/减少格数后再试。`);
    }

    this._pauseTradingRuntime();
    try {
      await this._cancelAllConfirmed(this.config.marketId, '调整区间前撤销原网格挂单');
    } catch (e) {
      this._resumeTradingRuntime();
      this._alert(`❌ ${e?.message || e} 已取消区间调整，保留原网格状态。`);
      this._changed();
      throw e;
    }
    this.active.clear();
    this._refillPausedUntil = 0; this._cancelTimes = []; // user re-set the range: clear back-off
    this._retryQueue = [];
    this._placementProgress = null;
    this.config = { ...this.config, lower: lo, upper: hi };
    this.grid = newGrid;
    this._recomputeRisk();
    this.outOfRange = Number.isFinite(price) ? (price < lo || price > hi) : false;
    this._resumeTradingRuntime();
    if (!this.outOfRange && Number.isFinite(price) && price > 0) {
      const seeds = seedOrders({ levels: newGrid.levels, price, mode: this.config.mode, spacing: newGrid.spacing });
      const placementId = this._beginPlacementProgress('adjust', seeds);
      await this._placeMany(seeds.map((s) => ({ ...s, opening: true, _placementId: placementId })));
      this._finishPlacementPass();
    }
    await this._refreshExchangeOpenOrderCount();
    const adjustProgress = this._placementProgressView();
    this._alert(adjustProgress && adjustProgress.status !== 'complete'
      ? `区间已调整为 [${lo}, ${hi}]（持仓保留）；新挂单目标 ${adjustProgress.target} / 已确认 ${adjustProgress.confirmed} / 待安全重试 ${adjustProgress.pending}。`
      : `已调整区间为 [${lo}, ${hi}]，${newGrid.count} 格，间距 ${newGrid.spacing}（${this.risk.spacingPct}%），重新挂出 ${this.active.size} 单（持仓保留）。`);
    this._changed();
    return this.getState();
  }

  /**
   * 一键补格（手动触发）：把当前没有挂单的网格档位重新补种上开仓单——低于现价
   * 补买、高于现价补卖，与启动铺单逻辑一致。之所以只做手动：对账机制故意不自动
   * 补开仓单（自动补种曾导致单方向持续开仓的事故），由人工确认场景安全后再补。
   */
  async refillGrid() {
    if (!this.running || !this.config || !this.grid) throw new Error('网格未在运行，无法补格。');
    if (this.recovery) throw new Error('回收模式没有网格，无需补格。');
    if (this.outOfRange) throw new Error('价格在区间外，暂不能补格；等价格回到区间内再操作。');
    if (this._refillPausedUntil && Date.now() < this._refillPausedUntil) {
      throw new Error('订单频繁被取消的保护期内，暂不补格，请稍后再试。');
    }
    const price = this.lastPrice;
    if (!Number.isFinite(price) || price <= 0) throw new Error('未能获取有效最新价，请稍后重试。');
    // 先对账：拿到真实占用情况（交易所上已有的挂单会被接管而不是重复补）
    await this.reconcileOpenOrders().catch(() => {});
    const occupied = new Set([...this.active.values()].map((o) => o.levelIndex));
    const seeds = seedOrders({ levels: this.grid.levels, price, mode: this.config.mode, spacing: this.grid.spacing })
      .filter((s) => !occupied.has(s.levelIndex));
    if (!seeds.length) {
      this._placementProgress = null;
      this._alert('补格检查：所有格位都已有挂单，无需补格。');
      this._changed();
      return this.getState();
    }
    // 新增开仓单的保证金预检
    const cs = Number(this.config.contractSize) > 0 ? Number(this.config.contractSize) : 1;
    const addMargin = (seeds.length * this.config.sizeBase * cs * price) / this.config.leverage;
    const available = typeof this.ex.equity === 'number' ? this.ex.equity
      : typeof this.ex.balance === 'number' ? this.ex.balance : null;
    if (available != null && addMargin > available) {
      throw new Error(`保证金不足以补 ${seeds.length} 格：约需 ${round2(addMargin)} USDC，当前权益 ${round2(available)} USDC。`);
    }
    if (available != null && addMargin > available * 0.5) {
      this._alert(`⚠️ 补格将新占用约 ${round2(addMargin)} USDC 保证金（超过权益一半），请留意强平风险。`);
    }
    const before = this.active.size;
    const placementId = this._beginPlacementProgress('refill', seeds);
    await this._placeMany(seeds.map((s) => ({ ...s, opening: true, _placementId: placementId })));
    this._finishPlacementPass();
    const placed = this.active.size - before;
    const verified = await this._refreshExchangeOpenOrderCount();
    const refillProgress = this._placementProgressView();
    this._alert(refillProgress && refillProgress.status !== 'complete'
      ? `补格已提交但尚未全部确认：目标 ${refillProgress.target} / 已确认 ${refillProgress.confirmed} / 待安全重试 ${refillProgress.pending}${verified == null ? '；真实挂单总数暂未确认' : `；交易所当前真实挂单 ${verified} 单`}。`
      : `一键补格完成：发现 ${seeds.length} 个空格位，成功补挂 ${placed} 单${verified == null ? '；交易所真实挂单数暂未确认' : `；交易所确认当前 ${verified} 单`}。`);
    this._changed();
    return this.getState();
  }

  /** Zero cumulative stats and re-baseline PnL to the current equity. */
  resetStats() {
    this.stats = { buys: 0, sells: 0, completedRungs: 0, gridProfit: 0, volume: 0 };
    this.fills = [];
    this._placeFails = 0;
    this._lastFailAt = 0;
    this._refillPausedUntil = 0; this._cancelTimes = [];
    this.startBalance = typeof this.ex.equity === 'number' ? this.ex.equity
      : typeof this.ex.balance === 'number' ? this.ex.balance : this.startBalance;
    // Offset-based reset: adapters like RISEx refresh realizedPnl from the
    // exchange every poll, so writing 0 into it never sticks — record a
    // baseline instead and subtract it in getState.
    this._pnlBase = typeof this.ex.realizedPnl === 'number' ? this.ex.realizedPnl : null;
    this._alert('已重置统计：已实现盈亏、收益率、成交量、完成格数清零，并以当前权益为新基准。');
    this._changed();
    return this.getState();
  }

  _recomputeRisk() {
    if (!this.grid || !this.config) return;
    const mid = (this.config.lower + this.config.upper) / 2;
    // 外汇保证金：名义敞口 = 格数 × 手数 × 合约规模 × 中间价
    const cs = Number(this.config.contractSize) > 0 ? Number(this.config.contractSize) : 1;
    const notional = this.grid.count * this.config.sizeBase * cs * mid;
    this.risk = {
      leverage: this.config.leverage,
      notional: round2(notional),
      requiredMargin: round2(notional / this.config.leverage),
      perRungProfit: round2(this.grid.spacing * this.config.sizeBase * cs),
      spacingPct: round2((this.grid.spacing / mid) * 100),
    };
  }

  _beginPlacementProgress(action, orders) {
    const levels = [...new Set((orders || []).map((o) => Number(o.levelIndex)).filter(Number.isFinite))];
    const id = `${Date.now()}-${(++this._coidSeq) % 1_000_000}`;
    this._placementProgress = {
      id, action, target: levels.length,
      // Retain only public order intent (no credentials/signatures). If the
      // process exits during a paced seed pass, resume can reconstruct the
      // still-pending levels and continue through the same safe retry path.
      orders: (orders || []).map((o) => ({
        levelIndex: Number(o.levelIndex), side: o.side, price: Number(o.price),
        sizeBase: Number(o.sizeBase) > 0 ? Number(o.sizeBase) : this.config?.sizeBase,
        opening: o.opening !== false, reduceOnly: !!o.reduceOnly, recovery: !!o.recovery,
        _placementId: id,
      })),
      confirmedLevels: [], pendingLevels: levels, failedLevels: [],
      status: levels.length ? 'placing' : 'complete', initialPassDone: false,
      completionAlerted: false, updatedAt: Date.now(),
    };
    return id;
  }

  _restorePendingPlacementRetries() {
    const p = this._placementProgress;
    if (!p || !this.ex.supportsSafeOpeningRetry || !Array.isArray(p.orders)) return;
    p.initialPassDone = true;
    const pending = new Set(p.pendingLevels || []);
    for (const order of p.orders) {
      if (!pending.has(order.levelIndex)) continue;
      if (this._retryQueue.some((x) => x.levelIndex === order.levelIndex && x._placementId === p.id)) continue;
      this._retryQueue.push({ ...order, _placementId: p.id, _tries: 0, _nextAt: Date.now() + 30_000, _lastError: '程序重启后恢复未完成挂单' });
    }
    this._refreshPlacementProgress(p);
  }

  _progressFor(order) {
    const p = this._placementProgress;
    return p && order?._placementId === p.id ? p : null;
  }

  _refreshPlacementProgress(p = this._placementProgress) {
    if (!p) return;
    const confirmed = new Set(p.confirmedLevels || []);
    const failed = new Set(p.failedLevels || []);
    p.pendingLevels = [...new Set(p.pendingLevels || [])].filter((level) => !confirmed.has(level) && !failed.has(level));
    if (!p.initialPassDone) p.status = p.target ? 'placing' : 'complete';
    else if (confirmed.size >= p.target) p.status = 'complete';
    else if (p.pendingLevels.length) p.status = 'retrying';
    else p.status = 'incomplete';
    p.updatedAt = Date.now();
  }

  _markPlacementConfirmed(order) {
    const p = this._progressFor(order);
    if (!p) return;
    const level = Number(order.levelIndex);
    if (!Number.isFinite(level)) return;
    if (!p.confirmedLevels.includes(level)) p.confirmedLevels.push(level);
    p.pendingLevels = p.pendingLevels.filter((x) => x !== level);
    p.failedLevels = p.failedLevels.filter((x) => x !== level);
    const was = p.status;
    this._refreshPlacementProgress(p);
    if (p.initialPassDone && was !== 'complete' && p.status === 'complete' && !p.completionAlerted) {
      p.completionAlerted = true;
      const label = p.action === 'refill' ? '补格' : p.action === 'adjust' ? '区间调整挂单' : '启动挂单';
      this._alert(`${label}已全部确认：目标 ${p.target} 单 / 已确认 ${p.target} 单 / 待重试 0 单。`);
    }
  }

  _markPlacementPending(order) {
    const p = this._progressFor(order);
    if (!p) return;
    const level = Number(order.levelIndex);
    if (!Number.isFinite(level) || p.confirmedLevels.includes(level) || p.failedLevels.includes(level)) return;
    if (!p.pendingLevels.includes(level)) p.pendingLevels.push(level);
    this._refreshPlacementProgress(p);
  }

  _markPlacementFailed(order) {
    const p = this._progressFor(order);
    if (!p) return;
    const level = Number(order.levelIndex);
    if (!Number.isFinite(level)) return;
    p.pendingLevels = p.pendingLevels.filter((x) => x !== level);
    if (!p.failedLevels.includes(level)) p.failedLevels.push(level);
    this._refreshPlacementProgress(p);
  }

  _finishPlacementPass() {
    if (!this._placementProgress) return;
    this._placementProgress.initialPassDone = true;
    this._refreshPlacementProgress();
  }

  _placementProgressView() {
    const p = this._placementProgress;
    if (!p) return null;
    return {
      action: p.action, target: p.target,
      confirmed: (p.confirmedLevels || []).length,
      pending: (p.pendingLevels || []).length,
      failed: (p.failedLevels || []).length,
      status: p.status, updatedAt: p.updatedAt,
    };
  }

  async _place(o) {
    const opening = o.opening !== false;
    const reduceOnly = o.reduceOnly ?? isReduceOnly(o.side, this.config.mode);
    // Back-off: while paused (after a burst of cancellations / collateral
    // rejections) do not place new OPENING orders. CLOSING / reduce-only /
    // recovery legs need no extra margin and are never blocked — dropping a
    // take-profit leg would strand its inventory without an exit order.
    if (opening && !o.recovery && this._refillPausedUntil && Date.now() < this._refillPausedUntil) return;
    // INVARIANT: at most ONE resting order per grid level. If this level is
    // already covered (or a placement for it is in flight), skip. Stacking a
    // second order on an occupied level is exactly what made the open-order
    // count creep up over time (replacement-one-rung-away colliding with the
    // order already resting there).
    const lvl = o.levelIndex;
    if (this._pendingLevels.has(lvl)) return;
    for (const a of this.active.values()) if (a.levelIndex === lvl) return;
    this._pendingLevels.add(lvl);
    const seq = (++this._coidSeq) % 1_000_000;
    const clientOrderId = Number(`${Date.now() % 1_000_000_0}${String(seq).padStart(6, '0')}`);
    const sizeBase = Number(o.sizeBase) > 0 ? Number(o.sizeBase) : this.config.sizeBase; // per-order override (partial fills)
    try {
      const r = await this.ex.placeLimitOrder({
        marketId: this.config.marketId, side: o.side, price: o.price,
        sizeBase, reduceOnly,
        levelIndex: o.levelIndex, clientOrderId,
      }).catch((e) => {
        this._placeFails++; this._lastFailAt = Date.now();
        this._alert('下单失败: ' + e.message);
        this._queueRetry({ ...o, opening, reduceOnly, sizeBase }, e);
        return null;
      });
      if (r?.orderId) {
        this.active.set(String(r.orderId), { levelIndex: lvl, side: o.side, price: o.price, sizeBase, opening, recovery: !!o.recovery, placedAt: Date.now() });
        this._markPlacementConfirmed(o);
      }
    } finally {
      this._pendingLevels.delete(lvl);
    }
  }

  /**
   * Batch-capable seed placement. Exchanges without a batch API retain the
   * original one-by-one behavior. Healthy batches are submitted continuously;
   * only an actual exchange rate-limit response stops the pass and moves the
   * current plus remaining levels into the reconciled retry queue.
   */
  async _placeMany(orders) {
    if (typeof this.ex.placeLimitOrders !== 'function') {
      for (const order of orders) await this._place(order);
      return;
    }
    const ready = [];
    const reservedLevels = new Set();
    for (const o of orders) {
      const opening = o.opening !== false;
      const reduceOnly = o.reduceOnly ?? isReduceOnly(o.side, this.config.mode);
      if (opening && !o.recovery && this._refillPausedUntil && Date.now() < this._refillPausedUntil) continue;
      const levelIndex = o.levelIndex;
      if (this._pendingLevels.has(levelIndex) || reservedLevels.has(levelIndex)) {
        if (o._tries) this._retryQueue.push({ ...o, _nextAt: Date.now() + 5_000 });
        continue;
      }
      if ([...this.active.values()].some((a) => a.levelIndex === levelIndex)) {
        this._markPlacementConfirmed(o);
        continue;
      }
      reservedLevels.add(levelIndex);
      const seq = (++this._coidSeq) % 1_000_000;
      const clientOrderId = Number(`${Date.now() % 1_000_000_0}${String(seq).padStart(6, '0')}`);
      const sizeBase = Number(o.sizeBase) > 0 ? Number(o.sizeBase) : this.config.sizeBase;
      ready.push({
        source: o, opening, reduceOnly, levelIndex, sizeBase,
        payload: {
          marketId: this.config.marketId, side: o.side, price: o.price,
          sizeBase, reduceOnly, levelIndex, clientOrderId,
        },
      });
    }
    const batchSize = Math.max(1, Math.min(15, Number(this.ex.orderBatchSize) || 15));
    const paceMs = Math.max(0, Number(this.ex.orderBatchPaceMs) || 0);
    this._placementPasses++;
    try {
      for (let offset = 0; offset < ready.length; offset += batchSize) {
        // A fill during startup can occupy a future seed level. Recheck
        // immediately before each batch so the closing leg wins and no duplicate
        // opening order is stacked on that level.
        const chunk = ready.slice(offset, offset + batchSize).filter((item) => {
          if (this._pendingLevels.has(item.levelIndex)) return false;
          if ([...this.active.values()].some((a) => a.levelIndex === item.levelIndex)) {
            this._markPlacementConfirmed(item.source);
            return false;
          }
          this._pendingLevels.add(item.levelIndex);
          return true;
        });
        if (!chunk.length) continue;
        let results;
        let waitAfterMs = offset + batchSize < ready.length ? paceMs : 0;
        let stopForRateLimit = false;
        try {
          results = await this.ex.placeLimitOrders(chunk.map((x) => x.payload));
          if (!Array.isArray(results) || results.length !== chunk.length) throw new Error('交易所批量下单返回数量不一致。');
        } catch (e) {
          this._placeFails += chunk.length; this._lastFailAt = Date.now();
          this._alert(`批量下单失败（${chunk.length} 笔）: ${e?.message || e}`);
          for (const item of chunk) this._queueRetry({ ...item.source, opening: item.opening, reduceOnly: item.reduceOnly, sizeBase: item.sizeBase }, e);
          if (e?.rateLimited || e?.status === 429) {
            waitAfterMs = Math.max(waitAfterMs, Number(e.retryAfterMs) || Number(this.ex.openingRetryBaseMs) || 30_000);
            stopForRateLimit = true;
            // Do not keep hammering later batches after the exchange has
            // explicitly rate-limited this write. Queue every untouched level
            // for the same de-duplicating retry path and end this pass now.
            for (const item of ready.slice(offset + batchSize)) {
              this._queueRetry({ ...item.source, opening: item.opening, reduceOnly: item.reduceOnly, sizeBase: item.sizeBase }, e);
            }
          }
          results = null;
        }
        if (results) {
          for (let i = 0; i < chunk.length; i++) {
            const item = chunk[i], result = results[i];
            if (result?.orderId) {
              this.active.set(String(result.orderId), {
                levelIndex: item.levelIndex, side: item.source.side,
                price: Number(result.price ?? item.source.price),
                sizeBase: Number(result.sizeBase ?? item.sizeBase),
                opening: item.opening, recovery: !!item.source.recovery, placedAt: Date.now(),
              });
              this._markPlacementConfirmed(item.source);
            } else {
              this._placeFails++; this._lastFailAt = Date.now();
              const error = new Error(`批量下单中的 level ${item.levelIndex} 未被交易所确认。`);
              this._alert(error.message);
              this._queueRetry({ ...item.source, opening: item.opening, reduceOnly: item.reduceOnly, sizeBase: item.sizeBase }, error);
            }
          }
        }
        for (const item of chunk) this._pendingLevels.delete(item.levelIndex);
        this._changed();
        if (stopForRateLimit) break;
        if (waitAfterMs > 0 && offset + batchSize < ready.length) await sleep(waitAfterMs);
      }
    } finally {
      for (const item of ready) this._pendingLevels.delete(item.levelIndex);
      this._placementPasses--;
    }
  }

  /**
   * Queue a failed placement. Closing/reduce-only orders remain intrinsically
   * safe to retry. Opening orders are accepted only for adapters (currently RHC)
   * that opt into the two-snapshot, level-de-duplicated retry path below.
   */
  _queueRetry(o, error = null) {
    const opening = o.opening !== false && !o.reduceOnly && !o.recovery;
    if (opening && !this.ex.supportsSafeOpeningRetry) return;
    const tries = (o._tries || 0) + 1;
    const maxTries = opening ? (Number(this.ex.openingRetryMax) || 8) : 5;
    if (tries > maxTries) {
      this._markPlacementFailed(o);
      this._alert(opening
        ? `❌ 开仓挂单（level ${o.levelIndex} @ ${o.price}）连续 ${tries - 1} 次安全重试仍失败，已停止自动重试。请到交易所核实。`
        : `❌ 补挂平仓单（level ${o.levelIndex} @ ${o.price}）连续 ${tries - 1} 次失败，已放弃。请到交易所核实并手动挂单。`);
      return;
    }
    const configuredBase = Number(this.ex.openingRetryBaseMs) || 30_000;
    // Fast first retry is reserved for an explicit rate-limit response. Other
    // failures retain a five-second floor so transient network/server errors do
    // not create a tight loop.
    const base = opening
      ? (error?.rateLimited ? configuredBase : Math.max(5_000, configuredBase))
      : 5_000;
    const exponential = opening ? Math.min(60_000, base * (2 ** (tries - 1))) : base * tries;
    const delay = Math.max(exponential, Number(error?.retryAfterMs) || 0);
    const queued = { ...o, _tries: tries, _nextAt: Date.now() + delay, _lastError: error?.message || String(error || '') };
    const existing = this._retryQueue.find((x) => x.levelIndex === queued.levelIndex && x._placementId === queued._placementId);
    if (existing) {
      existing._nextAt = Math.max(existing._nextAt, queued._nextAt);
      existing._tries = Math.max(existing._tries || 0, tries);
      existing._lastError = queued._lastError;
    } else {
      this._retryQueue.push(queued);
    }
    this._markPlacementPending(queued);
  }

  /** Retry due placements (driven by price ticks + reconcile timer). */
  _drainRetryQueue() {
    if (!this.running || !this._retryQueue.length || this._retryDrainInFlight || this._placementPasses > 0) return Promise.resolve();
    this._retryDrainInFlight = true;
    return this._drainRetryQueueNow().finally(() => { this._retryDrainInFlight = false; });
  }

  async _drainRetryQueueNow() {
    const now = Date.now();
    const due = [];
    this._retryQueue = this._retryQueue.filter((o) => (o._nextAt <= now ? (due.push(o), false) : true));
    if (!due.length) return;
    const opening = due.filter((o) => o.opening !== false && !o.reduceOnly && !o.recovery);
    const ready = due.filter((o) => !opening.includes(o));
    if (opening.length) {
      try {
        const snapshots = [];
        for (let i = 0; i < 2; i++) {
          const rows = await this.ex.fetchOpenOrders(this.config.marketId);
          if (!Array.isArray(rows)) throw new Error('交易所没有返回有效挂单快照。');
          snapshots.push(rows);
          if (i === 0) await sleep(750);
        }
        const merged = new Map();
        for (const rows of snapshots) for (const order of rows) merged.set(String(order.orderId), order);
        this._exchangeOpenOrders = snapshots.at(-1).length;
        this._exchangeOpenOrdersVerifiedAt = Date.now();
        const byLevel = new Map();
        for (const order of merged.values()) {
          const px = Number(order.price);
          if (!Number.isFinite(px) || !this.grid?.spacing) continue;
          const level = Math.round((px - this.grid.levels[0]) / this.grid.spacing);
          if (level >= 0 && level < this.grid.levels.length && !byLevel.has(level)) byLevel.set(level, order);
        }
        for (const item of opening) {
          const real = byLevel.get(item.levelIndex);
          if (!real) { ready.push(item); continue; }
          if (![...this.active.values()].some((a) => a.levelIndex === item.levelIndex)) {
            const orderId = String(real.orderId);
            const side = real.side === 'buy' ? 'buy' : 'sell';
            try { this.ex.adoptOrder?.({ orderId, marketId: this.config.marketId, levelIndex: item.levelIndex, side, price: Number(real.price), sizeBase: Number(real.sizeBase || item.sizeBase || this.config.sizeBase) }); } catch {}
            this.active.set(orderId, { levelIndex: item.levelIndex, side, price: Number(real.price), sizeBase: Number(real.sizeBase || item.sizeBase || this.config.sizeBase), opening: item.opening !== false, recovery: false, placedAt: Date.now() });
          }
          this._markPlacementConfirmed(item);
        }
      } catch (e) {
        const retryAt = Date.now() + (Number(this.ex.openingRetryBaseMs) || 30_000);
        for (const item of due) {
          if (!this._retryQueue.some((x) => x.levelIndex === item.levelIndex && x._placementId === item._placementId)) {
            this._retryQueue.push({ ...item, _nextAt: retryAt });
          }
        }
        if (Date.now() - (this._lastRetryReconAlertAt || 0) > 30_000) {
          this._lastRetryReconAlertAt = Date.now();
          this._alert(`安全重试暂缓：无法连续读取两次交易所真实挂单（${e?.message || e}），本轮没有重新下单。`);
        }
        this._changed();
        return;
      }
    }
    if (!this.running) return;
    if (ready.length) await this._placeMany(ready);
    this._changed();
  }

  _handleFill(f) {
    if (!this.running || f.marketId !== this.config.marketId) return;
    const id = String(f.orderId);
    const act = this.active.get(id);
    this.active.delete(id);
    const levelIndex = act?.levelIndex ?? f.levelIndex;
    const fillPrice = Number.isFinite(f.price) ? f.price : (act?.price ?? 0);
    const fillSize = Number.isFinite(f.sizeBase) ? f.sizeBase : this.config.sizeBase;

    if (f.side === 'buy') this.stats.buys++; else this.stats.sells++;
    // 累计交易量：MT5 的单位是手（lots），直接累加成交手数。
    // （加密版原算法是 fillPrice × fillSize 按 USDT 金额计价，不适用于外汇。）
    this.stats.volume = round2(this.stats.volume + fillSize);
    this.fills.unshift({ t: Date.now(), side: f.side, price: fillPrice, size: fillSize, level: levelIndex });
    if (this.fills.length > 50) this.fills.pop();

    const isRecovery = !!(act && act.recovery);
    const closing = isRecovery ? true
      : (act ? act.opening === false
             : ((this.config.mode === 'short') ? f.side === 'buy' : f.side === 'sell'));
    if (closing) {
      this.stats.completedRungs++;
      // Incremental accumulation with the ACTUAL fill size: adjustRange no longer
      // rewrites history (the old code recomputed rungs × CURRENT spacing), and
      // partial fills are credited with what really executed.
      const sp = this.grid?.spacing ?? this.config.spacing ?? 0;
      this.stats.gridProfit = round2(this.stats.gridProfit + sp * fillSize);
    }

    // Recovery-ladder fills are pure reduce-only EXITS of stranded inventory —
    // never re-quote a replacement for them.
    if (!isRecovery && this.grid) {
      const repl = replacementFor({ side: f.side, levelIndex }, this.grid.levels, this.config.mode);
      if (repl && !this.outOfRange && this.running) {
        repl.opening = closing; // replacement is the opposite leg
        if (fillSize > 0) repl.sizeBase = fillSize; // partial fill: mirror the actually-filled qty
        this._place(repl);
      }
    }
    this._changed();
  }

  _handlePrice(p) {
    if (p.marketId !== this.config.marketId) return;
    this.lastPrice = p.price;
    this._drainRetryQueue().catch(() => {});
    if (this.recovery) { this._manageRecoveryStandalone(); return; }
    const out = p.price < this.config.lower || p.price > this.config.upper;
    const action = this.config.outOfRangeAction || 'close';
    if (out && !this.outOfRange) {
      this.outOfRange = true;
      const where = p.price < this.config.lower ? '跌破下边界' : '突破上边界';
      if (action === 'recover') {
        this._alert(`⚠️ 价格${where}（${round2(p.price)}），启用「只减仓回收阶梯」：暂停补单，挂出 reduce-only 单等回调分批减仓（只减不加、不自动止损，请自行控制风险）。`);
        this._placeRecoveryLadder();
      } else {
        this._alert(`⚠️ 价格${where}（${round2(p.price)}），触发「冲破区间平仓」：撤单 + 平仓 + 停止。`);
        if (!this._stopping) {
          this._stopping = true;
          this.stop({ closePosition: true }).catch(() => {}).finally(() => { this._stopping = false; });
        }
      }
    } else if (out && this.outOfRange && action === 'recover') {
      this._placeRecoveryLadder(); // extend the ladder as price makes new extremes (dedup keeps it idempotent)
    } else if (!out && this.outOfRange && !this._recoveryCancelInFlight) {
      // Do not resume normal refill/replacement activity until the exchange has
      // confirmed that every recovery order is really gone.
      this._recoveryCancelInFlight = true;
      this._cancelRecoveryLadder()
        .then(() => {
          this.outOfRange = false;
          this._alert(`价格回到区间内（${round2(p.price)}），已确认撤销回收阶梯，恢复正常网格运行。`);
          this._changed();
        })
        .catch((e) => {
          this._alert(`❌ 价格已回到区间，但回收阶梯撤单未确认：${e?.message || e} 暂不恢复正常补单。`);
          this._changed();
        })
        .finally(() => { this._recoveryCancelInFlight = false; });
    }
  }

  /**
   * 只减仓回收阶梯：价格冲出区间后，在「现价 ↔ 被冲破的边界」之间挂一批 reduce-only
   * 单。价格每回调一档就分批了结被套住的库存。reduce-only 保证「只减不加」（永远不会
   * 把套牢的仓位越加越大）；本策略不自动止损 —— 趋势继续单边延续会一直扛着。
   */
  _placeRecoveryLadder() {
    if (!this.running || !this.outOfRange || !this.grid) return;
    if ((this.config.outOfRangeAction || 'close') !== 'recover') return;
    const price = this.lastPrice;
    if (!Number.isFinite(price) || price <= 0) return;
    const pos = this.ex.getPosition?.(this.config.marketId);
    if (!pos || !pos.sizeBase) return; // 没有可减的持仓
    const sp = this.grid.spacing, lvl0 = this.grid.levels[0];
    const L = this.config.lower, U = this.config.upper;
    const long = pos.sizeBase > 0;
    const existing = new Set([...this.active.values()].filter((o) => o.recovery).map((o) => o.levelIndex));
    const maxRungs = this.grid.count;
    let placed = 0;
    const room = () => existing.size + placed < maxRungs;
    if (long && price < L) {
      // 跌破下边界、手里是多头：在「现价 ↔ 下边界」之间挂 reduce-only 卖单
      for (let lv = L - sp; lv > price && room(); lv -= sp) {
        const idx = Math.round((lv - lvl0) / sp);
        if (existing.has(idx)) continue;
        this._place({ levelIndex: idx, side: 'sell', price: lv, reduceOnly: true, recovery: true, opening: false });
        placed++;
      }
    } else if (!long && price > U) {
      // 突破上边界、手里是空头：在「上边界 ↔ 现价」之间挂 reduce-only 买单
      for (let lv = U + sp; lv < price && room(); lv += sp) {
        const idx = Math.round((lv - lvl0) / sp);
        if (existing.has(idx)) continue;
        this._place({ levelIndex: idx, side: 'buy', price: lv, reduceOnly: true, recovery: true, opening: false });
        placed++;
      }
    }
    if (placed) {
      this._alert(`回收阶梯：新挂 ${placed} 个 reduce-only ${long ? '卖' : '买'}单，等回调分批减仓。`);
      this._changed();
    }
  }

  /** Cancel all recovery-ladder orders (when price returns into range). */
  async _cancelRecoveryLadder() {
    const ids = [...this.active].filter(([, o]) => o.recovery).map(([id]) => id);
    if (!ids.length) return;
    let requestErrors = 0;
    for (const id of ids) {
      try { await this.ex.cancelOrder?.(this.config.marketId, id); }
      catch { requestErrors++; }
    }
    await this._confirmOrdersGone(this.config.marketId, ids);
    for (const id of ids) {
      this.active.delete(id);
      try { this.ex.forgetOrder?.(id); } catch { /* ignore local cleanup */ }
    }
    this._alert(`已确认撤销 ${ids.length} 个回收阶梯挂单${requestErrors ? `（${requestErrors} 笔撤单请求报错，但交易所快照已确认订单消失）` : ''}。`);
    this._changed();
  }

  // ============ 未托管持仓处置（开机扫描后手动选择）============

  /**
   * 只减仓回收阶梯（独立模式）：对一笔已存在的持仓，挂 reduce-only 单在反弹时分批
   * 减仓；只减不加、不需要新保证金、不自动止损。不需要完整网格。
   */
  async startRecovery(cfg) {
    if (this.running || this._starting) throw new Error('已在运行，请先停止再操作。');
    // 防重复挂单：MT5 上已有本程序挂单时拒绝再次挂回收阶梯
    if (typeof this.ex.fetchOpenOrders === 'function' && this.config?.marketId != null) {
      let real;
      try { real = await this.ex.fetchOpenOrders(this.config.marketId); }
      catch { real = null; }
      if (Array.isArray(real) && real.length > 0) {
        throw new Error(`MT5 上仍挂有 ${real.length} 个本程序挂单（magic ${this.ex.magic}）。如需重新操作，请先「撤销所有挂单（保留持仓）」或「停止并平仓」。`);
      }
    }
    this._starting = true;
    try {
      const market = (await this.ex.getMarkets()).find((m) => m.marketId === Number(cfg.marketId));
      if (!market) throw new Error('找不到该市场 marketId=' + cfg.marketId);
      const pos = this.ex.getPosition?.(market.marketId);
      if (!pos || !pos.sizeBase) throw new Error('该市场当前没有持仓，无需回收。');
      const price = await this.ex.getPrice(market.marketId);
      if (!Number.isFinite(price) || price <= 0) throw new Error('未能获取有效最新价，请稍后重试。');
      // 阶梯间距：入参 -> 上次网格间距 -> 现价的 0.15%
      let spacing = Number(cfg.spacing) || this.config?.spacing || this.grid?.spacing;
      if (!(spacing > 0)) spacing = Math.max(market.stepPrice || 0.1, price * 0.0015);
      // 每档减仓量：入参 -> 上次每格量 -> 持仓量/20
      let sizeBase = Number(cfg.sizeBase) || this.config?.sizeBase || (Math.abs(pos.sizeBase) / 20);
      sizeBase = Math.max(sizeBase, market.minOrderSize || 0);
      this.config = {
        marketId: market.marketId, displayName: market.displayName, mode: 'recovery',
        sizeBase, spacing, stepSize: market.stepSize, stepPrice: market.stepPrice,
        lower: null, upper: null, gridCount: null, leverage: pos.leverage ?? null,
        outOfRangeAction: 'recover',
        aboveEntryOnly: !!cfg.aboveEntryOnly, // 只在成本价上方(多)/下方(空)、即不亏的价位才挂减仓单
      };
      this.grid = null; this.risk = null;
      this.recovery = true; this.outOfRange = false; this.lastPrice = price;
      this._noPosStreak = 0; this._retryQueue = [];
      this._placementProgress = null;
      this.active.clear();
      if (this.startBalance == null) {
        this.startBalance = typeof this.ex.equity === 'number' ? this.ex.equity
          : typeof this.ex.balance === 'number' ? this.ex.balance : null;
      }
      this.ex.on('fill', this._onFill);
      this.ex.on('price', this._onPrice);
      if (typeof this.ex.start === 'function') this.ex.start();
      this.running = true;
      const dir = pos.sizeBase > 0 ? '多' : '空';
      const modeTxt = this.config.aboveEntryOnly ? '仅在成本价以上(不亏)分批减仓' : '任何反弹都分批减仓';
      this._alert(`已对 ${market.displayName} 的${dir}头 ${Math.abs(round6(pos.sizeBase))} 启用「只减仓回收阶梯」：${modeTxt}（只减不加、不自动止损，请自行控制风险）。`);
      // Seed against any orders ALREADY resting on the exchange (e.g. left over from
      // a prior recovery session) so we adopt/dedup them instead of stacking a whole
      // new ladder on top — the cause of the runaway open-order count.
      this._recoveryOccupied = new Set();
      await this.reconcileOpenOrders().catch(() => {});
      this._manageRecoveryStandalone();
      this._startReconcileTimer(); // keep deduping/pruning the ladder while it runs
      this._changed();
      return this.getState();
    } finally { this._starting = false; }
  }

  /** 市价平仓：撤销该市场全部挂单并立即市价平掉持仓。 */
  async closePositionNow(marketId) {
    const mId = Number(marketId ?? this.config?.marketId);
    if (!Number.isFinite(mId)) throw new Error('未指定市场，无法平仓。');
    const wasRunning = this.running;
    this._pauseTradingRuntime();
    try {
      await this._cancelAllConfirmed(mId, '市价平仓前撤销挂单');
    } catch (e) {
      if (wasRunning) this._resumeTradingRuntime();
      this._alert(`❌ ${e?.message || e} 已中止市价平仓，本地挂单跟踪已保留。`);
      this._changed();
      throw e;
    }
    this.active.clear();
    this._retryQueue = [];
    this._placementProgress = null;
    let closed = false;
    if (typeof this.ex.closePosition === 'function') {
      await this._closeWithConfirm(mId);
      closed = true;
    }
    this.running = false; this.recovery = false;
    this._alert(closed ? '已发送市价平仓指令并撤销该市场挂单（请在交易所确认已平）。' : '已撤销挂单（该交易所不支持自动平仓）。');
    this._changed();
    return this.getState();
  }

  /**
   * Send a market close and CONFIRM the position is actually gone (polls the
   * adapter's position cache). Retries up to 3 times — an IOC close capped at a
   * worst-case price (±5%) can miss entirely when the market moves fast; each
   * retry re-prices from the latest mark. The old code fired once and hoped.
   */
  async _closeWithConfirm(marketId) {
    const mId = Number(marketId);
    if (typeof this.ex.closePosition !== 'function') return false;
    if (!this.ex.getPosition?.(mId)) { await this.ex.closePosition(mId).catch(() => {}); return true; }
    for (let attempt = 1; attempt <= 3; attempt++) {
      try { await this.ex.closePosition(mId); }
      catch (e) { this._alert('平仓指令发送失败: ' + (e?.message || e)); }
      const t0 = Date.now();
      while (Date.now() - t0 < 8000) { // wait for the adapter's position poll to reflect it
        await sleep(1000);
        const pos = this.ex.getPosition?.(mId);
        if (!pos || !pos.sizeBase) { this._alert('✅ 已确认仓位已平。'); return true; }
      }
      if (attempt < 3) this._alert(`⚠️ 平仓后仓位仍在（第 ${attempt} 次），按最新价重试市价平仓…`);
    }
    this._alert('❌ 已尝试 3 次平仓但仓位仍未平掉，请立即到交易所手动处理！');
    return false;
  }

  /** 独立回收阶梯：始终在现价的"下一档步进"处维持一排 reduce-only 退出单。 */
  _manageRecoveryStandalone() {
    if (!this.running || !this.recovery || !this.config) return;
    const price = this.lastPrice;
    if (!Number.isFinite(price) || price <= 0) return;
    const pos = this.ex.getPosition?.(this.config.marketId);
    if (!pos || !pos.sizeBase) {
      // Require several CONSECUTIVE empty observations before declaring the
      // recovery finished — a single transient empty response from the position
      // endpoint (network blip) must not tear down the whole ladder.
      if (++this._noPosStreak >= 5) this._finishRecovery().catch(() => {});
      return;
    }
    this._noPosStreak = 0;
    const sp = this.config.spacing;
    if (!(sp > 0)) return;
    const long = pos.sizeBase > 0;
    // "只在入场价以上(不亏)减仓"：多头只在 >= 成本价挂卖，空头只在 <= 成本价挂买。
    const aboveEntry = !!this.config.aboveEntryOnly;
    const entry = Number(pos.entryPrice) || 0;
    // Rungs needed = enough to fully exit the CURRENT position (not a fixed 30).
    // As fills shrink the position, `need` shrinks too, so the ladder never
    // over-provisions. Hard ceiling guards against a pathological position/step.
    const HARD_MAX = 80;
    const perRung = this.config.sizeBase || (Math.abs(pos.sizeBase) / 20);
    const need = Math.min(HARD_MAX, Math.max(1, Math.ceil(Math.abs(pos.sizeBase) / perRung)));
    // Occupied = our tracked recovery levels UNION the exchange's real resting
    // levels (from reconcile). Using the real set means a spurious "order gone"
    // can't trick us into stacking a second order on a level that is still live.
    const existing = new Set([...this.active.values()].filter((o) => o.recovery).map((o) => o.levelIndex));
    for (const idx of this._recoveryOccupied) existing.add(idx);
    let placed = 0;
    if (long) {
      let lv = Math.ceil(price / sp) * sp; if (lv <= price) lv += sp;
      if (aboveEntry && entry > 0) { const eLv = Math.ceil(entry / sp) * sp; if (lv < eLv) lv = eLv; } // 不在成本价下方卖
      for (let k = 0; k < HARD_MAX && existing.size + placed < need; k++, lv += sp) {
        const idx = Math.round(lv / sp);
        if (existing.has(idx)) continue;
        this._place({ levelIndex: idx, side: 'sell', price: lv, reduceOnly: true, recovery: true, opening: false });
        placed++;
      }
    } else {
      let lv = Math.floor(price / sp) * sp; if (lv >= price) lv -= sp;
      if (aboveEntry && entry > 0) { const eLv = Math.floor(entry / sp) * sp; if (lv > eLv) lv = eLv; } // 不在成本价上方买
      for (let k = 0; k < HARD_MAX && existing.size + placed < need; k++, lv -= sp) {
        const idx = Math.round(lv / sp);
        if (existing.has(idx)) continue;
        this._place({ levelIndex: idx, side: 'buy', price: lv, reduceOnly: true, recovery: true, opening: false });
        placed++;
      }
    }
    if (placed) this._changed();
  }

  /** 持仓已减完 -> 结束回收。 */
  async _finishRecovery() {
    if (!this.recovery || this._finishingRecovery) return;
    this._finishingRecovery = true;
    this._pauseTradingRuntime();
    try {
      await this._cancelAllConfirmed(this.config.marketId, '回收完成后撤销剩余阶梯');
      this.recovery = false;
      this._recoveryOccupied = new Set();
      this.active.clear();
      this.running = false;
      this._alert('回收完成：持仓已全部减完，交易所已确认回收阶梯全部撤销。');
      this._changed();
    } catch (e) {
      this._alert(`❌ 持仓已减完，但剩余回收阶梯撤单未确认：${e?.message || e} 程序保留跟踪并继续对账。`);
      this._resumeTradingRuntime();
      this._changed();
      throw e;
    } finally {
      this._finishingRecovery = false;
    }
  }

  /**
   * Reconcile our tracking against the exchange's REAL open orders:
   *  - prune tracked orders no longer on the book (missed fills/cancels),
   *  - refill grid levels that have no resting order on the exchange.
   * "Occupied" levels are derived from the real order prices, so this is robust
   * even when our in-memory tracking has drifted.
   */
  async reconcileOpenOrders() {
    if (!this.running || !this.config) return;
    if (typeof this.ex.fetchOpenOrders !== 'function') return;
    // Keep the adapter's price watch warm so a long-running market is never
    // pruned as "idle" (adapters drop unwatched markets after 10 min).
    this.ex.getPrice?.(this.config.marketId)?.catch?.(() => {});
    const recovery = !!this.recovery;
    // Recovery has no grid: derive levels straight from price via config.spacing.
    const sp = recovery ? this.config.spacing : this.grid?.spacing;
    const lvl0 = recovery ? 0 : this.grid?.levels?.[0];
    if (!(sp > 0) || lvl0 == null) return;
    const nLevels = recovery ? Infinity : this.grid.levels.length;
    // Grid-mode recovery ladder (outOfRangeAction='recover') rests OUTSIDE the
    // grid: negative idx below the range, >= nLevels above. Widen the accepted
    // window so dedup/trim covers the ladder too (it used to be skipped, letting
    // duplicate ladder orders stack unchecked).
    const ladderPad = (!recovery && this.config.outOfRangeAction === 'recover') ? (this.grid?.count ?? 0) : 0;
    const idxLo = 0 - ladderPad, idxHi = nLevels === Infinity ? Infinity : nLevels + ladderPad;
    let real;
    try { real = await this.ex.fetchOpenOrders(this.config.marketId); } catch { return; }
    if (!Array.isArray(real)) return;
    this._exchangeOpenOrders = real.length;
    this._exchangeOpenOrdersVerifiedAt = Date.now();
    const realIds = new Set(real.map((o) => String(o.orderId)));
    const now = Date.now();

    // GUARD against transient bad snapshots: Extended's open-order endpoint has
    // been observed returning "0 orders" while dozens are really resting. An
    // all-vanished snapshot while we track many is overwhelmingly an API glitch
    // (real fills arrive via fill events anyway) — trusting it once wiped 78
    // tracked orders and orphaned them on the exchange. Skip pruning entirely on
    // such a snapshot, and in general require an order to be missing from TWO
    // consecutive reconciles before pruning it.
    const massVanish = real.length === 0 && this.active.size >= 3;
    if (massVanish && now - (this._lastVanishAlertAt || 0) > 60000) {
      this._lastVanishAlertAt = now;
      this._alert(`⚠️ 挂单对账：交易所返回 0 单但本地跟踪 ${this.active.size} 单，疑似接口异常快照，本轮不清理（等待下轮复核）。`);
    }
    let pruned = 0;
    if (!massVanish) {
      for (const [oid, info] of [...this.active]) {
        if (realIds.has(oid)) { info.goneRecon = 0; continue; }
        if (now - (info.placedAt || 0) <= PRUNE_GRACE_MS) continue;
        info.goneRecon = (info.goneRecon || 0) + 1;
        if (info.goneRecon >= 2) { this.active.delete(oid); pruned++; }
      }
    }

    // Map real orders to levels. Cancel any DUPLICATE resting order on a level so
    // we converge to one-order-per-level (the root cause of count creep). ADOPT
    // any untracked survivor into tracking — in recovery mode that's a leftover
    // ladder; in grid mode it's an order we lost track of (e.g. a bad "0 orders"
    // snapshot once wiped tracking while the orders stayed live on the exchange).
    // Adoption restores accounting AND fill handling for those orphans.
    const occupied = new Set();
    let trimmed = 0, adopted = 0;
    for (const o of real) {
      const px = Number(o.price);
      if (!Number.isFinite(px) || !(sp > 0)) continue;
      const idx = Math.round((px - lvl0) / sp);
      if (!(idx >= idxLo && idx < idxHi)) continue;
      if (!occupied.has(idx)) {
        occupied.add(idx);
        if (!this.active.has(String(o.orderId))
            && ![...this.active.values()].some((a) => a.levelIndex === idx)) { // level truly unclaimed
          const side = o.side === 'buy' ? 'buy' : 'sell';
          // opening/closing heuristic (mirrors _handleFill's fallback): in short
          // mode buys close, otherwise sells close.
          const closing = recovery ? true : ((this.config.mode === 'short') ? side === 'buy' : side === 'sell');
          try { this.ex.adoptOrder?.({ orderId: o.orderId, marketId: this.config.marketId, levelIndex: idx, side, price: px, sizeBase: this.config.sizeBase }); } catch { /* ignore */ }
          this.active.set(String(o.orderId), { levelIndex: idx, side, price: px, opening: !closing, recovery, placedAt: now });
          adopted++;
        }
        continue;
      }
      // Do not clear local tracking on an accepted cancellation request. The
      // next exchange snapshot will confirm disappearance and normal pruning
      // will remove it; if cancellation failed, it remains tracked and retries.
      try { await this.ex.cancelOrder(this.config.marketId, o.orderId); trimmed++; }
      catch { /* leave it; next cycle retries */ }
    }
    if (recovery) this._recoveryOccupied = occupied;

    // IMPORTANT: reconciliation no longer re-seeds opening orders. Re-seeding via
    // seedOrders re-opened a SAME-SIDE order on a level that a fill had just
    // (correctly) vacated — its take-profit order lives one rung away — which made
    // the grid open positions endlessly in one direction (runaway inventory).
    // The grid is now maintained ONLY by the normal fill -> opposite-leg
    // replacement chain. Reconcile just keeps tracking accurate (prune) and
    // enforces one-order-per-level (trim). It never opens new positions.
    if (pruned || trimmed || adopted) {
      this._alert(`挂单对账：交易所实际 ${real.length} 单；清理失效 ${pruned}，撤除重复 ${trimmed}${adopted ? `，接管 ${adopted}` : ''}。`);
      this._changed();
    }
    this._drainRetryQueue().catch(() => {});
  }

  _startReconcileTimer() {
    if (this._reconTimer) return;
    this._reconTimer = setInterval(() => { this.reconcileOpenOrders().catch(() => {}); }, RECONCILE_MS);
    this._reconTimer.unref?.();
  }
  _stopReconcileTimer() { if (this._reconTimer) { clearInterval(this._reconTimer); this._reconTimer = null; } }

  _alert(message) {
    this.alerts.unshift({ t: Date.now(), message });
    if (this.alerts.length > 30) this.alerts.pop();
  }

  /** Per-exchange health classification surfaced to the dashboard. */
  _health() {
    const ex = this.ex;
    const okAge = (typeof ex.lastOkAt === 'number' && ex.lastOkAt > 0) ? Date.now() - ex.lastOkAt : null;
    const priceStale = !!(ex._pxStale && this.config && typeof ex._pxStale.has === 'function' && ex._pxStale.has(this.config.marketId));
    const recentFail = this._lastFailAt && (Date.now() - this._lastFailAt < 60000);
    const paused = this._refillPausedUntil && Date.now() < this._refillPausedUntil;
    let status = 'ok', reason = '正常运行';
    if (!this.running && !this.config) { status = 'idle'; reason = '未运行'; }
    else if (paused) { status = 'error'; reason = `订单频繁被取消（疑似保证金不足），已暂停补单 ${Math.ceil((this._refillPausedUntil - Date.now())/1000)}s`; }
    else if (ex.operationalIssue) { status = 'error'; reason = ex.operationalIssue.title || ex.operationalIssue.message || '交易所操作异常'; }
    else if (ex.dataSource === 'synthetic') { status = 'warn'; reason = '合成行情（未连真实交易所）'; }
    else if (okAge != null && okAge > 30000) { status = 'error'; reason = `交易所数据 ${Math.round(okAge / 1000)}s 未更新`; }
    else if (priceStale) { status = 'warn'; reason = '行情滞后（已用持仓推算价兜底）'; }
    else if (recentFail) { status = 'warn'; reason = `近1分钟下单失败 ${this._placeFails} 次`; }
    return {
      status, reason,
      dataSource: ex.dataSource ?? null,
      lastOkAgeMs: okAge,
      priceStale,
      placeFails: this._placeFails,
      exchangeOpenOrders: this._exchangeOpenOrders,
      exchangeOpenOrdersVerifiedAt: this._exchangeOpenOrdersVerifiedAt,
    };
  }

  getState() {
    const pos = this.running || this.config ? this.ex.getPosition?.(this.config?.marketId) : null;
    const openByLevel = {};
    for (const o of this.active.values()) openByLevel[o.levelIndex] = o.side;

    // 品种卡片显示本品种持仓浮盈（EA positions 按品种有 profit）；
    // 账户级权威浮盈(ex._accountProfit)单独暴露，供总览汇总使用。
    const unrealizedRaw = pos ? Number(pos.unrealizedPnl) : 0;
    const unrealized = round2(unrealizedRaw);
    const balance = typeof this.ex.balance === 'number' ? round2(this.ex.balance) : null;
    const equityRaw = typeof this.ex.equity === 'number' ? this.ex.equity
      : (balance != null ? balance + unrealized : null);
    const equity = equityRaw != null ? round2(equityRaw) : null;

    let realizedRaw;
    if (typeof this.ex.realizedPnl === 'number') {
      realizedRaw = this.ex.realizedPnl - (this._pnlBase ?? 0); // offset applied by resetStats
    } else if (equityRaw != null && this.startBalance != null) {
      realizedRaw = (equityRaw - this.startBalance) - unrealizedRaw;
    } else {
      realizedRaw = this.stats.gridProfit;
    }
    const realized = round2(realizedRaw);
    // Sum the unrounded components so two independent display roundings cannot
    // move the authoritative total by one cent.
    const totalPnl = round2(realizedRaw + unrealizedRaw);
    const returnPct = (this.startBalance && this.startBalance > 0)
      ? round2((totalPnl / this.startBalance) * 100)
      : ((equity && equity > 0) ? round2((totalPnl / equity) * 100) : null);
    return {
      mode: this.ex.mode,
      recovery: this.recovery,
      running: this.running,
      config: this.config,
      grid: this.grid,
      lastPrice: this.lastPrice != null ? round2(this.lastPrice) : null,
      outOfRange: this.outOfRange,
      risk: this.risk,
      stats: this.stats,
      openOrders: this.active.size,
      exchangeOpenOrders: this._exchangeOpenOrders,
      exchangeOpenOrdersVerifiedAt: this._exchangeOpenOrdersVerifiedAt,
      placementProgress: this._placementProgressView(),
      openByLevel,
      health: this._health(),
      position: pos ? {
        sizeBase: round6(pos.sizeBase),
        // 对冲模式下多空可并存，净头寸可能为 0 但仍有持仓：
        // longSize/shortSize 分方向毛量、positionCount 持仓笔数，
        // 前端判断"有无持仓"与展示都以此为准。
        longSize: round6(pos.longSize ?? 0),
        shortSize: round6(pos.shortSize ?? 0),
        positionCount: Number(pos.positionCount) || 0,
        entryPrice: roundPrice(pos.entryPrice),
        unrealizedPnl: round2(pos.unrealizedPnl),
        leverage: pos.leverage ?? null,
        liquidationPrice: Number.isFinite(Number(pos.liquidationPrice)) && Number(pos.liquidationPrice) > 0
          ? roundPrice(Number(pos.liquidationPrice)) : null,
        // MT5 无持仓级强平价（加密版遗留字段恒为 null）；改用账户级
        // 保证金水平（权益/已用保证金×100%）与可用保证金——这才是 MT5
        // 真正决定是否被强平的风控指标（低于经纪商强平线如 50% 被强平）。
        marginLevel: Number.isFinite(Number(this.ex.marginLevel)) ? this.ex.marginLevel : null,
        marginFree: Number.isFinite(Number(this.ex.marginFree)) ? round2(this.ex.marginFree) : null,
      } : null,
      operationalIssue: this.ex.operationalIssue ?? null,
      apiWalletAddress: this.ex.apiWalletAddress ?? null,
      // 账户级权威浮盈（EA 上报 ACCOUNT_PROFIT，5 槽位共享同一 MT5 账户时为同一值），
      // 供总览汇总显示账户整体盈亏（品种卡片用 unrealizedPnl 显示各自持仓浮盈）
      accountProfit: Number.isFinite(this.ex._accountProfit) ? round2(this.ex._accountProfit) : null,
      realizedPnl: realized,
      unrealizedPnl: unrealized,
      totalPnl,
      returnPct,
      equity,
      balance,
      volume: this.stats.volume,
      theoreticalProfit: round2(this.stats.gridProfit),
      startBalance: this.startBalance != null ? round2(this.startBalance) : null,
      fills: this.fills.slice(0, 20),
      alerts: this.alerts.slice(0, 12),
    };
  }
}

function labelMode(m) { return m === 'long' ? '做多网格' : m === 'short' ? '做空网格' : '中性网格'; }

function round2(x) { return Math.round(x * 100) / 100; }
function round4(x) { return Math.round(x * 10000) / 10000; }
function round6(x) { return Math.round(x * 1e6) / 1e6; }
function roundPrice(x) { return Number.isFinite(Number(x)) ? Math.round(Number(x) * 1e8) / 1e8 : null; }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
