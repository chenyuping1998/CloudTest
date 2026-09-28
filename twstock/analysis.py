"""個股綜合分析：報酬、波動、趨勢與技術訊號摘要。"""
from __future__ import annotations

import math

import numpy as np
import pandas as pd

from . import indicators as ind


def _f(x) -> float | None:
    if x is None:
        return None
    try:
        x = float(x)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(x) or math.isinf(x) else x


def period_return(close: pd.Series, days: int) -> float | None:
    if len(close) <= days:
        return None
    return _f(close.iloc[-1] / close.iloc[-1 - days] - 1)


def summarize(df: pd.DataFrame, ind_df: pd.DataFrame | None = None) -> dict:
    if ind_df is None:
        ind_df = ind.compute_all(df)
    c = df["close"]
    last = ind_df.iloc[-1]
    price = float(c.iloc[-1])
    prev = float(c.iloc[-2]) if len(c) > 1 else price

    ytd_base = c[c.index < pd.Timestamp(c.index[-1].year, 1, 1)]
    ytd = _f(price / ytd_base.iloc[-1] - 1) if len(ytd_base) else None
    rets = c.pct_change().dropna()

    signals: list[dict] = []

    def add(kind: str, text: str) -> None:
        signals.append({"type": kind, "text": text})

    # 均線排列
    ma5, ma20, ma60 = last.get("ma5"), last.get("ma20"), last.get("ma60")
    if all(_f(v) is not None for v in (ma5, ma20, ma60)):
        if ma5 > ma20 > ma60:
            add("bull", "均線多頭排列（MA5 > MA20 > MA60）")
        elif ma5 < ma20 < ma60:
            add("bear", "均線空頭排列（MA5 < MA20 < MA60）")
    if _f(last.get("ma20")) is not None:
        add("bull" if price > ma20 else "bear", f"股價位於月線（MA20 {ma20:.2f}）{'之上' if price > ma20 else '之下'}")
    if _f(last.get("ma60")) is not None:
        add("bull" if price > ma60 else "bear", f"股價位於季線（MA60 {ma60:.2f}）{'之上' if price > ma60 else '之下'}")

    recent = slice(-3, None)  # 最近 3 個交易日內的交叉
    if ind.crossed_above(ind_df["ma5"], ind_df["ma20"]).iloc[recent].any() and ma5 > ma20:
        add("bull", "近 3 日 MA5 黃金交叉 MA20")
    elif ind.crossed_below(ind_df["ma5"], ind_df["ma20"]).iloc[recent].any() and ma5 < ma20:
        add("bear", "近 3 日 MA5 死亡交叉 MA20")

    r = _f(last.get("rsi"))
    if r is not None:
        if r >= 70:
            add("bear", f"RSI {r:.1f} 超買區")
        elif r <= 30:
            add("bull", f"RSI {r:.1f} 超賣區")
        else:
            add("neutral", f"RSI {r:.1f} 中性")

    k, d = _f(last.get("k")), _f(last.get("d"))
    if k is not None and d is not None:
        if ind.crossed_above(ind_df["k"], ind_df["d"]).iloc[recent].any() and k > d:
            add("bull", f"KD 黃金交叉（K {k:.1f} / D {d:.1f}）")
        elif ind.crossed_below(ind_df["k"], ind_df["d"]).iloc[recent].any() and k < d:
            add("bear", f"KD 死亡交叉（K {k:.1f} / D {d:.1f}）")
        if k >= 80:
            add("bear", f"K 值 {k:.1f} 高檔鈍化風險")
        elif k <= 20:
            add("bull", f"K 值 {k:.1f} 低檔")

    h = _f(last.get("hist"))
    if ind.crossed_above(ind_df["dif"], ind_df["signal"]).iloc[recent].any() and (h or 0) > 0:
        add("bull", "MACD 黃金交叉")
    elif ind.crossed_below(ind_df["dif"], ind_df["signal"]).iloc[recent].any() and (h or 0) < 0:
        add("bear", "MACD 死亡交叉")
    if h is not None:
        add("bull" if h > 0 else "bear", f"MACD 柱狀體{'為正' if h > 0 else '為負'}（{h:.2f}）")

    up, lo = _f(last.get("bb_upper")), _f(last.get("bb_lower"))
    if up is not None and price > up:
        add("bear", "收盤突破布林上軌")
    if lo is not None and price < lo:
        add("bull", "收盤跌破布林下軌")

    vma = _f(last.get("vol_ma20"))
    vol = float(df["volume"].iloc[-1])
    if vma and vol > 2 * vma:
        add("neutral", f"成交量爆量（{vol / vma:.1f} 倍 20 日均量）")

    bulls = sum(s["type"] == "bull" for s in signals)
    bears = sum(s["type"] == "bear" for s in signals)
    score = round(100 * bulls / (bulls + bears)) if bulls + bears else 50

    return {
        "price": price,
        "change": price - prev,
        "change_pct": _f(price / prev - 1) if prev else None,
        "volume": vol,
        "date": c.index[-1].strftime("%Y-%m-%d"),
        "returns": {
            "1W": period_return(c, 5), "1M": period_return(c, 21), "3M": period_return(c, 63),
            "6M": period_return(c, 126), "YTD": ytd, "1Y": period_return(c, 240),
        },
        "high_52w": _f(df["high"].iloc[-240:].max()),
        "low_52w": _f(df["low"].iloc[-240:].min()),
        "volatility": _f(rets.iloc[-240:].std() * np.sqrt(252)),
        "indicators": {k2: _f(v) for k2, v in last.items()},
        "signals": signals,
        "score": score,
    }
