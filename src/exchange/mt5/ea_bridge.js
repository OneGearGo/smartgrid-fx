// EA 桥（Node 侧）：与 MQL5 桥 EA 通过本地 HTTP 通信
//
// 解决 MT5 build 6090 的 IPC 端口冲突：Python 库(MetaTrader5)依赖终端的
// IPC dispatcher(22346)，同一台电脑被第二个终端(实盘)占用后无法再连。
// 本桥改用「终端进程内的 EA」通过 WebRequest 与本 HTTP 服务通信——
// EA 在终端里跑，不依赖 IPC 端口，实盘终端不受任何影响。
//
// 协议（EA 为客户端，本服务为服务端，监听 127.0.0.1:EA_BRIDGE_PORT）：
//   POST /state    <- EA 上报 {account, prices[], orders[], positions[], ts}
//   GET  /cmd      <- EA 拉取待执行命令，纯文本行，如 "PLACE|XAUUSD|buy|2400|0.1|30000|GRID"
//   POST /result   <- EA 回报命令执行结果 JSON
//
// 对外暴露与 Mt5BridgeClient 相同接口：
//   call('get_price', {symbol}) / call('get_candles', ...) / call('place_limit', ...)
//   call('open_orders', ...) / call('positions', ...) / call('get_account', ...)
//   call('cancel', ...) / call('cancel_all', ...) / call('close_position', ...)
import http from 'node:http';
import { EventEmitter } from 'node:events';

const DEFAULT_PORT = 8383;

export class EaBridgeServer extends EventEmitter {
  /**
   * @param {object} opts { port, symbols[] }
   */
  constructor(opts = {}) {
    super();
    this.port = Number(opts.port) || DEFAULT_PORT;
    this.symbols = Array.isArray(opts.symbols) ? opts.symbols : ['XAUUSD', 'EURUSD', 'GBPUSD', 'USDJPY', 'NAS100'];
    this.connected = false;        // 最近收到过 /state
    this.lastStateAt = null;
    this.account = null;
    this.prices = new Map();       // symbol -> {bid, ask, time}
    this.specs = new Map();        // symbol -> {contractSize, digits, volumeMin, ...}
    this.orders = [];              // EA 上报的挂单
    this.positions = [];           // EA 上报的持仓
    this._cmdQueue = [];           // 待 EA 拉取的命令 {id, verb, line, resolve, reject, timer}
    this._pendingCmd = null;       // 已下发待回报的命令
    this._seq = 0;
    this._server = null;
    this._lastState = null;        // 原始状态快照
    this._stateEmitAt = 0;
  }

  start() {
    if (this._server) return this;
    this._server = http.createServer((req, res) => {
      try {
        if (req.method === 'POST' && req.url === '/state') {
          let body = '';
          req.on('data', (c) => { body += c; });
          req.on('end', () => this._onState(body, res));
          return;
        }
        if (req.method === 'GET' && req.url === '/cmd') {
          this._onCmd(req, res);
          return;
        }
        if (req.method === 'POST' && req.url === '/result') {
          let body = '';
          req.on('data', (c) => { body += c; });
          req.on('end', () => this._onResult(body, res));
          return;
        }
        // 健康检查
        if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, connected: this.connected, lastStateAt: this.lastStateAt }));
          return;
        }
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('not found');
      } catch (e) {
        try { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end(String(e?.message || e)); } catch { /* ignore */ }
      }
    });
    this._server.listen(this.port, '127.0.0.1');
    this._server.on('error', (e) => { this.emit('error', e); });
    return this;
  }

  stop() {
    // 拒绝所有挂起命令
    const err = new Error('EA 桥已停止');
    for (const q of this._cmdQueue) { clearTimeout(q.timer); try { q.reject(err); } catch { /* ignore */ } }
    this._cmdQueue = [];
    if (this._pendingCmd) { clearTimeout(this._pendingCmd.timer); try { this._pendingCmd.reject(err); } catch { /* ignore */ } this._pendingCmd = null; }
    this.connected = false;
    if (this._server) {
      const s = this._server;
      this._server = null;
      return new Promise((resolve) => { try { s.close(() => resolve()); } catch { resolve(); } });
    }
    return Promise.resolve();
  }

  // ── /state：EA 上报行情/订单/持仓 ────────────────────────────────────
  _onState(body, res) {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    let j;
    try { j = JSON.parse(body || '{}'); } catch { return; }
    this._lastState = j;
    this.lastStateAt = Date.now();
    this.connected = true;

    if (j.account) this.account = j.account;
    if (Array.isArray(j.prices)) {
      for (const p of j.prices) {
        if (p?.symbol) {
          const sym = p.symbol.toUpperCase();
          this.prices.set(sym, { bid: Number(p.bid), ask: Number(p.ask), time: Number(p.time) });
          // 缓存合约规模（EA 上报，用于外汇保证金计算）
          if (p.contract_size > 0) {
            const prev = this.specs.get(sym) || {};
            this.specs.set(sym, { ...prev, contractSize: Number(p.contract_size) });
          }
        }
      }
    }
    if (Array.isArray(j.orders)) this.orders = j.orders;
    if (Array.isArray(j.positions)) this.positions = j.positions;

    // 节流触发状态事件（适配器轮询用）
    const now = Date.now();
    if (now - this._stateEmitAt > 500) {
      this._stateEmitAt = now;
      try { this.emit('state', j); } catch { /* 监听器抛错不影响 */ }
    }
  }

  // ── GET /cmd：下发待执行命令 ─────────────────────────────────────────
  _onCmd(req, res) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    // EA 失联保护：超过 30 秒没有 /state 上报，说明 EA 不在运行（被移除/崩溃）。
    // 此时不应下发任何命令（挂单/撤单都会石沉大海），返回 NONE 让队列保留
    // 并尽快失败，避免命令积压造成 stop 卡死。
    const stale = this.lastStateAt && Date.now() - this.lastStateAt > 30000;
    if (stale) {
      this.connected = false;
      res.end('NONE');
      return;
    }
    // 先取一个排队命令
    if (this._pendingCmd) {
      // 上一个命令还没回报——暂时没有可执行的（避免并发）
      res.end('NONE');
      return;
    }
    const q = this._cmdQueue.shift();
    if (!q) { res.end('NONE'); return; }
    this._pendingCmd = q;
    // 命令超时保护
    q.timer = setTimeout(() => {
      if (this._pendingCmd === q) {
        this._pendingCmd = null;
        try { q.reject(new Error('命令执行超时: ' + q.verb)); } catch { /* ignore */ }
      }
    }, 30000);
    res.end(q.line);
  }

  // ── POST /result：EA 回报执行结果 ────────────────────────────────────
  _onResult(body, res) {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    if (!this._pendingCmd) return;
    const q = this._pendingCmd;
    this._pendingCmd = null;
    clearTimeout(q.timer);
    let j;
    try { j = JSON.parse(body || '{}'); } catch { j = {}; }
    try {
      if (j?.ok) q.resolve(j);
      else q.reject(new Error(j?.error || 'EA 执行失败'));
    } catch { /* resolve/reject 抛错（如调用方未处理）不应冒泡 */ }
  }

  // ── 对外接口（与 Mt5BridgeClient.call 对齐） ─────────────────────────
  call(method, params = {}, timeoutMs = 60000) {
    switch (method) {
      case 'ping':
        return Promise.resolve({ pong: true, connected: this.connected, ts: Date.now() });
      case 'get_account':
        return Promise.resolve(this.account);
      case 'get_price': {
        const p = this.prices.get(String(params.symbol || '').toUpperCase());
        return Promise.resolve(p || null);
      }
      case 'get_symbols': {
        // 从 EA 上报的合约规模构建规格（外汇保证金计算需要 contractSize）；
        // 未上报的品种返回 null 让适配器走兜底规格。
        const out = [];
        for (const sym of params.symbols || this.symbols) {
          const sp = this.specs.get(String(sym).toUpperCase());
          if (!sp || !sp.contractSize) continue;
          out.push({
            name: String(sym).toUpperCase(),
            digits: 5, point: 0.00001, volume_min: 0.01, volume_step: 0.01,
            trade_tick_size: 0.00001,
            contractSize: sp.contractSize,
          });
        }
        return Promise.resolve(out.length ? out : null);
      }
      case 'open_orders':
        return Promise.resolve(this.orders.filter((o) => !params.magic || Number(o.magic) === Number(params.magic)));
      case 'positions':
        return Promise.resolve(this.positions);
      case 'get_candles':
        return this._queueCommand('GET_CANDLES', [params.symbol, params.intervalSec ?? 3600, params.n ?? 200], timeoutMs);
      case 'place_limit':
        return this._queueCommand('PLACE', [
          params.symbol, params.side === 'sell' ? 'sell' : 'buy', params.price, params.volume,
          params.magic ?? 0, params.comment ?? 'GRID', params.sl ?? 0, params.tp ?? 0,
        ], timeoutMs);
      case 'cancel':
        return this._queueCommand('CANCEL', [params.symbol, params.ticket], timeoutMs);
      case 'cancel_all':
        return this._queueCommand('CANCEL_ALL', [params.symbol, params.magic ?? 0], timeoutMs);
      case 'close_position':
        return this._queueCommand('CLOSE', [params.symbol], timeoutMs);
      default:
        return Promise.reject(new Error('EA 桥不支持的方法: ' + method));
    }
  }

  _queueCommand(verb, args, timeoutMs) {
    if (!this._server) this.start();
    const line = [verb, ...args].join('|');
    return new Promise((resolve, reject) => {
      this._cmdQueue.push({ id: ++this._seq, verb, line, resolve, reject, timer: null });
    });
  }
}
