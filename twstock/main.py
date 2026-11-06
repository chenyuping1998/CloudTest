"""FastAPI 伺服器：提供 API 與前端靜態網頁。

啟動：uvicorn twstock.main:app --reload
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
from datetime import datetime
import secrets
import threading
import time
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from pathlib import Path

import pandas as pd
import requests
from fastapi import BackgroundTasks, Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.responses import HTMLResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import analysis, backtest as bt, data as D, fundamentals, indicators as ind, line_bot, monitor, notifier, picks, portfolio, screener

STATIC = Path(__file__).parent / "static"
# 預設為公開網站：瀏覽、分析、回測、選股都不需登入。
# TWSTOCK_PASSWORD 為管理員密碼，只用來保護伺服器端警示（會推播到 Telegram）。
# 設定 TWSTOCK_PRIVATE=1 則整個網站都需要登入（HTTP Basic Auth）。
AUTH_USER = os.environ.get("TWSTOCK_USER", "admin")
AUTH_PASSWORD = os.environ.get("TWSTOCK_PASSWORD", "")
PRIVATE = os.environ.get("TWSTOCK_PRIVATE", "0") == "1"
# 每位訪客（IP）每分鐘可呼叫次數；0 = 不限制。選股 / 最佳化會向外部抓大量資料，另外限制。
RATE_LIMIT = int(os.environ.get("TWSTOCK_RATE_LIMIT", "120"))
HEAVY_RATE_LIMIT = int(os.environ.get("TWSTOCK_HEAVY_RATE_LIMIT", "6"))
HEAVY_PATHS = ("/api/screen", "/api/optimize")
LOOPBACK = {"127.0.0.1", "::1", "localhost"}


@asynccontextmanager
async def lifespan(_app: FastAPI):
    stop = notifier.start() if os.environ.get("TWSTOCK_BACKGROUND_MONITOR", "1") == "1" else None
    yield
    if stop:
        stop.set()


app = FastAPI(title="台股監控分析回測平台", lifespan=lifespan)


class RateLimiter:
    """記憶體內的滑動視窗限流（單一伺服器行程適用）。"""

    def __init__(self) -> None:
        self.hits: dict[tuple[str, str], deque] = defaultdict(deque)
        self.lock = threading.Lock()

    def allow(self, key: tuple[str, str], limit: int, window: float = 60.0) -> bool:
        if limit <= 0:
            return True
        now = time.monotonic()
        with self.lock:
            q = self.hits[key]
            while q and now - q[0] > window:
                q.popleft()
            if len(q) >= limit:
                return False
            q.append(now)
            if len(self.hits) > 10_000:  # 避免記憶體無限成長
                for k in [k for k, v in self.hits.items() if not v or now - v[-1] > window]:
                    del self.hits[k]
            return True


limiter = RateLimiter()


def _client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def _basic_ok(request: Request) -> bool:
    header = request.headers.get("authorization", "")
    if not header.lower().startswith("basic "):
        return False
    try:
        user, _, pwd = base64.b64decode(header[6:]).decode().partition(":")
    except Exception:  # noqa: BLE001
        return False
    return secrets.compare_digest(user, AUTH_USER) & secrets.compare_digest(pwd, AUTH_PASSWORD)


@app.middleware("http")
async def guard(request: Request, call_next):
    path = request.url.path
    if path in ("/healthz", "/line/webhook", "/cron/tick"):  # 以簽章 / 金鑰驗證，不受登入與限流影響
        return await call_next(request)
    if PRIVATE and AUTH_PASSWORD and not _basic_ok(request):
        return Response("需要登入", status_code=401, headers={"WWW-Authenticate": 'Basic realm="twstock"'})
    if path.startswith("/api/"):
        ip = _client_ip(request)
        heavy = path in HEAVY_PATHS
        if not limiter.allow((ip, "api"), RATE_LIMIT) or (heavy and not limiter.allow((ip, "heavy"), HEAVY_RATE_LIMIT)):
            msg = "查詢太頻繁，請稍候一分鐘再試" + ("（選股 / 最佳化每分鐘最多 %d 次）" % HEAVY_RATE_LIMIT if heavy else "")
            return JSONResponse({"detail": msg}, status_code=429, headers={"Retry-After": "60"})
    return await call_next(request)


def require_admin(x_admin_password: str = Header("")) -> None:
    """管理員驗證：未設定密碼時只允許本機存取（方便本機開發）。"""
    if not AUTH_PASSWORD:
        raise HTTPException(403, "伺服器未設定管理員密碼（TWSTOCK_PASSWORD），無法管理警示")
    if not secrets.compare_digest(x_admin_password.encode(), AUTH_PASSWORD.encode()):
        raise HTTPException(401, "管理員密碼錯誤")


def require_admin_or_local(request: Request, x_admin_password: str = Header("")) -> None:
    if not AUTH_PASSWORD and _client_ip(request) in LOOPBACK:
        return
    require_admin(x_admin_password)


@app.get("/healthz")
def healthz():
    return {"ok": True}


def _load(code: str, years: float) -> D.PriceData:
    try:
        return D.get_history(code, years=years)
    except D.DataError as e:
        raise HTTPException(404, str(e)) from e


def _series(s: pd.Series) -> list:
    return [None if pd.isna(v) else round(float(v), 4) for v in s]


# ---------------------------------------------------------------- 行情與分析

@app.get("/api/config")
def config():
    return {
        "source": D.SOURCE, "admin_enabled": bool(AUTH_PASSWORD), "stocks": [{"code": k, "name": v} for k, v in D.STOCK_NAMES.items()],
        "strategies": bt.STRATEGIES, "alert_types": monitor.ALERT_TYPES,
        "screener_fields": screener.FIELDS, "screener_technical": screener.TECHNICAL,
    }


@app.get("/api/history/{code}")
def history(code: str, years: float = Query(2, gt=0, le=15)):
    p = _load(code, years)
    df = p.df
    x = ind.compute_all(df)
    return {
        "code": p.code, "name": p.name, "source": p.source,
        "dates": [d.strftime("%Y-%m-%d") for d in df.index],
        "ohlcv": {k: _series(df[k]) for k in ("open", "high", "low", "close", "volume")},
        "indicators": {k: _series(x[k]) for k in x.columns},
        "summary": analysis.summarize(df, x),
    }


@app.get("/api/compare")
def compare(codes: str = Query(..., description="逗號分隔代號"), years: float = Query(1, gt=0, le=15)):
    out = []
    for code in [c for c in codes.split(",") if c.strip()][:8]:
        p = _load(code, years)
        c = p.df["close"]
        out.append({"code": p.code, "name": p.name, "source": p.source,
                    "dates": [d.strftime("%Y-%m-%d") for d in c.index],
                    "normalized": _series(c / c.iloc[0] * 100)})
    return out


@app.get("/api/institutional/{code}")
def institutional(code: str, days: int = Query(20, ge=1, le=60)):
    try:
        rows = screener.institutional_history(code, days, use_demo=D.SOURCE == "demo")
        source = "demo" if D.SOURCE == "demo" else "live"
    except Exception:  # noqa: BLE001
        rows, source = [], "live"
    if not rows and D.SOURCE == "auto":
        rows, source = screener.institutional_history(code, days, use_demo=True), "demo"
    return {"code": code, "source": source, "rows": rows}


# ---------------------------------------------------------------- 回測

class BacktestRequest(BaseModel):
    code: str
    strategy: str = "sma_cross"
    params: dict = Field(default_factory=dict)
    years: float = Field(3, gt=0, le=15)
    initial_capital: float = Field(1_000_000, gt=0)
    fee_discount: float = Field(1.0, gt=0, le=1)
    lot_size: int = Field(1, ge=1)
    stop_loss: float | None = Field(None, gt=0, lt=1)
    take_profit: float | None = Field(None, gt=0)


class OptimizeRequest(BacktestRequest):
    grid: dict[str, list[float]]
    sort_by: str = "sharpe"


def _cfg(req: BacktestRequest) -> bt.BacktestConfig:
    return bt.BacktestConfig(initial_capital=req.initial_capital, fee_discount=req.fee_discount,
                             lot_size=req.lot_size, stop_loss=req.stop_loss, take_profit=req.take_profit)


@app.post("/api/backtest")
def run_backtest(req: BacktestRequest):
    if req.strategy not in bt.STRATEGIES:
        raise HTTPException(400, f"未知策略：{req.strategy}")
    p = _load(req.code, req.years)
    pos = bt.generate_positions(p.df, req.strategy, req.params)
    res = bt.run_backtest(p.df, pos, _cfg(req), p.code)
    _, dd = bt.max_drawdown(res.equity)
    return {
        "code": p.code, "name": p.name, "source": p.source,
        "dates": [d.strftime("%Y-%m-%d") for d in p.df.index],
        "ohlcv": {k: _series(p.df[k]) for k in ("open", "high", "low", "close", "volume")},
        "equity": _series(res.equity), "benchmark": _series(res.benchmark), "drawdown": _series(dd),
        "trades": [t.__dict__ for t in res.trades], "metrics": res.metrics,
    }


@app.post("/api/optimize")
def optimize(req: OptimizeRequest):
    if req.strategy not in bt.STRATEGIES:
        raise HTTPException(400, f"未知策略：{req.strategy}")
    p = _load(req.code, req.years)
    results = bt.optimize(p.df, req.strategy, req.grid, _cfg(req), p.code, req.sort_by)
    return {"code": p.code, "name": p.name, "source": p.source, "results": results}


# ---------------------------------------------------------------- 監控

class AlertBody(BaseModel):
    code: str
    type: str
    value: float | None = None


@app.get("/api/quotes")
def get_quotes(codes: str = Query("", description="逗號分隔代號（最多 30 檔）")):
    try:
        return {"rows": monitor.quotes(codes.split(","))}
    except D.DataError as e:
        raise HTTPException(400, str(e)) from e


@app.get("/api/admin/check")
def admin_check(_: None = Depends(require_admin_or_local)):
    return {"ok": True}


@app.get("/api/alerts")
def list_alerts(_: None = Depends(require_admin_or_local)):
    export = monitor.alerts_export()
    seed = json.dumps([{k: a[k] for k in ("id", "code", "type", "value")} for a in monitor.seed_alerts()],
                      ensure_ascii=False, separators=(",", ":"))
    return {**monitor.check_alerts(), "export": export, "persisted": export == seed}


@app.post("/api/alerts")
def post_alert(body: AlertBody, _: None = Depends(require_admin_or_local)):
    try:
        return monitor.add_alert(body.code, body.type, body.value)
    except (ValueError, D.DataError) as e:
        raise HTTPException(400, str(e)) from e


@app.delete("/api/alerts/{alert_id}")
def del_alert(alert_id: str, _: None = Depends(require_admin_or_local)):
    monitor.delete_alert(alert_id)
    return {"ok": True}


# ---------------------------------------------------------------- 持股

class Holding(BaseModel):
    code: str
    shares: float = Field(gt=0)
    cost: float = Field(gt=0)


class PortfolioRequest(BaseModel):
    holdings: list[Holding] = Field(max_length=portfolio.MAX_HOLDINGS)


@app.post("/api/portfolio")
def analyze_portfolio(req: PortfolioRequest):
    try:
        return portfolio.analyze([h.model_dump() for h in req.holdings])
    except (ValueError, D.DataError) as e:
        raise HTTPException(400, str(e)) from e


# ---------------------------------------------------------------- 推播

@app.post("/line/webhook")
async def line_webhook(request: Request, background: BackgroundTasks):
    body = await request.body()
    if not line_bot.verify_signature(body, request.headers.get("x-line-signature", "")):
        raise HTTPException(401, "LINE 簽章驗證失敗")
    try:
        payload = json.loads(body)
    except ValueError as e:
        raise HTTPException(400, "格式錯誤") from e
    background.add_task(line_bot.handle_events, payload)  # 先回 200，再在背景查詢並回覆
    return {"ok": True}


@app.post("/api/admin/test-notify")
def test_notify(_: None = Depends(require_admin_or_local)):
    result = notifier.send_all("✅ 台股監控平台測試推播：收到這則訊息代表設定成功")
    errors = notifier.send_errors(result)
    if not any(result.values()):
        raise HTTPException(400, "推播失敗：" + "；".join(errors.values()) if errors else "沒有設定任何推播管道")
    return {**result, "errors": errors}


@app.get("/api/picks")
def daily_picks():
    """每日精選（同一資料日期只計算一次）。"""
    offline = D.SOURCE == "auto" and time.time() < D._offline_until
    try:
        return picks.compute(use_demo=D.SOURCE == "demo" or offline)
    except D.DataError as e:
        if D.SOURCE == "auto":
            D._offline_until = time.time() + 300
            return picks.compute(use_demo=True)
        raise HTTPException(503, str(e)) from e


@app.post("/api/admin/push-picks")
def push_picks_now(_: None = Depends(require_admin_or_local)):
    result = notifier.push_daily_picks(force=True)
    if result is None:
        raise HTTPException(503, notifier.picks_error or "每日精選計算失敗，請稍後再試")
    return result


def _probe(url: str, params: dict | None = None) -> dict:
    t = time.time()
    try:
        r = requests.get(url, params=params, headers=D.HEADERS, timeout=10, allow_redirects=False)
        blocked = "SECURITY REASONS" in r.text[:2000] or "安全性考量" in r.text[:2000]
        try:
            r.json()
            is_json = True
        except ValueError:
            is_json = False
        ok = r.ok and is_json and not blocked
        if blocked:
            return {"ok": False, "status": r.status_code, "ms": int((time.time() - t) * 1000),
                    "error": "被對方封鎖（回傳「因為安全性考量，您所執行的頁面無法呈現」）"}
        return {"ok": ok, "status": r.status_code, "ms": int((time.time() - t) * 1000),
                **({} if ok else {"error": f"HTTP {r.status_code}" + ("（可能被封鎖或限流）" if r.status_code in (403, 429) else "")})}
    except requests.RequestException as e:
        return {"ok": False, "error": D.friendly_error(e), "ms": int((time.time() - t) * 1000)}


@app.api_route("/cron/tick", methods=["GET", "POST"])
def cron_tick(key: str = ""):
    """給 cron-job.org 等外部排程呼叫：喚醒伺服器並執行排程工作（推播每日精選、盤中檢查警示）。"""
    expected = os.environ.get("TWSTOCK_CRON_KEY", "").strip()
    if not expected:
        raise HTTPException(403, "伺服器未設定 TWSTOCK_CRON_KEY")
    if not secrets.compare_digest(key.encode(), expected.encode()):
        raise HTTPException(401, "金鑰錯誤")
    started = notifier.tick_async("外部排程")
    return {"ok": True, "started": started, "picks_due": notifier.picks_due(), "market_open": notifier.market_open()}


@app.get("/api/admin/status")
def admin_status(_: None = Depends(require_admin_or_local)):
    """系統診斷：資料來源連線、推播設定、最近一次精選推播結果。"""
    sources = {
        "Yahoo Finance（日線）": _probe("https://query1.finance.yahoo.com/v8/finance/chart/2330.TW", {"range": "5d", "interval": "1d"}),
        "證交所（法人 / 行情，選股與精選用）": _probe("https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX", {"response": "json", "type": "IND"}),
        "證交所 OpenAPI（月營收 / 本益比）": _probe("https://openapi.twse.com.tw/v1/exchangeReport/BWIBBU_ALL"),
    }
    return {
        "source_mode": D.SOURCE,
        "offline_fallback": D.SOURCE == "auto" and time.time() < D._offline_until,
        "sources": sources,
        "telegram": {"configured": bool(os.environ.get("TELEGRAM_BOT_TOKEN") and os.environ.get("TELEGRAM_CHAT_ID")),
                     "last_error": notifier.telegram_error},
        "line": line_bot.status(),
        "picks": {"enabled": os.environ.get("TWSTOCK_DAILY_PICKS", "1") == "1",
                  "time": os.environ.get("TWSTOCK_PICKS_TIME", "08:30"),
                  "last_push": notifier.last_picks_push, "last_error": notifier.picks_error},
        "server_time": datetime.now(notifier.TZ).strftime("%Y-%m-%d %H:%M:%S"),
        "cron": {"configured": bool(os.environ.get("TWSTOCK_CRON_KEY", "").strip()), "last_tick": notifier.last_tick},
        "alerts": {"count": len(monitor.get_alerts()), "seeded": len(monitor.seed_alerts())},
        "fundamentals": fundamentals.status(),
    }


# ---------------------------------------------------------------- 選股

class ScreenFilter(BaseModel):
    field: str
    op: str = ">"
    value: float = 0
    value2: float | None = None


class ScreenRequest(BaseModel):
    market: str = Field("twse", pattern="^(twse|tpex)$")
    days: int = Field(10, ge=1, le=60)
    filters: list[ScreenFilter] = Field(default_factory=list)
    technical: list[str] = Field(default_factory=list)
    sort: str = "trust_net"
    order: str = Field("desc", pattern="^(asc|desc)$")
    limit: int = Field(10, ge=1, le=200)
    include_etf: bool = False


@app.post("/api/screen")
def screen(req: ScreenRequest):
    kwargs = req.model_dump()
    kwargs["filters"] = [f.model_dump() for f in req.filters]
    offline = D.SOURCE == "auto" and time.time() < D._offline_until
    try:
        return screener.screen(**kwargs, use_demo=D.SOURCE == "demo" or offline)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    except D.DataError as e:
        if D.SOURCE == "auto":
            D._offline_until = time.time() + 300
            return screener.screen(**kwargs, use_demo=True)
        raise HTTPException(503, str(e)) from e


# ---------------------------------------------------------------- 前端

app.mount("/static", StaticFiles(directory=STATIC), name="static")


def _asset_version() -> str:
    """依前端檔案內容產生版本號，部署新版時瀏覽器會自動抓新檔案。"""
    h = hashlib.sha1()
    for name in ("app.js", "style.css"):
        h.update((STATIC / name).read_bytes())
    return h.hexdigest()[:10]


ASSET_VERSION = _asset_version()


@app.get("/")
def index():
    html = (STATIC / "index.html").read_text(encoding="utf-8")
    for name in ("app.js", "style.css"):
        html = html.replace(f"/static/{name}\"", f"/static/{name}?v={ASSET_VERSION}\"")
    return HTMLResponse(html, headers={"Cache-Control": "no-cache"})
