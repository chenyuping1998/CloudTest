"""全市場每日資料：三大法人買賣超（T86）與每日收盤行情（MI_INDEX）。

每個交易日一個檔案快取於 data/cache/market/，過去日期的資料不會再變動，因此永久快取。
目前支援上市（TWSE）；上櫃（TPEx）為盡力支援（官方格式變動時可能失效）。
"""
from __future__ import annotations

import hashlib
import json
import time
from datetime import date, datetime, timedelta
from functools import lru_cache

import numpy as np
import pandas as pd
import requests

from . import data as D

MARKET_CACHE = D.CACHE_DIR / "market"
_last_request = 0.0


def _throttle() -> None:
    """證交所限制請求頻率（約每 5 秒 3 次），過快會被暫時封鎖 IP。"""
    global _last_request
    wait = 2.0 - (time.time() - _last_request)
    if wait > 0:
        time.sleep(wait)
    _last_request = time.time()


def _get_json(url: str, params: dict) -> dict:
    _throttle()
    r = requests.get(url, params=params, headers=D.HEADERS, timeout=D.TIMEOUT)
    r.raise_for_status()
    return r.json()


def _find_table(js: dict, must_have: list[str]) -> tuple[list[str], list[list]] | None:
    """在證交所回應中找出同時包含指定欄位的表格（新舊兩種格式）。"""
    candidates = []
    if "fields" in js and "data" in js:
        candidates.append((js["fields"], js["data"]))
    for t in js.get("tables", []) or []:
        if t.get("fields") and t.get("data") is not None:
            candidates.append((t["fields"], t["data"]))
    for i in range(1, 10):
        if f"fields{i}" in js:
            candidates.append((js[f"fields{i}"], js.get(f"data{i}", [])))
    for fields, rows in candidates:
        if all(any(m in f for f in fields) for m in must_have):
            return fields, rows
    return None


def _col(fields: list[str], *keywords: str, exact: str | None = None) -> int | None:
    if exact and exact in fields:
        return fields.index(exact)
    for i, f in enumerate(fields):
        if all(k in f for k in keywords):
            return i
    return None


# ---------------------------------------------------------------- 單日資料（TWSE）

def _fetch_twse_inst(d: date) -> pd.DataFrame | None:
    js = _get_json("https://www.twse.com.tw/rwd/zh/fund/T86",
                   {"date": d.strftime("%Y%m%d"), "selectType": "ALLBUT0999", "response": "json"})
    if js.get("stat") != "OK":
        return None
    tbl = _find_table(js, ["證券代號", "投信買賣超"])
    if not tbl:
        return None
    fields, rows = tbl
    ic = {
        "code": _col(fields, "證券代號"), "name": _col(fields, "證券名稱"),
        "foreign": _col(fields, "外陸資買賣超"), "foreign_dealer": _col(fields, "外資自營商買賣超"),
        "trust": _col(fields, "投信買賣超"), "dealer": _col(fields, exact="自營商買賣超股數"),
        "inst": _col(fields, "三大法人買賣超"),
    }
    if ic["dealer"] is None:
        ic["dealer"] = _col(fields, "自營商買賣超")
    recs = []
    for row in rows:
        rec = {"code": str(row[ic["code"]]).strip(), "name": str(row[ic["name"]]).strip()}
        for k in ("foreign", "foreign_dealer", "trust", "dealer", "inst"):
            rec[k] = D._to_float(row[ic[k]]) if ic[k] is not None else 0.0
        rec["foreign"] = rec["foreign"] + (rec.pop("foreign_dealer") or 0)
        recs.append(rec)
    return pd.DataFrame(recs)


def _fetch_twse_quotes(d: date) -> pd.DataFrame | None:
    js = _get_json("https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX",
                   {"date": d.strftime("%Y%m%d"), "type": "ALLBUT0999", "response": "json"})
    if js.get("stat") != "OK":
        return None
    tbl = _find_table(js, ["證券代號", "收盤價", "成交股數"])
    if not tbl:
        return None
    fields, rows = tbl
    ic = {k: _col(fields, v) for k, v in {
        "code": "證券代號", "name": "證券名稱", "volume": "成交股數", "value": "成交金額",
        "open": "開盤價", "high": "最高價", "low": "最低價", "close": "收盤價"}.items()}
    recs = []
    for row in rows:
        rec = {"code": str(row[ic["code"]]).strip(), "name": str(row[ic["name"]]).strip()}
        for k in ("volume", "value", "open", "high", "low", "close"):
            rec[k] = D._to_float(row[ic[k]])
        recs.append(rec)
    return pd.DataFrame(recs)


# ---------------------------------------------------------------- 單日資料（TPEx，盡力支援）

def _roc(d: date) -> str:
    return f"{d.year - 1911}/{d.month:02d}/{d.day:02d}"


def _tpex_rows(js: dict) -> tuple[list[str], list[list]] | None:
    if js.get("tables"):
        t = js["tables"][0]
        return t.get("fields", []), t.get("data", [])
    if js.get("aaData") is not None:
        return js.get("fields", []), js["aaData"]
    return None


def _fetch_tpex_inst(d: date) -> pd.DataFrame | None:
    js = _get_json("https://www.tpex.org.tw/web/stock/3insti/daily_trade/3itrade_hedge_result.php",
                   {"l": "zh-tw", "o": "json", "se": "EW", "t": "D", "d": _roc(d)})
    got = _tpex_rows(js)
    if not got or not got[1]:
        return None
    fields, rows = got
    # 欄位順序（官方格式）：代號,名稱,外資(買,賣,超)...,投信(買,賣,超),自營商合計超...,三大法人合計
    fi = _col(fields, "外資及陸資", "買賣超") or 4
    ti = _col(fields, "投信", "買賣超") or 13
    di = _col(fields, "自營商", "買賣超") or 22
    ii = _col(fields, "三大法人", "買賣超") or len(rows[0]) - 1
    recs = [{"code": str(r[0]).strip(), "name": str(r[1]).strip(), "foreign": D._to_float(r[fi]),
             "trust": D._to_float(r[ti]), "dealer": D._to_float(r[di]), "inst": D._to_float(r[ii])}
            for r in rows if len(r) > ii]
    return pd.DataFrame(recs)


def _fetch_tpex_quotes(d: date) -> pd.DataFrame | None:
    js = _get_json("https://www.tpex.org.tw/web/stock/aftertrading/daily_close_quotes/stk_quote_result.php",
                   {"l": "zh-tw", "o": "json", "d": _roc(d)})
    got = _tpex_rows(js)
    if not got or not got[1]:
        return None
    fields, rows = got
    ic = {"close": _col(fields, "收盤") or 2, "open": _col(fields, "開盤") or 4, "high": _col(fields, "最高") or 5,
          "low": _col(fields, "最低") or 6, "volume": _col(fields, "成交股數") or 8, "value": _col(fields, "成交金額") or 9}
    recs = []
    for r in rows:
        rec = {"code": str(r[0]).strip(), "name": str(r[1]).strip()}
        for k, i in ic.items():
            rec[k] = D._to_float(r[i]) if i < len(r) else np.nan
        recs.append(rec)
    return pd.DataFrame(recs)


# ---------------------------------------------------------------- 示範資料

DEMO_UNIVERSE = [c for c in D.STOCK_NAMES if not c.startswith("^")] + [f"{9000 + i}" for i in range(60)]


@lru_cache(maxsize=512)
def _demo_hist(code: str, end: date) -> pd.DataFrame:
    return D.demo_data(code, end - timedelta(days=200), end)


def _demo_day(d: date) -> tuple[pd.DataFrame, pd.DataFrame]:
    quotes, inst = [], []
    for code in DEMO_UNIVERSE:
        h = _demo_hist(code, date.today())
        if pd.Timestamp(d) not in h.index:
            continue
        row = h.loc[pd.Timestamp(d)]
        i = h.index.get_loc(pd.Timestamp(d))
        ret = row["close"] / h["close"].iloc[i - 1] - 1 if i > 0 else 0
        rng = np.random.default_rng(int(hashlib.md5(f"{code}{d}".encode()).hexdigest()[:8], 16))
        vol = row["volume"]
        # 法人買賣超與報酬呈正相關，加上隨機雜訊
        f = vol * (0.25 * np.tanh(ret * 40) + rng.normal(0, 0.08))
        t = vol * (0.08 * np.tanh(ret * 40) + rng.normal(0.005, 0.03))
        dl = vol * rng.normal(0, 0.03)
        name = D.stock_name(code) if code in D.STOCK_NAMES else f"示範{code}"
        quotes.append({"code": code, "name": name, "volume": vol, "value": vol * row["close"],
                       "open": row["open"], "high": row["high"], "low": row["low"], "close": row["close"]})
        inst.append({"code": code, "name": name, "foreign": round(f, -3), "trust": round(t, -3),
                     "dealer": round(dl, -3), "inst": round(f + t + dl, -3)})
    return pd.DataFrame(quotes), pd.DataFrame(inst)


# ---------------------------------------------------------------- 統一介面

def _cache_file(market: str, kind: str, d: date):
    return MARKET_CACHE / market / f"{kind}_{d:%Y%m%d}.json"


def get_day(market: str, d: date, use_demo: bool = False) -> tuple[pd.DataFrame, pd.DataFrame] | None:
    """取得某日的 (行情, 法人) 資料；非交易日或尚未公布回傳 None。"""
    if use_demo:
        if d.weekday() >= 5:
            return None
        q, i = _demo_day(d)
        return (q, i) if not q.empty else None

    fetch = {"twse": (_fetch_twse_quotes, _fetch_twse_inst), "tpex": (_fetch_tpex_quotes, _fetch_tpex_inst)}[market]
    out = []
    for kind, fn in zip(("quotes", "inst"), fetch):
        p = _cache_file(market, kind, d)
        if p.exists():
            js = json.loads(p.read_text())
            if js is None:
                return None
            out.append(pd.DataFrame(js))
            continue
        df = fn(d)
        is_past = d < date.today() or datetime.now().hour >= 18  # 當日資料約 16~17 點後公布
        if df is None:
            if is_past:
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text("null")  # 假日 / 無資料
            return None
        if is_past:
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(df.to_json(orient="records", force_ascii=False))
        out.append(df)
    return out[0], out[1]


def get_window(market: str, days: int, use_demo: bool = False, max_lookback: int = 60) -> list[tuple[date, pd.DataFrame, pd.DataFrame]]:
    """由近到遠往回找 `days` 個交易日的資料，回傳由舊到新排序。"""
    got = []
    d = date.today()
    tried = 0
    while len(got) < days and tried < max_lookback:
        if d.weekday() < 5:
            try:
                day = get_day(market, d, use_demo)
            except Exception as e:  # noqa: BLE001 - 網路或格式錯誤
                raise D.DataError(f"{market} {d:%Y-%m-%d} 資料取得失敗：{e}") from e
            if day is not None:
                got.append((d, day[0], day[1]))
        d -= timedelta(days=1)
        tried += 1
    if not got:
        raise D.DataError("找不到任何交易日資料（網路無法連線或來源格式變更）")
    return list(reversed(got))
