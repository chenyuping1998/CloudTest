"""台股資料來源：Yahoo Finance、TWSE 證交所、TWSE 即時報價 (MIS)，以及離線示範資料。

所有日線資料統一為 DataFrame，index 為日期 (DatetimeIndex)，欄位：
open, high, low, close, volume（volume 單位：股）。
"""
from __future__ import annotations

import hashlib
import json
import os
import time
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path

import numpy as np
import pandas as pd
import requests

DATA_DIR = Path(os.environ.get("TWSTOCK_DATA_DIR", Path(__file__).resolve().parent.parent / "data"))
CACHE_DIR = DATA_DIR / "cache"
CACHE_TTL_SECONDS = int(os.environ.get("TWSTOCK_CACHE_TTL", "1800"))
# auto: yahoo -> twse -> demo；也可指定 yahoo / twse / demo
SOURCE = os.environ.get("TWSTOCK_SOURCE", "auto").lower()

HEADERS = {"User-Agent": "Mozilla/5.0 (twstock-dashboard)"}
TIMEOUT = 10

# 常見個股 / ETF 名稱（Yahoo 只回英文名稱，這裡補中文）
STOCK_NAMES = {
    "0050": "元大台灣50", "0056": "元大高股息", "00878": "國泰永續高股息", "00919": "群益台灣精選高息",
    "006208": "富邦台50", "2330": "台積電", "2317": "鴻海", "2454": "聯發科", "2308": "台達電",
    "2382": "廣達", "2303": "聯電", "2412": "中華電", "2881": "富邦金", "2882": "國泰金",
    "2891": "中信金", "2886": "兆豐金", "2884": "玉山金", "1301": "台塑", "1303": "南亞",
    "2002": "中鋼", "2603": "長榮", "2609": "陽明", "2615": "萬海", "3711": "日月光投控",
    "2357": "華碩", "2379": "瑞昱", "3008": "大立光", "2345": "智邦", "3231": "緯創",
    "2356": "英業達", "6669": "緯穎", "3034": "聯詠", "2327": "國巨", "1216": "統一",
    "2207": "和泰車", "5880": "合庫金", "2892": "第一金", "2880": "華南金", "3037": "欣興",
    "8069": "元太", "6488": "環球晶", "5483": "中美晶", "3105": "穩懋", "6547": "高端疫苗",
    "^TWII": "加權指數",
}


_offline_until = 0.0


class DataError(Exception):
    pass


@dataclass
class PriceData:
    code: str
    name: str
    source: str
    df: pd.DataFrame


def normalize_code(code: str) -> str:
    code = code.strip().upper()
    for suffix in (".TW", ".TWO"):
        if code.endswith(suffix):
            code = code[: -len(suffix)]
    if code in ("TAIEX", "TWII", "加權指數"):
        return "^TWII"
    if not code or len(code) > 10 or not all(c.isalnum() or c == "^" for c in code):
        raise DataError(f"無效的股票代號：{code!r}")
    return code


def stock_name(code: str) -> str:
    return STOCK_NAMES.get(code, code)


# ---------------------------------------------------------------- Yahoo

def fetch_yahoo(code: str, start: date, end: date) -> pd.DataFrame:
    symbols = [code] if code.startswith("^") else [f"{code}.TW", f"{code}.TWO"]
    p1 = int(datetime.combine(start, datetime.min.time()).timestamp())
    p2 = int(datetime.combine(end + timedelta(days=1), datetime.min.time()).timestamp())
    last_err: Exception | None = None
    for sym in symbols:
        url = f"https://query1.finance.yahoo.com/v8/finance/chart/{sym}"
        try:
            r = requests.get(url, params={"period1": p1, "period2": p2, "interval": "1d"},
                             headers=HEADERS, timeout=TIMEOUT)
            r.raise_for_status()
            result = r.json()["chart"]["result"]
            if not result:
                continue
            res = result[0]
            ts = res.get("timestamp") or []
            q = res["indicators"]["quote"][0]
            if not ts:
                continue
            df = pd.DataFrame({
                "open": q["open"], "high": q["high"], "low": q["low"],
                "close": q["close"], "volume": q["volume"],
            }, index=pd.to_datetime(ts, unit="s", utc=True).tz_convert("Asia/Taipei").normalize().tz_localize(None))
            df = df.dropna(subset=["close"])
            df = df[~df.index.duplicated(keep="last")]
            if not df.empty:
                return df
        except Exception as e:  # noqa: BLE001 - try next symbol / source
            last_err = e
    raise DataError(f"Yahoo 查無資料：{code} ({last_err})")


# ---------------------------------------------------------------- TWSE

def _to_float(s: str) -> float:
    s = str(s).replace(",", "").strip()
    try:
        return float(s)
    except ValueError:
        return float("nan")


def _roc_to_date(s: str) -> pd.Timestamp:
    y, m, d = s.strip().split("/")
    return pd.Timestamp(int(y) + 1911, int(m), int(d))


def fetch_twse(code: str, start: date, end: date) -> pd.DataFrame:
    """證交所個股日成交資訊（上市），每次請求一個月。"""
    if code.startswith("^"):
        raise DataError("TWSE 來源不支援指數")
    rows = []
    cur = date(start.year, start.month, 1)
    while cur <= end:
        url = "https://www.twse.com.tw/exchangeReport/STOCK_DAY"
        r = requests.get(url, params={"response": "json", "date": cur.strftime("%Y%m01"), "stockNo": code},
                         headers=HEADERS, timeout=TIMEOUT)
        r.raise_for_status()
        js = r.json()
        if js.get("stat") == "OK":
            for row in js.get("data", []):
                rows.append({
                    "date": _roc_to_date(row[0]), "volume": _to_float(row[1]),
                    "open": _to_float(row[3]), "high": _to_float(row[4]),
                    "low": _to_float(row[5]), "close": _to_float(row[6]),
                })
        cur = (cur.replace(day=28) + timedelta(days=4)).replace(day=1)
        time.sleep(0.3)  # 避免被證交所封鎖
    if not rows:
        raise DataError(f"TWSE 查無資料：{code}")
    df = pd.DataFrame(rows).set_index("date").sort_index()
    return df.dropna(subset=["close"])


# ---------------------------------------------------------------- Demo

def demo_data(code: str, start: date, end: date) -> pd.DataFrame:
    """以股票代號為種子產生的擬真隨機走勢（無網路時使用，非真實行情）。"""
    seed = int(hashlib.md5(code.encode()).hexdigest()[:8], 16)
    rng = np.random.default_rng(seed)
    anchor = pd.Timestamp("2015-01-01")
    days = pd.bdate_range(anchor, pd.Timestamp(end))
    n = len(days)
    base = 20 + (seed % 900)
    drift = 0.0003 + (seed % 7) * 0.00005
    vol = 0.012 + (seed % 5) * 0.002
    # 加入緩慢變化的趨勢循環，讓技術指標有意義
    cycle = 0.0015 * np.sin(np.arange(n) / (40 + seed % 60))
    rets = rng.normal(drift, vol, n) + cycle
    close = np.exp(np.cumsum(rets))
    close = base * close / close[-1]  # 讓最新價格落在合理區間
    open_ = close * (1 + rng.normal(0, vol / 3, n))
    high = np.maximum(open_, close) * (1 + np.abs(rng.normal(0, vol / 2, n)))
    low = np.minimum(open_, close) * (1 - np.abs(rng.normal(0, vol / 2, n)))
    volume = (rng.lognormal(15, 0.5, n) * (1 + 5 * np.abs(rets))).round(-3)
    tick = lambda a: np.round(a, 2)  # noqa: E731
    df = pd.DataFrame({"open": tick(open_), "high": tick(high), "low": tick(low),
                       "close": tick(close), "volume": volume}, index=days)
    return df.loc[pd.Timestamp(start):pd.Timestamp(end)]


# ---------------------------------------------------------------- 快取與統一介面

def _cache_path(code: str) -> Path:
    return CACHE_DIR / f"{code.replace('^', 'IDX_')}.csv"


def _read_cache(code: str) -> tuple[pd.DataFrame, str, float] | None:
    p = _cache_path(code)
    meta = p.with_suffix(".json")
    if not p.exists() or not meta.exists():
        return None
    try:
        info = json.loads(meta.read_text())
        df = pd.read_csv(p, index_col=0, parse_dates=True)
        return df, info["source"], info["fetched_at"]
    except Exception:  # noqa: BLE001
        return None


def _write_cache(code: str, df: pd.DataFrame, source: str) -> None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    p = _cache_path(code)
    df.to_csv(p)
    p.with_suffix(".json").write_text(json.dumps({"source": source, "fetched_at": time.time()}))


def get_history(code: str, years: float = 3, source: str | None = None, use_cache: bool = True) -> PriceData:
    """取得日線資料。回傳 PriceData（含實際使用的資料來源）。"""
    code = normalize_code(code)
    source = (source or SOURCE).lower()
    end = date.today()
    start = end - timedelta(days=int(365 * years) + 10)

    if source == "demo":
        return PriceData(code, stock_name(code), "demo", demo_data(code, start, end))

    if use_cache:
        cached = _read_cache(code)
        if cached:
            df, src, fetched = cached
            fresh = time.time() - fetched < CACHE_TTL_SECONDS
            covers = not df.empty and df.index[0] <= pd.Timestamp(start) + pd.Timedelta(days=10)
            if fresh and covers and src != "demo":
                return PriceData(code, stock_name(code), src, df.loc[pd.Timestamp(start):])

    order = {"auto": ["yahoo", "twse"], "yahoo": ["yahoo"], "twse": ["twse"]}.get(source)
    if order is None:
        raise DataError(f"未知的資料來源：{source}")
    fetchers = {"yahoo": fetch_yahoo, "twse": fetch_twse}
    errors = []
    global _offline_until
    if source == "auto" and time.time() < _offline_until:
        order = []  # 近期連線全數失敗，暫時直接使用示範資料
    for name in order:
        try:
            df = fetchers[name](code, start, end)
            _write_cache(code, df, name)
            return PriceData(code, stock_name(code), name, df)
        except Exception as e:  # noqa: BLE001
            errors.append(f"{name}: {e}")

    if source == "auto":
        if errors:
            _offline_until = time.time() + 300
        return PriceData(code, stock_name(code), "demo", demo_data(code, start, end))
    raise DataError("; ".join(errors))


def get_realtime(codes: list[str]) -> dict[str, dict]:
    """TWSE MIS 即時報價（盤中約 5 秒更新）。失敗時回傳空 dict。"""
    codes = [c for c in codes if not c.startswith("^")]
    if not codes or SOURCE == "demo":
        return {}
    ex_ch = "|".join(f"tse_{c}.tw|otc_{c}.tw" for c in codes)
    try:
        r = requests.get("https://mis.twse.com.tw/stock/api/getStockInfo.jsp",
                         params={"ex_ch": ex_ch, "json": 1, "delay": 0}, headers=HEADERS, timeout=TIMEOUT)
        r.raise_for_status()
        out = {}
        for it in r.json().get("msgArray", []):
            price = _to_float(it.get("z", "-"))
            if np.isnan(price):  # 尚未成交時取最佳買價
                price = _to_float(str(it.get("b", "-")).split("_")[0])
            prev = _to_float(it.get("y", "-"))
            if np.isnan(price) or np.isnan(prev):
                continue
            out[it["c"]] = {
                "price": price, "prev_close": prev, "open": _to_float(it.get("o", "-")),
                "high": _to_float(it.get("h", "-")), "low": _to_float(it.get("l", "-")),
                "volume": _to_float(it.get("v", "-")) * 1000, "name": it.get("n"),
                "time": f"{it.get('d', '')} {it.get('t', '')}".strip(),
            }
        return out
    except Exception:  # noqa: BLE001
        return {}
