"""背景警示監控：盤中定期檢查警示，觸發時推播到 Telegram / LINE（瀏覽器關閉也會執行）。

環境變數：
- TELEGRAM_BOT_TOKEN、TELEGRAM_CHAT_ID：設定後才會推播到 Telegram
- LINE_CHANNEL_ACCESS_TOKEN、LINE_TO（或 LINE_BROADCAST=1）：設定後推播到 LINE（見 line_bot.py）
- TWSTOCK_MONITOR_INTERVAL：檢查間隔秒數（預設 60）
- TWSTOCK_DAILY_PICKS：是否在開盤前推播每日精選（預設 1）
- TWSTOCK_PICKS_TIME：每日精選推播時間（預設 08:30，台北時間，週一至週五）
"""
from __future__ import annotations

import logging
import os
import threading
from datetime import date, datetime
from zoneinfo import ZoneInfo

import requests

from . import data as D
from . import line_bot, monitor, picks

log = logging.getLogger("twstock.notifier")
TZ = ZoneInfo("Asia/Taipei")
_sent: set[str] = set()  # 同一警示每天只推播一次
_picks_sent: str | None = None  # 每日精選最後推播日期


def market_open(now: datetime | None = None) -> bool:
    now = now or datetime.now(TZ)
    minutes = now.hour * 60 + now.minute
    return now.weekday() < 5 and 9 * 60 <= minutes <= 13 * 60 + 35


telegram_error: str | None = None
picks_error: str | None = None
last_picks_push: dict | None = None


def send_telegram(text: str) -> bool:
    global telegram_error
    token, chat = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip(), os.environ.get("TELEGRAM_CHAT_ID", "").strip()
    if token.lower().startswith("bot") and ":" in token:  # 常見錯誤：連同網址中的 "bot" 一起貼上
        token = token[3:]
    if not token or not chat:
        telegram_error = "未設定 TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID"
        return False
    try:
        r = requests.post(f"https://api.telegram.org/bot{token}/sendMessage",
                          json={"chat_id": chat, "text": text}, timeout=10)
        hints = {401: "Bot Token 無效", 404: "Bot Token 錯誤（請到 @BotFather 重新複製，不要包含開頭的 bot）",
                 400: "Chat ID 錯誤，或還沒對機器人按「開始」", 403: "機器人被封鎖或已被移出群組"}
        telegram_error = None if r.ok else f"Telegram 失敗（HTTP {r.status_code}）：{hints.get(r.status_code, r.text[:200])}"
        return r.ok
    except requests.RequestException as e:
        telegram_error = f"Telegram 連線失敗：{D.friendly_error(e)}"
        log.warning(telegram_error)
        return False


def send_errors(result: dict[str, bool]) -> dict[str, str]:
    """回傳推播失敗管道的原因（成功的管道不列出）。"""
    errs = {"telegram": telegram_error, "line": line_bot.last_error}
    return {k: v for k, v in errs.items() if not result.get(k) and v}


def send_all(text: str) -> dict[str, bool]:
    """推播到所有已設定的管道。"""
    return {"telegram": send_telegram(text), "line": line_bot.push(text)}


def check_once() -> list[dict]:
    if not monitor.get_alerts():
        return []
    today = datetime.now(TZ).strftime("%Y-%m-%d")
    fresh = []
    for t in monitor.check_alerts()["triggered"]:
        key = f"{today}:{t['id']}"
        if key in _sent:
            continue
        _sent.add(key)
        fresh.append(t)
        send_all(f"📈 台股警示\n{t['code']} {t['name']}\n{t['message']}")
    return fresh


def picks_due(now: datetime | None = None) -> bool:
    """週一至週五 TWSTOCK_PICKS_TIME 之後、TWSTOCK_PICKS_DEADLINE（預設 13:30）之前，且今天尚未推播。

    伺服器若在推播時間正在休眠（免費主機），醒來後仍會在期限內補發。
    """
    if os.environ.get("TWSTOCK_DAILY_PICKS", "1") != "1":
        return False
    now = now or datetime.now(TZ)
    h, m = (int(v) for v in os.environ.get("TWSTOCK_PICKS_TIME", "08:30").split(":"))
    dh, dm = (int(v) for v in os.environ.get("TWSTOCK_PICKS_DEADLINE", "13:30").split(":"))
    minutes = now.hour * 60 + now.minute
    return now.weekday() < 5 and h * 60 + m <= minutes < dh * 60 + dm and _picks_sent != now.strftime("%Y-%m-%d")


def push_daily_picks(force: bool = False) -> dict | None:
    """計算並推播每日精選。資料日期距今超過 4 天（連假）時不推播，除非 force。"""
    global _picks_sent, picks_error, last_picks_push
    try:
        result = picks.safe_compute(use_demo=D.SOURCE == "demo", retries=0 if force else 2, raise_last=True)
        picks_error = None
    except Exception as e:  # noqa: BLE001
        picks_error = f"每日精選計算失敗：{e}" if isinstance(e, D.DataError) else f"每日精選計算失敗（程式錯誤 {type(e).__name__}：{e}）"
        last_picks_push = {"at": datetime.now(TZ).strftime("%Y-%m-%d %H:%M"), "ok": False, "error": picks_error}
        return None
    _picks_sent = datetime.now(TZ).strftime("%Y-%m-%d")
    stale = (datetime.now(TZ).date() - date.fromisoformat(result["date"])).days > 4
    if stale and not force:
        log.info("每日精選：資料日期 %s 過舊（可能為連假），今日不推播", result["date"])
        return result
    result["sent"] = send_all(picks.format_message(result))
    result["errors"] = send_errors(result["sent"])
    last_picks_push = {"at": datetime.now(TZ).strftime("%Y-%m-%d %H:%M"), "ok": any(result["sent"].values()),
                       "date": result["date"], "sent": result["sent"], "errors": result["errors"]}
    return result


_tick_lock = threading.Lock()
last_tick: dict | None = None


def tick(source: str = "背景排程") -> bool:
    """執行一次排程工作：到時間就推播每日精選，盤中檢查警示。正在執行時直接略過（回傳 False）。"""
    global last_tick
    if not _tick_lock.acquire(blocking=False):
        return False
    try:
        last_tick = {"at": datetime.now(TZ).strftime("%Y-%m-%d %H:%M:%S"), "source": source}
        try:
            if picks_due():
                push_daily_picks()
        except Exception:  # noqa: BLE001 - 背景執行緒不能中斷
            log.exception("每日精選推播失敗")
        if market_open():
            try:
                for t in check_once():
                    log.info("警示觸發：%s %s", t["code"], t["message"])
            except Exception:  # noqa: BLE001
                log.exception("背景警示檢查失敗")
        return True
    finally:
        _tick_lock.release()


def tick_async(source: str) -> bool:
    """在背景執行 tick（給外部排程呼叫，立即回應避免逾時）。"""
    if _tick_lock.locked():
        return False
    threading.Thread(target=tick, args=(source,), daemon=True, name="twstock-tick").start()
    return True


def _loop(stop: threading.Event, interval: int) -> None:
    while not stop.wait(interval):
        tick()


def start() -> threading.Event:
    stop = threading.Event()
    interval = int(os.environ.get("TWSTOCK_MONITOR_INTERVAL", "60"))
    threading.Thread(target=_loop, args=(stop, interval), daemon=True, name="twstock-notifier").start()
    return stop
