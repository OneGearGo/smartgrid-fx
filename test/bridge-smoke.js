// 测试 MT5 桥：spawn 进程 -> 发请求 -> 校验响应（只读操作，不产生订单）
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BRIDGE = path.join(__dirname, '..', 'bridge', 'mt5_bridge.py');
// 凭据从环境变量/.env 读取（本仓库不存任何账号信息）
const child = spawn('python', [BRIDGE], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...process.env,
    MT5_LOGIN: process.env.MT5_LOGIN || '',
    MT5_SERVER: process.env.MT5_SERVER || '',
    MT5_PASSWORD: process.env.MT5_PASSWORD || '',
    MT5_TERMINAL: process.env.MT5_TERMINAL || 'F:\\MT5\\terminal64.exe',
  },
});

let buffer = '';
const pending = new Map();
const events = [];
let nextId = 1;
let done = false;

const finish = (msg, code = 0) => {
  if (!done) { done = true; console.log('\n=== ' + msg + ' ==='); try { child.kill(); } catch (e) {} process.exit(code); }
};
const timer = setTimeout(() => finish('TIMEOUT after 90s', 1), 90000);

function send(m) { child.stdin.write(JSON.stringify(m) + '\n'); }
function call(method, params, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const t = setTimeout(() => { pending.delete(id); reject(new Error(method + ' 超时')); }, timeoutMs);
    pending.set(id, { res: (v) => { clearTimeout(t); resolve(v); }, rej: (e) => { clearTimeout(t); reject(e); } });
    send({ id, method, params });
  });
}

child.stdout.on('data', (d) => {
  buffer += d.toString();
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let m;
    try { m = JSON.parse(line); } catch (e) { continue; }
    if (m.event) { events.push(m); continue; }
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.ok ? p.res(m.result) : p.rej(new Error(m.error));
    }
  }
});
child.stderr.on('data', (d) => process.stderr.write('[bridge] ' + d));
child.on('error', (e) => finish('SPAWN ERROR: ' + e.message, 1));

(async () => {
  try {
    // 先等 2s 让后台连接线程跑一轮
    await new Promise((r) => setTimeout(r, 2000));
    console.log('--- status events so far:', JSON.stringify(events));

    const ping = await call('ping');
    console.log('\nping:', JSON.stringify(ping));

    const acct = await call('get_account');
    console.log('\naccount:', acct ? JSON.stringify({ login: acct.login, server: acct.server, balance: acct.balance, equity: acct.equity, leverage: acct.leverage }) : 'null (未连接)');

    // 无论是否连上，get_symbols 应该能返回规格（MT5 本地符号库）
    const syms = await call('get_symbols', { symbols: ['XAUUSD', 'EURUSD', 'GBPUSD', 'USDJPY', 'NAS100'] });
    console.log('\nsymbols:');
    for (const s of syms || []) {
      console.log(`  ${s.name}: digits=${s.digits} vol_min=${s.volume_min} vol_step=${s.volume_step} spread=${s.spread} tick=${s.trade_tick_size}`);
    }

    const price = await call('get_price', { symbol: 'XAUUSD' });
    console.log('\nXAUUSD price:', price ? `bid=${price.bid} ask=${price.ask}` : 'null');

    const candles = await call('get_candles', { symbol: 'XAUUSD', intervalSec: 3600, n: 50 });
    console.log('\nXAUUSD 1H candles:', candles ? `${candles.candles.length} 根, 最新 close=${candles.candles.at(-1)?.close}` : 'null', candles?.error ? ' error=' + candles.error : '');

    finish('bridge test done');
  } catch (e) {
    console.error('FAIL:', e.message);
    finish('bridge test failed', 1);
  }
})();
