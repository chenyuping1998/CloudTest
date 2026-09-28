"""技術指標計算（均採台股常用參數預設值）。"""
from __future__ import annotations

import numpy as np
import pandas as pd


def sma(s: pd.Series, n: int) -> pd.Series:
    return s.rolling(n, min_periods=n).mean()


def ema(s: pd.Series, n: int) -> pd.Series:
    return s.ewm(span=n, adjust=False, min_periods=n).mean()


def rsi(close: pd.Series, n: int = 14) -> pd.Series:
    """Wilder RSI。"""
    delta = close.diff()
    gain = delta.clip(lower=0).ewm(alpha=1 / n, adjust=False, min_periods=n).mean()
    loss = (-delta.clip(upper=0)).ewm(alpha=1 / n, adjust=False, min_periods=n).mean()
    rs = gain / loss.replace(0, np.nan)
    out = 100 - 100 / (1 + rs)
    return out.where(loss != 0, 100.0).where(gain.notna())


def macd(close: pd.Series, fast: int = 12, slow: int = 26, signal: int = 9) -> pd.DataFrame:
    dif = ema(close, fast) - ema(close, slow)
    dem = dif.ewm(span=signal, adjust=False, min_periods=signal).mean()
    return pd.DataFrame({"dif": dif, "signal": dem, "hist": dif - dem})


def kd(df: pd.DataFrame, n: int = 9, k_smooth: int = 3, d_smooth: int = 3) -> pd.DataFrame:
    """台股常用 KD（隨機指標），K、D 初始值 50，以 1/3 平滑。"""
    low_n = df["low"].rolling(n, min_periods=n).min()
    high_n = df["high"].rolling(n, min_periods=n).max()
    rsv = ((df["close"] - low_n) / (high_n - low_n).replace(0, np.nan) * 100).fillna(50)
    rsv = rsv.where(low_n.notna())
    k_vals, d_vals = [], []
    k = d = 50.0
    for v in rsv.to_numpy():
        if np.isnan(v):
            k_vals.append(np.nan)
            d_vals.append(np.nan)
            continue
        k = (k * (k_smooth - 1) + v) / k_smooth
        d = (d * (d_smooth - 1) + k) / d_smooth
        k_vals.append(k)
        d_vals.append(d)
    return pd.DataFrame({"k": k_vals, "d": d_vals}, index=df.index)


def bollinger(close: pd.Series, n: int = 20, k: float = 2.0) -> pd.DataFrame:
    mid = sma(close, n)
    std = close.rolling(n, min_periods=n).std(ddof=0)
    return pd.DataFrame({"upper": mid + k * std, "middle": mid, "lower": mid - k * std})


def atr(df: pd.DataFrame, n: int = 14) -> pd.Series:
    prev = df["close"].shift()
    tr = pd.concat([df["high"] - df["low"], (df["high"] - prev).abs(), (df["low"] - prev).abs()], axis=1).max(axis=1)
    return tr.ewm(alpha=1 / n, adjust=False, min_periods=n).mean()


def compute_all(df: pd.DataFrame) -> pd.DataFrame:
    out = pd.DataFrame(index=df.index)
    c = df["close"]
    for n in (5, 10, 20, 60, 120, 240):
        out[f"ma{n}"] = sma(c, n)
    out["rsi"] = rsi(c, 14)
    out = out.join(macd(c))
    out = out.join(kd(df))
    bb = bollinger(c)
    out["bb_upper"], out["bb_middle"], out["bb_lower"] = bb["upper"], bb["middle"], bb["lower"]
    out["vol_ma20"] = sma(df["volume"], 20)
    out["atr"] = atr(df)
    return out


def crossed_above(a: pd.Series, b: pd.Series | float) -> pd.Series:
    b_prev = b.shift() if isinstance(b, pd.Series) else b
    return (a > b) & (a.shift() <= b_prev)


def crossed_below(a: pd.Series, b: pd.Series | float) -> pd.Series:
    b_prev = b.shift() if isinstance(b, pd.Series) else b
    return (a < b) & (a.shift() >= b_prev)
