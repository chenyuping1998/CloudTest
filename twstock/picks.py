"""每日精選：綜合台股常見選股法自動挑出 5 檔，附簡短原因。

計分流程：
1. 全市場（上市）近 10 個交易日的法人籌碼與價量資料，先排除流動性差的股票。
2. 籌碼面計分（投信認養、外資投信同步買超、量增價漲），取前 30 名候選。
3. 逐檔檢查技術面（均線多頭、創新高、KD / MACD 轉強；過熱扣分），取總分前 5 名。

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

METHODS = [
    {"name": "投信認養", "desc": "投信連續買超 3 日以上、買超佔成交量比重高"},
    {"name": "法人同步買超", "desc": "外資與投信近 10 日同步買超"},
    {"name": "量價突破", "desc": "量增價漲、創 20 日新高"},
    {"name": "均線多頭", "desc": "MA5 > MA20 > MA60、站上月線"},
    {"name": "技術轉強", "desc": "KD 黃金交叉、MACD 柱狀體翻正"},
    {"name": "Minervini 趨勢模板", "desc": "8 項條件全符合 +3 分、7 項 +1.5 分"},
    {"name": "12-1 個月動能", "desc": "過去 12 個月（扣除近 1 月）報酬為正且優於 0050"},
    {"name": "營收成長", "desc": "月營收年增 > 20% 且累計年增 > 10%"},
    {"name": "價值 / 殖利率", "desc": "本益比 ≤ 15 且殖利率 ≥ 4%"},
    {"name": "風險扣分", "desc": "RSI > 80 過熱、10 日漲幅 > 25%、跌破季線、營收年減 > 20%、本益比 > 60"},
]

DAYS = 10
MIN_VOLUME = 1000  # 10 日均量（張）
MIN_PRICE = 10.0
CANDIDATES = 30
REVENUE_CANDIDATES = 20

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
    return {k: (None if pd.isna(v) else float(v)) for k, v in fund.loc[code].items()}


def compute(top: int = 5, use_demo: bool = False) -> dict:
    """計算每日精選（同一資料日期只計算一次）。"""
    with _lock:
        table, dates = S.build_table("twse", DAYS, use_demo)
        key = f"{'demo' if use_demo else 'live'}:{dates[-1]}:{top}"
        if key in _cache:
            return _cache[key]

        fund = F.get_fundamentals(use_demo)
        bench = _load(M.BENCHMARK, use_demo)
        bench_close = bench["close"] if bench is not None else None

        code = table["code"].astype(str)
        t = table[code.str.fullmatch(r"[1-9]\d{3}") & (table["volume_avg"] >= MIN_VOLUME) & (table["close"] >= MIN_PRICE)]
        t = t.dropna(subset=["trust_net", "foreign_net", "inst_net", "change_pct", "volume_ratio"])
        cands = []
        for r in t.to_dict("records"):
            s, why = _chip_score(r)
            cands.append((s, r.get("inst_net") or 0, r, why))
        cands.sort(key=lambda c: (-c[0], -c[1]))
        chosen = cands[:CANDIDATES]
        # 加入月營收年增最高的股票，讓「營收成長」型股票也有機會入選
        if not fund.empty and "rev_yoy" in fund:
            seen = {c[2]["code"] for c in chosen}
            yoy = fund["rev_yoy"].dropna().sort_values(ascending=False)
            extra = [c for c in cands if c[2]["code"] not in seen and c[2]["code"] in yoy.index[:200]]
            extra.sort(key=lambda c: -yoy.get(c[2]["code"], 0))
            chosen += extra[:REVENUE_CANDIDATES]

        picks = []
        for chip, _, r, why in chosen:
            df = _load(r["code"], use_demo)
            tech = _tech_score(df)
            if tech is None:
                continue
            results = M.evaluate_all(df, _fund_row(fund, r["code"]), bench_close)
            total = chip + tech[0] + sum(m.score for m in results)
            model_why = [w for m in results for w in m.reasons]
            chip_why = [w for w in why if not w.startswith("⚠")]
            tech_why = [w for w in tech[1] if not w.startswith("⚠")]
            reasons = model_why[:2] + chip_why[:2] + tech_why[:2] + model_why[2:] + chip_why[2:] + tech_why[2:]
            risks = [w[2:] for w in why + tech[1] if w.startswith("⚠")] + [w for m in results for w in m.risks]
            picks.append({
                "code": r["code"], "name": r["name"], "close": S._clean(r["close"]),
                "day_change_pct": S._clean(r["day_change_pct"]), "change_pct": S._clean(r["change_pct"]),
                "foreign_net": S._clean(r["foreign_net"]), "trust_net": S._clean(r["trust_net"]),
                "score": round(total, 1), "reasons": reasons[:5], "risks": risks,
                "signals": (chip_why[:2] + tech_why[:2]) or (chip_why + tech_why), "model_reasons": model_why,
                "models": [M.MODELS[m.model]["name"] for m in results if m.passed],
            })
        picks.sort(key=lambda p: (-p["score"], -(p["trust_net"] or 0)))
        result = {
            "date": dates[-1], "generated_at": datetime.now(D_TZ).strftime("%Y-%m-%d %H:%M"),
            "picks": picks[:top], "methods": METHODS, "models": list(M.MODELS.values()),
            "source": "demo" if use_demo else "twse", "fundamentals": not fund.empty,
            "universe": int(len(table)), "eligible": int(len(t)),
        }
        _cache.clear()
        _cache[key] = result
        return result


def format_message(result: dict) -> str:
    today = datetime.now(D_TZ)
    when = "開盤前" if today.hour < 9 else "盤中補發"
    lines = [f"📊 台股每日精選（{today:%m/%d} {when}）", f"資料日期：{result['date']}", ""]
    for i, p in enumerate(result["picks"], 1):
        chg = p["day_change_pct"] or 0
        lines.append(f"{i}. {p['code']} {p['name']}　收 {p['close']:,.2f}（{chg:+.2f}%）")
        lines.append("   " + "、".join(p.get("signals") or p["reasons"][:4] or ["綜合分數領先"]))
        if p.get("model_reasons"):
            lines.append("   ✅ " + "、".join(p["model_reasons"]))
        if p["risks"]:
            lines.append("   ⚠ " + "、".join(p["risks"]))
    if not result["picks"]:
        lines.append("今天沒有符合條件的股票。")
    lines += ["", "綜合法人籌碼、技術面與 Minervini / 動能 / 營收 / 價值模型自動篩選，僅供參考，不構成投資建議。"]
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
