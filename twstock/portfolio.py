"""持股組合分析與建議。

建議以透明的規則產生（趨勢、動能、損益、波動、集中度、相關性），每條建議都附理由。
僅供參考，不構成投資建議。
"""
from __future__ import annotations

import math

import numpy as np
import pandas as pd

from . import analysis
from . import data as D
from . import indicators as ind

MAX_HOLDINGS = 50
BENCHMARK = "0050"  # 以元大台灣50 代表大盤（各資料來源皆可取得）
FEE_RATE = 0.001425

ACTIONS = {
    "stop": {"label": "停損檢視", "level": 3},
    "reduce": {"label": "考慮減碼 / 停利", "level": 2},
    "hold": {"label": "續抱觀察", "level": 1},
    "add": {"label": "可考慮加碼", "level": 0},
}


def _f(x) -> float | None:
    return analysis._f(x)


def _sell_cost(code: str, amount: float) -> float:
    tax = 0.001 if code.startswith("00") else 0.003
    return max(20.0, amount * FEE_RATE) + amount * tax


def _advise(code: str, df: pd.DataFrame, x: pd.DataFrame, summary: dict, cost: float, ret: float) -> dict:
    """單一持股的建議與理由。"""
    last = x.iloc[-1]
    price = float(df["close"].iloc[-1])
    atr = _f(last.get("atr")) or 0.0
    ma20, ma60 = _f(last.get("ma20")), _f(last.get("ma60"))
    rsi = _f(last.get("rsi"))
    score = summary["score"]

    # 移動停損：近 20 日最高收盤價 − 2.5 × ATR，且不低於成本的 85%（避免過寬）
    trail = float(df["close"].iloc[-20:].max()) - 2.5 * atr if atr else None
    stop_price = max(trail, cost * 0.85) if trail else cost * 0.85
    if ret > 0.1 and trail:
        stop_price = max(trail, cost)  # 已有一定獲利時，停損至少拉到成本（保本）

    reasons: list[str] = []
    action = "hold"
    if price <= stop_price and ret > 0:
        action = "reduce"
        reasons.append(f"收盤 {price:.2f} 跌破移動停利價 {stop_price:.2f}（近 20 日高點回落 2.5 倍 ATR），"
                       f"目前仍有 {ret:.1%} 獲利，可考慮獲利了結保護利潤")
    elif price <= stop_price:
        action = "stop"
        reasons.append(f"收盤 {price:.2f} 已跌破建議停損價 {stop_price:.2f}（近 20 日高點回落 2.5 倍 ATR 或成本 −15%）")
    elif ret <= -0.15 and ma60 is not None and price < ma60:
        action = "stop"
        reasons.append(f"帳面虧損 {ret:.1%} 且股價在季線（{ma60:.2f}）之下，趨勢未轉強")
    elif score <= 30:
        action = "reduce"
        reasons.append(f"技術面偏空（多空分數 {score}/100）")
    elif rsi is not None and rsi >= 75 and ret >= 0.2:
        action = "reduce"
        reasons.append(f"獲利 {ret:.1%} 且 RSI {rsi:.0f} 過熱，可考慮分批獲利了結")
    elif score >= 70 and ma60 is not None and price > ma60 and (rsi is None or rsi < 70):
        action = "add"
        reasons.append(f"技術面偏多（多空分數 {score}/100）、站上季線且未過熱")
    else:
        reasons.append(f"技術面中性（多空分數 {score}/100），依停損價控管風險")

    if action in ("hold", "add") and price <= stop_price * 1.03:
        reasons.append(f"距停損價 {stop_price:.2f} 不到 3%，留意風險")
    if ma20 is not None:
        reasons.append(f"股價{'站上' if price >= ma20 else '跌破'}月線 {ma20:.2f}")
    if rsi is not None and action != "reduce" and (rsi >= 70 or rsi <= 30):
        reasons.append(f"RSI {rsi:.0f} {'超買' if rsi >= 70 else '超賣'}")
    return {"action": action, "action_label": ACTIONS[action]["label"], "reasons": reasons,
            "stop_price": round(stop_price, 2)}


def analyze(holdings: list[dict], years: float = 1.5) -> dict:
    """holdings: [{code, shares, cost}]，cost 為每股平均成本。"""
    merged: dict[str, dict] = {}
    for h in holdings[:MAX_HOLDINGS]:
        code = D.normalize_code(str(h.get("code", "")))
        shares, cost = float(h.get("shares") or 0), float(h.get("cost") or 0)
        if shares <= 0 or cost <= 0:
            raise ValueError(f"{code} 的股數與成本必須大於 0")
        if code in merged:  # 同一檔合併為加權平均成本
            m = merged[code]
            total = m["shares"] + shares
            m["cost"] = (m["cost"] * m["shares"] + cost * shares) / total
            m["shares"] = total
        else:
            merged[code] = {"code": code, "shares": shares, "cost": cost}
    if not merged:
        raise ValueError("請至少輸入一筆持股")

    rows, closes, errors, sources = [], {}, [], set()
    for code, h in merged.items():
        try:
            p = D.get_history(code, years=years)
        except Exception as e:  # noqa: BLE001
            errors.append({"code": code, "error": str(e)})
            continue
        df = p.df
        if len(df) < 2:
            errors.append({"code": code, "error": "資料不足"})
            continue
        sources.add(p.source)
        x = ind.compute_all(df)
        summary = analysis.summarize(df, x)
        price, prev = float(df["close"].iloc[-1]), float(df["close"].iloc[-2])
        mv = price * h["shares"]
        cost_total = h["cost"] * h["shares"]
        net_pnl = mv - _sell_cost(code, mv) - cost_total
        ret = mv / cost_total - 1
        advice = _advise(code, df, x, summary, h["cost"], ret)
        closes[code] = df["close"]
        rows.append({
            "code": code, "name": p.name, "shares": h["shares"], "cost": round(h["cost"], 4),
            "price": price, "day_change_pct": (price / prev - 1) * 100,
            "day_pnl": (price - prev) * h["shares"], "market_value": mv, "cost_value": cost_total,
            "pnl": mv - cost_total, "net_pnl": net_pnl, "return_pct": ret * 100,
            "score": summary["score"], "rsi": _f(summary["indicators"].get("rsi")),
            "volatility": summary["volatility"], **advice,
        })

    total_mv = sum(r["market_value"] for r in rows)
    for r in rows:
        r["weight"] = r["market_value"] / total_mv * 100 if total_mv else 0.0

    risk = _risk(rows, closes, years)
    suggestions = _portfolio_suggestions(rows, risk)
    rows.sort(key=lambda r: (-ACTIONS[r["action"]]["level"], -r["weight"]))
    total_cost = sum(r["cost_value"] for r in rows)
    summary = {
        "market_value": total_mv, "cost_value": total_cost,
        "pnl": total_mv - total_cost, "net_pnl": sum(r["net_pnl"] for r in rows),
        "return_pct": (total_mv / total_cost - 1) * 100 if total_cost else 0.0,
        "day_pnl": sum(r["day_pnl"] for r in rows),
        "day_change_pct": (sum(r["day_pnl"] for r in rows) / (total_mv - sum(r["day_pnl"] for r in rows)) * 100) if total_mv else 0.0,
        "count": len(rows),
        "actions": {k: sum(r["action"] == k for r in rows) for k in ACTIONS},
    }
    return {"rows": _clean(rows), "summary": _clean(summary), "risk": _clean(risk),
            "suggestions": suggestions, "errors": errors,
            "source": "demo" if "demo" in sources else (next(iter(sources)) if sources else None)}


def _risk(rows: list[dict], closes: dict[str, pd.Series], years: float) -> dict:
    """以「目前權重」回推過去一年的組合表現（假設期間持股不變，僅供參考）。"""
    if not rows:
        return {}
    weights = pd.Series({r["code"]: r["weight"] / 100 for r in rows})
    px = pd.DataFrame(closes).ffill().dropna()
    px = px.iloc[-250:]
    rets = px.pct_change().dropna()
    if len(rets) < 20:
        return {}
    port = (rets[weights.index] * weights).sum(axis=1)
    curve = (1 + port).cumprod()
    out = {
        "dates": [d.strftime("%Y-%m-%d") for d in curve.index],
        "curve": [round(float(v) * 100, 2) for v in curve],
        "volatility": float(port.std() * math.sqrt(252)),
        "max_drawdown": float((curve / curve.cummax() - 1).min()),
        "return_1y": float(curve.iloc[-1] - 1),
    }
    try:
        b = D.get_history(BENCHMARK, years=years).df["close"]
        b_ret = b.pct_change().reindex(port.index).dropna()
        common = port.reindex(b_ret.index)
        if len(b_ret) >= 20 and b_ret.var() > 0:
            out["beta"] = float(np.cov(common, b_ret)[0, 1] / b_ret.var())
            bc = (1 + b_ret).cumprod()
            out["benchmark_curve"] = [round(float(bc.get(d, np.nan)) * 100, 2) if d in bc.index else None for d in curve.index]
            out["benchmark_return_1y"] = float(bc.iloc[-1] - 1)
    except Exception:  # noqa: BLE001
        pass
    if len(weights) >= 2:
        corr = rets[weights.index].corr()
        pairs = []
        codes = list(weights.index)
        for i, a in enumerate(codes):
            for b2 in codes[i + 1:]:
                c = corr.loc[a, b2]
                if not np.isnan(c):
                    pairs.append({"a": a, "b": b2, "corr": float(c)})
        out["high_corr_pairs"] = sorted([p for p in pairs if p["corr"] >= 0.8], key=lambda p: -p["corr"])[:5]
        out["avg_corr"] = float(np.mean([p["corr"] for p in pairs])) if pairs else None
    return out


def _portfolio_suggestions(rows: list[dict], risk: dict) -> list[dict]:
    out: list[dict] = []

    def add(level: str, text: str) -> None:
        out.append({"level": level, "text": text})

    if not rows:
        return out
    names = {r["code"]: f"{r['code']} {r['name']}" for r in rows}
    by_w = sorted(rows, key=lambda r: -r["weight"])
    if by_w[0]["weight"] > 30 and not by_w[0]["code"].startswith("00"):
        add("warn", f"{names[by_w[0]['code']]} 佔組合 {by_w[0]['weight']:.0f}%，單一個股比重偏高（建議 30% 以下）")
    top3 = sum(r["weight"] for r in by_w[:3])
    if len(rows) > 3 and top3 > 70:
        add("warn", f"前三大持股合計 {top3:.0f}%，集中度高")
    stocks = [r for r in rows if not r["code"].startswith("00")]
    if len(rows) < 3 and stocks:
        add("info", "持股檔數少於 3 檔，可考慮搭配市值型 ETF（如 0050、006208）分散風險")
    etf_w = sum(r["weight"] for r in rows if r["code"].startswith("00"))
    if etf_w:
        add("info", f"ETF 佔組合 {etf_w:.0f}%")
    for p in risk.get("high_corr_pairs", [])[:3]:
        add("warn", f"{names[p['a']]} 與 {names[p['b']]} 走勢高度相關（相關係數 {p['corr']:.2f}），分散效果有限")
    beta = risk.get("beta")
    if beta is not None:
        if beta > 1.3:
            add("warn", f"組合 Beta {beta:.2f}，波動比大盤大，市場回檔時跌幅可能較大")
        elif beta < 0.7:
            add("info", f"組合 Beta {beta:.2f}，相對大盤防禦")
    mdd = risk.get("max_drawdown")
    if mdd is not None and mdd < -0.25:
        add("warn", f"以目前配置回推過去一年，最大回撤達 {mdd:.0%}，請確認可承受")
    stops = [r for r in rows if r["action"] == "stop"]
    if stops:
        add("danger", "跌破停損價或深度套牢：" + "、".join(names[r["code"]] for r in stops) + "，建議檢視是否出場")
    reduce = [r for r in rows if r["action"] == "reduce"]
    if reduce:
        add("warn", "可考慮減碼或停利：" + "、".join(names[r["code"]] for r in reduce))
    adds = [r for r in rows if r["action"] == "add"]
    if adds:
        add("good", "技術面轉強、可列入加碼觀察：" + "、".join(names[r["code"]] for r in adds))
    losers = [r for r in rows if r["return_pct"] < -10]
    if len(losers) >= max(2, len(rows) // 2):
        add("warn", f"{len(losers)} 檔帳面虧損超過 10%，建議重新檢視選股與進場時機")
    if not out:
        add("good", "目前配置沒有明顯風險訊號")
    return out


def _clean(obj):
    if isinstance(obj, dict):
        return {k: _clean(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_clean(v) for v in obj]
    if isinstance(obj, (float, np.floating)):
        return None if math.isnan(obj) or math.isinf(obj) else float(obj)
    if isinstance(obj, np.integer):
        return int(obj)
    return obj
