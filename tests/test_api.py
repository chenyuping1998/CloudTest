from fastapi.testclient import TestClient

from twstock.main import app

client = TestClient(app)


def test_history_and_summary():
    r = client.get("/api/history/2330?years=1")
    assert r.status_code == 200
    j = r.json()
    assert j["source"] == "demo" and len(j["dates"]) == len(j["ohlcv"]["close"])
    assert 0 <= j["summary"]["score"] <= 100


def test_invalid_code():
    assert client.get("/api/history/..%2Fetc").status_code in (404, 422)


def test_backtest_and_optimize():
    r = client.post("/api/backtest", json={"code": "2330", "strategy": "kd"})
    assert r.status_code == 200 and "sharpe" in r.json()["metrics"]
    r = client.post("/api/optimize", json={"code": "2330", "strategy": "rsi", "grid": {"lower": [20, 30], "upper": [70, 80]}})
    assert r.status_code == 200 and len(r.json()["results"]) == 4
    assert client.post("/api/backtest", json={"code": "2330", "strategy": "nope"}).status_code == 400


def test_watchlist_and_alerts():
    assert client.put("/api/watchlist", json={"codes": ["2330", "2330.TW", "0050"]}).json()["codes"] == ["2330", "0050"]
    a = client.post("/api/alerts", json={"code": "2330", "type": "price_above", "value": 0.01}).json()
    snap = client.get("/api/monitor").json()
    assert [r["code"] for r in snap["rows"]] == ["2330", "0050"]
    assert any(t["id"] == a["id"] for t in snap["triggered"])
    client.delete(f"/api/alerts/{a['id']}")
    assert client.get("/api/monitor").json()["alerts"] == []
    assert client.post("/api/alerts", json={"code": "2330", "type": "price_above"}).status_code == 400


def test_screen_endpoint():
    r = client.post("/api/screen", json={"days": 10, "filters": [{"field": "trust_net", "op": ">", "value": 0}], "sort": "trust_net", "limit": 10})
    assert r.status_code == 200 and len(r.json()["rows"]) <= 10
    assert client.post("/api/screen", json={"sort": "bad"}).status_code == 400


def test_basic_auth(monkeypatch):
    from twstock import main
    monkeypatch.setattr(main, "AUTH_PASSWORD", "secret")
    assert client.get("/api/config").status_code == 401
    assert client.get("/api/config", auth=("admin", "wrong")).status_code == 401
    assert client.get("/api/config", auth=("admin", "secret")).status_code == 200
    assert client.get("/healthz").status_code == 200


def test_notifier_market_hours():
    from datetime import datetime
    from twstock.notifier import TZ, market_open
    assert market_open(datetime(2026, 9, 28, 10, 0, tzinfo=TZ))       # 週一盤中
    assert not market_open(datetime(2026, 9, 28, 14, 0, tzinfo=TZ))   # 收盤後
    assert not market_open(datetime(2026, 9, 27, 10, 0, tzinfo=TZ))   # 週日
