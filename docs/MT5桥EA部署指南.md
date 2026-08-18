# MT5 桥 EA 部署指南（EA 桥模式）

## 为什么需要 EA 桥

MT5 build 6090 的终端通过 **IPC dispatcher（端口 22346）** 与 Python 库（MetaTrader5）通信。
**同一台电脑上，这个端口只能被一个终端占用**——谁先启动谁占用。

你的实盘终端（F:\pepperstone / Exness）先启动了，占着 22346，导致 F:\MT5（Pepperstone-Demo）
的 IPC dispatcher 起不来，Python 桥永远连不上（IPC timeout）。**实盘终端不能关**，所以
换一种通信方式：

> **MQL5 桥 EA 在终端进程内运行**，通过 WebRequest 与本地 Node HTTP 服务通信，
> 完全不依赖 IPC 端口。实盘终端不受任何影响，F:\MT5 照常使用。

## 工作原理

```
Node 服务 (127.0.0.1:8383)  ◄──WebRequest──►  MQL5 桥 EA (在 F:\MT5 终端内)
  ├─ POST /state   ◄─────── EA 每秒上报 账户/5品种价格/挂单/持仓
  ├─ GET  /cmd     ───────► EA 拉取要执行的命令 (挂单/撤单/平仓/拉K线)
  └─ POST /result  ◄─────── EA 回报执行结果
```

## 部署步骤（一次性）

### 1. 确认 EA 已编译

`fxgrid_mt5_bridge_ea.ex5` 应存在于：
`C:\Users\Administrator\AppData\Roaming\MetaQuotes\Terminal\C54ABD31694C1B0FC8715C4F2B20FBAF\MQL5\Experts\`

（源码在项目 `bridge/fxgrid_mt5_bridge_ea.mq5`，编译方法见文末。）

### 2. 在 MT5 终端启用 WebRequest 白名单

1. 打开 F:\MT5 终端（已登录 Pepperstone-Demo 61564223）；
2. 菜单 **工具 → 选项 → EA 交易**；
3. 勾选 **允许 WebRequest 用于列出的 URL**；
4. 点击"添加"，输入：`http://127.0.0.1:8383`（注意：**必须带 http:// 前缀**）；
5. 确认"允许算法交易"已勾选；
6. 确定保存。

> 若端口改为其他值（.env 里 `EA_BRIDGE_PORT`），白名单填对应端口。

### 3. 把 EA 拖到图表

1. 在 F:\MT5 导航窗口 **智能交易系统** 下找到 `fxgrid_mt5_bridge_ea`；
2. 拖到任意品种图表（如 XAUUSD H1）；
3. 弹窗里确认"允许算法交易"，确定；
4. 图表右上角应显示笑脸 😊（表示 EA 运行中）。

### 4. 确认 EA 运行正常

- 终端底部 **专家** 标签页（或 工具→专家日志）应看到：
  `fxgrid-bridge: started, symbols=XAUUSD,EURUSD,GBPUSD,USDJPY,NAS100, server=http://127.0.0.1:8383`
- 如果看到 `WebRequest 被拒(4014)`：说明白名单没加对，重做第 2 步。

### 5. 启动 fx-grid-bot（EA 桥模式）

`.env` 中设置：

```ini
MT5_BRIDGE=ea
EA_BRIDGE_PORT=8383
```

然后：

```powershell
npm start
```

启动日志应显示：
```
[MT5-EA桥] ⚠ 等待 MQL5 桥 EA 上报（当前未收到 /state）。
[MT5-EA桥]   请确认：1) F:\MT5 已把 fxgrid_mt5_bridge_ea 拖到图表...
```
收到 EA 上报后自动切到真实行情（每个槽位日志从"合成行情"变为正常）。

## 验证真实行情

浏览器打开 `http://127.0.0.1:8283`（或被占则 8284），看任意品种卡片：
- 价格应随 MT5 行情跳动（不再是合成的假价格）；
- 总览页健康状态不再显示"合成行情"。

## 切换回 Python 桥（备用）

`.env` 中 `MT5_BRIDGE=python`（默认值）恢复 Python 桥。注意 Python 桥仍受 IPC 端口
冲突限制——只有实盘终端（F:\pepperstone）关闭时才能连上 F:\MT5。

## 常见问题

| 现象 | 原因 | 解决 |
| --- | --- | --- |
| 日志 `WebRequest 被拒(4014)` | 白名单没加 `http://127.0.0.1:8383` | 重做部署步骤 2 |
| 图表没有笑脸 | EA 未启用 | 拖 EA 时勾选"允许算法交易"，或 工具→选项→EA交易→允许算法交易 |
| 价格仍为合成 | EA 没上报或服务没起 | 检查 EA 日志 + Node 日志 |
| `[MT5-EA桥]` 提示一直显示 | EA 未上报 /state | 确认 EA 在图表上运行 |
| 端口冲突（EADDRINUSE 8383） | 另一个程序占用 | 改 `.env` 的 `EA_BRIDGE_PORT` 并同步改 EA 白名单 |

## 重新编译 EA（改代码后）

```powershell
Copy-Item F:\fx-grid-bot\bridge\fxgrid_mt5_bridge_ea.mq5 `
  "$env:APPDATA\MetaQuotes\Terminal\C54ABD31694C1B0FC8715C4F2B20FBAF\MQL5\Experts\" -Force
& 'F:\MT5\MetaEditor64.exe' /compile:"$env:APPDATA\MetaQuotes\Terminal\C54ABD31694C1B0FC8715C4F2B20FBAF\MQL5\Experts\fxgrid_mt5_bridge_ea.mq5" /log
```

然后在 MT5 里把图表上的旧 EA 移除再重新拖入（或右键图表→智能交易系统→重新加载）。

## 安全说明

- EA 只连接 `127.0.0.1`（本机），不访问任何外部地址；
- EA 只操作**监控品种**（EA_SYMBOLS 输入的 5 个品种）的订单/持仓，
  且按 magic 号区分网格单（30000+），**不会碰你的手动单**；
- live 模式才发送真实订单；paper 模式 EA 只上报行情，订单撮合在本地模拟。
