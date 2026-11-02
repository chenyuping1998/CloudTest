import pandas as pd
import pytest

from twstock import portfolio as P


def test_merge_and_totals():
    r = P.analyze([{"code": "2330", "shares": 1000, "cost": 100}, {"code": "2330.TW", "shares": 1000, "cost": 200},
                   {"code": "0050", "shares": 500, "cost": 100}])
    rows = {x["code"]: x for x in r["rows"]}
    assert set(rows) == {"2330", "0050"}
    assert rows["2330"]["shares"] == 2000 and rows["2330"]["cost"] == pytest.approx(150)
    assert sum(x["weight"] for x in r["rows"]) == pytest.approx(100)
    s = r["summary"]
    assert s["market_value"] == pytest.approx(sum(x["market_value"] for x in r["rows"]))
    assert s["net_pnl"] < s["pnl"]  # 已扣賣出費用
    assert all(x["action"] in P.ACTIONS and x["reasons"] for x in r["rows"])
    assert r["suggestions"] and r["risk"]["curve"]


def test_rejects_bad_input():
    with pytest.raises(ValueError):
        P.analyze([])
    with pytest.raises(ValueError):
        P.analyze([{"code": "2330", "shares": 0, "cost": 10}])


def _frame(closes):
    idx = pd.bdate_range("2024-01-01", periods=len(closes))
    c = pd.Series(closes, index=idx, dtype=float)
    return pd.DataFrame({"open": c, "high": c * 1.01, "low": c * 0.99, "close": c, "volume": 1e6})


def _advice(closes, cost):
    from twstock import analysis, indicators as ind
    df = _frame(closes)
    x = ind.compute_all(df)
    price = closes[-1]
    return P._advise("2330", df, x, analysis.summarize(df, x), cost, price / cost - 1)


def test_stop_loss_vs_take_profit():
    falling = [100 + i for i in range(60)] + [159 - 4 * i for i in range(15)]  # 高點 159 急跌到 103
    loss = _advice(falling, cost=150)
    assert loss["action"] == "stop"
    gain = _advice(falling, cost=80)
    assert gain["action"] == "reduce" and "停利" in gain["reasons"][0]
    assert gain["stop_price"] >= 80  # 有獲利時停損拉到成本以上


def test_concentration_warning():
    r = P.analyze([{"code": "2330", "shares": 100000, "cost": 100}, {"code": "2454", "shares": 10, "cost": 30}])
    assert any("比重偏高" in s["text"] for s in r["suggestions"])


def test_api_portfolio():
    from fastapi.testclient import TestClient
    from twstock.main import app
    c = TestClient(app)
    assert c.post("/api/portfolio", json={"holdings": [{"code": "2330", "shares": 1000, "cost": 100}]}).status_code == 200
    assert c.post("/api/portfolio", json={"holdings": [{"code": "2330", "shares": -1, "cost": 100}]}).status_code == 422
    assert c.post("/api/portfolio", json={"holdings": []}).status_code == 400
