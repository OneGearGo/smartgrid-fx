// MT5 Python 桥客户端（Node 侧）
// 管理 mt5_bridge.py 子进程生命周期：spawn、JSON-lines 协议、请求/响应映射、
// 崩溃自动重启、连接状态事件上报。对外暴露与 Node 兼容的 async API。
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_SCRIPT = path.join(__dirname, '..', '..', '..', 'bridge', 'mt5_bridge.py');

/**
 * @param {object} opts
 *   opts.terminalPath, opts.login, opts.password, opts.server
 *   opts.python    Python 解释器路径（默认 'python'，可用 MT5_PYTHON 指定）
 *   opts.retryBaseMs / opts.retryMaxMs  桥内 initialize 退避参数
 */
export class Mt5BridgeClient extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.opts = opts;
    this.child = null;
    this._buffer = '';
    this._pending = new Map();
    this._nextId = 1;
    this._restarting = false;
    this.connected = false;
    this._restartTimer = null;
  }

  /** 启动子进程（幂等：已启动则忽略）。 */
  start() {
    if (this.child) return;
    const env = { ...process.env };
    if (this.opts.terminalPath) env.MT5_TERMINAL = this.opts.terminalPath;
    if (this.opts.login) env.MT5_LOGIN = String(this.opts.login);
    if (this.opts.password) env.MT5_PASSWORD = this.opts.password;
    if (this.opts.server) env.MT5_SERVER = this.opts.server;
    if (this.opts.retryBaseMs) env.MT5_RETRY_BASE_MS = String(this.opts.retryBaseMs);
    if (this.opts.retryMaxMs) env.MT5_RETRY_MAX_MS = String(this.opts.retryMaxMs);
    const python = this.opts.python || process.env.MT5_PYTHON || 'python';

    const child = spawn(python, [BRIDGE_SCRIPT], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    this._buffer = '';

    child.stdout.on('data', (d) => this._onData(d.toString()));
    child.stderr.on('data', (d) => { try { process.stderr.write('[mt5-bridge] ' + d); } catch { /* ignore */ } });
    child.on('error', (e) => { this.emit('process-error', e); this._scheduleRestart(); });
    child.on('exit', (code, signal) => {
      this.child = null;
      this.connected = false;
      this.emit('status', { connected: false, exited: true, code, signal });
      // 拒绝所有挂起请求
      const err = new Error('MT5 桥进程已退出 (code=' + code + ' signal=' + signal + ')');
      for (const [, p] of this._pending) p.rej(err);
      this._pending.clear();
      this._scheduleRestart();
    });
  }

  _scheduleRestart() {
    if (this._restarting || this._restartTimer) return;
    this._restarting = true;
    const delay = 3000;
    this._restartTimer = setTimeout(() => {
      this._restartTimer = null;
      this._restarting = false;
      this.start();
    }, delay);
  }

  _onData(chunk) {
    this._buffer += chunk;
    let idx;
    while ((idx = this._buffer.indexOf('\n')) >= 0) {
      const line = this._buffer.slice(0, idx).trim();
      this._buffer = this._buffer.slice(idx + 1);
      if (!line) continue;
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      if (m.event) {
        if (m.event === 'status') {
          this.connected = !!m.data?.connected;
          this.emit('status', m.data);
        }
        continue;
      }
      if (m.id && this._pending.has(m.id)) {
        const p = this._pending.get(m.id);
        this._pending.delete(m.id);
        m.ok ? p.res(m.result) : p.rej(new Error(m.error));
      }
    }
  }

  /** 发请求。若进程未启动则先启动（首次请求自动拉起桥）。 */
  call(method, params = {}, timeoutMs = 60000) {
    if (!this.child) this.start();
    return new Promise((resolve, reject) => {
      const id = this._nextId++;
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`${method} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      this._pending.set(id, {
        res: (v) => { clearTimeout(timer); resolve(v); },
        rej: (e) => { clearTimeout(timer); reject(e); },
      });
      try {
        this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
      } catch (e) {
        clearTimeout(timer);
        this._pending.delete(id);
        reject(e);
      }
    });
  }

  /** 关闭子进程。 */
  stop() {
    if (this._restartTimer) { clearTimeout(this._restartTimer); this._restartTimer = null; }
    if (!this.child) return;
    try { this.child.kill(); } catch { /* ignore */ }
    this.child = null;
    this.connected = false;
  }
}
