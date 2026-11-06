import json

import pytest
from fastapi.testclient import TestClient

from twstock import main, monitor, notifier

client = TestClient(main.app)
H = {"X-Admin-Password": "pw"}


@pytest.fixture(autouse=True)
def isolated(monkeypatch, tmp_path):
    monkeypatch.setattr(main, "AUTH_PASSWORD", "pw")
    monkeypatch.setattr(monitor, "ALERTS_FILE", tmp_path / "alerts.json")
    monkeypatch.delenv("TWSTOCK_ALERTS", raising=False)


def test_describe_and_validation():
    assert monitor.describe({"type": "price_above", "value": 1100.0}) == "股價 ≥ 1,100 元"
    assert monitor.describe({"type": "change_below", "value": -5.0}) == "單日漲跌幅 ≤ -5%"
    assert monitor.describe({"type": "cross_ma_down", "value": 20.0}) == "向下跌破 20 日均線"
    with pytest.raises(ValueError, match="均線天數"):
        monitor.add_alert("2330", "cross_ma_up", 2.5)
    with pytest.raises(ValueError, match="RSI"):
        monitor.add_alert("2330", "rsi_below", 150)
    with pytest.raises(ValueError, match="需要設定數值"):
        monitor.add_alert("2330", "price_above", None)
    assert monitor.add_alert("2330", "kd_golden", 99)["value"] is None  # 不需數值的類型忽略數值


def test_batch_create_patch_and_disable():
    r = client.post("/api/alerts", json={"codes": ["2330", "0050"], "type": "price_above", "value": 1, "note": "測試"}, headers=H)
    created = r.json()["created"]
    assert [a["code"] for a in created] == ["2330", "0050"] and all(a["enabled"] and a["note"] == "測試" for a in created)
    aid = created[0]["id"]
    assert client.patch(f"/api/alerts/{aid}", json={"enabled": False}).status_code == 401
    assert client.patch(f"/api/alerts/{aid}", json={"enabled": False}, headers=H).json()["enabled"] is False
    assert client.patch(f"/api/alerts/{aid}", json={"value": 2000, "note": "改"}, headers=H).json()["value"] == 2000
    assert client.patch(f"/api/alerts/{aid}", json={"value": -1}, headers=H).status_code == 400
    assert client.patch("/api/alerts/nope", json={"enabled": True}, headers=H).status_code == 404
    d = client.get("/api/alerts", headers=H).json()
    rows = {a["id"]: a for a in d["alerts"]}
    assert rows[aid]["enabled"] is False and rows[aid]["message"] is None  # 暫停：不觸發
    other = created[1]["id"]
    assert rows[other]["message"] and rows[other]["state"]["current"].startswith("現價")
    assert [t["id"] for t in d["triggered"]] == [other]
    exported = json.loads(d["export"])
    assert {"enabled": False, "note": "改"}.items() <= next(a for a in exported if a["id"] == aid).items()
    assert d["persisted"] is False


def test_state_distance_text():
    import pandas as pd
    from twstock import indicators as ind
    idx = pd.bdate_range("2024-01-01", periods=80)
    c = pd.Series([100.0] * 79 + [110.0], index=idx)
    df = pd.DataFrame({"open": c, "high": c, "low": c, "close": c, "volume": 1e6})
    x = ind.compute_all(df)
    st = monitor.alert_state({"type": "price_above", "value": 121.0}, df, x)
    assert st["current"] == "現價 110.00" and st["distance"] == "還差 +10.0%"
    assert monitor.alert_state({"type": "price_above", "value": 100.0}, df, x)["distance"] is None  # 已達成
    assert "還差" in monitor.alert_state({"type": "cross_ma_down", "value": 20}, df, x)["distance"]


def test_seed_keeps_enabled_and_note(monkeypatch):
    monkeypatch.setenv("TWSTOCK_ALERTS", json.dumps([{"id": "a1", "code": "2330", "type": "rsi_below", "value": 30,
                                                       "enabled": False, "note": "超賣"}]))
    (a,) = monitor.get_alerts()
    assert a["enabled"] is False and a["note"] == "超賣"
    assert json.loads(monitor.alerts_export())[0]["enabled"] is False


def test_history_recorded_and_disabled_not_pushed(monkeypatch):
    sent = []
    monkeypatch.setattr(notifier, "send_all", lambda text: sent.append(text) or {"line": True, "telegram": False})
    monkeypatch.setattr(notifier, "send_errors", lambda r: {})
    notifier._sent.clear(); notifier.history.clear()
    on = monitor.add_alert("2330", "price_above", 1, note="突破了")
    off = monitor.add_alert("0050", "price_above", 1)
    monitor.update_alert(off["id"], enabled=False)
    fired = notifier.check_once()
    assert [t["id"] for t in fired] == [on["id"]] and "備註：突破了" in sent[0]
    assert notifier.history[0]["id"] == on["id"] and notifier.history[0]["channels"] == ["line"]
    assert on["id"] in notifier.sent_today()
    d = client.get("/api/alerts", headers=H).json()
    assert d["history"][0]["code"] == "2330"
    assert next(a for a in d["alerts"] if a["id"] == on["id"])["pushed_today"] is True
