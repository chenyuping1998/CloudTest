"""每日精選：多因子排名（量化基金常用做法）＋大盤濾網＋產業分散，挑出 5 檔並附原因。

流程：
1. 全市場（上市）流動性足夠的股票（10 日均量 ≥ 1000 張、股價 ≥ 10 元）。
2. 以籌碼、營收成長、本益比、財務體質、融資使用率預選前 80 檔候選股。
3. 對候選股計算 9 個因子，各自在候選股中排名（百分位），依大盤多空狀態給不同權重加總為 0~100 分；
   再加上模型加減分（Minervini、葛拉漢、財務體質、Altman Z 等）與風險扣分。
4. 大盤空頭（0050 跌破 200 日線）時只選 3 檔並偏重低波動與財務體質；同一產業最多 2 檔。

規則固定、可重現，僅供參考，不構成投資建議。
"""
from __future__ import annotations

import logging
import threading
import time
from datetime import datetime
from zoneinfo import ZoneInfo

import pandas as pd

from . import data as D
from . import fundamentals as F
from . import indicators as ind
from . import models as M
from . import screener as S

log = logging.getLogger("twstock.picks")
D_TZ = ZoneInfo("Asia/Taipei")

FACTORS = {  # 因子名稱 → 說明（數值越高越好；低波動、融資使用率取負號）
    "chip": "籌碼（投信認養、法人同步買超、量增價漲）",
    "trend": "趨勢（均線多頭、創 20 日新高、KD / MACD 轉強）",
    "momentum": "12-1 個月動能（Jegadeesh & Titman）",
    "high52": "52 週高點動能（George & Hwang）",
    "lowvol": "低波動（近 60 日年化波動率越低越好）",
    "value": "價值（盈餘殖利率、現金殖利率）",
    "growth": "成長（月營收年增、累計年增）",
    "quality": "財務體質（ROE、負債比、流動比等 6 項）",
    "margin": "融資籌碼（融資使用率越低越好）",
}
WEIGHTS = {
    "bull": {"chip": .20, "trend": .15, "momentum": .15, "high52": .10, "lowvol": .05, "value": .10, "growth": .10, "quality": .10, "margin": .05},
    "neutral": {"chip": .20, "trend": .10, "momentum": .10, "high52": .10, "lowvol": .10, "value": .10, "growth": .10, "quality": .15, "margin": .05},
    "bear": {"chip": .15, "trend": .05, "momentum": .05, "high52": .05, "lowvol": .20, "value": .15, "growth": .10, "quality": .20, "margin": .05},
}
WEIGHTS["unknown"] = WEIGHTS["neutral"]
TOP_BY_REGIME = {"bull": 5, "neutral": 5, "unknown": 5, "bear": 3}
MAX_PER_INDUSTRY = 2

METHODS = [{"name": v.split("（")[0], "desc": v} for v in FACTORS.values()] + [
    {"name": "模型加減分", "desc": "Minervini 趨勢模板、葛拉漢條件、價值 / 殖利率、營收成長、財務體質、Altman Z 分數"},
    {"name": "大盤濾網", "desc": "0050 跌破 200 日線視為空頭：只選 3 檔，權重偏重低波動與財務體質"},
    {"name": "風險扣分", "desc": "RSI > 80 過熱、10 日漲幅 > 25%、跌破季線、營收年減 > 20%、本益比 > 60、Altman Z 危險區"},
]

DAYS = 10
MIN_VOLUME = 1000  # 10 日均量（張）
MIN_PRICE = 10.0
PRE_CANDIDATES = 80

_cache: dict[str, dict] = {}
_lock = threading.Lock()


def _chip_score(r: dict) -> tuple[float, list[str]]:
    """籌碼與價量面計分。"""
    score, why = 0.0, []
    if r["trust_streak"] >= 3:
        score += 2
        why.append(f"投信連買 {int(r['trust_streak'])} 日")
    elif r["trust_net"] > 0 and r["trust_days"] >= 6:
        score += 1
        why.append(f"投信 10 日 {int(r['trust_days'])} 日買超")
    if r["foreign_net"] > 0 and r["trust_net"] > 0:
        score += 2
        why.append("外資投信同步買超")
    elif r["inst_net"] > 0:
        score += 0.5
    if r["trust_ratio"] >= 1:
        score += 1
        why.append(f"投信買超佔量 {r['trust_ratio']:.1f}%")
    if r["volume_ratio"] >= 1.5 and r["day_change_pct"] > 0:
        score += 1
        why.append(f"量增價漲（量 {r['volume_ratio']:.1f} 倍均量）")
    if 0 < r["change_pct"] <= 20:
        score += 1
    elif r["change_pct"] > 25:
        score -= 2
        why.append(f"⚠ 10 日已漲 {r['change_pct']:.0f}%，追高風險")
    return score, why


def _load(code: str, use_demo: bool):
    try:
        return D.get_history(code, years=1.6, source="demo" if use_demo else None).df
    except Exception:  # noqa: BLE001
        return None


def _tech_score(df) -> tuple[float, list[str]] | None:
    if df is None or len(df) < 60:
        return None
    x = ind.compute_all(df)
    last = x.iloc[-1]
    c = float(df["close"].iloc[-1])
    score, why = 0.0, []
    if last["ma5"] > last["ma20"] > last["ma60"]:
        score += 2
        why.append("均線多頭排列")
    elif c > last["ma20"]:
        score += 1
        why.append("站上月線")
    if c < last["ma60"]:
        score -= 1
        why.append("⚠ 仍在季線之下")
    if c >= df["close"].iloc[-20:].max():
        score += 1
        why.append("創 20 日新高")
    if ind.crossed_above(x["k"], x["d"]).iloc[-3:].any() and last["k"] > last["d"]:
        score += 1
        why.append(f"KD 黃金交叉（K {last['k']:.0f}）")
    if last["hist"] > 0 and x["hist"].iloc[-6:-1].min() <= 0:
        score += 1
        why.append("MACD 翻正")
    if last["rsi"] > 80:
        score -= 2
        why.append(f"⚠ RSI {last['rsi']:.0f} 過熱")
    return score, why


def _fund_row(fund, code: str) -> dict | None:
    if fund is None or fund.empty or code not in fund.index:
        return None
    out = {}
    for k, v in fund.loc[code].items():
        if v is None or (not isinstance(v, str) and pd.isna(v)):
            out[k] = None
        else:
            out[k] = v if isinstance(v, str) else float(v)
    return out


def _model_extra(signals: list[str], model_reasons: list[str]) -> list[str]:
    """模型理由中，與因子理由不重複的部分（例如兩邊都有「12-1 動能」「財務體質」時只留一邊）。"""
    heads = {x[:4] for x in signals} | {x.split(" ")[0] for x in signals}
    keys = ("12-1", "財務體質", "本益比", "月營收")
    sig_text = "、".join(signals)
    return [m for m in model_reasons
            if m[:4] not in heads and not any(k in m and k in sig_text for k in keys)]


def _pct(values: dict[str, float | None]) -> dict[str, float]:
    """候選股之間的百分位排名（0~1），缺值給 0.5（中性）。"""
    ser = pd.Series({k: v for k, v in values.items() if v is not None and not pd.isna(v)}, dtype=float)
    ranks = ser.rank(pct=True) if len(ser) > 1 else ser.map(lambda _: 0.5)
    return {k: float(ranks.get(k, 0.5)) for k in values}


def _f(v):
    return None if v is None or pd.isna(v) else float(v)


def _preselect(t: pd.DataFrame) -> list[dict]:
    """以不需股價歷史的資料預選候選股（籌碼 40%、成長 20%、價值 15%、體質 15%、融資 10%）。"""
    recs = t.to_dict("records")
    chip = {r["code"]: _chip_score(r)[0] for r in recs}
    get = lambda col, f=lambda v: v: {r["code"]: (f(r[col]) if col in r and _f(r[col]) is not None else None) for r in recs}  # noqa: E731
    parts = [(0.4, _pct(chip)), (0.2, _pct(get("rev_yoy"))), (0.15, _pct(get("pe", lambda v: 1 / v if v > 0 else None))),
             (0.15, _pct(get("quality_score"))), (0.1, _pct(get("margin_usage", lambda v: -v)))]
    score = {c: sum(w * p[c] for w, p in parts) for c in chip}
    recs.sort(key=lambda r: -score[r["code"]])
    return recs[:PRE_CANDIDATES]


def _factor_reason(name: str, raw: dict, row: dict, chip_why: list[str], tech_why: list[str]) -> str | None:
    v = raw.get(name)
    if name == "chip":
        return chip_why[0] if chip_why else None
    if name == "trend":
        return tech_why[0] if tech_why else None
    if v is None:
        return None
    if name == "momentum":
        return f"12-1 動能 {v:+.0%}"
    if name == "high52":
        return "創一年新高" if v >= 0.999 else f"距一年高點 {1 - v:.0%}"
    if name == "lowvol":
        return f"低波動（年化 {-v:.0%}）"
    if name == "value":
        pe, dy = _f(row.get("pe")), _f(row.get("dividend_yield"))
        return "、".join(x for x in [f"本益比 {pe:.1f}" if pe and pe > 0 else "", f"殖利率 {dy:.1f}%" if dy else ""] if x) or None
    if name == "growth":
        yoy = _f(row.get("rev_yoy"))
        return f"月營收年增 {yoy:.0f}%" if yoy is not None else None
    if name == "quality":
        return f"財務體質 {v:.0f}/6"
    if name == "margin":
        return f"融資使用率低（{-v:.1f}%）"
    return None


def compute(top: int | None = None, use_demo: bool = False) -> dict:
    """計算每日精選（同一資料日期只計算一次）。top 未指定時依大盤多空決定（多頭 5 檔、空頭 3 檔）。"""
    with _lock:
        table, dates = S.build_table("twse", DAYS, use_demo)
        key = f"{'demo' if use_demo else 'live'}:{dates[-1]}:{top}"
        if key in _cache:
            return _cache[key]

        fund = F.get_fundamentals(use_demo)
        bench = _load(M.BENCHMARK, use_demo)
        bench_close = bench["close"] if bench is not None else None
        regime = M.market_regime(bench)
        weights = WEIGHTS[regime["state"]]
        n_top = top or TOP_BY_REGIME[regime["state"]]

        code = table["code"].astype(str)
        t = table[code.str.fullmatch(r"[1-9]\d{3}") & (table["volume_avg"] >= MIN_VOLUME) & (table["close"] >= MIN_PRICE)]
        t = t.dropna(subset=["trust_net", "foreign_net", "inst_net", "change_pct", "volume_ratio"])

        rows: dict[str, dict] = {}
        for r in _preselect(t):
            try:
                df = _load(r["code"], use_demo)
                tech = _tech_score(df)
                if tech is None:
                    continue
                chip, why = _chip_score(r)
                fr = _fund_row(fund, r["code"]) or {}
                results = M.evaluate_all(df, fr, bench_close)
                mom = M.momentum_12_1(df, bench_close).detail.get("momentum")
                vol = M.volatility(df)
                pe, dy = _f(fr.get("pe")), _f(fr.get("dividend_yield"))
                yoy, cum = _f(fr.get("rev_yoy")), _f(fr.get("rev_cum_yoy"))
                mu = _f(fr.get("margin_usage"))
                rows[r["code"]] = {
                    "row": {**r, **fr}, "results": results, "why": why, "tech": tech,
                    "raw": {
                        "chip": chip, "trend": tech[0], "momentum": mom, "high52": M.high_52w_ratio(df),
                        "lowvol": -vol if vol is not None else None,
                        "value": (1 / pe if pe and pe > 0 else 0) * 100 + (dy or 0) if (pe or dy) else None,
                        "growth": ((yoy or 0) + (cum or 0)) / (2 if cum is not None else 1) if yoy is not None else None,
                        "quality": _f(fr.get("quality_score")), "margin": -mu if mu is not None else None,
                    },
                }
            except Exception:  # noqa: BLE001 - 單檔資料異常不影響其他股票
                log.exception("每日精選：%s 計算失敗，已略過", r.get("code"))

        pct = {f: _pct({c: v["raw"][f] for c, v in rows.items()}) for f in FACTORS}
        picks = []
        for c, v in rows.items():
            r, results, why, tech = v["row"], v["results"], v["why"], v["tech"]
            factors = {f: pct[f][c] for f in FACTORS}
            composite = 100 * sum(weights[f] * factors[f] for f in FACTORS)
            model_score = sum(m.score for m in results)
            risks = [w[2:] for w in why + tech[1] if w.startswith("⚠")] + [w for m in results for w in m.risks]
            total = composite + 2 * model_score - 3 * len([w for w in why + tech[1] if w.startswith("⚠")])
            chip_why = [w for w in why if not w.startswith("⚠")]
            tech_why = [w for w in tech[1] if not w.startswith("⚠")]
            ranked = sorted(FACTORS, key=lambda f: -weights[f] * factors[f])
            signals = [x for f in ranked if factors[f] >= 0.7
                       for x in [_factor_reason(f, v["raw"], r, chip_why, tech_why)] if x][:4]
            model_why = [w for m in results for w in m.reasons]
            picks.append({
                "code": c, "name": r["name"], "industry": r.get("industry"), "close": S._clean(r["close"]),
                "day_change_pct": S._clean(r["day_change_pct"]), "change_pct": S._clean(r["change_pct"]),
                "foreign_net": S._clean(r["foreign_net"]), "trust_net": S._clean(r["trust_net"]),
                "score": round(total, 1), "composite": round(composite, 1),
                "factors": {f: round(x * 100) for f, x in factors.items()},
                "signals": signals or chip_why[:2] + tech_why[:2], "model_reasons": model_why,
                "model_extra": _model_extra(signals or chip_why[:2] + tech_why[:2], model_why)[:3],
                "reasons": (signals + model_why)[:6], "risks": risks,
                "models": [M.MODELS[m.model]["name"] for m in results if m.passed],
            })
        picks.sort(key=lambda p: (-p["score"], -(p["trust_net"] or 0)))

        chosen, per_industry = [], {}
        for p in picks:  # 產業分散：同產業最多 MAX_PER_INDUSTRY 檔
            ind_name = p.get("industry")
            if ind_name and per_industry.get(ind_name, 0) >= MAX_PER_INDUSTRY:
                continue
            per_industry[ind_name] = per_industry.get(ind_name, 0) + 1
            chosen.append(p)
            if len(chosen) >= n_top:
                break

        result = {
            "date": dates[-1], "generated_at": datetime.now(D_TZ).strftime("%Y-%m-%d %H:%M"),
            "days_used": len(dates), "days_target": DAYS, "picks": chosen, "regime": regime, "weights": weights, "factors": FACTORS,
            "methods": METHODS, "models": list(M.MODELS.values()),
            "source": "demo" if use_demo else "twse", "fundamentals": not fund.empty,
            "fundamentals_status": F.status(), "universe": int(len(table)), "eligible": int(len(t)),
            "candidates": len(rows),
        }
        _cache.clear()
        _cache[key] = result
        return result


def format_message(result: dict) -> str:
    today = datetime.now(D_TZ)
    when = "開盤前" if today.hour < 9 else "盤中補發"
    lines = [f"📊 台股每日精選（{today:%m/%d} {when}）", f"資料日期：{result['date']}"]
    if result.get("days_used") and result["days_used"] < result.get("days_target", DAYS):
        lines.append(f"（證交所資料暫時無法完整取得，法人籌碼僅以近 {result['days_used']} 日計算）")
    reg = result.get("regime") or {}
    if reg.get("state") in ("bull", "neutral", "bear"):
        lines.append(f"大盤：{reg['label']}（{reg['detail']}）")
        if reg["state"] == "bear":
            lines.append("⚠ 大盤空頭：精選減為 3 檔並偏重低波動與財務體質，建議降低持股比重")
    lines.append("")
    for i, p in enumerate(result["picks"], 1):
        chg = p["day_change_pct"] or 0
        ind_txt = f"［{p['industry']}］" if p.get("industry") else ""
        lines.append(f"{i}. {p['code']} {p['name']}{ind_txt}　收 {p['close']:,.2f}（{chg:+.2f}%）")
        lines.append("   " + "、".join(p.get("signals") or p["reasons"][:4] or ["綜合分數領先"]))
        extra = p.get("model_extra") or _model_extra(p.get("signals") or [], p.get("model_reasons") or [])
        if extra:
            lines.append("   ✅ " + "、".join(extra[:3]))
        if p["risks"]:
            lines.append("   ⚠ " + "、".join(p["risks"]))
    if not result["picks"]:
        lines.append("今天沒有符合條件的股票。")
    lines += ["", "多因子排名（籌碼、趨勢、動能、52 週高點、低波動、價值、成長、財務體質、融資）＋選股模型自動篩選，僅供參考，不構成投資建議。"]
    if result.get("source") == "demo":
        lines.append("⚠ 示範資料，非真實行情")
    return "\n".join(lines)


def safe_compute(use_demo: bool = False, retries: int = 2, raise_last: bool = False) -> dict | None:
    for i in range(retries + 1):
        try:
            return compute(use_demo=use_demo)
        except Exception:  # noqa: BLE001
            log.exception("每日精選計算失敗（第 %d 次）", i + 1)
            if i == retries:
                if raise_last:
                    raise
                return None
            time.sleep(30 * (i + 1))
    return None
