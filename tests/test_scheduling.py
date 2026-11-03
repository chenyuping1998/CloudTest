import json
from datetime import datetime

import pytest
from fastapi.testclient import TestClient

from twstock import main, monitor, notifier, picks
from twstock.notifier import TZ

client = TestClient(app := main.app)


@pytest.mark.parametrize("when, due", [
    (datetime(2026, 11, 3, 8, 29, tzinfo=TZ), False),
    (datetime(2026, 11, 3, 8, 30, tzinfo=TZ), True),
    (datetime(2026, 11, 3, 10, 15, tzinfo=TZ), True),   # 伺服器睡過頭，醒來後補發
    (datetime(2026, 11, 3, 13, 30, tzinfo=TZ), False),
    (datetime(2026, 11, 8, 9, 0, tzinfo=TZ), False),    # 週日
])
def test_catch_up_window(monkeypatch, when, due):
    monkeypatch.setattr(notifier, "_picks_sent", None)
    assert notifier.picks_due(when) is due


def test_late_message_title(monkeypatch):
    class Late(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime(2026, 11, 3, 10, 0, tzinfo=TZ)
    monkeypatch.setattr(picks, "datetime", Late)
    msg = picks.format_message({"date": "2026-11-02", "picks": [], "source": "twse"})
    assert "盤中補發" in msg


def test_cron_tick_requires_key(monkeypatch):
    monkeypatch.delenv("TWSTOCK_CRON_KEY", raising=False)
    assert client.get("/cron/tick?key=x").status_code == 403
    monkeypatch.setenv("TWSTOCK_CRON_KEY", "k123")
    assert client.get("/cron/tick?key=wrong").status_code == 401
    ran = []
    monkeypatch.setattr(notifier, "tick_async", lambda source: ran.append(source) or True)
    r = client.get("/cron/tick?key=k123")
    assert r.status_code == 200 and r.json()["started"] and ran == ["外部排程"]


def test_tick_runs_picks_and_skips_when_busy(monkeypatch):
    calls = []
    monkeypatch.setattr(notifier, "picks_due", lambda now=None: True)
    monkeypatch.setattr(notifier, "push_daily_picks", lambda force=False: calls.append("picks"))
    monkeypatch.setattr(notifier, "market_open", lambda now=None: False)
    assert notifier.tick("test") is True and calls == ["picks"]
    assert notifier.last_tick["source"] == "test"
    with notifier._tick_lock:
        assert notifier.tick("test") is False  # 上一次還在執行


def test_alerts_seed_from_env(monkeypatch, tmp_path):
    monkeypatch.setattr(monitor, "ALERTS_FILE", tmp_path / "alerts.json")
    monkeypatch.setenv("TWSTOCK_ALERTS", json.dumps([
        {"id": "a1", "code": "2330", "type": "price_above", "value": 1100},
        {"id": "bad", "code": "2330", "type": "nope"}, "garbage"]))
    assert [a["id"] for a in monitor.get_alerts()] == ["a1"]  # 檔案不存在 → 從環境變數還原
    monitor.add_alert("0050", "rsi_below", 30)
    assert len(monitor.get_alerts()) == 2  # 之後以檔案為準
    exported = json.loads(monitor.alerts_export())
    assert {a["code"] for a in exported} == {"2330", "0050"}
    monkeypatch.setenv("TWSTOCK_ALERTS", "not json")
    assert monitor.seed_alerts() == []


def test_alerts_api_persisted_flag(monkeypatch, tmp_path):
    monkeypatch.setattr(main, "AUTH_PASSWORD", "pw")
    monkeypatch.setattr(monitor, "ALERTS_FILE", tmp_path / "alerts.json")
    monkeypatch.delenv("TWSTOCK_ALERTS", raising=False)
    h = {"X-Admin-Password": "pw"}
    client.post("/api/alerts", json={"code": "2330", "type": "price_above", "value": 1}, headers=h)
    d = client.get("/api/alerts", headers=h).json()
    assert d["persisted"] is False and "2330" in d["export"]
    monkeypatch.setenv("TWSTOCK_ALERTS", d["export"])
    assert client.get("/api/alerts", headers=h).json()["persisted"] is True
