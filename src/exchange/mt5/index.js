// MT5 适配器工厂：按槽位配置返回 paper 或 live 适配器。
// 所有槽位共享同一个桥客户端（单 MT5 终端登入）。
// 桥接方式由 mt5Cfg.bridge 决定：
//   'python' -> Mt5BridgeClient（MetaTrader5 Python 库，依赖终端 IPC）
//   'ea'     -> EaBridgeServer（MQL5 桥 EA，WebRequest 走本地 HTTP，绕开 IPC 端口冲突）
import { Mt5BridgeClient } from './bridge.js';
import { EaBridgeServer } from './ea_bridge.js';
import { PaperMt5 } from './paper.js';
import { LiveMt5 } from './mt5.js';

let sharedBridge = null;
let sharedBridgeKind = null;

/** 获取（或创建）共享的桥客户端。5 个槽位共用。 */
export function getSharedBridge(mt5Cfg) {
  const kind = mt5Cfg.bridge === 'ea' ? 'ea' : 'python';
  if (sharedBridge && sharedBridgeKind === kind) return sharedBridge;
  if (sharedBridge) { try { sharedBridge.stop(); } catch { /* ignore */ } }
  if (kind === 'ea') {
    sharedBridge = new EaBridgeServer({ port: mt5Cfg.eaPort });
    sharedBridge.start();
  } else {
    sharedBridge = new Mt5BridgeClient(mt5Cfg);
  }
  sharedBridgeKind = kind;
  return sharedBridge;
}

/**
 * @param {object} slotCfg  槽位配置 {key, symbol, platform, mode, startBalance, proxy}
 * @param {object} mt5Cfg   MT5 通道配置 {terminalPath, login, password, server, pollMs, bridge, eaPort, ...}
 * @param {number} magic    该槽位的 magic 号（live 模式标识网格单）
 */
export function createExchange(slotCfg, mt5Cfg, magic) {
  const bridge = getSharedBridge(mt5Cfg);
  const common = {
    bridge,
    symbol: slotCfg.symbol,
    startBalance: slotCfg.startBalance,
    pollMs: mt5Cfg.pollMs,
    magic,
  };
  if (slotCfg.mode === 'live') {
    return new LiveMt5(common);
  }
  return new PaperMt5(common);
}

/** 测试用：重置共享桥（避免测试间串状态）。 */
export function _resetSharedBridge() {
  if (sharedBridge) { try { sharedBridge.stop(); } catch { /* ignore */ } }
  sharedBridge = null;
  sharedBridgeKind = null;
}
