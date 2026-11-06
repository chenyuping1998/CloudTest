"""上市公司基本面與籌碼資料（證交所 OpenAPI，欄位已以 2026-11 實際回應驗證）。

| 資料 | 端點 | 用途 |
| --- | --- | --- |
| 月營收（含產業別） | opendata/t187ap05_L | 營收成長、產業分散 |
| 本益比 / 殖利率 / 股價淨值比 | exchangeReport/BWIBBU_ALL | 價值、葛拉漢條件 |
| 公司基本資料 | opendata/t187ap03_L | 已發行股數（市值） |
| 綜合損益表（一般業） | opendata/t187ap06_L_ci | 獲利、ROE、Altman Z、神奇公式 |
| 資產負債表（一般業） | opendata/t187ap07_L_ci | 負債比、流動比、Altman Z |
| 營益分析 | opendata/t187ap17_L | 毛利率、營益率 |
| 融資融券餘額 | exchangeReport/MI_MARGN | 融資使用率、券資比 |

限制：財報只提供「最新一季」（年初至今累計），申報期間尚未公布的公司沒有資料；
沒有現金流量表與去年同期資料，因此財務體質分數為 Piotroski F-Score 的精簡版。
金融保險業財報格式不同，目前只處理一般業。

各來源獨立取得，任何一個失敗只會讓對應欄位為 NaN，選股流程照常進行。每日快取一次。
"""
from __future__ import annotations

import hashlib
import json
import logging
import threading
import time
from datetime import date

import numpy as np
import pandas as pd
import requests

from . import data as D

log = logging.getLogger("twstock.fundamentals")
OPENAPI = "https://openapi.twse.com.tw/v1"
CACHE = D.CACHE_DIR / "fundamentals"
COLUMNS = [
    "code", "industry", "rev_yoy", "rev_cum_yoy", "pe", "dividend_yield", "pb", "shares",
    "margin_usage", "short_ratio", "margin_chg",
    "fs_period", "eps", "roe", "roa", "debt_ratio", "current_ratio", "gross_margin", "op_margin", "quality_score",
    "ebit_annual", "sales_annual", "total_assets", "total_liab", "current_assets", "current_liab", "retained",
]
_lock = threading.Lock()
_mem: dict[str, pd.DataFrame] = {}
_status: dict[str, str] = {}


def _num(v) -> float:
    try:
        return float(str(v).replace(",", "").strip())
    except ValueError:
        return float("nan")


def _key(rec: dict, *must: str, exclude: tuple[str, ...] = ()) -> str | None:
    for k in rec:
        if all(m in k for m in must) and not any(e in k for e in exclude):
            return k
    return None


def _need(first: dict, name: str, *must: str, exclude: tuple[str, ...] = ()) -> str:
    k = _key(first, *must, exclude=exclude)
    if not k:
        raise D.DataError(f"{name} 欄位格式無法辨識（找不到 {'+'.join(must)}）：{list(first)[:10]}")
    return k


# ---------------------------------------------------------------- 解析

def parse_revenue(records: list[dict]) -> pd.DataFrame:
    if not records:
        return pd.DataFrame(columns=["code", "rev_yoy", "rev_cum_yoy", "industry"])
    first = records[0]
    kc = _need(first, "月營收", "公司代號")
    ky = _need(first, "月營收", "營業收入", "去年同月增減", exclude=("累計",))
    kcum = _key(first, "累計", "前期比較增減")
    kind = _key(first, "產業別")
    return pd.DataFrame([{
        "code": str(r[kc]).strip(), "rev_yoy": _num(r.get(ky)),
        "rev_cum_yoy": _num(r.get(kcum)) if kcum else np.nan,
        "industry": str(r.get(kind) or "").strip() or None if kind else None,
    } for r in records])


def parse_valuation(records: list[dict]) -> pd.DataFrame:
    if not records:
        return pd.DataFrame(columns=["code", "pe", "dividend_yield", "pb"])
    return pd.DataFrame([{
        "code": str(r.get("Code", "")).strip(), "pe": _num(r.get("PEratio")),
        "dividend_yield": _num(r.get("DividendYield")), "pb": _num(r.get("PBratio")),
    } for r in records])


def parse_company(records: list[dict]) -> pd.DataFrame:
    if not records:
        return pd.DataFrame(columns=["code", "shares"])
    first = records[0]
    kc = _need(first, "公司基本資料", "公司代號")
    ks = _need(first, "公司基本資料", "已發行普通股數")
    return pd.DataFrame([{"code": str(r[kc]).strip(), "shares": _num(r.get(ks))} for r in records])


def parse_margin(records: list[dict]) -> pd.DataFrame:
    """融資使用率 = 融資餘額 / 融資限額；券資比 = 融券餘額 / 融資餘額；融資增減 = 今日 vs 前日。"""
    if not records:
        return pd.DataFrame(columns=["code", "margin_usage", "short_ratio", "margin_chg"])
    first = records[0]
    kc = _need(first, "融資融券", "代號")
    k_today = _need(first, "融資融券", "融資今日餘額")
    k_prev = _need(first, "融資融券", "融資前日餘額")
    k_limit = _need(first, "融資融券", "融資限額")
    k_short = _need(first, "融資融券", "融券今日餘額")
    rows = []
    for r in records:
        today, prev, limit, short = (_num(r.get(k)) for k in (k_today, k_prev, k_limit, k_short))
        rows.append({
            "code": str(r[kc]).strip(),
            "margin_usage": today / limit * 100 if limit and limit > 0 and not np.isnan(today) else np.nan,
            "short_ratio": short / today * 100 if today and today > 0 and not np.isnan(short) else np.nan,
            "margin_chg": (today - prev) / prev * 100 if prev and prev > 0 and not np.isnan(today) else np.nan,
        })
    return pd.DataFrame(rows)


def parse_statements(income: list[dict], balance: list[dict], margins: list[dict] | None = None) -> pd.DataFrame:
    """一般業損益表 + 資產負債表 → 財務指標（金額單位：千元；年初至今累計值以季別年化）。"""
    cols = ["code", "fs_period", "eps", "roe", "roa", "debt_ratio", "current_ratio", "gross_margin", "op_margin",
            "ebit_annual", "sales_annual", "total_assets", "total_liab", "current_assets", "current_liab", "retained",
            "net_income_annual"]
    inc = [r for r in income if str(r.get("公司代號", "")).strip()]
    bal = {str(r.get("公司代號", "")).strip(): r for r in balance if str(r.get("公司代號", "")).strip()}
    if not inc:
        return pd.DataFrame(columns=cols)
    fi, fb = inc[0], next(iter(bal.values()), {})
    k_rev = _need(fi, "損益表", "營業收入")
    k_gp = _key(fi, "營業毛利", exclude=("淨額",)) or _key(fi, "營業毛利")
    k_op = _need(fi, "損益表", "營業利益")
    k_ni = _need(fi, "損益表", "本期淨利", exclude=("繼續營業",))
    k_ni_parent = _key(fi, "淨利", "歸屬於母公司") or k_ni
    k_eps = _key(fi, "每股盈餘")
    if fb:
        k_ca, k_ta = _need(fb, "資產負債表", "流動資產", exclude=("非流動",)), _need(fb, "資產負債表", "資產總計")
        k_cl = _need(fb, "資產負債表", "流動負債", exclude=("非流動",))
        k_tl, k_re = _need(fb, "資產負債表", "負債總計"), _key(fb, "保留盈餘")
        k_eq_parent = _key(fb, "歸屬於母公司業主之權益") or _need(fb, "資產負債表", "權益總計")
    gm = {str(m.get("公司代號", "")).strip(): m for m in (margins or [])}
    rows = []
    for r in inc:
        code = str(r["公司代號"]).strip()
        season = _num(r.get("季別"))
        ann = 4 / season if season and season > 0 else np.nan  # 年初至今累計 → 年化
        rev, op, ni, ni_p = (_num(r.get(k)) for k in (k_rev, k_op, k_ni, k_ni_parent))
        gp = _num(r.get(k_gp)) if k_gp else np.nan
        row = {"code": code, "fs_period": f"{r.get('年度')}Q{r.get('季別')}", "eps": _num(r.get(k_eps)) if k_eps else np.nan,
               "ebit_annual": op * ann, "sales_annual": rev * ann, "net_income_annual": ni * ann,
               "gross_margin": gp / rev * 100 if rev else np.nan, "op_margin": op / rev * 100 if rev else np.nan}
        b = bal.get(code)
        if b:
            ca, ta, cl, tl, eq = (_num(b.get(k)) for k in (k_ca, k_ta, k_cl, k_tl, k_eq_parent))
            row.update({
                "total_assets": ta, "total_liab": tl, "current_assets": ca, "current_liab": cl,
                "retained": _num(b.get(k_re)) if k_re else np.nan,
                "roe": ni_p * ann / eq * 100 if eq and eq > 0 else np.nan,
                "roa": ni * ann / ta * 100 if ta else np.nan,
                "debt_ratio": tl / ta * 100 if ta else np.nan,
                "current_ratio": ca / cl if cl else np.nan,
            })
        m = gm.get(code)
        if m:  # 營益分析的毛利率 / 營益率為官方計算值，優先使用
            kg, ko = _key(m, "毛利率"), _key(m, "營業利益率")
            if kg and not np.isnan(_num(m.get(kg))):
                row["gross_margin"] = _num(m.get(kg))
            if ko and not np.isnan(_num(m.get(ko))):
                row["op_margin"] = _num(m.get(ko))
        rows.append(row)
    return pd.DataFrame(rows).reindex(columns=cols)


def quality_score(row) -> tuple[float, int]:
    """財務體質分數（參考 Piotroski F-Score 的獲利與財務安全項目，精簡版）。回傳（得分, 可評估項目數）。"""
    checks = [
        (row.get("net_income_annual"), lambda v: v > 0),   # 有獲利
        (row.get("ebit_annual"), lambda v: v > 0),         # 本業賺錢
        (row.get("roe"), lambda v: v >= 8),                # ROE ≥ 8%
        (row.get("debt_ratio"), lambda v: v < 60),         # 負債比 < 60%
        (row.get("current_ratio"), lambda v: v >= 1.25),   # 流動比 ≥ 1.25
        (row.get("rev_cum_yoy"), lambda v: v > 0),         # 累計營收成長
    ]
    valid = [(v, f) for v, f in checks if v is not None and not (isinstance(v, float) and np.isnan(v))]
    return float(sum(1 for v, f in valid if f(v))), len(valid)


def price_metrics(f: pd.DataFrame | dict, price) -> dict:
    """需要股價的指標：市值、Altman Z 分數、神奇公式（資本報酬率、盈餘殖利率）。

    Altman Z（原始製造業版）= 1.2·營運資金/總資產 + 1.4·保留盈餘/總資產 + 3.3·EBIT/總資產
                              + 0.6·市值/總負債 + 1.0·營收/總資產
    神奇公式（近似）：資本報酬率 = EBIT / (總資產 − 流動負債)；盈餘殖利率 = EBIT / (市值 + 總負債)
    財報金額單位為千元，市值換算為千元計算。
    """
    g = (lambda k: f.get(k)) if isinstance(f, dict) else (lambda k: f[k] if k in f else np.nan)
    ta, tl, ca, cl, re_, ebit, sales, shares = (g(k) for k in (
        "total_assets", "total_liab", "current_assets", "current_liab", "retained", "ebit_annual", "sales_annual", "shares"))
    mcap = price * shares / 1000 if shares is not None else np.nan  # 千元
    with np.errstate(divide="ignore", invalid="ignore"):
        z = 1.2 * (ca - cl) / ta + 1.4 * re_ / ta + 3.3 * ebit / ta + 0.6 * mcap / tl + 1.0 * sales / ta
        roc = ebit / (ta - cl) * 100
        ey = ebit / (mcap + tl) * 100
    return {"market_cap": mcap * 1000, "z_score": z, "magic_roc": roc, "magic_ey": ey}


# ---------------------------------------------------------------- 取得

def _fetch(path: str) -> list[dict]:
    last: Exception | None = None
    for attempt in range(2):
        try:
            r = requests.get(f"{OPENAPI}/{path}", headers={**D.HEADERS, "Accept": "application/json"}, timeout=60)
            r.raise_for_status()
            js = r.json()
            if not isinstance(js, list):
                raise D.DataError(f"{path} 回應格式不是陣列")
            return [x for x in js if any(str(v).strip() for v in x.values())]
        except (requests.RequestException, ValueError) as e:
            last = e
            time.sleep(5 * (attempt + 1))  # OpenAPI 連續請求太快會被中斷
    raise last  # type: ignore[misc]


SOURCES = [  # （名稱, 端點）
    ("月營收", "opendata/t187ap05_L"),
    ("本益比殖利率", "exchangeReport/BWIBBU_ALL"),
    ("公司基本資料", "opendata/t187ap03_L"),
    ("融資融券", "exchangeReport/MI_MARGN"),
    ("損益表", "opendata/t187ap06_L_ci"),
    ("資產負債表", "opendata/t187ap07_L_ci"),
    ("營益分析", "opendata/t187ap17_L"),
]


def _live() -> pd.DataFrame:
    raw: dict[str, list[dict]] = {}
    for i, (name, path) in enumerate(SOURCES):
        if i:
            time.sleep(3)  # 避免連續請求被 OpenAPI 中斷
        try:
            raw[name] = _fetch(path)
            _status[name] = f"OK（{len(raw[name])} 筆）"
        except Exception as e:  # noqa: BLE001 - 基本面為加分項，失敗不中斷選股
            raw[name] = []
            _status[name] = f"失敗：{D.friendly_error(e)}"
            log.warning("基本面資料 %s 取得失敗：%s", name, e)
    parts = []
    for name, parser in (("月營收", parse_revenue), ("本益比殖利率", parse_valuation),
                         ("公司基本資料", parse_company), ("融資融券", parse_margin)):
        try:
            parts.append(parser(raw[name]))
        except D.DataError as e:
            _status[name] = f"解析失敗：{e}"
            log.warning("%s", e)
    try:
        parts.append(parse_statements(raw["損益表"], raw["資產負債表"], raw["營益分析"]))
    except D.DataError as e:
        _status["損益表"] = f"解析失敗：{e}"
        log.warning("%s", e)
    df = pd.DataFrame(columns=["code"])
    for part in parts:
        if part.empty:
            continue
        part = part.drop_duplicates("code")
        df = part if df.empty else df.merge(part, on="code", how="outer")
    return _finish(df)


def _finish(df: pd.DataFrame) -> pd.DataFrame:
    if df.empty:
        return df
    for c in COLUMNS + ["net_income_annual"]:
        if c not in df:
            df[c] = np.nan
    scores = [quality_score(r) for r in df.to_dict("records")]
    df["quality_score"] = [s if n >= 4 else np.nan for s, n in scores]  # 可評估項目太少時不給分
    return df


def _demo() -> pd.DataFrame:
    from .market import DEMO_UNIVERSE
    inds = ["半導體業", "電子零組件業", "金融保險業", "航運業", "電腦及週邊設備業", "其他電子業", "鋼鐵工業", "食品工業"]
    rows = []
    for code in DEMO_UNIVERSE:
        rng = np.random.default_rng(int(hashlib.md5(f"fund{code}".encode()).hexdigest()[:8], 16))
        pe = float(rng.choice([np.nan, *rng.uniform(6, 45, 9)]))
        ta = float(rng.uniform(5e6, 5e8))
        rows.append({
            "code": code, "industry": inds[int(rng.integers(len(inds)))],
            "rev_yoy": round(float(rng.normal(8, 25)), 2), "rev_cum_yoy": round(float(rng.normal(6, 18)), 2),
            "pe": round(pe, 2), "dividend_yield": round(float(rng.uniform(0, 8)), 2), "pb": round(float(rng.uniform(0.6, 6)), 2),
            "shares": float(rng.uniform(2e8, 2e10)), "margin_usage": round(float(rng.uniform(0, 30)), 2),
            "short_ratio": round(float(rng.uniform(0, 25)), 2), "margin_chg": round(float(rng.normal(0, 2)), 2),
            "fs_period": "115Q3", "eps": round(float(rng.normal(3, 4)), 2),
            "total_assets": ta, "total_liab": ta * float(rng.uniform(0.2, 0.8)), "current_assets": ta * 0.4,
            "current_liab": ta * float(rng.uniform(0.1, 0.4)), "retained": ta * float(rng.uniform(-0.05, 0.4)),
            "ebit_annual": ta * float(rng.normal(0.08, 0.06)), "sales_annual": ta * float(rng.uniform(0.3, 1.5)),
            "net_income_annual": ta * float(rng.normal(0.06, 0.05)), "gross_margin": float(rng.uniform(5, 60)),
            "op_margin": float(rng.normal(10, 10)),
        })
    df = pd.DataFrame(rows)
    df["roe"] = df["net_income_annual"] / (df["total_assets"] - df["total_liab"]) * 100
    df["roa"] = df["net_income_annual"] / df["total_assets"] * 100
    df["debt_ratio"] = df["total_liab"] / df["total_assets"] * 100
    df["current_ratio"] = df["current_assets"] / df["current_liab"]
    return _finish(df)


def get_fundamentals(use_demo: bool = False) -> pd.DataFrame:
    """回傳 code 為索引的基本面表；任何來源失敗時該部分欄位為 NaN。"""
    key = "demo" if use_demo else f"live:{date.today():%Y%m%d}"
    with _lock:
        if key in _mem:
            return _mem[key]
        if use_demo:
            df = _demo()
        else:
            p = CACHE / f"{date.today():%Y%m%d}.json"
            if p.exists():
                df = pd.DataFrame(json.loads(p.read_text()))
            else:
                df = _live()
                if not df.empty:
                    CACHE.mkdir(parents=True, exist_ok=True)
                    p.write_text(df.to_json(orient="records", force_ascii=False))
        if df.empty:
            df = pd.DataFrame(columns=COLUMNS)
        df = df.reindex(columns=COLUMNS + ["net_income_annual"]).drop_duplicates("code").set_index("code")
        _mem.clear()
        _mem[key] = df
        return df


def status() -> dict[str, str]:
    return dict(_status)
