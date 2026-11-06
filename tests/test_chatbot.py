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
    for k in ("TWSTOCK_LLM_PROVIDER", "TWSTOCK_LLM_API_KEY", "TWSTOCK_LLM_MODEL", "TWSTOCK_LLM_BASE_URL", "TWSTOCK_LLM_ACCOUNT_ID"):
        monkeypatch.delenv(k, raising=False)


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
    assert chatbot.find_stocks("我在 2400 買了台積電") == ["2330"]
    assert chatbot.find_stocks("成本 950 的 2454 怎麼辦") == ["2454"]


def test_canned_reply_without_api_key():
    text = chatbot.reply("2330 會漲嗎", "C1")
    assert "台積電" in text and "多空分數" in text and chatbot.status["fallback_used"] == 1
    assert chatbot.reply("隨便聊聊", "C1") in chatbot.GENERIC


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
    assert "不要預設對方的狀況" in call["system"] and "80 字以內" in call["system"]


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
    assert chatbot.reply("隨便聊聊", "C1") in chatbot.GENERIC and "拒絕" in chatbot.status["last_error"]

    def boom():
        raise RuntimeError("x")
    monkeypatch.setattr(chatbot, "_get_client", boom)
    assert chatbot.reply("隨便聊聊", "C2") in chatbot.GENERIC


def test_rate_limits(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    monkeypatch.setenv("TWSTOCK_AI_CHAT_LIMIT", "1")
    fake = FakeClient()
    monkeypatch.setattr(chatbot, "_get_client", lambda: fake)
    assert chatbot.reply("你好", "G1") == "哈，追高仔又來了"
    assert chatbot.reply("隨便聊聊", "G1") in chatbot.GENERIC and "上限" in chatbot.status["last_error"]
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



# ---------------------------------------------------------------- 開源模型與意圖句庫

class FakeResp:
    def __init__(self, status=200, content="好啦好啦，追高的人都這樣說。"):
        self.status_code, self.ok = status, status < 400
        self._content = content

    def json(self):
        return {"choices": [{"message": {"content": self._content}}]}


def test_intent_replies():
    assert chatbot.intent("我被套牢了怎麼辦") == "trapped"
    assert chatbot.intent("現在可以買嗎") == "buy"
    assert chatbot.intent("要不要停損") == "sell"
    assert chatbot.intent("明天會漲嗎") == "rise"
    assert chatbot.intent("謝謝老司機") == "thanks"
    trapped = next(r for n, _, r in chatbot.INTENTS if n == "trapped")
    assert chatbot.reply("我被套牢了", "C1") in trapped
    text = chatbot.reply("2330 可以買嗎", "C1")
    assert text.split("\n")[0] in chatbot.BUY_DIP + chatbot.BUY_CHASE and "台積電" in text  # 意圖句＋真實報價
    falling = {"code": "2330", "name": "台積電", "price": 100.0, "change_pct": -4.0, "score": 40, "rsi": 50}
    assert chatbot.canned_reply("可以上車嗎", [falling]).split("\n")[0] in chatbot.BUY_DIP
    assert chatbot.canned_reply("可以上車嗎", [{**falling, "change_pct": 4.0}]).split("\n")[0] in chatbot.BUY_CHASE


def test_groq_request_and_traditional_conversion(monkeypatch):
    monkeypatch.setenv("TWSTOCK_LLM_PROVIDER", "groq")
    monkeypatch.setenv("TWSTOCK_LLM_API_KEY", "gsk_test")
    calls = []
    monkeypatch.setattr(chatbot.requests, "post", lambda url, **kw: calls.append((url, kw)) or
                        FakeResp(content="<think>先想想</think>这只股票的软件概念太热门，追高要设置止损。"))
    out = chatbot.reply("台積電還能追嗎", "C1")
    assert out == "這隻股票的軟體概念太熱門，追高要設定止損。"  # 去掉思考、簡轉繁（台灣用語）
    url, kw = calls[0]
    assert url == "https://api.groq.com/openai/v1/chat/completions"
    assert kw["headers"]["Authorization"] == "Bearer gsk_test" and kw["json"]["model"] == "openai/gpt-oss-120b"
    assert "台積電（2330）" in kw["json"]["messages"][1]["content"] and "繁體中文" in kw["json"]["messages"][0]["content"]
    assert chatbot.status["last_source"] == "groq:openai/gpt-oss-120b"


def test_llm_failures_fall_back(monkeypatch):
    monkeypatch.setenv("TWSTOCK_LLM_PROVIDER", "groq")
    monkeypatch.setenv("TWSTOCK_LLM_API_KEY", "gsk_test")
    monkeypatch.setattr(chatbot.requests, "post", lambda url, **kw: FakeResp(429))
    assert chatbot.reply("隨便聊聊", "C1") in chatbot.GENERIC and "429" in chatbot.status["llm_error"]  # 兩個模型都滿
    monkeypatch.setattr(chatbot.requests, "post", lambda url, **kw: FakeResp(content="你這個白癡"))
    assert chatbot.reply("隨便聊聊", "C2") in chatbot.GENERIC and "不適當" in chatbot.status["llm_error"]
    # 開源模型失敗時，有 Claude 金鑰就改用 Claude
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    monkeypatch.setattr(chatbot, "_get_client", lambda: FakeClient(text="Claude 接手"))
    monkeypatch.setattr(chatbot.requests, "post", lambda url, **kw: FakeResp(500))
    assert chatbot.reply("隨便聊聊", "C3") == "Claude 接手"


def test_provider_config_problems(monkeypatch):
    monkeypatch.setenv("TWSTOCK_LLM_PROVIDER", "cloudflare")
    monkeypatch.setenv("TWSTOCK_LLM_API_KEY", "cf")
    assert "ACCOUNT_ID" in chatbot.llm_config()["problem"]
    monkeypatch.setenv("TWSTOCK_LLM_ACCOUNT_ID", "abc123")
    cfg = chatbot.llm_config()
    assert cfg["problem"] is None and cfg["base"] == "https://api.cloudflare.com/client/v4/accounts/abc123/ai/v1"
    monkeypatch.setenv("TWSTOCK_LLM_PROVIDER", "openrouter")
    assert "MODEL" in chatbot.llm_config()["problem"]  # 免費模型需自行指定
    monkeypatch.setenv("TWSTOCK_LLM_PROVIDER", "ollama")
    monkeypatch.delenv("TWSTOCK_LLM_API_KEY")
    cfg = chatbot.llm_config()
    assert cfg["problem"] is None and cfg["model"] == "qwen2.5:3b"  # 自架不需金鑰
    called = []
    monkeypatch.setattr(chatbot.requests, "post", lambda url, **kw: called.append(kw["headers"]) or FakeResp())
    chatbot.reply("隨便聊聊", "C1")
    assert "Authorization" not in called[0]
    assert chatbot.usage()["llm"]["provider"] == "ollama" and "key" not in chatbot.usage()["llm"]



def test_analyze_target_fundamental_blocks():
    b = {"code": "1303", "name": "南亞", "date": "2026-11-06", "price": 239.5, "change_pct": -3.82, "score": 40,
         "rsi": 38.0, "k": 16.0, "d": 23.0, "ma5": 245.0, "ma20": 299.3, "ma60": 251.5, "atr": 22.0,
         "hi20": 330.0, "lo20": 224.5, "high_52w": 350.0, "low_52w": 43.5, "ret_1m": -18.3, "ret_3m": 35.3,
         "bull": ["K 值低檔"], "bear": ["跌破月線"], "signals": [], "fund": None}
    a = chatbot.canned_reply("分析南亞", [b], "G")
    assert "趨勢：跌破月線（299.30）、跌破季線（251.50）" in a and "RSI 38" in a and "偏空：跌破月線" in a
    t = chatbot.canned_reply("南亞目標價", [b], "G")
    assert "上方壓力：251.50（季線）、299.30（月線）" in t and "下方支撐：224.50（近 20 日低點）" in t and "195.50～283.50" in t
    assert "還沒載入" in chatbot.canned_reply("南亞本益比", [b], "G")
    f = chatbot.canned_reply("南亞本益比", [{**b, "fund": {"pe": 12.3, "dividend_yield": 4.5, "industry": "塑膠工業"}}], "G")
    assert "本益比 12.3 倍" in f and "塑膠工業" in f
    assert "📊" in chatbot.canned_reply("南亞", [b], "G")  # 只給名稱 → 分析
    ask = chatbot.canned_reply("分析一下", [], "G")
    assert "通靈" in ask or "名稱呢" in ask


def test_no_immediate_repeats():
    seen = [chatbot._pick(["a", "b", "c"], "room") for _ in range(3)]
    assert sorted(seen) == ["a", "b", "c"]  # 三句輪流用完才會重複


def test_llm_error_detail(monkeypatch):
    monkeypatch.setenv("TWSTOCK_LLM_PROVIDER", "groq")
    monkeypatch.setenv("TWSTOCK_LLM_API_KEY", "gsk_test")

    class Bad(FakeResp):
        def json(self):
            return {"error": {"message": "The model `x` has been decommissioned"}}
    monkeypatch.setattr(chatbot.requests, "post", lambda url, **kw: Bad(400))
    chatbot.reply("隨便聊聊", "C9")
    assert "decommissioned" in chatbot.status["llm_error"]



def test_model_fallback_chain(monkeypatch):
    monkeypatch.setenv("TWSTOCK_LLM_PROVIDER", "groq")
    monkeypatch.setenv("TWSTOCK_LLM_API_KEY", "gsk_test")
    tried = []

    def post(url, **kw):
        tried.append(kw["json"]["model"])
        return FakeResp(404) if kw["json"]["model"] == "openai/gpt-oss-120b" else FakeResp(content="備用模型回覆")
    monkeypatch.setattr(chatbot.requests, "post", post)
    assert chatbot.reply("隨便聊聊", "C1") == "備用模型回覆"
    assert tried == ["openai/gpt-oss-120b", "qwen/qwen3.8-27b"] and chatbot.status["last_source"] == "groq:qwen/qwen3.8-27b"
    tried.clear()  # 429（這個模型的流量滿了）→ 換下一個模型；全部都滿才用句庫
    monkeypatch.setattr(chatbot.requests, "post", lambda url, **kw: tried.append(kw["json"]["model"]) or FakeResp(429))
    assert chatbot.reply("隨便聊聊", "C2") in chatbot.GENERIC and tried == ["openai/gpt-oss-120b", "qwen/qwen3.8-27b"]
    tried.clear()  # 401（金鑰錯）不換模型
    monkeypatch.setattr(chatbot.requests, "post", lambda url, **kw: tried.append(1) or FakeResp(401))
    chatbot.reply("隨便聊聊", "C4")
    assert tried == [1]
    bodies = []  # gpt-oss 帶 reasoning_effort
    monkeypatch.setenv("TWSTOCK_LLM_MODEL", "openai/gpt-oss-20b")
    monkeypatch.setattr(chatbot.requests, "post", lambda url, **kw: bodies.append(kw["json"]) or FakeResp())
    chatbot.reply("隨便聊聊", "C3")
    assert bodies[0]["reasoning_effort"] == "low" and bodies[0]["max_tokens"] >= 1000



def test_library_does_not_presume_user_is_trapped():
    """句庫不能預設提問者有持股、被套或賠錢（除非他自己說）。"""
    presumptive = ("你的帳戶", "你那堆", "套牢股", "你的投資組合", "賠了別哭")
    neutral_pools = [r for n, _, r in chatbot.INTENTS if n not in ("trapped",)] + [
        chatbot.GENERIC, chatbot.CHEERS, chatbot.GLOOMS, chatbot.MEH, chatbot.EMPTY, chatbot.BUY_DIP, chatbot.BUY_CHASE]
    for pool in neutral_pools:
        for line in pool:
            assert not any(p in line for p in presumptive), line
    assert "賠了別哭" not in chatbot.FOOTER


def test_user_cost_and_pnl_in_context():
    assert chatbot.user_cost("我在 2400 買了台積電") == 2400
    assert chatbot.user_cost("成本 95.5 的 0050") == 95.5
    assert chatbot.user_cost("買在 300 被套") == 300
    assert chatbot.user_cost("台積電能買嗎") is None
    b = {"code": "2330", "name": "台積電", "date": "2026-11-06", "price": 2135.0, "change_pct": -4.7, "score": 43,
         "rsi": 19.0, "k": 20.0, "d": 30.0, "ma5": 2200.0, "ma20": 2390.0, "ma60": 2422.0, "atr": 80.0, "hi20": 2500.0,
         "lo20": 2020.0, "high_52w": 2600.0, "low_52w": 1375.0, "ret_1m": -10.0, "ret_3m": -5.0, "signals": [], "demo": False}
    ctx = chatbot.context_text([b], "我在 2400 買了台積電，現在怎麼辦")
    assert "帳面虧損 11.0%" in ctx and "每股 -265.00" in ctx


def test_web_search_for_gpt_oss_only(monkeypatch):
    monkeypatch.setenv("TWSTOCK_LLM_PROVIDER", "groq")
    monkeypatch.setenv("TWSTOCK_LLM_API_KEY", "gsk_test")
    bodies = []

    class Searched(FakeResp):
        def json(self):
            return {"choices": [{"message": {"content": "答案是 **Francis Halzen**【1†L6-L14】。",
                                             "executed_tools": [{"type": "browser_search", "arguments": "{}"}]}}]}
    monkeypatch.setattr(chatbot.requests, "post", lambda url, **kw: bodies.append(kw["json"]) or Searched())
    out = chatbot.reply("2026 年諾貝爾物理學獎得主是誰", "W1")
    assert out == "答案是 Francis Halzen。"  # 去掉引用標記與 Markdown 粗體
    body = bodies[0]
    assert body["model"] == "openai/gpt-oss-120b" and body["tools"] == [{"type": "browser_search"}]
    assert "今天是" in body["messages"][0]["content"] and "browser_search" in body["messages"][0]["content"]
    assert "上網搜尋 1 次" in chatbot.status["last_source"]
    # qwen（不支援內建搜尋）不帶 tools，但仍知道今天日期、遇到時事要說查不到
    bodies.clear()
    monkeypatch.setenv("TWSTOCK_LLM_MODEL", "qwen/qwen3.8-27b")
    monkeypatch.setattr(chatbot.requests, "post", lambda url, **kw: bodies.append(kw["json"]) or FakeResp())
    chatbot.reply("今天天氣如何", "W2")
    assert "tools" not in bodies[0] and "沒辦法上網" in bodies[0]["messages"][0]["content"]
    # 可以關閉
    bodies.clear()
    monkeypatch.setenv("TWSTOCK_LLM_MODEL", "openai/gpt-oss-120b")
    monkeypatch.setenv("TWSTOCK_LLM_WEB_SEARCH", "0")
    chatbot.reply("今天天氣如何", "W3")
    assert "tools" not in bodies[0]
