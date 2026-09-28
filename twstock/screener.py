"""自訂條件選股：以 N 日法人買賣超、價量與技術面條件篩選全市場股票。"""
from __future__ import annotations

import math
import operator

import numpy as np
import pandas as pd

from . import data as D
from . import indicators as ind
from . import market as M

# 可篩選 / 排序的欄位（前端據此產生勾選清單）
FIELDS: dict[str, dict] = {
    "trust_net": {"label": "投信買賣超(張)", "group": "法人", "window": True},
    "foreign_net": {"label": "外資買賣超(張)", "group": "法人", "window": True},
    "dealer_net": {"label": "自營商買賣超(張)", "group": "法人", "window": True},
    "inst_net": {"label": "三大法人合計(張)", "group": "法人", "window": True},
    "trust_days": {"label": "投信買超天數", "group": "法人", "window": True},
    "foreign_days": {"label": "外資買超天數", "group": "法人", "window": True},
    "trust_streak": {"label": "投信連續買超天數(負=連賣)", "group": "法人"},
    "foreign_streak": {"label": "外資連續買超天數(負=連賣)", "group": "法人"},
    "dealer_streak": {"label": "自營商連續買超天數(負=連賣)", "group": "法人"},
    "trust_ratio": {"label": "投信買超佔成交量(%)", "group": "法人", "window": True},
    "foreign_ratio": {"label": "外資買超佔成交量(%)", "group": "法人", "window": True},
    "close": {"label": "收盤價", "group": "價量"},
    "day_change_pct": {"label": "當日漲跌幅(%)", "group": "價量"},
    "change_pct": {"label": "N日漲跌幅(%)", "group": "價量", "window": True},
    "volume_avg": {"label": "N日均量(張)", "group": "價量", "window": True},
    "value_avg": {"label": "N日均成交值(億)", "group": "價量", "window": True},
    "volume_ratio": {"label": "當日量/N日均量(倍)", "group": "價量", "window": True},
}

TECHNICAL: dict[str, dict] = {
    "above_ma20": {"label": "站上月線 (收盤 > MA20)"},
    "above_ma60": {"label": "站上季線 (收盤 > MA60)"},
    "ma_bull": {"label": "均線多頭排列 (MA5 > MA20 > MA60)"},
    "kd_golden": {"label": "近 3 日 KD 黃金交叉"},
    "macd_golden": {"label": "近 3 日 MACD 黃金交叉"},
    "macd_positive": {"label": "MACD 柱狀體為正"},
    "rsi_below_30": {"label": "RSI < 30（超賣）"},
    "rsi_50_70": {"label": "RSI 介於 50~70（強勢未過熱）"},
    "new_high_20": {"label": "創 20 日新高"},
    "new_high_60": {"label": "創 60 日新高"},
}

OPS = {">": operator.gt, ">=": operator.ge, "<": operator.lt, "<=": operator.le}


def _streak(values: np.ndarray) -> int:
    """回傳結尾連續買超（正）或賣超（負）的天數。"""
    if len(values) == 0 or values[-1] == 0 or np.isnan(values[-1]):
        return 0
    sign = 1 if values[-1] > 0 else -1
    n = 0
    for v in values[::-1]:
        if np.isnan(v) or np.sign(v) != sign:
            break
        n += 1
    return sign * n


def build_table(market: str, days: int, use_demo: bool = False) -> tuple[pd.DataFrame, list[str]]:
    """計算全市場每檔股票在最近 `days` 個交易日的彙總欄位。"""
    window = M.get_window(market, days + 1, use_demo)  # 多抓一天作為漲跌幅基準
    dates = [d.strftime("%Y-%m-%d") for d, _, _ in window]
    frames = []
    for d, q, i in window:
        merged = q.merge(i.drop(columns=["name"], errors="ignore"), on="code", how="left")
        merged["date"] = d
        frames.append(merged)
    long = pd.concat(frames, ignore_index=True)
    names = long.groupby("code")["name"].last()

    def pivot(col: str) -> pd.DataFrame:
        return long.pivot_table(index="date", columns="code", values=col, aggfunc="last").sort_index()

    close, volume, value = pivot("close"), pivot("volume"), pivot("value")
    flows = {k: pivot(k) / 1000 for k in ("foreign", "trust", "dealer", "inst")}  # 股 -> 張
    has_base = len(close) > days
    base_close = close.iloc[0]
    cur = slice(1, None) if has_base else slice(None)
    vol_w = volume.iloc[cur] / 1000

    out = pd.DataFrame(index=close.columns)
    out["name"] = names.reindex(out.index)
    out["close"] = close.iloc[-1]
    prev = close.iloc[-2] if len(close) > 1 else close.iloc[-1]
    out["day_change_pct"] = (close.iloc[-1] / prev - 1) * 100
    out["change_pct"] = (close.iloc[-1] / base_close - 1) * 100
    out["volume_avg"] = vol_w.mean()
    out["value_avg"] = (value.iloc[cur] / 1e8).mean()
    out["volume_ratio"] = (volume.iloc[-1] / 1000) / out["volume_avg"]
    vol_sum = vol_w.sum()
    for k, f in flows.items():
        fw = f.iloc[cur]
        out[f"{k}_net"] = fw.sum(min_count=1)
        if k != "inst":
            out[f"{k}_days"] = (fw > 0).sum()
            out[f"{k}_streak"] = [_streak(fw[c].to_numpy(dtype=float)) for c in out.index]
    out["trust_ratio"] = out["trust_net"] / vol_sum.replace(0, np.nan) * 100
    out["foreign_ratio"] = out["foreign_net"] / vol_sum.replace(0, np.nan) * 100
    out.index.name = "code"
    return out.reset_index(), dates[1:] if has_base else dates


def _technical_ok(code: str, checks: list[str], use_demo: bool) -> tuple[bool, dict]:
    try:
        pdata = D.get_history(code, years=1, source="demo" if use_demo else None)
    except Exception:  # noqa: BLE001
        return False, {}
    df = pdata.df
    if len(df) < 60:
        return False, {}
    x = ind.compute_all(df)
    last, c = x.iloc[-1], df["close"].iloc[-1]
    rec = slice(-3, None)
    tests = {
        "above_ma20": lambda: c > last["ma20"],
        "above_ma60": lambda: c > last["ma60"],
        "ma_bull": lambda: last["ma5"] > last["ma20"] > last["ma60"],
        "kd_golden": lambda: ind.crossed_above(x["k"], x["d"]).iloc[rec].any(),
        "macd_golden": lambda: ind.crossed_above(x["dif"], x["signal"]).iloc[rec].any(),
        "macd_positive": lambda: last["hist"] > 0,
        "rsi_below_30": lambda: last["rsi"] < 30,
        "rsi_50_70": lambda: 50 <= last["rsi"] <= 70,
        "new_high_20": lambda: c >= df["close"].iloc[-20:].max(),
        "new_high_60": lambda: c >= df["close"].iloc[-60:].max(),
    }
    ok = all(bool(tests[k]()) for k in checks if k in tests)
    info = {"rsi": last["rsi"], "k": last["k"], "d": last["d"], "ma20": last["ma20"]}
    return ok, info


def _clean(v):
    if isinstance(v, (float, np.floating)):
        return None if math.isnan(v) or math.isinf(v) else round(float(v), 2)
    if isinstance(v, np.integer):
        return int(v)
    return v


def screen(market: str = "twse", days: int = 10, filters: list[dict] | None = None,
           technical: list[str] | None = None, sort: str = "trust_net", order: str = "desc",
           limit: int = 10, include_etf: bool = False, use_demo: bool = False,
           max_technical_scan: int = 80) -> dict:
    days = max(1, min(int(days), 60))
    limit = max(1, min(int(limit), 200))
    if sort not in FIELDS:
        raise ValueError(f"未知排序欄位：{sort}")
    table, dates = build_table(market, days, use_demo)

    code = table["code"].astype(str)
    is_stock = code.str.fullmatch(r"[1-9]\d{3}")
    is_etf = code.str.fullmatch(r"00\d{2,4}[A-Z]?")
    universe = int(len(table))
    table = table[is_stock | (is_etf & include_etf)]

    applied = []
    for f in filters or []:
        field, op = f.get("field"), f.get("op", ">")
        if field not in FIELDS:
            raise ValueError(f"未知篩選欄位：{field}")
        val = float(f.get("value", 0))
        col = table[field]
        if op == "between":
            val2 = float(f.get("value2", val))
            table = table[(col >= min(val, val2)) & (col <= max(val, val2))]
        elif op in OPS:
            table = table[OPS[op](col, val)]
        else:
            raise ValueError(f"未知運算子：{op}")
        applied.append(f)

    table = table.dropna(subset=[sort]).sort_values(sort, ascending=(order == "asc"))
    matched_before_tech = len(table)

    rows = []
    scanned = 0
    tech = [t for t in (technical or []) if t in TECHNICAL]
    for rec in table.to_dict("records"):
        if len(rows) >= limit:
            break
        if tech:
            if scanned >= max_technical_scan:
                break
            scanned += 1
            ok, info = _technical_ok(rec["code"], tech, use_demo)
            if not ok:
                continue
            rec.update({f"tech_{k}": v for k, v in info.items()})
        rows.append({k: _clean(v) for k, v in rec.items()})

    return {
        "market": market, "days": days, "dates": dates, "sort": sort, "order": order,
        "filters": applied, "technical": tech, "universe": universe,
        "matched": matched_before_tech, "technical_scanned": scanned,
        "rows": rows, "source": "demo" if use_demo else market,
    }


def institutional_history(code: str, days: int = 20, use_demo: bool = False) -> list[dict]:
    """單一個股近 N 日三大法人買賣超（張）。"""
    code = D.normalize_code(code)
    out = []
    markets = ["twse"] if use_demo else ["twse", "tpex"]
    for market in markets:
        try:
            window = M.get_window(market, days, use_demo)
        except D.DataError:
            continue
        for d, q, i in window:
            row = i[i["code"] == code]
            if row.empty:
                continue
            r = row.iloc[0]
            qrow = q[q["code"] == code]
            out.append({
                "date": d.strftime("%Y-%m-%d"),
                **{k: _clean(r[k] / 1000) for k in ("foreign", "trust", "dealer", "inst")},
                "close": _clean(qrow.iloc[0]["close"]) if not qrow.empty else None,
            })
        if out:
            break
    return out
