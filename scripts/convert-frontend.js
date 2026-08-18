// 前端转换脚本：5 交易所 -> 5 品种槽位（de/ex/rs/ar/lr -> eur/gbp/jpy/xau/nas）
// 只做带边界的精确替换，避免误伤子串。运行：node scripts/convert-frontend.js
import fs from 'node:fs';

const file = new URL('../public/index.html', import.meta.url);
let s = fs.readFileSync(file, 'utf8');
const origLen = s.length;

const KEYMAP = { de: 'eur', ex: 'gbp', rs: 'jpy', ar: 'xau', lr: 'nas' };
const NAMEMAP = { Decibel: 'EURUSD', Extended: 'GBPUSD', RISEx: 'USDJPY', Arcus: 'XAUUSD', 'RHC Lighter': 'NAS100' };

// 1) 交易所 ID：带引号的 'de' "de" 以及 -de- / -de" / -de: 连字符边界（id、CSS 类、属性）
for (const [oldK, newK] of Object.entries(KEYMAP)) {
  s = s.split(`'${oldK}'`).join(`'${newK}'`);
  s = s.split(`"${oldK}"`).join(`"${newK}"`);
  s = s.split(`-${oldK}-`).join(`-${newK}-`);
  s = s.split(`-${oldK}"`).join(`-${newK}"`);
  s = s.split(`-${oldK} `).join(`-${newK} `);
  s = s.split(`-${oldK}.`).join(`-${newK}.`);
  s = s.split(`--${oldK}-`).join(`--${newK}-`); // CSS 变量 --de-color
  s = s.split(`'${oldK}',`).join(`'${newK}',`); // 数组元素带逗号
  s = s.split(`'${oldK}']`).join(`'${newK}']`);
}

// 2) 交易所名称
for (const [oldN, newN] of Object.entries(NAMEMAP)) {
  s = s.split(oldN).join(newN);
}

// 3) 代理 env 键名
const ENVMAP = {
  DECIBEL_PROXY: 'EUR_PROXY', EXTENDED_PROXY: 'GBP_PROXY', RISEX_PROXY: 'JPY_PROXY',
  ARCUS_PROXY: 'XAU_PROXY', LIGHTER_PROXY: 'NAS_PROXY',
};
for (const [oldE, newE] of Object.entries(ENVMAP)) {
  s = s.split(oldE).join(newE);
}

// 4) 特殊文案：交易所特有内容
s = s.split('Decibel API 签名钱包没有足够的 APT 支付链上手续费').join('MT5 账户余额不足或终端未连接');
s = s.split('重连交易所（不动挂单/持仓）').join('重连 MT5（不动挂单/持仓）');
s = s.split('进入 ').join('进入 ');
s = s.split('三个所现在整体情况怎么样？').join('五个品种现在整体情况怎么样？');

// 5) AI 对话 placeholder 里的 Extended 上边界示例
s = s.split('把 Extended 上边界调到 66000').join('把 XAUUSD 上边界调到 2450');

// 6) 总览标题
s = s.split('五所统一总览').join('五品种统一总览');
s = s.split('五所').join('五品种');

console.log('chars:', origLen, '->', s.length);
fs.writeFileSync(file, s, 'utf8');
console.log('done');
