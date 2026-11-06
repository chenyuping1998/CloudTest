from types import SimpleNamespace

import pytest

from twstock import chatbot, line_bot


@pytest.fixture(autouse=True)
def reset(monkeypatch):
    chatbot._chat_hits.clear()
    chatbot._daily.update(date="", count=0)
    chatbot.status.update(last_error=None, last_reply_at=None, fallback_used=0)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("TWSTOCK_AI_MODEL", raising=False)


class FakeClient:
    def __init__(self, text="哈，追高仔又來了", stop="end_turn"):
        self.calls = []
        resp = SimpleNamespace(stop_reason=stop, content=[SimpleNamespace(type="thinking", thinking=""),
                                                          SimpleNamespace(type="text", text=text)])
        make = lambda **kw: self.calls.append(kw) or resp  # noqa: E731
        self.messages = SimpleNamespace(create=lambda **kw: make(api="messages", **kw))
        self.beta = SimpleNamespace(messages=SimpleNamespace(create=lambda **kw: make(api="beta", **kw)))


def test_find_stocks_ignores_prices():
    assert chatbot.find_stocks("台積電會到 1100 元嗎") == ["2330"]
    assert chatbot.find_stocks("2330 跟 2317 哪個好") == ["2330", "2317"]
    assert chatbot.find_stocks("發哥最近怎樣") == ["2454"]
    assert chatbot.find_stocks("大盤漲到 23000 點了") == ["0050"]
    assert chatbot.find_stocks("今天晚餐吃什麼") == []


def test_canned_reply_without_api_key():
    text = chatbot.reply("2330 會漲嗎", "C1")
    assert "台積電" in text and "多空分數" in text and chatbot.status["fallback_used"] == 1
    assert chatbot.reply("你好嗎", "C1") in chatbot.GENERIC


def test_ai_reply_uses_data_and_fallbacks(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    fake = FakeClient()
    monkeypatch.setattr(chatbot, "_get_client", lambda: fake)
    assert chatbot.reply("台積電還能追嗎", "C1") == "哈，追高仔又來了"
    (call,) = fake.calls
    assert call["api"] == "beta" and call["model"] == "claude-opus-5-5"
    assert call["fallbacks"] == "default" and call["betas"] == ["server-side-fallback-2026-07-01"]
    assert call["output_config"] == {"effort": "low"} and "thinking" not in call
    prompt = call["messages"][0]["content"]
    assert "<資料>" in prompt and "台積電（2330）" in prompt and "多空分數" in prompt
    assert "毒舌" in call["system"]


def test_other_model_skips_fallbacks(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    monkeypatch.setenv("TWSTOCK_AI_MODEL", "claude-haiku-5-5")
    fake = FakeClient()
    monkeypatch.setattr(chatbot, "_get_client", lambda: fake)
    chatbot.reply("嗨", "C1")
    assert fake.calls[0]["api"] == "messages" and "fallbacks" not in fake.calls[0]


def test_refusal_and_errors_fall_back(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    monkeypatch.setattr(chatbot, "_get_client", lambda: FakeClient(stop="refusal"))
    assert chatbot.reply("你好", "C1") in chatbot.GENERIC and "拒絕" in chatbot.status["last_error"]

    def boom():
        raise RuntimeError("x")
    monkeypatch.setattr(chatbot, "_get_client", boom)
    assert chatbot.reply("你好", "C2") in chatbot.GENERIC


def test_rate_limits(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    monkeypatch.setenv("TWSTOCK_AI_CHAT_LIMIT", "1")
    fake = FakeClient()
    monkeypatch.setattr(chatbot, "_get_client", lambda: fake)
    assert chatbot.reply("你好", "G1") == "哈，追高仔又來了"
    assert chatbot.reply("你好", "G1") in chatbot.GENERIC and "上限" in chatbot.status["last_error"]
    assert chatbot.reply("你好", "G2") == "哈，追高仔又來了"  # 其他聊天室不受影響
    assert len(fake.calls) == 2


@pytest.fixture
def line_sent(monkeypatch):
    out = []
    monkeypatch.setattr(line_bot, "reply", lambda token, text: out.append(text))
    monkeypatch.setattr(line_bot, "bot_user_id", lambda: "Ubot")
    return out


def _event(text, source, mention=None):
    msg = {"type": "text", "text": text}
    if mention:
        msg["mention"] = {"mentionees": mention}
    return {"events": [{"type": "message", "replyToken": "r", "source": source, "message": msg}]}


GROUP = {"type": "group", "groupId": "Cg", "userId": "Ux"}


def test_group_only_answers_when_tagged(line_sent, monkeypatch):
    asked = []
    monkeypatch.setattr(chatbot, "reply", lambda q, chat_id: asked.append((q, chat_id)) or "老司機回覆")
    line_bot.handle_events(_event("今天好熱", GROUP))
    assert line_sent == [] and asked == []  # 沒 tag：安靜
    line_bot.handle_events(_event("@股市老司機 台積電還能追嗎", GROUP, [{"index": 0, "length": 6, "isSelf": True, "type": "user"}]))
    assert asked == [("台積電還能追嗎", "Cg")] and line_sent == ["老司機回覆"]
    line_bot.handle_events(_event("@機器人 嗨", GROUP, [{"index": 0, "length": 4, "userId": "Ubot", "type": "user"}]))
    assert asked[-1] == ("嗨", "Cg")  # 沒有 isSelf 時以 userId 判斷
    line_bot.handle_events(_event("@小明 你看", GROUP, [{"index": 0, "length": 3, "userId": "Uother", "type": "user"}]))
    assert len(asked) == 2  # tag 別人不回


def test_commands_still_work_and_direct_chat(line_sent, monkeypatch):
    monkeypatch.setattr(chatbot, "reply", lambda q, chat_id: "老司機回覆")
    line_bot.handle_events(_event("@股市老司機 id", GROUP, [{"index": 0, "length": 6, "isSelf": True, "type": "user"}]))
    assert "Cg" in line_sent[-1]  # tag + 指令 → 指令結果
    line_bot.handle_events(_event("今天要買什麼", {"type": "user", "userId": "U1"}))
    assert line_sent[-1] == "老司機回覆"  # 私訊不需要 tag
