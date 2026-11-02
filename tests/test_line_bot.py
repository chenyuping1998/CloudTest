import base64
import hashlib
import hmac
import json

import pytest
from fastapi.testclient import TestClient

from twstock import line_bot, notifier
from twstock.main import app

client = TestClient(app)


@pytest.fixture
def sent(monkeypatch):
    calls = []
    monkeypatch.setattr(line_bot, "_post", lambda path, payload: calls.append((path, payload)) or True)
    monkeypatch.setenv("LINE_CHANNEL_ACCESS_TOKEN", "tok")
    monkeypatch.setenv("LINE_CHANNEL_SECRET", "sec")
    monkeypatch.delenv("LINE_BROADCAST", raising=False)
    monkeypatch.delenv("LINE_TO", raising=False)
    return calls


def _sign(body: bytes, secret="sec") -> str:
    return base64.b64encode(hmac.new(secret.encode(), body, hashlib.sha256).digest()).decode()


def test_push_targets(sent, monkeypatch):
    assert line_bot.push("x") is False and sent == []  # 未設定對象
    monkeypatch.setenv("LINE_TO", "Uaaa")
    line_bot.push("hello")
    assert sent[-1] == ("push", {"to": "Uaaa", "messages": [{"type": "text", "text": "hello"}]})
    sent.clear()
    monkeypatch.setenv("LINE_TO", "Uaaa, Ubbb ,Cgroup1")
    line_bot.push("hi")
    assert ("multicast", {"to": ["Uaaa", "Ubbb"], "messages": [{"type": "text", "text": "hi"}]}) in sent
    assert ("push", {"to": "Cgroup1", "messages": [{"type": "text", "text": "hi"}]}) in sent
    sent.clear()
    monkeypatch.setenv("LINE_BROADCAST", "1")
    line_bot.push("all")
    assert sent == [("broadcast", {"messages": [{"type": "text", "text": "all"}]})]


def test_handle_text():
    assert "2330" in line_bot.handle_text("2330", {}) and "多空分數" in line_bot.handle_text("查 2330", {})
    assert "Cgroup" in line_bot.handle_text("id", {"type": "group", "groupId": "Cgroup", "userId": "Uxx"})
    assert "Uxx" in line_bot.handle_text("ID", {"type": "user", "userId": "Uxx"})
    assert "指令" in line_bot.handle_text("說明", {})
    assert line_bot.handle_text("今天天氣如何", {}) is None  # 群組閒聊不回覆


def test_webhook_signature_and_reply(sent):
    body = json.dumps({"events": [{"type": "message", "replyToken": "r1", "source": {"type": "user", "userId": "U1"},
                                   "message": {"type": "text", "text": "id"}}]}).encode()
    assert client.post("/line/webhook", content=body, headers={"x-line-signature": "bad"}).status_code == 401
    r = client.post("/line/webhook", content=body, headers={"x-line-signature": _sign(body)})
    assert r.status_code == 200
    assert sent and sent[0][0] == "reply" and sent[0][1]["replyToken"] == "r1" and "U1" in sent[0][1]["messages"][0]["text"]


def test_webhook_rejected_without_secret(sent, monkeypatch):
    monkeypatch.delenv("LINE_CHANNEL_SECRET")
    body = b'{"events":[]}'
    assert client.post("/line/webhook", content=body, headers={"x-line-signature": _sign(body)}).status_code == 401


def test_alerts_go_to_line(sent, monkeypatch):
    monkeypatch.setenv("LINE_TO", "Uaaa")
    monkeypatch.setattr(notifier, "send_telegram", lambda text: False)
    monkeypatch.setattr(notifier.monitor, "get_alerts", lambda: [{"id": "a1"}])
    monkeypatch.setattr(notifier.monitor, "check_alerts",
                        lambda: {"triggered": [{"id": "a1", "code": "2330", "name": "台積電", "message": "股價 ≥ 1"}]})
    notifier._sent.clear()
    assert len(notifier.check_once()) == 1 and "台積電" in sent[-1][1]["messages"][0]["text"]
    assert notifier.check_once() == []  # 同一天不重複推播


def test_test_notify_endpoint(sent, monkeypatch):
    from twstock import main
    monkeypatch.setattr(main, "AUTH_PASSWORD", "pw")
    monkeypatch.setattr(notifier, "send_telegram", lambda text: False)
    h = {"X-Admin-Password": "pw"}
    assert client.post("/api/admin/test-notify").status_code == 401
    assert client.post("/api/admin/test-notify", headers=h).status_code == 400  # 尚未設定推播對象
    monkeypatch.setenv("LINE_TO", "Uaaa")
    r = client.post("/api/admin/test-notify", headers=h).json()
    assert r["line"] is True and r["telegram"] is False and "line" not in r["errors"]


def test_secret_with_whitespace(sent, monkeypatch):
    monkeypatch.setenv("LINE_CHANNEL_SECRET", "  sec\n")
    body = b'{"destination":"Uxxx","events":[]}'  # LINE 後台按 Verify 時送的內容
    assert client.post("/line/webhook", content=body, headers={"x-line-signature": _sign(body)}).status_code == 200


def test_join_group_replies_group_id(sent):
    line_bot.handle_events({"events": [{"type": "join", "replyToken": "r9", "source": {"type": "group", "groupId": "Cabc123"}}]})
    assert sent[-1][0] == "reply" and "Cabc123" in sent[-1][1]["messages"][0]["text"]


class _Resp:
    def __init__(self, status, body):
        self.status_code, self._body, self.ok, self.text = status, body, status < 400, str(body)

    def json(self):
        return self._body


def test_line_error_reason(monkeypatch):
    monkeypatch.setenv("LINE_CHANNEL_ACCESS_TOKEN", "bad")
    monkeypatch.setenv("LINE_TO", "Uaaa")
    monkeypatch.setattr(line_bot.requests, "post", lambda *a, **k: _Resp(401, {"message": "Authentication failed"}))
    assert line_bot.push("x") is False
    assert "access token" in line_bot.last_error and "401" in line_bot.last_error
    monkeypatch.delenv("LINE_TO")
    line_bot.push("x")
    assert "LINE_TO" in line_bot.last_error


def test_push_picks_reports_compute_failure(monkeypatch):
    from twstock import main, picks
    monkeypatch.setattr(main, "AUTH_PASSWORD", "pw")

    def fail(**kw):
        raise ConnectionError("證交所連線被拒")
    monkeypatch.setattr(picks, "compute", fail)
    r = client.post("/api/admin/push-picks", headers={"X-Admin-Password": "pw"})
    assert r.status_code == 503 and "證交所連線被拒" in r.json()["detail"]


def test_admin_status(monkeypatch):
    from twstock import main
    monkeypatch.setattr(main, "AUTH_PASSWORD", "pw")
    monkeypatch.setattr(main, "_probe", lambda url, params=None: {"ok": "yahoo" in url, "ms": 5, "error": "blocked"})
    assert client.get("/api/admin/status").status_code == 401
    j = client.get("/api/admin/status", headers={"X-Admin-Password": "pw"}).json()
    assert len(j["sources"]) == 3 and sum(v["ok"] for v in j["sources"].values()) == 1
    assert {"access_token", "channel_secret", "to", "enabled"} <= set(j["line"])
