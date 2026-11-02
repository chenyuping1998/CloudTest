"""選股模型：參考公開的選股方法實作，每個模型獨立判斷並回傳理由。

- Minervini 趨勢模板（Mark Minervini《超級績效》SEPA 的 8 項條件）。
  原版第 8 項為 IBD 相對強度排名 ≥ 70，需全市場排名；這裡以「加權報酬優於 0050」近似。
- 12-1 個月動能（Jegadeesh & Titman, 1993）：過去 12 個月扣除最近 1 個月的報酬。
- 營收成長動能（台灣常見的月營收選股法）：月營收年增率與累計年增率。
- 價值 / 高殖利率：本益比合理、現金殖利率高。
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

import pandas as pd

from . import indicators as ind

BENCHMARK = "0050"


@dataclass
class ModelResult:
    model: str
    passed: bool
    score: float = 0.0
    reasons: list[str] = field(default_factory=list)
    risks: list[str] = field(default_factory=list)
    detail: dict = field(default_factory=dict)


MODELS = {
    "minervini": {"name": "Minervini 趨勢模板", "desc": "8 項條件：股價在 50/150/200 日均線之上且均線多頭排列、200 日線上揚、距 52 週低點 +30% 以上、距高點 25% 以內、相對強度優於大盤"},
    "momentum": {"name": "12-1 個月動能", "desc": "過去 12 個月（扣除最近 1 個月）報酬為正且優於 0050（學術上最穩健的動能因子之一）"},
    "revenue": {"name": "營收成長動能", "desc": "最新月營收年增 > 20% 且累計營收年增 > 10%"},
    "value": {"name": "價值 / 高殖利率", "desc": "本益比 0~15 倍且現金殖利率 ≥ 4%"},
}


def _num(v) -> float | None:
    """轉成有限浮點數；None / NaN / 無法轉換回傳 None。"""
    try:
        v = float(v)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(v) or math.isinf(v) else v


def _ret(c: pd.Series, days: int, skip: int = 0) -> float | None:
    if len(c) <= days:
        return None
    end = c.iloc[-1 - skip]
    start = c.iloc[-1 - days]
    return float(end / start - 1) if start else None


def weighted_strength(c: pd.Series) -> float | None:
    """IBD 風格加權報酬：近 3 個月權重 40%，6/9/12 個月各 20%。"""
    parts = [_ret(c, d) for d in (63, 126, 189, 252)]
    if any(p is None for p in parts):
        return None
    return 0.4 * parts[0] + 0.2 * (parts[1] + parts[2] + parts[3])


def minervini(df: pd.DataFrame, bench_close: pd.Series | None = None) -> ModelResult:
    c = df["close"]
    r = ModelResult("minervini", False)
    if len(c) < 240:
        r.detail["error"] = "資料不足 1 年"
        return r
    price = float(c.iloc[-1])
    ma50, ma150, ma200 = (float(ind.sma(c, n).iloc[-1]) for n in (50, 150, 200))
    ma200_series = ind.sma(c, 200)
    ma200_up = float(ma200_series.iloc[-1]) > float(ma200_series.iloc[-22])  # 至少上揚 1 個月
    hi, lo = float(df["high"].iloc[-252:].max()), float(df["low"].iloc[-252:].min())
    rs = weighted_strength(c)
    rs_b = weighted_strength(bench_close) if bench_close is not None else None
    checks = {
        "股價 > 150 日與 200 日均線": price > ma150 and price > ma200,
        "150 日均線 > 200 日均線": ma150 > ma200,
        "200 日均線上揚至少 1 個月": ma200_up,
        "50 日均線 > 150 日與 200 日均線": ma50 > ma150 and ma50 > ma200,
        "股價 > 50 日均線": price > ma50,
        "距 52 週低點 +30% 以上": price >= lo * 1.3,
        "距 52 週高點 25% 以內": price >= hi * 0.75,
        "相對強度優於 0050": rs is not None and (rs_b is None or rs > rs_b),
    }
    passed = sum(checks.values())
    r.detail = {"checks": checks, "passed": passed}
    r.passed = passed == 8
    if passed == 8:
        r.score = 3
        r.reasons.append("符合 Minervini 趨勢模板 8/8")
    elif passed == 7:
        r.score = 1.5
        miss = next(k for k, v in checks.items() if not v)
        r.reasons.append(f"Minervini 趨勢模板 7/8（差：{miss}）")
    return r


def momentum_12_1(df: pd.DataFrame, bench_close: pd.Series | None = None) -> ModelResult:
    c = df["close"]
    r = ModelResult("momentum", False)
    m = _ret(c, 252, skip=21)
    if m is None:
        return r
    mb = _ret(bench_close, 252, skip=21) if bench_close is not None else None
    r.detail = {"momentum": m, "benchmark": mb}
    if m > 0 and (mb is None or m > mb):
        r.passed = True
        r.score = 1
        r.reasons.append(f"12-1 個月動能 {m:+.0%}" + (f"（0050 {mb:+.0%}）" if mb is not None else ""))
    return r


def revenue_growth(fund: dict | None) -> ModelResult:
    r = ModelResult("revenue", False)
    if not fund:
        return r
    yoy, cum = _num(fund.get("rev_yoy")), _num(fund.get("rev_cum_yoy"))
    if yoy is None:
        return r
    cum_ok = cum is None or cum > 10
    r.detail = {"rev_yoy": yoy, "rev_cum_yoy": cum}
    if yoy > 20 and cum_ok:
        r.passed = True
        r.score = 2
        r.reasons.append(f"月營收年增 {yoy:.0f}%")
    elif yoy > 10:
        r.score = 0.5
    elif yoy < -20:
        r.score = -1
        r.risks.append(f"月營收年減 {abs(yoy):.0f}%")
    return r


def value_yield(fund: dict | None) -> ModelResult:
    r = ModelResult("value", False)
    if not fund:
        return r
    pe, dy = _num(fund.get("pe")), _num(fund.get("dividend_yield"))
    if pe is not None and pe <= 0:  # 虧損公司本益比無意義
        pe = None
    r.detail = {"pe": pe, "dividend_yield": dy}
    if pe is not None and pe <= 15 and dy is not None and dy >= 4:
        r.passed = True
        r.score = 1
        r.reasons.append(f"本益比 {pe:.1f} 倍、殖利率 {dy:.1f}%")
    elif pe is not None and pe > 60:
        r.score = -1
        r.risks.append(f"本益比 {pe:.0f} 倍偏高")
    return r


def evaluate_all(df: pd.DataFrame, fund: dict | None, bench_close: pd.Series | None) -> list[ModelResult]:
    return [minervini(df, bench_close), momentum_12_1(df, bench_close), revenue_growth(fund), value_yield(fund)]
