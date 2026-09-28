"""自選股監控與警示規則。"""
from __future__ import annotations

import json
import threading
import uuid

import pandas as pd

from . import data as D
from . import indicators as ind
from .analysis import _f

ALERTS_FILE = D.DATA_DIR / "alerts.json"
_lock = threading.Lock()

ALERT_TYPES = {
    "price_above": {"label": "股價 ≥", "needs_value": True},
    "price_below": {"label": "股價 ≤", "needs_value": True},
    "change_above": {"label": "漲幅 ≥ (%)", "needs_value": True},
    "change_below": {"label": "跌幅 ≤ (%)", "needs_value": True},
    "rsi_above": {"label": "RSI ≥", "needs_value": True},
    "rsi_below": {"label": "RSI ≤", "needs_value": True},
    "volume_surge": {"label": "成交量 ≥ N 倍 20 日均量", "needs_value": True},
    "cross_ma_up": {"label": "向上突破 N 日均線", "needs_value": True},
    "cross_ma_down": {"label": "向下跌破 N 日均線", "needs_value": True},
    "kd_golden": {"label": "KD 黃金交叉", "needs_value": False},
    "kd_death": {"label": "KD 死亡交叉", "needs_value": False},
    "macd_golden": {"label": "MACD 黃金交叉", "needs_value": False},
    "macd_death": {"label": "MACD 死亡交叉", "needs_value": False},
}


def _load(path, default):
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def _save(path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=2))


MAX_CODES = 30


def parse_codes(codes: list[str]) -> list[str]:
    """正規化、去除重複並限制數量（自選股存在各訪客的瀏覽器中）。"""
    seen, clean = set(), []
    for c in codes:
        if not c.strip():
            continue
        c = D.normalize_code(c)
        if c not in seen:
            seen.add(c)
            clean.append(c)
    return clean[:MAX_CODES]


def get_alerts() -> list[dict]:
    return _load(ALERTS_FILE, [])


def add_alert(code: str, type_: str, value: float | None = None) -> dict:
    if type_ not in ALERT_TYPES:
        raise ValueError(f"未知警示類型：{type_}")
    if ALERT_TYPES[type_]["needs_value"] and value is None:
        raise ValueError("此警示需要設定數值")
    alert = {"id": uuid.uuid4().hex[:8], "code": D.normalize_code(code), "type": type_, "value": value}
    with _lock:
        alerts = get_alerts()
        alerts.append(alert)
        _save(ALERTS_FILE, alerts)
    return alert


def delete_alert(alert_id: str) -> None:
    with _lock:
        _save(ALERTS_FILE, [a for a in get_alerts() if a["id"] != alert_id])


def _with_realtime(df: pd.DataFrame, rt: dict | None) -> pd.DataFrame:
    """把盤中即時價併入日線（當日尚未收盤時新增或覆蓋最後一根 K 棒）。"""
    if not rt:
        return df
    today = pd.Timestamp.now(tz="Asia/Taipei").normalize().tz_localize(None)
    row = {"open": rt["open"], "high": rt["high"], "low": rt["low"], "close": rt["price"], "volume": rt["volume"]}
    row = {k: (v if not pd.isna(v) else rt["price"]) for k, v in row.items()}
    df = df.copy()
    df.loc[today] = row
    return df.sort_index()


def evaluate(alert: dict, df: pd.DataFrame, x: pd.DataFrame) -> str | None:
    t, v = alert["type"], alert.get("value")
    c = df["close"]
    price = float(c.iloc[-1])
    chg = (price / float(c.iloc[-2]) - 1) * 100 if len(c) > 1 else 0.0
    last = x.iloc[-1]
    if t == "price_above" and price >= v:
        return f"股價 {price:.2f} ≥ {v}"
    if t == "price_below" and price <= v:
        return f"股價 {price:.2f} ≤ {v}"
    if t == "change_above" and chg >= v:
        return f"漲幅 {chg:.2f}% ≥ {v}%"
    if t == "change_below" and chg <= v:
        return f"漲跌幅 {chg:.2f}% ≤ {v}%"
    r = _f(last.get("rsi"))
    if t == "rsi_above" and r is not None and r >= v:
        return f"RSI {r:.1f} ≥ {v}"
    if t == "rsi_below" and r is not None and r <= v:
        return f"RSI {r:.1f} ≤ {v}"
    vma = _f(last.get("vol_ma20"))
    if t == "volume_surge" and vma and df["volume"].iloc[-1] >= v * vma:
        return f"成交量達 {df['volume'].iloc[-1] / vma:.1f} 倍均量"
    if t in ("cross_ma_up", "cross_ma_down"):
        ma = ind.sma(c, int(v))
        fn = ind.crossed_above if t == "cross_ma_up" else ind.crossed_below
        if len(ma.dropna()) > 1 and fn(c, ma).iloc[-1]:
            return f"{'突破' if t == 'cross_ma_up' else '跌破'} MA{int(v)}（{ma.iloc[-1]:.2f}）"
    if t == "kd_golden" and ind.crossed_above(x["k"], x["d"]).iloc[-1]:
        return f"KD 黃金交叉（K {last['k']:.1f}）"
    if t == "kd_death" and ind.crossed_below(x["k"], x["d"]).iloc[-1]:
        return f"KD 死亡交叉（K {last['k']:.1f}）"
    if t == "macd_golden" and ind.crossed_above(x["dif"], x["signal"]).iloc[-1]:
        return "MACD 黃金交叉"
    if t == "macd_death" and ind.crossed_below(x["dif"], x["signal"]).iloc[-1]:
        return "MACD 死亡交叉"
    return None


def _load_frame(code: str, rt: dict | None):
    p = D.get_history(code, years=1)
    df = _with_realtime(p.df, rt)
    return p, df, ind.compute_all(df)


def quotes(codes: list[str]) -> list[dict]:
    """自選股報價列表（公開）。"""
    codes = parse_codes(codes)
    rt_all = D.get_realtime(codes)
    rows = []
    for code in codes:
        try:
            p, df, x = _load_frame(code, rt_all.get(code))
        except Exception as e:  # noqa: BLE001
            rows.append({"code": code, "name": D.stock_name(code), "error": str(e)})
            continue
        rt = rt_all.get(code)
        c = df["close"]
        last = x.iloc[-1]
        price, prev = float(c.iloc[-1]), float(c.iloc[-2])
        rows.append({
            "code": code, "name": (rt or {}).get("name") or p.name, "source": "realtime" if rt else p.source,
            "price": price, "change": price - prev, "change_pct": (price / prev - 1) * 100,
            "open": _f(df["open"].iloc[-1]), "high": _f(df["high"].iloc[-1]), "low": _f(df["low"].iloc[-1]),
            "volume": _f(df["volume"].iloc[-1] / 1000), "time": (rt or {}).get("time") or c.index[-1].strftime("%Y-%m-%d"),
            "rsi": _f(last["rsi"]), "k": _f(last["k"]), "d": _f(last["d"]), "ma20": _f(last["ma20"]),
            "spark": [round(float(v), 2) for v in c.iloc[-60:]],
        })
    return rows


def check_alerts() -> dict:
    """檢查所有警示（管理員專用，背景推播也使用）。"""
    alerts = get_alerts()
    codes = sorted({a["code"] for a in alerts})
    rt_all = D.get_realtime(codes)
    triggered = []
    for code in codes:
        try:
            p, df, x = _load_frame(code, rt_all.get(code))
        except Exception:  # noqa: BLE001
            continue
        name = (rt_all.get(code) or {}).get("name") or p.name
        for a in alerts:
            if a["code"] == code:
                msg = evaluate(a, df, x)
                if msg:
                    triggered.append({**a, "name": name, "message": msg})
    return {"alerts": alerts, "triggered": triggered}
