#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
MT5 常驻桥（fx-grid-bot 专用）
================================
通过 stdio JSON-lines 与 Node 端通信（协议通道 = stdout，所有日志走 stderr）。

请求:   {"id": 1, "method": "get_price", "params": {"symbol": "XAUUSD"}}
响应:   {"id": 1, "ok": true, "result": {...}}
错误:   {"id": 1, "ok": false, "error": "..."}
事件:   {"event": "status", "data": {...}}          （连接状态变化）

方法列表:
  ping                     -> {"pong": true, "connected": bool}
  init                     -> 连接终端（指数退避重试），返回账户信息
  get_account              -> 账户信息（login/server/balance/equity/leverage/...）
  get_symbols              -> 全部可交易品种规格
  get_markets              -> 指定品种列表的规格（params.symbols）
  get_candles              -> 真实历史K线  params: {symbol, intervalSec, n}
  get_price                -> 最新 bid/ask  params: {symbol}
  get_snapshot             -> 挂单+持仓+价格 一次拿全  params: {symbol}
  place_limit              -> 挂限价单  params: {symbol, side, price, volume, sl?, tp?, magic?, comment?}
  cancel                   -> 撤销单笔  params: {symbol, ticket}
  cancel_all               -> 撤销某品种全部挂单  params: {symbol, magic?}
  close_position           -> 市价平仓  params: {symbol, volume?, ticket?}
  set_leverage             -> MT5 杠杆为账户级，返回提示（不执行）
  shutdown                 -> 干净退出
"""
import sys
import os
import json
import time
import threading

import MetaTrader5 as mt5

# ── 配置（环境变量覆盖） ──────────────────────────────────────────────────────
TERMINAL_PATH = os.environ.get('MT5_TERMINAL', r'F:\MT5\terminal64.exe')
LOGIN = os.environ.get('MT5_LOGIN', '')
PASSWORD = os.environ.get('MT5_PASSWORD', '')
SERVER = os.environ.get('MT5_SERVER', '')
RETRY_BASE_MS = int(os.environ.get('MT5_RETRY_BASE_MS', '5000'))
RETRY_MAX_MS = int(os.environ.get('MT5_RETRY_MAX_MS', '30000'))
POLL_MS = int(os.environ.get('MT5_POLL_MS', '1000'))
LOG_FILE = os.environ.get('MT5_BRIDGE_LOG', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'bridge.log'))

# MT5 时间周期常量
TIMEFRAMES = {
    60: mt5.TIMEFRAME_M1,
    300: mt5.TIMEFRAME_M5,
    900: mt5.TIMEFRAME_M15,
    1800: mt5.TIMEFRAME_M30,
    3600: mt5.TIMEFRAME_H1,
    7200: mt5.TIMEFRAME_H2,
    14400: mt5.TIMEFRAME_H4,
    86400: mt5.TIMEFRAME_D1,
}

_connected = False
_connected_at = 0
_last_error = None
_lock = threading.Lock()   # 串行化 mt5 API 调用（mt5 库非线程安全）

def log(msg):
    """所有日志走 stderr，绝不污染 stdout 协议通道。"""
    ts = time.strftime('%Y-%m-%d %H:%M:%S')
    line = f'[{ts}] {msg}'
    try:
        sys.stderr.write(line + '\n')
        sys.stderr.flush()
        with open(LOG_FILE, 'a', encoding='utf-8') as f:
            f.write(line + '\n')
    except Exception:
        pass

def emit(event, data):
    sys.stdout.write(json.dumps({'event': event, 'data': data}, ensure_ascii=False) + '\n')
    sys.stdout.flush()

def connect(attempt=1, timeout_ms=8000):
    """连接终端（惰性：由 init 请求触发，主线程同步执行，带超时）。
    timeout_ms 限制 initialize 阻塞时长 —— C 扩展调用会占住 GIL，
    不能让它在后台线程里无限阻塞导致协议请求全部超时。"""
    global _connected, _connected_at, _last_error
    kwargs = {'path': TERMINAL_PATH, 'timeout': timeout_ms}
    if LOGIN:
        kwargs['login'] = int(LOGIN)
        kwargs['password'] = PASSWORD
        if SERVER:
            kwargs['server'] = SERVER
    try:
        ok = mt5.initialize(**kwargs)
        if ok:
            _connected = True
            _connected_at = time.time()
            _last_error = None
            log(f'MT5 connected: login={LOGIN or "auto"} server={SERVER or "auto"}')
            emit('status', {'connected': True, 'ts': _connected_at})
            return {'connected': True, 'account': account_info()}
        err = mt5.last_error()
        _last_error = str(err)
        log(f'initialize failed (attempt {attempt}): {err}')
    except Exception as e:
        _last_error = str(e)
        log(f'initialize exception (attempt {attempt}): {e}')
    emit('status', {'connected': False, 'error': _last_error, 'attempt': attempt})
    return {'connected': False, 'error': _last_error}

def start_retry_loop():
    """连接失败后的后台指数退避重试。每次尝试带超时，不阻塞协议请求。"""
    def loop():
        attempt = 2
        while True:
            delay = min(RETRY_MAX_MS, RETRY_BASE_MS * (2 ** (attempt - 2)))
            time.sleep(delay / 1000.0)
            if _connected:
                return
            connect(attempt=attempt, timeout_ms=8000)
            attempt += 1
    threading.Thread(target=loop, daemon=True).start()

def account_info():
    with _lock:
        info = mt5.account_info()
    if not info:
        return None
    return {
        'login': info.login,
        'server': info.server,
        'name': info.name,
        'currency': info.currency,
        'balance': info.balance,
        'equity': info.equity,
        'margin': info.margin,
        'margin_free': info.margin_free,
        'leverage': info.leverage,
        'trade_mode': info.trade_mode,
        'hedging': info.margin_mode == 1,  # 粗略：netting=0 hedging=1（实际看 margin_mode）
    }

def symbol_spec(sym):
    with _lock:
        info = mt5.symbol_info(sym)
    if not info:
        return None
    return {
        'name': info.name,
        'digits': info.digits,
        'point': info.point,
        'trade_mode': info.trade_mode,
        'volume_min': info.volume_min,
        'volume_max': info.volume_max,
        'volume_step': info.volume_step,
        'spread': info.spread,
        'trade_tick_size': info.trade_tick_size,
        'trade_tick_value': info.trade_tick_value,
        'trade_contract_size': info.trade_contract_size,
        'currency_profit': info.currency_profit,
        'currency_margin': info.currency_margin,
        'margin_initial': info.margin_initial,
        'swap_long': info.swap_long,
        'swap_short': info.swap_short,
        'session_deals': info.session_deals,
        'visible': info.visible,
    }

def candle_row(r):
    """copy_rates 返回的命名元组 -> dict"""
    return {
        'time': int(r[0]),
        'open': float(r[1]),
        'high': float(r[2]),
        'low': float(r[3]),
        'close': float(r[4]),
        'volume': float(r[5]),
    }

def get_candles(symbol, interval_sec, n):
    tf = TIMEFRAMES.get(int(interval_sec))
    if tf is None:
        raise ValueError(f'不支持的K线周期: {interval_sec}s（支持 60/300/900/1800/3600/7200/14400/86400）')
    with _lock:
        rates = mt5.copy_rates_from_pos(symbol, tf, 0, min(int(n), 1000))
    if rates is None or len(rates) == 0:
        err = mt5.last_error()
        return {'candles': [], 'error': str(err)}
    return {'candles': [candle_row(r) for r in rates]}

def tick(symbol):
    with _lock:
        t = mt5.symbol_info_tick(symbol)
    if not t:
        return None
    return {'bid': float(t.bid), 'ask': float(t.ask), 'last': float(t.last), 'time': int(t.time_msc)}

def open_orders(symbol, magic=None):
    with _lock:
        orders = mt5.orders_get(symbol=symbol) if symbol else mt5.orders_get()
    out = []
    for o in (orders or []):
        if magic is not None and o.magic != magic:
            continue
        out.append({
            'ticket': o.ticket,
            'symbol': o.symbol,
            'type': o.type,
            'type_str': o.type_str,
            'volume': o.volume_current,
            'volume_initial': o.volume_initial,
            'price_open': o.price_open,
            'sl': o.sl,
            'tp': o.tp,
            'magic': o.magic,
            'comment': o.comment,
            'time_setup': o.time_setup,
        })
    return out

def positions(symbol=None):
    with _lock:
        pos = mt5.positions_get(symbol=symbol) if symbol else mt5.positions_get()
    out = []
    for p in (pos or []):
        out.append({
            'ticket': p.ticket,
            'symbol': p.symbol,
            'type': p.type,
            'type_str': p.type_str,
            'volume': p.volume,
            'price_open': p.price_open,
            'sl': p.sl,
            'tp': p.tp,
            'profit': p.profit,
            'swap': p.swap,
            'magic': p.magic,
            'comment': p.comment,
            'time': p.time,
        })
    return out

def place_limit(symbol, side, price, volume, sl=None, tp=None, magic=0, comment='GRID', deviation=20):
    """挂限价单。side: 'buy' | 'sell'"""
    order_type = mt5.ORDER_TYPE_BUY_LIMIT if side == 'buy' else mt5.ORDER_TYPE_SELL_LIMIT
    request = {
        'action': mt5.TRADE_ACTION_PENDING,
        'symbol': symbol,
        'volume': float(volume),
        'type': order_type,
        'price': float(price),
        'sl': float(sl) if sl else 0.0,
        'tp': float(tp) if tp else 0.0,
        'deviation': deviation,
        'magic': int(magic),
        'comment': str(comment)[:31],
        'type_time': mt5.ORDER_TIME_GTC,
        'type_filling': mt5.ORDER_FILLING_RETURN,
    }
    with _lock:
        result = mt5.order_send(request)
    if result is None:
        return {'ok': False, 'error': str(mt5.last_error())}
    if result.retcode not in (mt5.TRADE_RETCODE_DONE, mt5.TRADE_RETCODE_PLACED):
        # 重试 IOC 填充模式（对齐 place_limit.py 的既有做法）
        request['type_filling'] = mt5.ORDER_FILLING_IOC
        with _lock:
            result = mt5.order_send(request)
        if result is None:
            return {'ok': False, 'error': str(mt5.last_error())}
        if result.retcode not in (mt5.TRADE_RETCODE_DONE, mt5.TRADE_RETCODE_PLACED):
            return {'ok': False, 'error': f'retcode={result.retcode} {result.comment}'}
    return {'ok': True, 'ticket': result.order, 'retcode': result.retcode, 'price': result.price, 'volume': result.volume}

def cancel(symbol, ticket):
    request = {
        'action': mt5.TRADE_ACTION_REMOVE,
        'symbol': symbol,
        'order': int(ticket),
    }
    with _lock:
        result = mt5.order_send(request)
    if result is None:
        return {'ok': False, 'error': str(mt5.last_error())}
    if result.retcode != mt5.TRADE_RETCODE_DONE and result.retcode != mt5.TRADE_RETCODE_PLACED:
        return {'ok': False, 'error': f'retcode={result.retcode} {result.comment}'}
    return {'ok': True, 'ticket': int(ticket)}

def cancel_all(symbol, magic=None):
    orders = open_orders(symbol, magic)
    errors = []
    for o in orders:
        try:
            r = cancel(symbol, o['ticket'])
            if not r['ok']:
                errors.append(f"#{o['ticket']}: {r['error']}")
        except Exception as e:
            errors.append(f"#{o['ticket']}: {e}")
    return {'ok': len(errors) == 0, 'cancelled': len(orders), 'errors': errors}

def close_position(symbol, volume=None, ticket=None, deviation=30):
    """市价平仓：优先按 ticket，否则按品种。volume 缺省 = 全部。"""
    pos_list = positions(symbol)
    if not pos_list:
        return {'ok': True, 'closed': 0, 'message': '无持仓'}
    target = [p for p in pos_list if (ticket is None or p['ticket'] == int(ticket))]
    closed = 0
    errors = []
    for p in target:
        vol = float(volume) if volume else float(p['volume'])
        close_type = mt5.ORDER_TYPE_SELL if p['type'] == 0 else mt5.ORDER_TYPE_BUY  # 0=buy position -> close sell
        request = {
            'action': mt5.TRADE_ACTION_DEAL,
            'symbol': symbol,
            'volume': vol,
            'type': close_type,
            'position': p['ticket'],
            'deviation': deviation,
            'magic': p['magic'],
            'comment': 'GRID_CLOSE',
            'type_filling': mt5.ORDER_FILLING_IOC,
        }
        with _lock:
            result = mt5.order_send(request)
        if result is None:
            errors.append(f"#{p['ticket']}: {mt5.last_error()}")
        elif result.retcode != mt5.TRADE_RETCODE_DONE:
            errors.append(f"#{p['ticket']}: retcode={result.retcode} {result.comment}")
        else:
            closed += 1
    return {'ok': len(errors) == 0, 'closed': closed, 'errors': errors}

# ── 请求分发 ──────────────────────────────────────────────────────────────────
HANDLERS = {
    'ping': lambda p: {'pong': True, 'connected': _connected, 'ts': time.time()},
    'get_account': lambda p: account_info(),
    'get_symbols': lambda p: [symbol_spec(s) for s in (p.get('symbols') or []) if symbol_spec(s)],
    'get_candles': lambda p: get_candles(p['symbol'], p.get('intervalSec', 3600), p.get('n', 200)),
    'get_price': lambda p: tick(p['symbol']),
    'get_snapshot': lambda p: {
        'price': tick(p['symbol']),
        'orders': open_orders(p['symbol'], p.get('magic')),
        'positions': positions(p['symbol']),
    },
    'place_limit': lambda p: place_limit(
        p['symbol'], p.get('side', 'buy'), p['price'], p['volume'],
        p.get('sl'), p.get('tp'), p.get('magic', 0), p.get('comment', 'GRID'),
    ),
    'cancel': lambda p: cancel(p['symbol'], p['ticket']),
    'cancel_all': lambda p: cancel_all(p['symbol'], p.get('magic')),
    'close_position': lambda p: close_position(p['symbol'], p.get('volume'), p.get('ticket')),
    'set_leverage': lambda p: {'ok': True, 'warning': 'MT5 杠杆为账户级，无法按品种设置，请忽略。'},
}

def handle(method, params):
    if method == 'init':
        # 惰性连接：首个 init 请求在主线程同步连接（带超时，不阻塞太久）
        if _connected:
            return {'connected': True, 'account': account_info()}
        result = connect(attempt=1, timeout_ms=8000)
        if not result.get('connected'):
            # 失败 -> 后台指数退避重试（不影响协议请求）
            start_retry_loop()
        return result
    if method == 'shutdown':
        with _lock:
            mt5.shutdown()
        sys.stdout.write(json.dumps({'id': params.get('id'), 'ok': True, 'result': {'bye': True}}, ensure_ascii=False) + '\n')
        sys.stdout.flush()
        os._exit(0)
    if method not in HANDLERS:
        raise ValueError(f'未知方法: {method}')
    return HANDLERS[method](params or {})

def main():
    log(f'bridge starting: terminal={TERMINAL_PATH} login={LOGIN or "auto"} server={SERVER or "auto"}')
    # 惰性连接：不在启动时连终端（避免 C 扩展 initialize 阻塞 GIL 卡死协议），
    # 由首个 init 请求触发主线程同步连接，失败后 start_retry_loop 后台重试。
    # 周期心跳：MT5 终端长时间无 API 调用可能自动退出，定期 get_account 保活
    def keepalive():
        while True:
            time.sleep(30)
            try:
                if _connected:
                    with _lock:
                        mt5.account_info()
            except Exception:
                pass
    threading.Thread(target=keepalive, daemon=True).start()

    buffer = ''
    for line in sys.stdin:
        buffer = line
        try:
            req = json.loads(buffer)
        except Exception:
            log(f'bad request: {buffer[:200]}')
            continue
        rid = req.get('id')
        method = req.get('method')
        params = req.get('params') or {}
        if rid is None:
            # 无 id 的请求（如通知）忽略
            continue
        try:
            result = handle(method, params)
            sys.stdout.write(json.dumps({'id': rid, 'ok': True, 'result': result}, ensure_ascii=False) + '\n')
        except Exception as e:
            log(f'{method} error: {e}')
            sys.stdout.write(json.dumps({'id': rid, 'ok': False, 'error': str(e)}, ensure_ascii=False) + '\n')
        sys.stdout.flush()

if __name__ == '__main__':
    main()
