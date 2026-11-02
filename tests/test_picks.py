from datetime import datetime

import pytest
from fastapi.testclient import TestClient

from twstock import line_bot, notifier, picks
from twstock.main import app
from twstock.notifier import TZ

client = TestClient(app)


def test_compute_top5_with_reasons():
    r = picks.compute(use_demo=True)
    assert len(r["picks"]) == 5
    scores = [p["score"] for p in r["picks"]]
    assert scores == sorted(scores, reverse=True)
    for p in r["picks"]:
        assert p["code"].isdigit() and len(p["code"]) == 4  # 只選個股，不含 ETF
        assert p["reasons"]
    msg = picks.format_message(r)
    assert msg.count("\n1. ") == 1 and "僅供參考" in msg and r["picks"][0]["code"] in msg


def test_chip_score_rules():
    base = {"trust_streak": 0, "trust_net": 0, "trust_days": 0, "trust_ratio": 0, "foreign_net": 0,
            "inst_net": 0, "volume_ratio": 1, "day_change_pct": 0, "change_pct": 0}
    s0, _ = picks._chip_score(base)
    s1, why = picks._chip_score(base | {"trust_streak": 4, "trust_net": 500, "foreign_net": 800, "inst_net": 1300})
    assert s1 >= s0 + 4 and "投信連買 4 日" in why and "外資投信同步買超" in why
    s2, why2 = picks._chip_score(base | {"change_pct": 40})
    assert s2 < s0 and any("追高" in w for w in why2)


@pytest.mark.parametrize("when, due", [
    (datetime(2026, 11, 2, 8, 29, tzinfo=TZ), False),  # 週一 8:29
    (datetime(2026, 11, 2, 8, 30, tzinfo=TZ), True),
    (datetime(2026, 11, 2, 8, 59, tzinfo=TZ), True),
    (datetime(2026, 11, 2, 9, 0, tzinfo=TZ), False),
    (datetime(2026, 11, 1, 8, 45, tzinfo=TZ), False),  # 週日
])
def test_picks_due(monkeypatch, when, due):
    monkeypatch.setattr(notifier, "_picks_sent", None)
    assert notifier.picks_due(when) is due


def test_push_once_per_day(monkeypatch):
    sent = []
    monkeypatch.setattr(notifier, "_picks_sent", None)
    monkeypatch.setattr(notifier, "send_all", lambda text: sent.append(text) or {"telegram": True, "line": False})
    today = datetime.now(TZ).strftime("%Y-%m-%d")
    monkeypatch.setattr(picks, "safe_compute", lambda use_demo=False, retries=2: {
        "date": today, "picks": [{"code": "2330", "name": "台積電", "close": 1000, "day_change_pct": 1, "reasons": ["均線多頭排列"], "risks": []}],
        "source": "twse"})
    r = notifier.push_daily_picks()
    assert r["sent"]["telegram"] and "2330 台積電" in sent[0]
    now = datetime.now(TZ).replace(hour=8, minute=40)
    if now.weekday() < 5:
        assert notifier.picks_due(now) is False  # 今天已推播


def test_stale_data_not_pushed(monkeypatch):
    sent = []
    monkeypatch.setattr(notifier, "send_all", lambda text: sent.append(text) or {})
    monkeypatch.setattr(picks, "safe_compute", lambda use_demo=False, retries=2: {"date": "2026-01-01", "picks": [], "source": "twse"})
    notifier.push_daily_picks()
    assert sent == []
    notifier.push_daily_picks(force=True)
    assert len(sent) == 1


def test_api_and_line_command(monkeypatch):
    r = client.get("/api/picks")
    assert r.status_code == 200 and len(r.json()["picks"]) == 5
    assert "每日精選" in line_bot.handle_text("精選", {})
    from twstock import main
    monkeypatch.setattr(main, "AUTH_PASSWORD", "pw")
    assert client.post("/api/admin/push-picks").status_code == 401
