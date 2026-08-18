# 平台接入位（Platform Adapters）

本目录是"5 个外汇平台接入位"的预留位置。当前 5 个品种槽位（eur/gbp/jpy/xau/nas）都使用
`mt5` 平台（共享一个 MT5 终端登入）。未来要接入第 2~5 个外汇平台（如 OANDA、FXCM、
IC Markets、盈透等），按本目录契约实现适配器即可，**网格引擎不需要任何改动**。

## 接口契约

网格引擎（`src/bot.js` 的 `GridBot`）通过以下接口与平台适配器交互。实现新平台时
必须完整提供这些成员（类继承 `EventEmitter`）：

### 必需成员（属性）

| 成员 | 类型 | 说明 |
| --- | --- | --- |
| `mode` | string | `'paper'`（模拟）或 `'live'`（实盘） |
| `dataSource` | string | `'real'`（真实行情）或 `'synthetic'`（合成/离线降级） |
| `network` | string | 网络标识（如 `'mt5'`、`'oanda-live'`） |
| `feeRate` | number | 手续费率（paper 撮合用，如 `0.00005`） |
| `balance` / `equity` / `realizedPnl` | number | 账户资金（实时更新） |
| `lastOkAt` | number | 最近一次成功通信的时间戳（健康检测用） |
| `operationalIssue` | object\|null | 操作异常（`{title, message}`），无则 null |
| `apiWalletAddress` | string\|null | 账户标识（可选） |

### 必需方法（async）

| 方法 | 签名 | 说明 |
| --- | --- | --- |
| `init()` | `() => Promise<boolean>` | 连接平台，加载市场与账户 |
| `reconnect()` | `() => Promise<boolean>` | 重连（不撤单/不平仓/不动网格状态） |
| `getMarkets()` | `() => Promise<Market[]>` | 市场列表（每个含 `marketId/displayName/stepSize/stepPrice/minOrderSize/maxLeverage`） |
| `getCandles(marketId, intervalSec, n)` | `(n, n, n) => Promise<Candle[]>` | K线（`{time,open,high,low,close,volume}`，按时间升序） |
| `getPrice(marketId)` | `(n) => Promise<number\|null>` | 最新价（失败返回 null） |
| `setLeverage(marketId, lev)` | `(n, n) => Promise<boolean>` | 设置杠杆（平台不支持返回 false） |
| `placeLimitOrder(o)` | `(obj) => Promise<{orderId}>` | 挂限价单（`{marketId, side, price, sizeBase, reduceOnly, levelIndex, clientOrderId}`） |
| `cancelOrder(marketId, orderId)` | `(n, str) => Promise<boolean>` | 撤单（失败必须 throw） |
| `cancelAll(marketId)` | `(n) => Promise<boolean>` | 撤销某市场全部挂单 |
| `fetchOpenOrders(marketId)` | `(n) => Promise<Order[]>` | 真实挂单（`{orderId, price, side, sizeBase}`） |
| `getPosition(marketId)` | `(n) => Position\|null` | 持仓（`{sizeBase, entryPrice, unrealizedPnl, leverage?, liquidationPrice?}`） |
| `closePosition(marketId)` | `(n) => Promise<boolean>` | 市价平仓 |
| `start()` / `stop()` | `() => void` | 启动/停止行情轮询 |
| `adoptOrder({orderId, marketId, levelIndex, side, price, sizeBase})` | `(obj) => void` | 接管既有挂单（恢复/对账用） |
| `forgetOrders(marketId)` / `forgetOrder(orderId)` | `() => void` | 清理本地跟踪 |

### 必需事件

| 事件 | 载荷 | 说明 |
| --- | --- | --- |
| `'fill'` | `{orderId, marketId, side, price, sizeBase, levelIndex, clientOrderId?}` | 成交（驱动网格替换） |
| `'price'` | `{marketId, price}` | 价格更新（驱动出区间检测/重试） |
| `'error'` | `Error` | 交易相关错误（**必须始终有监听器**，否则 Node 进程崩溃） |

## 接入流程（以新增 OANDA 为例）

1. 建目录 `src/exchange/oanda/`，实现上述契约（参考 `src/exchange/mt5/` 现有实现）；
2. 在 `src/exchange/oanda/index.js` 提供 `createExchange(slotCfg, platformCfg, magic)` 工厂，
   按 `slotCfg.mode` 返回 paper（模拟撮合）/ live（真实订单）适配器；
3. 在 `src/server.js` 顶部按槽位注册工厂，并把槽位的 `platform` 配置指向它（见下文）；
4. 在 `.env` 设置 `XAU_PLATFORM=oanda` + OANDA 凭据，重启程序即可。

> 平台工厂注册方式：`src/server.js` 中 `createExchange(slotCfg, mt5Cfg, magic)` 目前直接
> import mt5 工厂。接入多平台后改为按 `slotCfg.platform` 分发（`switch` 或注册表），
> 其余逻辑（GridBot、总览、AI、代理、持久化）完全不变。

## 目录规划

```
src/exchange/
├─ mt5/                 # ★ 已实现：MT5 通道（当前 5 槽位共用）
│  ├─ bridge.js         #   Python 桥客户端（进程管理 + JSON-lines）
│  ├─ base.js           #   行情基类（规格/K线/价格轮询/合成降级）
│  ├─ paper.js          #   paper：真实行情 + 本地模拟撮合
│  ├─ mt5.js            #   live：真实订单（order_send）
│  └─ index.js          #   工厂
├─ oanda/               # （示例，未实现）OANDA REST API
├─ fxcm/                # （示例，未实现）
└─ platforms/README.md  # 本文件（接口契约）
```

## 安全边界

- paper 适配器**绝不能**发送真实订单——撮合必须完全本地模拟；
- 密钥只从 `.env` 读取，绝不写日志/前端回显明文；
- 适配器实现的 `closePosition` 等不可逆操作必须真实可用且在 live 模式被 bot 正确调用；
- 新平台接入后必须跑 `npm test`（含适配器集成测试），并先在 paper 模式验证全流程。
