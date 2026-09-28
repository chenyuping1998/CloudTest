"""回測引擎與內建策略。

規則：
- 策略在第 t 日收盤後依當日（含）以前的資料產生目標部位（0 = 空手、1 = 持有）。
- 部位變動於第 t+1 日「開盤價」成交，避免使用未來資料。
- 只做多；可設定停損 / 停利（以盤中最高 / 最低價觸發，跳空則以開盤價成交）。
- 費用依台股規則：手續費 0.1425%（可設折扣、最低 20 元），賣出證交稅股票 0.3%、ETF 0.1%。
"""
from __future__ import annotations

import itertools
import math
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from . import indicators as ind

# ---------------------------------------------------------------- 策略

STRATEGIES: dict[str, dict] = {
    "sma_cross": {
        "name": "均線交叉",
        "desc": "短均線向上穿越長均線買進，向下穿越賣出。",
        "params": {"fast": {"label": "短均線", "default": 5, "min": 2, "max": 120},
                   "slow": {"label": "長均線", "default": 20, "min": 5, "max": 240}},
    },
    "rsi": {
        "name": "RSI 超買超賣",
        "desc": "RSI 低於下限買進，高於上限賣出。",
        "params": {"period": {"label": "RSI 週期", "default": 14, "min": 2, "max": 60},
                   "lower": {"label": "買進門檻", "default": 30, "min": 5, "max": 50},
                   "upper": {"label": "賣出門檻", "default": 70, "min": 50, "max": 95}},
    },
    "macd": {
        "name": "MACD 交叉",
        "desc": "DIF 向上穿越訊號線買進，向下穿越賣出。",
        "params": {"fast": {"label": "快線", "default": 12, "min": 2, "max": 50},
                   "slow": {"label": "慢線", "default": 26, "min": 5, "max": 100},
                   "signal": {"label": "訊號線", "default": 9, "min": 2, "max": 30}},
    },
    "kd": {
        "name": "KD 交叉",
        "desc": "K 在低檔（< 買進區）向上穿越 D 買進；K 在高檔（> 賣出區）向下穿越 D 賣出。",
        "params": {"n": {"label": "RSV 週期", "default": 9, "min": 3, "max": 30},
                   "buy_level": {"label": "買進區 K <", "default": 30, "min": 5, "max": 100},
                   "sell_level": {"label": "賣出區 K >", "default": 70, "min": 0, "max": 95}},
    },
    "bollinger": {
        "name": "布林通道均值回歸",
        "desc": "收盤跌破下軌買進，回到中軌以上賣出。",
        "params": {"n": {"label": "週期", "default": 20, "min": 5, "max": 60},
                   "k": {"label": "標準差倍數", "default": 2.0, "min": 0.5, "max": 4, "step": 0.1}},
    },
    "breakout": {
        "name": "通道突破（海龜）",
        "desc": "收盤創 N 日新高買進，跌破 M 日新低賣出。",
        "params": {"entry": {"label": "突破天數 N", "default": 20, "min": 5, "max": 120},
                   "exit": {"label": "出場天數 M", "default": 10, "min": 3, "max": 60}},
    },
    "buy_hold": {
        "name": "買進持有",
        "desc": "第一天買進一路持有（比較基準）。",
        "params": {},
    },
}


def _stateful(entry: pd.Series, exit_: pd.Series) -> pd.Series:
    pos, out = 0, []
    for e, x in zip(entry.fillna(False).to_numpy(), exit_.fillna(False).to_numpy()):
        if pos == 0 and e:
            pos = 1
        elif pos == 1 and x:
            pos = 0
        out.append(pos)
    return pd.Series(out, index=entry.index)


def generate_positions(df: pd.DataFrame, strategy: str, params: dict) -> pd.Series:
    c = df["close"]
    p = {k: v["default"] for k, v in STRATEGIES[strategy]["params"].items()} | (params or {})
    if strategy == "sma_cross":
        fast, slow = ind.sma(c, int(p["fast"])), ind.sma(c, int(p["slow"]))
        return (fast > slow).astype(int)
    if strategy == "rsi":
        r = ind.rsi(c, int(p["period"]))
        return _stateful(r < float(p["lower"]), r > float(p["upper"]))
    if strategy == "macd":
        m = ind.macd(c, int(p["fast"]), int(p["slow"]), int(p["signal"]))
        return (m["dif"] > m["signal"]).astype(int).where(m["signal"].notna(), 0)
    if strategy == "kd":
        k = ind.kd(df, int(p["n"]))
        entry = ind.crossed_above(k["k"], k["d"]) & (k["k"] < float(p["buy_level"]))
        exit_ = ind.crossed_below(k["k"], k["d"]) & (k["k"] > float(p["sell_level"]))
        return _stateful(entry, exit_)
    if strategy == "bollinger":
        bb = ind.bollinger(c, int(p["n"]), float(p["k"]))
        return _stateful(c < bb["lower"], c > bb["middle"])
    if strategy == "breakout":
        hi = c.rolling(int(p["entry"])).max().shift()
        lo = c.rolling(int(p["exit"])).min().shift()
        return _stateful(c > hi, c < lo)
    if strategy == "buy_hold":
        return pd.Series(1, index=df.index)
    raise ValueError(f"未知策略：{strategy}")


# ---------------------------------------------------------------- 回測

@dataclass
class BacktestConfig:
    initial_capital: float = 1_000_000
    fee_rate: float = 0.001425
    fee_discount: float = 1.0
    min_fee: float = 20
    tax_rate: float | None = None  # None = 依代號自動判斷（ETF 0.1%、股票 0.3%）
    lot_size: int = 1  # 1 = 可零股；1000 = 整張
    stop_loss: float | None = None  # 例：0.1 = 10% 停損
    take_profit: float | None = None


@dataclass
class Trade:
    entry_date: str
    entry_price: float
    exit_date: str | None = None
    exit_price: float | None = None
    shares: int = 0
    pnl: float = 0.0
    return_pct: float = 0.0
    reason: str = ""
    bars: int = 0


@dataclass
class BacktestResult:
    equity: pd.Series
    benchmark: pd.Series
    trades: list[Trade] = field(default_factory=list)
    metrics: dict = field(default_factory=dict)


def _fee(amount: float, cfg: BacktestConfig) -> float:
    return max(cfg.min_fee, math.floor(amount * cfg.fee_rate * cfg.fee_discount))


def run_backtest(df: pd.DataFrame, positions: pd.Series, cfg: BacktestConfig | None = None,
                 code: str = "") -> BacktestResult:
    cfg = cfg or BacktestConfig()
    tax_rate = cfg.tax_rate if cfg.tax_rate is not None else (0.001 if code.startswith("00") else 0.003)
    o, h, l, c = (df[k].to_numpy(dtype=float) for k in ("open", "high", "low", "close"))
    dates = [d.strftime("%Y-%m-%d") for d in df.index]
    target = positions.reindex(df.index).fillna(0).to_numpy()
    n = len(df)

    cash, shares = float(cfg.initial_capital), 0
    trades: list[Trade] = []
    cur: Trade | None = None
    entry_cost = 0.0
    equity = np.empty(n)
    blocked_until_flat = False  # 停損停利後，需等訊號轉為 0 才能再進場

    def sell(i: int, price: float, reason: str) -> None:
        nonlocal cash, shares, cur
        amount = price * shares
        proceeds = amount - _fee(amount, cfg) - math.floor(amount * tax_rate)
        cash += proceeds
        cur.exit_date, cur.exit_price, cur.reason = dates[i], price, reason
        cur.pnl = proceeds - entry_cost
        cur.return_pct = cur.pnl / entry_cost if entry_cost else 0.0
        cur.bars = i - dates.index(cur.entry_date)
        trades.append(cur)
        shares, cur = 0, None

    for i in range(n):
        want = target[i - 1] if i > 0 else 0  # 昨日收盤訊號，今日開盤執行
        if want == 0:
            blocked_until_flat = False
        if shares > 0 and want == 0:
            sell(i, o[i], "訊號出場")
        elif shares == 0 and want == 1 and not blocked_until_flat and not np.isnan(o[i]):
            price = o[i]
            unit = cfg.lot_size
            qty = int(cash / (price * (1 + cfg.fee_rate * cfg.fee_discount)) // unit * unit)
            while qty > 0 and qty * price + _fee(qty * price, cfg) > cash:
                qty -= unit
            if qty > 0:
                amount = qty * price
                fee = _fee(amount, cfg)
                cash -= amount + fee
                shares, entry_cost = qty, amount + fee
                cur = Trade(entry_date=dates[i], entry_price=price, shares=qty)

        if shares > 0 and cur is not None:
            ep = cur.entry_price
            if cfg.stop_loss and l[i] <= ep * (1 - cfg.stop_loss):
                sell(i, min(o[i], ep * (1 - cfg.stop_loss)) if dates[i] != cur.entry_date else ep * (1 - cfg.stop_loss), "停損")
                blocked_until_flat = True
            elif cfg.take_profit and h[i] >= ep * (1 + cfg.take_profit):
                sell(i, max(o[i], ep * (1 + cfg.take_profit)) if dates[i] != cur.entry_date else ep * (1 + cfg.take_profit), "停利")
                blocked_until_flat = True

        equity[i] = cash + shares * c[i]

    if cur is not None:  # 期末未平倉：以最後收盤價計算未實現損益
        mv = shares * c[-1]
        cur.exit_price = float(c[-1])
        cur.pnl = mv - entry_cost
        cur.return_pct = cur.pnl / entry_cost if entry_cost else 0.0
        cur.reason = "持有中"
        cur.bars = n - 1 - dates.index(cur.entry_date)
        trades.append(cur)

    eq = pd.Series(equity, index=df.index)
    bench = cfg.initial_capital * df["close"] / df["open"].iloc[0]
    exposure = float(np.mean(target[:-1])) if n > 1 else 0.0
    return BacktestResult(eq, bench, trades, compute_metrics(eq, bench, trades, exposure))


def _clean(x: float) -> float | None:
    return None if x is None or (isinstance(x, float) and (math.isnan(x) or math.isinf(x))) else float(x)


def max_drawdown(eq: pd.Series) -> tuple[float, pd.Series]:
    dd = eq / eq.cummax() - 1
    return float(dd.min()) if len(dd) else 0.0, dd


def compute_metrics(eq: pd.Series, bench: pd.Series, trades: list[Trade], exposure: float) -> dict:
    years = max((eq.index[-1] - eq.index[0]).days / 365.25, 1e-9)
    total = eq.iloc[-1] / eq.iloc[0] - 1
    rets = eq.pct_change().dropna()
    mdd, _ = max_drawdown(eq)
    sharpe = rets.mean() / rets.std() * math.sqrt(252) if rets.std() > 0 else 0.0
    downside = rets[rets < 0].std()
    sortino = rets.mean() / downside * math.sqrt(252) if downside and downside > 0 else 0.0
    cagr = (eq.iloc[-1] / eq.iloc[0]) ** (1 / years) - 1 if eq.iloc[-1] > 0 else -1.0
    closed = [t for t in trades if t.reason != "持有中"]
    wins = [t for t in closed if t.pnl > 0]
    losses = [t for t in closed if t.pnl <= 0]
    gross_win, gross_loss = sum(t.pnl for t in wins), -sum(t.pnl for t in losses)
    b_total = bench.iloc[-1] / bench.iloc[0] - 1
    b_mdd, _ = max_drawdown(bench)
    return {k: _clean(v) if isinstance(v, float) else v for k, v in {
        "total_return": total, "cagr": cagr, "max_drawdown": mdd, "sharpe": sharpe, "sortino": sortino,
        "calmar": cagr / abs(mdd) if mdd < 0 else 0.0, "volatility": rets.std() * math.sqrt(252),
        "trades": len(closed), "win_rate": len(wins) / len(closed) if closed else 0.0,
        "profit_factor": gross_win / gross_loss if gross_loss > 0 else (float("inf") if gross_win else 0.0),
        "avg_trade": float(np.mean([t.return_pct for t in closed])) if closed else 0.0,
        "avg_bars": float(np.mean([t.bars for t in closed])) if closed else 0.0,
        "exposure": exposure, "final_equity": float(eq.iloc[-1]),
        "benchmark_return": b_total, "benchmark_mdd": b_mdd,
        "benchmark_cagr": (1 + b_total) ** (1 / years) - 1,
        "years": years,
    }.items()}


def optimize(df: pd.DataFrame, strategy: str, grid: dict[str, list], cfg: BacktestConfig | None = None,
             code: str = "", sort_by: str = "sharpe", max_runs: int = 400) -> list[dict]:
    keys = list(grid)
    combos = list(itertools.product(*(grid[k] for k in keys)))[:max_runs]
    out = []
    for combo in combos:
        params = {k: int(v) if float(v).is_integer() else float(v) for k, v in zip(keys, combo)}
        if strategy in ("sma_cross", "macd") and params.get("fast", 0) >= params.get("slow", 1e9):
            continue
        res = run_backtest(df, generate_positions(df, strategy, params), cfg, code)
        out.append({"params": params, **{k: res.metrics[k] for k in (
            "total_return", "cagr", "max_drawdown", "sharpe", "win_rate", "trades")}})
    out.sort(key=lambda r: (r.get(sort_by) is None, -(r.get(sort_by) or 0)))
    return out
