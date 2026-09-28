"""背景警示監控：盤中定期檢查警示，觸發時推播到 Telegram（瀏覽器關閉也會執行）。

環境變數：
- TELEGRAM_BOT_TOKEN、TELEGRAM_CHAT_ID：設定後才會推播
- TWSTOCK_MONITOR_INTERVAL：檢查間隔秒數（預設 60）
"""
from __future__ import annotations

import logging
import os
import threading
from datetime import datetime
from zoneinfo import ZoneInfo

import requests

from . import monitor

log = logging.getLogger("twstock.notifier")
TZ = ZoneInfo("Asia/Taipei")
_sent: set[str] = set()  # 同一警示每天只推播一次


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


def check_once() -> list[dict]:
    if not monitor.get_alerts():
        return []
    today = datetime.now(TZ).strftime("%Y-%m-%d")
    fresh = []
    for t in monitor.snapshot()["triggered"]:
        key = f"{today}:{t['id']}"
        if key in _sent:
            continue
        _sent.add(key)
        fresh.append(t)
        send_telegram(f"📈 台股警示\n{t['code']} {t['name']}\n{t['message']}")
    return fresh


def _loop(stop: threading.Event, interval: int) -> None:
    while not stop.wait(interval):
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
