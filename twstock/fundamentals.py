"""上市公司基本面資料（證交所 OpenAPI）：月營收、本益比、殖利率、股價淨值比。

- 月營收：/v1/opendata/t187ap05_L（最新一個月，含去年同月增減%、累計增減%）
- 估值：/v1/exchangeReport/BWIBBU_ALL（Code、PEratio、DividendYield、PBratio）

欄位名稱以關鍵字比對解析，官方格式小幅變動時仍可運作；取得失敗時回傳空表，
選股流程會略過基本面條件而不中斷。每日快取一次。
"""
from __future__ import annotations

import hashlib
import json
import logging
import threading
from datetime import date

import numpy as np
import pandas as pd
import requests

from . import data as D

log = logging.getLogger("twstock.fundamentals")
OPENAPI = "https://openapi.twse.com.tw/v1"
CACHE = D.CACHE_DIR / "fundamentals"
COLUMNS = ["code", "rev_yoy", "rev_cum_yoy", "pe", "dividend_yield", "pb"]
_lock = threading.Lock()
_mem: dict[str, pd.DataFrame] = {}


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


def parse_revenue(records: list[dict]) -> pd.DataFrame:
    if not records:
        return pd.DataFrame(columns=["code", "rev_yoy", "rev_cum_yoy"])
    first = records[0]
    kc = _key(first, "公司代號")
    ky = _key(first, "營業收入", "去年同月增減", exclude=("累計",))
    kcum = _key(first, "累計", "前期比較增減")
    if not kc or not ky:
        raise D.DataError(f"月營收欄位格式無法辨識：{list(first)[:12]}")
    return pd.DataFrame([{
        "code": str(r[kc]).strip(), "rev_yoy": _num(r.get(ky)),
        "rev_cum_yoy": _num(r.get(kcum)) if kcum else np.nan,
    } for r in records])


def parse_valuation(records: list[dict]) -> pd.DataFrame:
    if not records:
        return pd.DataFrame(columns=["code", "pe", "dividend_yield", "pb"])
    return pd.DataFrame([{
        "code": str(r.get("Code", "")).strip(), "pe": _num(r.get("PEratio")),
        "dividend_yield": _num(r.get("DividendYield")), "pb": _num(r.get("PBratio")),
    } for r in records])


def _fetch(path: str) -> list[dict]:
    r = requests.get(f"{OPENAPI}/{path}", headers={**D.HEADERS, "Accept": "application/json"}, timeout=D.TIMEOUT)
    r.raise_for_status()
    js = r.json()
    if not isinstance(js, list):
        raise D.DataError(f"{path} 回應格式不是陣列")
    return js


def _demo() -> pd.DataFrame:
    from .market import DEMO_UNIVERSE
    rows = []
    for code in DEMO_UNIVERSE:
        rng = np.random.default_rng(int(hashlib.md5(f"fund{code}".encode()).hexdigest()[:8], 16))
        pe = float(rng.choice([np.nan, *rng.uniform(6, 45, 9)]))
        rows.append({"code": code, "rev_yoy": round(float(rng.normal(8, 25)), 2),
                     "rev_cum_yoy": round(float(rng.normal(6, 18)), 2),
                     "pe": round(pe, 2), "dividend_yield": round(float(rng.uniform(0, 8)), 2),
                     "pb": round(float(rng.uniform(0.6, 6)), 2)})
    return pd.DataFrame(rows)


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
                parts = []
                for path, parser in (("opendata/t187ap05_L", parse_revenue), ("exchangeReport/BWIBBU_ALL", parse_valuation)):
                    try:
                        parts.append(parser(_fetch(path)))
                    except Exception as e:  # noqa: BLE001 - 基本面為加分項，失敗不中斷選股
                        log.warning("基本面資料 %s 取得失敗：%s", path, e)
                df = pd.DataFrame(columns=["code"])
                for part in parts:
                    df = df.merge(part, on="code", how="outer") if not df.empty else part
                if not df.empty:
                    CACHE.mkdir(parents=True, exist_ok=True)
                    p.write_text(df.to_json(orient="records", force_ascii=False))
        df = df.reindex(columns=COLUMNS).drop_duplicates("code").set_index("code")
        _mem.clear()
        _mem[key] = df
        return df
