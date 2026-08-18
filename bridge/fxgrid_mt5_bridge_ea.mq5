//+------------------------------------------------------------------+
//|                                    fxgrid_mt5_bridge_ea.mq5      |
//|  MT5 <-> Node 桥 EA（fx-grid-bot 专用）                          |
//|                                                                    |
//|  解决 MT5 build 6090 IPC 端口冲突：本 EA 在终端进程内运行，       |
//|  通过 WebRequest 与本地 Node HTTP 服务通信，彻底绕开              |
//|  Python 库(MetaTrader5)依赖的 IPC dispatcher(22346 端口)。        |
//|                                                                    |
//|  协议（全部指向 127.0.0.1:EA_BRIDGE_PORT）：                      |
//|    POST /state    -> 上报 账户/5品种tick/挂单/持仓 (JSON)         |
//|    GET  /cmd      -> 拉取待执行命令 (纯文本行)                    |
//|    POST /result   -> 回报命令执行结果 (JSON)                      |
//|                                                                    |
//|  注意：需在 MT5 终端【工具->选项->EA交易->WebRequest 允许列表】   |
//|  加入 http://127.0.0.1:端口 才能联网（本 EA 只连本机）。          |
//+------------------------------------------------------------------+
#property copyright "fx-grid-bot"
#property version   "0.1.0"
#property strict
#property description "fx-grid-bot MT5 bridge: quote/order bridge to local Node server"

//--- inputs
input string EA_BRIDGE_HOST = "127.0.0.1";   // Node 桥主机
input int    EA_BRIDGE_PORT = 8383;           // Node 桥端口
input int    EA_POLL_MS     = 1000;           // 轮询间隔(毫秒)
input string EA_SYMBOLS     = "XAUUSD,EURUSD,GBPUSD,USDJPY,NAS100"; // 监控品种(逗号分隔)

//--- globals
string g_symbols[];
int    g_symbols_count = 0;
string g_base = "";
long   g_timer_ms = 0;
string g_cmd_buf = "";    // 从 Node 拉到的命令缓存
int    g_req_seq = 0;

//+------------------------------------------------------------------+
//| 初始化                                                            |
//+------------------------------------------------------------------+
int OnInit()
{
   g_base = "http://" + EA_BRIDGE_HOST + ":" + IntegerToString(EA_BRIDGE_PORT);

   // 解析监控品种
   string parts[];
   int n = StringSplit(EA_SYMBOLS, ',', parts);
   for(int i = 0; i < n; i++)
   {
      string s = parts[i];
      StringTrimLeft(s);
      StringTrimRight(s);
      if(s != "")
      {
         int idx = ArraySize(g_symbols);
         ArrayResize(g_symbols, idx + 1);
         g_symbols[idx] = s;
         // 确保符号在市场报价中
         SymbolSelect(s, true);
      }
   }
   g_symbols_count = ArraySize(g_symbols);
   if(g_symbols_count == 0)
   {
      Print("fxgrid-bridge: 没有有效监控品种，使用默认 XAUUSD");
      ArrayResize(g_symbols, 1);
      g_symbols[0] = "XAUUSD";
      SymbolSelect("XAUUSD", true);
      g_symbols_count = 1;
   }

   // 启动定时器轮询
   int poll = EA_POLL_MS < 200 ? 200 : EA_POLL_MS;
   if(!EventSetMillisecondTimer(poll))
   {
      Diag("EventSetMillisecondTimer 失败");
      Print("fxgrid-bridge: EventSetMillisecondTimer 失败");
      return(INIT_FAILED);
   }
   g_timer_ms = poll;

   Diag("started, symbols=" + EA_SYMBOLS + ", server=" + g_base);
   Print("fxgrid-bridge: started, symbols=", EA_SYMBOLS, ", server=", g_base);
   // 启动立即上报一次
   SendState();
   return(INIT_SUCCEEDED);
}

//+------------------------------------------------------------------+
//| 定时器                                                             |
//+------------------------------------------------------------------+
void OnTimer()
{
   // 1) 上报状态（行情/订单/持仓）
   SendState();
   // 2) 拉取命令并执行
   PollCommand();
}

//+------------------------------------------------------------------+
//| 终端关闭                                                           |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   EventKillTimer();
   Print("fxgrid-bridge: stopped, reason=", reason);
}

//+------------------------------------------------------------------+
//| 交易事件（订单/成交变化时立即上报，加速 Node 端检测）              |
//+------------------------------------------------------------------+
void OnTradeTransaction(const MqlTradeTransaction& trans,
                        const MqlTradeRequest& request,
                        const MqlTradeResult& result)
{
   SendState();
}

//+------------------------------------------------------------------+
//| 上报状态                                                          |
//+------------------------------------------------------------------+
void SendState()
{
   string body = BuildStateJson();
   string headers;
   char data[];
   char resp[];
   StringToCharArray(body, data, 0, StringLen(body), CP_UTF8);
   int timeout = 2000;
   int code = WebRequest("POST", g_base + "/state", "", "", timeout, data, ArraySize(data), resp, headers);
   if(code == -1)
   {
      int err = GetLastError();
      // 4014 = 白名单未包含 URL; 4015 = 连接失败
      if(err == 4014)
      {
         Diag("WebRequest 被拒(4014)！白名单未包含 " + g_base + "。请在 工具->选项->EA交易->WebRequest允许列表 添加");
         Print("fxgrid-bridge: WebRequest 被拒(4014)。请在 MT5 工具->选项->EA交易->WebRequest允许列表 添加: ", g_base);
      }
      else if(err != 0 && err != 10035)
      {
         Diag("WebRequest 失败 code=" + IntegerToString(code) + " err=" + IntegerToString(err));
         Print("fxgrid-bridge: /state 失败 code=", code, " err=", err);
      }
   }
   else if(code != 200)
   {
      Diag("/state HTTP " + IntegerToString(code));
      Print("fxgrid-bridge: /state HTTP ", code);
   }
   else
   {
      Diag("/state OK (" + IntegerToString(ArraySize(resp)) + "B resp)");
   }
}

//+------------------------------------------------------------------+
//| 拉取命令                                                          |
//+------------------------------------------------------------------+
void PollCommand()
{
   string headers;
   char resp[];
   char empty[];
   int timeout = 2000;
   int code = WebRequest("GET", g_base + "/cmd", "", "", timeout, empty, ArraySize(empty), resp, headers);
   if(code == -1)
   {
      int err = GetLastError();
      if(err != 0 && err != 10035)
         Print("fxgrid-bridge: /cmd 失败 code=", code, " err=", err);
      return;
   }
   if(code != 200) return;

   string cmd = CharArrayToString(resp, 0, WHOLE_ARRAY, CP_UTF8);
   StringTrimLeft(cmd);
   StringTrimRight(cmd);
   if(cmd == "" || cmd == "NONE") return;

   g_cmd_buf = cmd;
   ExecuteCommand(cmd);
}

//+------------------------------------------------------------------+
//| 执行命令（返回执行结果 JSON）                                     |
//+------------------------------------------------------------------+
void ExecuteCommand(string cmd)
{
   // 命令格式: <verb>|<param1>|<param2>|...
   //  GET_CANDLES|symbol|timeframe_sec|count
   //  PLACE|symbol|buy|sell|price|volume|magic|comment
   //  CANCEL|symbol|ticket
   //  CANCEL_ALL|symbol|magic
   //  CLOSE|symbol
   string parts[];
   int n = StringSplit(cmd, '|', parts);
   if(n < 1) return;
   string verb = parts[0];
   string result_json = "";
   string symbol = (n > 1 ? parts[1] : "");

   if(verb == "GET_CANDLES" && n >= 4)
   {
      ENUM_TIMEFRAMES tf = TimeframeFromSec((int)StringToInteger(parts[2]));
      int count = (int)StringToInteger(parts[3]);
      result_json = CandlesToJson(symbol, tf, count);
   }
   else if(verb == "PLACE" && n >= 8)
   {
      string side = parts[2];          // buy|sell
      double price = StringToDouble(parts[3]);
      double volume = StringToDouble(parts[4]);
      long magic = StringToInteger(parts[5]);
      string comment = parts[6];
      // 可选 sl/tp: parts[7], parts[8]
      double sl = (n > 7 ? StringToDouble(parts[7]) : 0);
      double tp = (n > 8 ? StringToDouble(parts[8]) : 0);
      result_json = PlaceLimit(symbol, side, price, volume, sl, tp, magic, comment);
   }
   else if(verb == "CANCEL" && n >= 3)
   {
      ulong ticket = StringToInteger(parts[2]);
      result_json = CancelOrder(symbol, ticket);
   }
   else if(verb == "CANCEL_ALL" && n >= 3)
   {
      long magic = StringToInteger(parts[2]);
      result_json = CancelAll(symbol, magic);
   }
   else if(verb == "CLOSE" && n >= 2)
   {
      result_json = ClosePosition(symbol);
   }
   else if(verb == "PING")
   {
      result_json = "{\"ok\":true,\"pong\":true}";
   }
   else
   {
      result_json = "{\"ok\":false,\"error\":\"unknown command: " + cmd + "\"}";
   }

   // 回报结果
   SendResult(result_json);
}

//+------------------------------------------------------------------+
//| 上报命令执行结果                                                  |
//+------------------------------------------------------------------+
void SendResult(string result_json)
{
   string body = result_json;
   char data[];
   char resp[];
   string headers;
   StringToCharArray(body, data, 0, StringLen(body), CP_UTF8);
   int code = WebRequest("POST", g_base + "/result", "", "", 2000, data, ArraySize(data), resp, headers);
   if(code != 200)
      Print("fxgrid-bridge: /result 失败 code=", code, " err=", GetLastError());
}

//+------------------------------------------------------------------+
//| 秒 -> MQL5 时间周期                                                |
//+------------------------------------------------------------------+
ENUM_TIMEFRAMES TimeframeFromSec(int sec)
{
   switch(sec)
   {
      case 60:    return(PERIOD_M1);
      case 300:   return(PERIOD_M5);
      case 900:   return(PERIOD_M15);
      case 1800:  return(PERIOD_M30);
      case 3600:  return(PERIOD_H1);
      case 7200:  return(PERIOD_H2);
      case 14400: return(PERIOD_H4);
      case 86400: return(PERIOD_D1);
      default:    return(PERIOD_H1);
   }
}

//+------------------------------------------------------------------+
//| 构建状态 JSON（账户 + 品种 tick + 挂单 + 持仓）                   |
//+------------------------------------------------------------------+
string BuildStateJson()
{
   string s = "";
   // 账户
   double balance = AccountInfoDouble(ACCOUNT_BALANCE);
   double equity  = AccountInfoDouble(ACCOUNT_EQUITY);
   double margin  = AccountInfoDouble(ACCOUNT_MARGIN);
   double free    = AccountInfoDouble(ACCOUNT_MARGIN_FREE);
   long   login   = AccountInfoInteger(ACCOUNT_LOGIN);
   string server  = AccountInfoString(ACCOUNT_SERVER);
   long   leverage= AccountInfoInteger(ACCOUNT_LEVERAGE);
   int    trade_mode = (int)AccountInfoInteger(ACCOUNT_TRADE_MODE);

   s += "{\"account\":{";
   s += "\"login\":" + IntegerToString(login);
   s += ",\"server\":\"" + server + "\"";
   s += ",\"balance\":" + DoubleToString(balance, 2);
   s += ",\"equity\":" + DoubleToString(equity, 2);
   s += ",\"margin\":" + DoubleToString(margin, 2);
   s += ",\"margin_free\":" + DoubleToString(free, 2);
   s += ",\"leverage\":" + IntegerToString(leverage);
   s += ",\"trade_mode\":" + IntegerToString(trade_mode);
   s += "}";

   // 品种 tick
   s += ",\"prices\":[";
   for(int i = 0; i < g_symbols_count; i++)
   {
      string sym = g_symbols[i];
      MqlTick tick;
      bool got = SymbolInfoTick(sym, tick);
      if(i > 0) s += ",";
      s += "{\"symbol\":\"" + sym + "\"";
      if(got)
      {
         s += ",\"bid\":" + DoubleToString(tick.bid, _DigitsFor(sym));
         s += ",\"ask\":" + DoubleToString(tick.ask, _DigitsFor(sym));
         s += ",\"time\":" + IntegerToString((long)tick.time_msc);
      }
      s += "}";
   }
   s += "]";

   // 挂单
   s += ",\"orders\":[";
   int oi = 0;
   for(int i = OrdersTotal() - 1; i >= 0; i--)
   {
      ulong ticket = OrderGetTicket(i);
      if(ticket == 0) continue;
      if(!OrderSelect(ticket)) continue;
      string osym = OrderGetString(ORDER_SYMBOL);
      // 只上报监控品种（避免把用户手动单全塞给 Node）
      if(!IsMonitored(osym)) continue;
      if(oi > 0) s += ",";
      s += "{\"ticket\":\"" + IntegerToString(ticket) + "\"";
      s += ",\"symbol\":\"" + osym + "\"";
      s += ",\"type\":" + IntegerToString(OrderGetInteger(ORDER_TYPE));
      s += ",\"price_open\":" + DoubleToString(OrderGetDouble(ORDER_PRICE_OPEN), _DigitsFor(osym));
      s += ",\"volume\":\"" + DoubleToString(OrderGetDouble(ORDER_VOLUME_CURRENT), 2) + "\"";
      s += ",\"volume_initial\":\"" + DoubleToString(OrderGetDouble(ORDER_VOLUME_INITIAL), 2) + "\"";
      s += ",\"magic\":" + IntegerToString(OrderGetInteger(ORDER_MAGIC));
      s += ",\"comment\":\"" + OrderGetString(ORDER_COMMENT) + "\"";
      s += ",\"sl\":" + DoubleToString(OrderGetDouble(ORDER_SL), _DigitsFor(osym));
      s += ",\"tp\":" + DoubleToString(OrderGetDouble(ORDER_TP), _DigitsFor(osym));
      s += "}";
      oi++;
   }
   s += "]";

   // 持仓
   s += ",\"positions\":[";
   int pi = 0;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0) continue;
      if(!PositionSelectByTicket(ticket)) continue;
      string psym = PositionGetString(POSITION_SYMBOL);
      if(!IsMonitored(psym)) continue;
      if(pi > 0) s += ",";
      s += "{\"ticket\":\"" + IntegerToString(ticket) + "\"";
      s += ",\"symbol\":\"" + psym + "\"";
      s += ",\"type\":" + IntegerToString(PositionGetInteger(POSITION_TYPE));
      s += ",\"volume\":\"" + DoubleToString(PositionGetDouble(POSITION_VOLUME), 2) + "\"";
      s += ",\"price_open\":" + DoubleToString(PositionGetDouble(POSITION_PRICE_OPEN), _DigitsFor(psym));
      s += ",\"sl\":" + DoubleToString(PositionGetDouble(POSITION_SL), _DigitsFor(psym));
      s += ",\"tp\":" + DoubleToString(PositionGetDouble(POSITION_TP), _DigitsFor(psym));
      s += ",\"profit\":" + DoubleToString(PositionGetDouble(POSITION_PROFIT), 2);
      s += ",\"swap\":" + DoubleToString(PositionGetDouble(POSITION_SWAP), 2);
      s += ",\"magic\":" + IntegerToString(PositionGetInteger(POSITION_MAGIC));
      s += "}";
      pi++;
   }
   s += "]";

   s += ",\"ts\":" + IntegerToString((long)TimeCurrent());
   s += "}";
   return(s);
}

//+------------------------------------------------------------------+
//| 拉取K线为 JSON                                                    |
//+------------------------------------------------------------------+
string CandlesToJson(string symbol, ENUM_TIMEFRAMES tf, int count)
{
   MqlRates rates[];
   int got = CopyRates(symbol, tf, 0, count, rates);
   string s = "{\"ok\":true,\"symbol\":\"" + symbol + "\",\"timeframe\":" + IntegerToString((int)tf) + ",\"candles\":[";
   if(got > 0)
   {
      for(int i = 0; i < got; i++)
      {
         if(i > 0) s += ",";
         s += "{\"time\":" + IntegerToString((long)rates[i].time);
         s += ",\"open\":" + DoubleToString(rates[i].open, _DigitsFor(symbol));
         s += ",\"high\":" + DoubleToString(rates[i].high, _DigitsFor(symbol));
         s += ",\"low\":" + DoubleToString(rates[i].low, _DigitsFor(symbol));
         s += ",\"close\":" + DoubleToString(rates[i].close, _DigitsFor(symbol));
         s += ",\"volume\":" + DoubleToString(rates[i].tick_volume, 0);
         s += "}";
      }
   }
   s += "],\"count\":" + IntegerToString(got) + "}";
   return(s);
}

//+------------------------------------------------------------------+
//| 挂限价单                                                          |
//+------------------------------------------------------------------+
string PlaceLimit(string symbol, string side, double price, double volume,
                  double sl, double tp, long magic, string comment)
{
   MqlTradeRequest req;
   MqlTradeResult res;
   ZeroMemory(req);
   ZeroMemory(res);

   req.action    = TRADE_ACTION_PENDING;
   req.symbol    = symbol;
   req.volume    = volume;
   req.price     = price;
   req.sl        = sl;
   req.tp        = tp;
   req.deviation = 20;
   req.magic     = magic;
   req.comment   = StringSubstr(comment, 0, 31);
   req.type_time = ORDER_TIME_GTC;
   req.type_filling = ORDER_FILLING_RETURN;

   if(side == "buy")
      req.type = ORDER_TYPE_BUY_LIMIT;
   else if(side == "sell")
      req.type = ORDER_TYPE_SELL_LIMIT;
   else
      return("{\"ok\":false,\"error\":\"bad side: " + side + "\"}");

   if(!OrderSend(req, res))
   {
      // 重试 IOC
      req.type_filling = ORDER_FILLING_IOC;
      if(!OrderSend(req, res))
         return("{\"ok\":false,\"error\":\"" + DoubleToString(res.retcode, 0) + " " + res.comment + "\"}");
   }

   return("{\"ok\":true,\"ticket\":\"" + IntegerToString(res.order) + "\",\"retcode\":" + IntegerToString(res.retcode) + ",\"price\":" + DoubleToString(res.price, _DigitsFor(symbol)) + ",\"volume\":" + DoubleToString(res.volume, 2) + "}");
}

//+------------------------------------------------------------------+
//| 撤单                                                              |
//+------------------------------------------------------------------+
string CancelOrder(string symbol, ulong ticket)
{
   MqlTradeRequest req;
   MqlTradeResult res;
   ZeroMemory(req);
   ZeroMemory(res);
   req.action = TRADE_ACTION_REMOVE;
   req.symbol = symbol;
   req.order  = ticket;
   if(!OrderSend(req, res))
      return("{\"ok\":false,\"error\":\"" + DoubleToString(res.retcode, 0) + " " + res.comment + "\"}");
   return("{\"ok\":true,\"ticket\":\"" + IntegerToString(ticket) + "\"}");
}

//+------------------------------------------------------------------+
//| 批量撤单（按品种+magic）                                          |
//+------------------------------------------------------------------+
string CancelAll(string symbol, long magic)
{
   int cancelled = 0;
   string errors = "";
   for(int i = OrdersTotal() - 1; i >= 0; i--)
   {
      ulong ticket = OrderGetTicket(i);
      if(ticket == 0) continue;
      if(!OrderSelect(ticket)) continue;
      if(OrderGetString(ORDER_SYMBOL) != symbol) continue;
      if(magic != 0 && OrderGetInteger(ORDER_MAGIC) != magic) continue;
      string r = CancelOrder(symbol, ticket);
      if(StringFind(r, "\"ok\":true") >= 0)
         cancelled++;
      else
         errors += r + ";";
   }
   return("{\"ok\":true,\"cancelled\":" + IntegerToString(cancelled) + ",\"errors\":\"" + errors + "\"}");
}

//+------------------------------------------------------------------+
//| 市价平仓（该品种全部）                                            |
//+------------------------------------------------------------------+
string ClosePosition(string symbol)
{
   int closed = 0;
   string errors = "";
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0) continue;
      if(!PositionSelectByTicket(ticket)) continue;
      if(PositionGetString(POSITION_SYMBOL) != symbol) continue;

      double vol = PositionGetDouble(POSITION_VOLUME);
      long ptype = PositionGetInteger(POSITION_TYPE);
      MqlTradeRequest req;
      MqlTradeResult res;
      ZeroMemory(req);
      ZeroMemory(res);
      req.action    = TRADE_ACTION_DEAL;
      req.symbol    = symbol;
      req.volume    = vol;
      req.type      = (ptype == POSITION_TYPE_BUY ? ORDER_TYPE_SELL : ORDER_TYPE_BUY);
      req.position  = ticket;
      req.deviation = 30;
      req.magic     = PositionGetInteger(POSITION_MAGIC);
      req.comment   = "GRID_CLOSE";
      req.type_filling = ORDER_FILLING_IOC;
      if(OrderSend(req, res))
         closed++;
      else
         errors += IntegerToString(ticket) + ":" + DoubleToString(res.retcode, 0) + " " + res.comment + ";";
   }
   return("{\"ok\":true,\"closed\":" + IntegerToString(closed) + ",\"errors\":\"" + errors + "\"}");
}

//+------------------------------------------------------------------+
//| 诊断日志（写文件，便于命令行读取，区别于 Print 只进专家标签）       |
//+------------------------------------------------------------------+
void Diag(string msg)
{
   string fn = "fxgrid_bridge_diag.log";
   int h = FileOpen(fn, FILE_READ|FILE_WRITE|FILE_TXT|FILE_ANSI);
   if(h == INVALID_HANDLE) return;
   FileSeek(h, 0, SEEK_END);
   FileWriteString(h, TimeToString(TimeCurrent()) + " " + msg + "\n");
   FileClose(h);
}

//+------------------------------------------------------------------+
//| 是否监控品种                                                       |
//+------------------------------------------------------------------+
bool IsMonitored(string symbol)
{
   for(int i = 0; i < g_symbols_count; i++)
      if(g_symbols[i] == symbol)
         return(true);
   return(false);
}

//+------------------------------------------------------------------+
//| 品种小数位（用于价格格式化）                                       |
//+------------------------------------------------------------------+
int _DigitsFor(string symbol)
{
   int d = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);
   return(d > 0 ? d : 5);
}
//+------------------------------------------------------------------+
