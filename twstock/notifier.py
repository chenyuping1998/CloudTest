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


def send_telegram(text: str) -> bool:
    token, chat = os.environ.get("TELEGRAM_BOT_TOKEN"), os.environ.get("TELEGRAM_CHAT_ID")
    if not token or not chat:
        return False
    try:
        r = requests.post(f"https://api.telegram.org/bot{token}/sendMessage",
                          json={"chat_id": chat, "text": text}, timeout=10)
        return r.ok
    except requests.RequestException as e:
        log.warning("Telegram 推播失敗：%s", e)
        return False


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
    """週一至週五 TWSTOCK_PICKS_TIME ~ 09:00 之間，且今天尚未推播。"""
    if os.environ.get("TWSTOCK_DAILY_PICKS", "1") != "1":
        return False
    now = now or datetime.now(TZ)
    h, m = (int(v) for v in os.environ.get("TWSTOCK_PICKS_TIME", "08:30").split(":"))
    minutes = now.hour * 60 + now.minute
    return now.weekday() < 5 and h * 60 + m <= minutes < 9 * 60 and _picks_sent != now.strftime("%Y-%m-%d")


def push_daily_picks(force: bool = False) -> dict | None:
    """計算並推播每日精選。資料日期距今超過 4 天（連假）時不推播，除非 force。"""
    global _picks_sent
    result = picks.safe_compute(use_demo=D.SOURCE == "demo", retries=0 if force else 2)
    if result is None:
        return None
    _picks_sent = datetime.now(TZ).strftime("%Y-%m-%d")
    stale = (datetime.now(TZ).date() - date.fromisoformat(result["date"])).days > 4
    if stale and not force:
        log.info("每日精選：資料日期 %s 過舊（可能為連假），今日不推播", result["date"])
        return result
    result["sent"] = send_all(picks.format_message(result))
    return result


def _loop(stop: threading.Event, interval: int) -> None:
    while not stop.wait(interval):
        try:
            if picks_due():
                push_daily_picks()
        except Exception:  # noqa: BLE001 - 背景執行緒不能中斷
            log.exception("每日精選推播失敗")
        if not market_open():
            continue
        try:
            for t in check_once():
                log.info("警示觸發：%s %s", t["code"], t["message"])
        except Exception:  # noqa: BLE001 - 背景執行緒不能中斷
            log.exception("背景警示檢查失敗")


def start() -> threading.Event:
    stop = threading.Event()
    interval = int(os.environ.get("TWSTOCK_MONITOR_INTERVAL", "60"))
    threading.Thread(target=_loop, args=(stop, interval), daemon=True, name="twstock-notifier").start()
    return stop
