// 多交易所代理管理器
// 支持 HTTP(S) 代理和 SOCKS5 代理（含认证）。
// 因 Node.js fetch 使用统一全局 dispatcher，当五个交易所代理不同时，
// 采用"最后配置生效"策略，并给出提示。推荐统一使用 GLOBAL_PROXY。
import net from 'node:net';
import tls from 'node:tls';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** host:port:user:pass -> socks5://user:pass@host:port ; bare host:port -> http:// */
export function normalizeProxy(v) {
  const s = String(v).trim();
  if (/^\w+:\/\//.test(s)) return s;
  const parts = s.split(':');
  if (parts.length === 4) {
    const [host, port, user, pass] = parts;
    return `socks5://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
  }
  if (parts.length === 2) return `http://${s}`;
  return s;
}

function masked(url) {
  return url.replace(/\/\/([^:@/]+):[^@/]+@/, '//$1:***@');
}

/**
 * Extract the HTTPS (or fallback HTTP) proxy from a WinINET ProxyServer value.
 * Windows accepts either one proxy for all protocols (host:port) or a list such
 * as "http=host:80;https=host:443". This returns only a transport value; it
 * never exposes a system proxy to the dashboard or logs.
 */
export function selectWinInetProxy(proxyServer) {
  const raw = String(proxyServer || '').trim();
  if (!raw) return '';
  if (!raw.includes('=')) return raw;
  const byProtocol = new Map();
  for (const entry of raw.split(';')) {
    const pos = entry.indexOf('=');
    if (pos < 1) continue;
    const protocol = entry.slice(0, pos).trim().toLowerCase();
    const value = entry.slice(pos + 1).trim();
    if (value) byProtocol.set(protocol, value);
  }
  return byProtocol.get('https') || byProtocol.get('http') || '';
}

/**
 * Node/Undici does not inherit the Windows Internet Options proxy used by
 * browsers and Invoke-WebRequest. Read the manual WinINET proxy only when the
 * user did not explicitly configure any project proxy. PAC files are
 * deliberately not evaluated: executing third-party PAC JavaScript from a
 * trading process would be unsafe and non-deterministic.
 */
async function readWindowsSystemProxy() {
  if (process.platform !== 'win32') return '';
  const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
  try {
    const options = { windowsHide: true, timeout: 2_000, maxBuffer: 16 * 1024 };
    const [enabled, server] = await Promise.all([
      execFileAsync('reg.exe', ['query', key, '/v', 'ProxyEnable'], options),
      execFileAsync('reg.exe', ['query', key, '/v', 'ProxyServer'], options),
    ]);
    if (!/\b0x1\b/i.test(enabled.stdout)) return '';
    // The value starts after the REG_* type column, whose token is stable even
    // in localized Windows versions. Keep the proxy value itself private.
    const line = server.stdout.split(/\r?\n/).find((row) => /\bProxyServer\b/i.test(row));
    if (!line) return '';
    const value = line.replace(/^.*?\bREG_\w+\s+/, '').trim();
    return selectWinInetProxy(value);
  } catch {
    return '';
  }
}

/** 完整 SOCKS5 握手（RFC 1928/1929） */
export function socks5Connect({ host, port, user, pass }, destHost, destPort, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port: Number(port) });
    let buf = Buffer.alloc(0);
    let waiter = null;
    const fail = (msg) => { cleanup(); sock.destroy(); reject(new Error(msg)); };
    const timer = setTimeout(() => fail('SOCKS5 代理连接超时（代理无响应）'), timeoutMs);
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      if (waiter && buf.length >= waiter.need) {
        const out = buf.subarray(0, waiter.need);
        buf = buf.subarray(waiter.need);
        const w = waiter; waiter = null; w.resolve(out);
      }
    };
    const onErr = (e) => { cleanup(); reject(e); };
    const cleanup = () => { clearTimeout(timer); sock.off('data', onData); sock.off('error', onErr); };
    const read = (need) => new Promise((res) => {
      if (buf.length >= need) { const out = buf.subarray(0, need); buf = buf.subarray(need); res(out); }
      else waiter = { need, resolve: res };
    });
    sock.on('data', onData);
    sock.once('error', onErr);
    sock.once('connect', async () => {
      try {
        sock.write(Buffer.from([0x05, 0x02, 0x00, 0x02]));
        let r = await read(2);
        if (r[0] !== 0x05) return fail('不是 SOCKS5 代理（握手响应异常）');
        if (r[1] === 0x02) {
          const u = Buffer.from(String(user ?? ''), 'utf8');
          const p = Buffer.from(String(pass ?? ''), 'utf8');
          sock.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
          r = await read(2);
          if (r[1] !== 0x00) return fail('SOCKS5 认证被拒绝（用户名/密码错误，或套餐已过期）');
        } else if (r[1] !== 0x00) {
          return fail('SOCKS5 代理拒绝了支持的认证方式（代码 ' + r[1] + '）');
        }
        const dh = Buffer.from(String(destHost), 'utf8');
        sock.write(Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00, 0x03, dh.length]), dh,
          Buffer.from([(destPort >> 8) & 0xff, destPort & 0xff]),
        ]));
        const head = await read(4);
        if (head[1] !== 0x00) {
          const codes = { 1: '代理内部错误', 2: '规则不允许', 3: '网络不可达', 4: '主机不可达', 5: '连接被拒绝', 6: 'TTL 过期', 7: '命令不支持', 8: '地址类型不支持' };
          return fail('SOCKS5 无法连通目标（' + (codes[head[1]] || '代码 ' + head[1]) + '）');
        }
        const atyp = head[3];
        await read(atyp === 0x01 ? 6 : atyp === 0x04 ? 18 : (await read(1))[0] + 2);
        cleanup();
        resolve(sock);
      } catch (e) { fail(e?.message || String(e)); }
    });
  });
}

/**
 * 为指定代理 URL 创建 undici Dispatcher（Agent 或 ProxyAgent）。
 * 返回 dispatcher 实例，或 null（无代理/失败）。
 */
export async function createDispatcher(proxyUrl) {
  if (!proxyUrl) return null;
  const proxy = normalizeProxy(proxyUrl);
  try {
    const { Agent, ProxyAgent } = await import('undici');
    if (/^socks/i.test(proxy)) {
      const u = new URL(proxy);
      const opts = {
        host: u.hostname, port: Number(u.port),
        user: u.username ? decodeURIComponent(u.username) : undefined,
        pass: u.password ? decodeURIComponent(u.password) : undefined,
      };
      return new Agent({
        connect(copts, callback) {
          const dport = Number(copts.port) || (copts.protocol === 'https:' ? 443 : 80);
          socks5Connect(opts, copts.hostname, dport)
            .then((socket) => {
              if (copts.protocol === 'https:') {
                const t = tls.connect({ socket, servername: copts.servername || copts.hostname, ALPNProtocols: ['http/1.1'] }, () => callback(null, t));
                t.once('error', (e) => callback(e, null));
              } else {
                callback(null, socket);
              }
            })
            .catch((e) => callback(e, null));
        },
      });
    }
    return new ProxyAgent(proxy);
  } catch (e) {
    console.error('⚠ 代理库加载失败，请先运行 npm install。错误：' + e.message);
    return null;
  }
}

/**
 * 根据五个品种槽位的代理配置，设置全局 dispatcher。
 * 优先级：全局代理 > 各槽位（eur/gbp/jpy/xau/nas）
 * 若各槽位代理不同，警告用户；若需独立代理，建议分开部署。
 */
export async function setupProxies(cfg) {
  const { globalProxy, slots } = cfg;
  const keys = ['eur', 'gbp', 'jpy', 'xau', 'nas'];

  const proxies = {
    global: globalProxy || '',
    eur: slots.eur?.proxy || '',
    gbp: slots.gbp?.proxy || '',
    jpy: slots.jpy?.proxy || '',
    xau: slots.xau?.proxy || '',
    nas: slots.nas?.proxy || '',
  };

  // 选出实际要设置的代理（全局 > 各槽位 > Windows 手动系统代理）。
  // The system proxy is a fallback only: an explicit .env setting always wins.
  const configured = proxies.global || keys.some((k) => proxies[k]);
  const systemProxy = configured ? '' : await readWindowsSystemProxy();
  const effective = configured || systemProxy;
  const source = configured ? 'configured' : systemProxy ? 'windows-system' : 'none';
  if (!effective) return { eur: null, gbp: null, jpy: null, xau: null, nas: null, used: null, source };

  // 检查是否有不同的代理
  const uniqueProxies = new Set(keys.map((k) => proxies[k]).filter(Boolean));
  if (uniqueProxies.size > 1 && !proxies.global) {
    console.warn('[代理] ⚠ 检测到各槽位配置了不同代理，但 GLOBAL_PROXY 未设置。');
    console.warn('[代理]   由于 Node.js 全局 fetch 限制，将统一使用第一个有效代理。');
    console.warn('[代理]   如需严格隔离代理，请设置 GLOBAL_PROXY 或分开部署各槽位。');
  }

  const normalized = normalizeProxy(effective);
  try {
    const { setGlobalDispatcher } = await import('undici');
    const dispatcher = await createDispatcher(effective);
    if (dispatcher) {
      setGlobalDispatcher(dispatcher);
      return {
        // Do not reveal a possibly credential-bearing system proxy address in
        // logs or the local dashboard.
        used: source === 'windows-system' ? 'Windows 系统代理' : masked(normalized),
        dispatcher,
        source,
      };
    }
  } catch (e) {
    console.error('⚠ 设置全局代理失败：' + e.message);
  }
  return { used: null, source };
}

/** 验证代理是否可用，返回 { ok, ip } 或 { ok: false, error } */
export async function checkProxy() {
  const urls = ['https://api.ipify.org', 'https://ifconfig.me/ip', 'https://icanhazip.com'];
  let lastErr = 'unknown';
  for (const url of urls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (res.ok) {
        const ip = (await res.text()).trim();
        if (/^[0-9a-fA-F.:]+$/.test(ip)) return { ok: true, ip };
      }
      lastErr = `HTTP ${res.status}`;
    } catch (e) {
      lastErr = e?.cause?.code || e?.cause?.message || e?.message || String(e);
    }
  }
  return { ok: false, error: lastErr };
}
