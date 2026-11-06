"""LINE 機器人的對話回覆：被 tag（群組）或私訊時，用毒舌、詼諧的語氣回答使用者的問題。

回覆來源依序為：
1. 開源模型（設定 TWSTOCK_LLM_PROVIDER 時）：透過 OpenAI 相容 API 呼叫 Groq / OpenRouter / Cloudflare Workers AI
   的免費額度，或自架的 Ollama。小模型常混用簡體字，回覆會自動轉成台灣繁體（OpenCC s2twp）。
2. Claude（設定 ANTHROPIC_API_KEY 時）。
3. 內建句庫（免費、一定可用）：先判斷問題意圖（會不會漲、能不能買、套牢、大盤、推薦…）再挑對應的嘲諷回覆，附真實報價。
問題提到的股票會先查即時報價與技術訊號當作「資料」，模型只能引用資料中的數字，避免亂編。
模型失敗、逾時、超過次數上限或內容不適當時，自動改用下一個來源。

環境變數：
- TWSTOCK_LLM_PROVIDER：groq / openrouter / cloudflare / ollama / custom（選填）
- TWSTOCK_LLM_API_KEY：該服務的 API 金鑰（ollama 不需要）
- TWSTOCK_LLM_MODEL：模型名稱（各服務有預設值）
- TWSTOCK_LLM_BASE_URL：自訂 API 位址（custom / ollama 用；cloudflare 另需 TWSTOCK_LLM_ACCOUNT_ID）
- ANTHROPIC_API_KEY：Claude API 金鑰（選填）
- TWSTOCK_AI_MODEL：模型（預設 claude-opus-5-5）
- TWSTOCK_AI_EFFORT：思考深度 low / medium / high（預設 low，聊天回覆快又省）
- TWSTOCK_AI_CHAT_LIMIT：每個聊天室每小時 AI 回覆上限（預設 20）
- TWSTOCK_AI_DAILY_LIMIT：全站每天 AI 回覆上限（預設 300）
"""
from __future__ import annotations

import logging
import os
import random
import re
import threading
import time
from collections import defaultdict, deque
from datetime import datetime
from zoneinfo import ZoneInfo

import requests

from . import analysis
from . import data as D
from . import indicators as ind

log = logging.getLogger("twstock.chatbot")
TZ = ZoneInfo("Asia/Taipei")
DEFAULT_MODEL = "claude-opus-5-5"
FALLBACK_MODELS = {"claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5"}  # 支援 server-side fallback
MAX_STOCKS = 3

SYSTEM_PROMPT = """你是 LINE 群組裡的台股機器人「股市老司機」，嘴巴出了名的毒。你看盤多年、看過太多散戶追高殺低，對愚蠢的操作零容忍，講話直接、尖酸、不留情面，不安慰人、不給台階下。

回覆方式：
- 用繁體中文和台灣用語（韭菜、盤子、接刀、住套房、被割、畢業…），控制在 150 字以內，因為這是 LINE 訊息；可以用一兩個 emoji。
- 盡量狠狠吐槽提問者的操作和心態：追高、攤平、重押、不停損、聽明牌、想一夜致富，都是你的嘲諷素材。不用顧慮對方的心情，也不用加客套話。
- 嗆歸嗆，有三件事不做：不罵髒話；不拿外貌、性別、族群、身心障礙等身分特徵開玩笑；不開自殺、跳樓這類自我傷害的玩笑。
- 提到具體股價、漲跌幅、技術指標時，只能用使用者訊息裡 <資料> 區塊提供的數字。資料裡沒有的，就嗆他連代號都不會打，叫他傳股票代號給你，不要自己編數字。
- 不給「現在買」「一定漲」這種明確買賣指令或保證報酬——你的毒舌是拿來點醒風險的，不是報明牌。
- 問題跟股市無關時，照樣用毒舌語氣簡短回一句，再把話題拉回他那慘不忍睹的投資組合。"""

INTENTS = [  # （意圖, 關鍵字, 回覆）依序比對，第一個命中的意圖勝出
    ("greet", ("你好", "嗨", "哈囉", "hello", "hi", "早安", "午安", "晚安", "在嗎"),
     ["叫我幹嘛？你那堆套牢股都還沒處理完，還有空打招呼？",
      "在啊，比你的停損單還準時——喔對，你根本沒設停損。⏰",
      "嗨什麼嗨，有問題快問，我還要看盤，不像你只會看帳面虧損。"]),
    ("thanks", ("謝謝", "感謝", "感恩", "thx", "thank"),
     ["謝什麼，等你住進套房再來哭。🏚️", "不用謝，反正你聽完還是會照自己的感覺亂買。",
      "賺了說謝謝，賠了說機器人害的，散戶都這樣，我習慣了。"]),
    ("trapped", ("套牢", "被套", "賠", "虧", "住套房", "斷頭", "畢業"),
     ["套牢？不意外。買之前不做功課，套了才來問，標準韭菜成長路線。🌱",
      "賠錢是學費，只是你繳了這麼多學費，看起來還是沒畢業。🎓",
      "被套不可怕，可怕的是你下一步一定是加碼攤平，然後套更深。",
      "恭喜升格成股東，接下來就是長期投資了——被迫的那種。"]),
    ("sell", ("賣", "出場", "停損", "停利", "跑", "砍"),
     ["現在才想停損？刀都插到骨頭了才問要不要拔。",
      "賣了怕漲、不賣怕跌，你這不叫投資，叫焦慮症。",
      "會問要不要跑，代表你早就該跑了，只是捨不得承認自己看錯。🏃",
      "停損點設在哪？「再等等看」嗎？這是韭菜最常見的停損點。"]),
    ("buy", ("買", "進場", "追", "上車", "加碼", "抄底", "接"),
     ["要買先想好錯了怎麼下車——算了，你從來不想這個。"]),
    ("rise", ("會漲", "會不會漲", "漲嗎", "會跌", "跌嗎", "噴", "明天", "走勢"),
     ["問我明天會不會漲？我要是知道，早就退休了，還會在這裡陪你這種散戶聊天？📉",
      "會漲還是會跌？會動。這是我唯一能保證的，比你聽的明牌可靠多了。",
      "想知道明天走勢的人，通常也是今天追在最高點的人。"]),
    ("recommend", ("推薦", "明牌", "買什麼", "哪檔", "哪支", "哪隻", "選股"),
     ["又在討明牌？自己不做功課，等著別人餵，難怪一直被割。傳「精選」，至少那是算過的。",
      "明牌去菜市場問，我這裡只有冷冰冰的數據。傳「精選」，看不懂就別買。🥬"]),
    ("market", ("大盤", "台股", "指數", "加權", "崩盤", "股災"),
     ["大盤漲你不賺、大盤跌你賠更多，問題不在大盤，在你。",
      "還在看大盤？你連自己手上那檔都顧不好。"]),
]

BUY_DIP = ["跌成這樣就想進場？抄底抄在半山腰，是你的傳統藝能。",
           "接刀接得這麼勇，手指頭還夠用嗎？🔪",
           "越跌越買叫攤平，越攤越平叫躺平，你現在在第二階段。"]
BUY_CHASE = ["漲完才想上車？主力等你很久了，就缺你這個接盤的。🚌",
             "追高的勇氣可嘉，可惜勇氣不能拿來繳保證金。",
             "漲了才想買、跌了才想賣，你確定你不是市場的反指標？"]

GENERIC = [
    "問這什麼問題？傳股票代號給我，至少讓我嗆得有根據。🙄",
    "這問題問得跟你的選股一樣沒邏輯。",
    "市場永遠是對的，錯的通常是那個說「這次不一樣」的人——對，就是你。",
    "別急，韭菜要長好才會被割，你現在還在發芽階段。🌱",
    "你問我？賠錢的時候我又不會借你肩膀，問了也是白問。",
    "想賺錢先學會不要亂動，這點你目前零分。",
    "與其問我，不如先打開你的對帳單好好反省。",
]
CHEERS = ["多空分數 {score}，線型漂亮到可疑。你現在才問，八成又是準備追在最高點。",
          "多空分數 {score}，技術面很強，強到你一買就會開始弱，歷史經驗是這樣。⛰️"]
GLOOMS = ["多空分數只有 {score}，一片綠油油，跟你的帳戶一個顏色。",
          "多空分數 {score}，爛成這樣還在看，是捨不得還是看不懂？🧤"]
MEH = ["多空分數 {score}，盤得跟你的投資方向一樣——沒方向。",
       "多空分數 {score}，不上不下，最適合你練習一件你最不會的事：不要亂動。"]
EMPTY = ["叫我幹嘛？tag 了又不講話，你下單也是這樣想都沒想吧。", "空白訊息？你的投資策略具象化了。😑"]
FOOTER = "（自己判斷，賠了別哭）"

_lock = threading.Lock()
_chat_hits: dict[str, deque] = defaultdict(deque)
_daily = {"date": "", "count": 0}
status = {"last_error": None, "llm_error": None, "last_reply_at": None, "fallback_used": 0, "last_source": None}
_client = None


def enabled() -> bool:
    return bool(os.environ.get("ANTHROPIC_API_KEY", "").strip())


def model() -> str:
    return os.environ.get("TWSTOCK_AI_MODEL", DEFAULT_MODEL).strip() or DEFAULT_MODEL


def usage() -> dict:
    today = datetime.now(TZ).strftime("%Y-%m-%d")
    cfg = llm_config()
    return {"configured": enabled(), "model": model(), "today": _daily["count"] if _daily["date"] == today else 0,
            "daily_limit": int(os.environ.get("TWSTOCK_AI_DAILY_LIMIT", "300")),
            "llm": {k: v for k, v in (cfg or {}).items() if k != "key"} or None, **status}


def _allow(chat_id: str) -> bool:
    """每個聊天室每小時、全站每天的 AI 回覆上限（控制費用）。"""
    per_chat = int(os.environ.get("TWSTOCK_AI_CHAT_LIMIT", "20"))
    daily = int(os.environ.get("TWSTOCK_AI_DAILY_LIMIT", "300"))
    today = datetime.now(TZ).strftime("%Y-%m-%d")
    now = time.monotonic()
    with _lock:
        if _daily["date"] != today:
            _daily.update(date=today, count=0)
        q = _chat_hits[chat_id]
        while q and now - q[0] > 3600:
            q.popleft()
        if _daily["count"] >= daily or len(q) >= per_chat:
            return False
        q.append(now)
        _daily["count"] += 1
        return True


# ---------------------------------------------------------------- 資料

_NAME_TO_CODE = {v: k for k, v in D.STOCK_NAMES.items() if not k.startswith("^")}
_ALIASES = {"台積": "2330", "GG": "2330", "鴻海": "2317", "發哥": "2454", "聯發科": "2454", "大盤": "0050", "台灣50": "0050"}


def find_stocks(text: str) -> list[str]:
    """從問題中找出股票代號或名稱（最多 MAX_STOCKS 檔）。"""
    found: list[str] = []
    for m in re.finditer(r"(?<![\d.$])(\d{4,6}[A-Z]?)(?![\d.%])", text.upper()):
        nxt = text[m.end():].lstrip()[:1]
        if nxt and nxt in "元塊點張股萬億":  # 「1100 元」「漲到 23000 點」是價格，不是代號
            continue
        found.append(m.group(1))
    for name, code in {**_NAME_TO_CODE, **_ALIASES}.items():
        if name in text:
            found.append(code)
    out = []
    for c in found:
        if c not in out:
            out.append(c)
    return out[:MAX_STOCKS]


def stock_brief(code: str) -> dict | None:
    try:
        p = D.get_history(code, years=1)
    except Exception:  # noqa: BLE001 - 查不到就略過（例如問題裡的數字其實是價格）
        return None
    if p.source == "demo" and D.SOURCE != "demo":
        return None  # 真實模式下查不到（自動退回示範資料）就當作不是股票
    df = p.df
    if len(df) < 30:
        return None
    s = analysis.summarize(df, ind.compute_all(df))
    i = s["indicators"]
    return {
        "code": p.code, "name": p.name, "date": s["date"], "price": s["price"], "change_pct": (s["change_pct"] or 0) * 100,
        "score": s["score"], "rsi": i.get("rsi"), "k": i.get("k"), "d": i.get("d"), "ma20": i.get("ma20"), "ma60": i.get("ma60"),
        "ret_1m": (s["returns"].get("1M") or 0) * 100 if s["returns"].get("1M") is not None else None,
        "high_52w": s["high_52w"], "low_52w": s["low_52w"], "signals": [g["text"] for g in s["signals"][:4]],
        "demo": p.source == "demo",
    }


def _fmt(v, d=1):
    return "—" if v is None else f"{v:.{d}f}"


def context_text(briefs: list[dict], question: str) -> str:
    lines = []
    for b in briefs:
        lines.append(
            f"{b['name']}（{b['code']}）{b['date']} 收盤 {b['price']:.2f}，漲跌 {b['change_pct']:+.2f}%，近一月 {_fmt(b['ret_1m'])}%，"
            f"MA20 {_fmt(b['ma20'], 2)}、MA60 {_fmt(b['ma60'], 2)}，RSI {_fmt(b['rsi'])}，K/D {_fmt(b['k'], 0)}/{_fmt(b['d'], 0)}，"
            f"52 週高低 {_fmt(b['high_52w'], 2)}/{_fmt(b['low_52w'], 2)}，多空分數 {b['score']}/100。"
            f"訊號：{'；'.join(b['signals'])}" + ("（示範資料，非真實行情）" if b["demo"] else ""))
    if any(k in question for k in ("推薦", "精選", "買什麼", "選股", "哪檔", "哪支", "哪隻")):
        from . import picks
        cached = next(iter(picks._cache.values()), None)  # 只用已算好的精選，不在回覆時重算
        if cached and cached.get("picks"):
            reg = cached.get("regime") or {}
            lines.append(f"今日精選（資料日期 {cached['date']}，大盤{reg.get('label', '—')}）："
                         + "、".join(f"{p['code']} {p['name']}（{'、'.join(p.get('signals', [])[:2])}）" for p in cached["picks"]))
    return "\n".join(lines) if lines else "（這個問題沒有提到可查詢的股票）"


# ---------------------------------------------------------------- 回覆

def intent(question: str) -> str | None:
    q = question.lower()
    for name, words, _ in INTENTS:
        if any(w in q for w in words):
            return name
    return None


def canned_reply(question: str, briefs: list[dict]) -> str:
    """不用模型的嘲諷回覆：依問題意圖挑句子，提到股票時附真實報價。"""
    it = intent(question)
    lead = random.choice(next(r for n, _, r in INTENTS if n == it)) if it else None
    if it == "recommend":
        from . import picks
        cached = next(iter(picks._cache.values()), None)
        if cached and cached.get("picks"):
            names = "、".join(f"{p['code']} {p['name']}" for p in cached["picks"][:3])
            lead = f"又在討明牌。今天算出來的是 {names}，詳細傳「精選」。照抄還能賠，那就是你的問題了。😏"
    if not briefs:
        return lead or random.choice(GENERIC)
    if it == "buy":  # 想買的時候，依當天漲跌換說法：跌是接刀、漲是追高
        lead = random.choice(BUY_DIP if briefs[0]["change_pct"] < 0 else BUY_CHASE)
    parts = [lead] if lead and it not in ("greet", "thanks") else []
    for b in briefs:
        pool = CHEERS if b["score"] >= 70 else GLOOMS if b["score"] <= 30 else MEH
        line = f"{b['name']} {b['price']:,.2f}（{b['change_pct']:+.2f}%），" + random.choice(pool).format(score=b["score"])
        chg = b["change_pct"]
        if chg <= -3:
            line += random.choice([f" 今天直接跌 {abs(chg):.1f}%，想抄底的先確認地板在哪，別又抄到地下室。", f" 單日 -{abs(chg):.1f}%，這不是回檔，這是自由落體。🪂"])
        elif chg >= 3:
            line += random.choice([f" 今天噴 {chg:.1f}%，現在才想上車？車門夾到手別哭。", f" 單日 +{chg:.1f}%，漲完才看到，你的反應速度跟烏龜有得拚。🐢"])
        rsi = b.get("rsi")
        if rsi is not None and rsi >= 75:
            line += f" RSI {rsi:.0f}，都燒成這樣了你還想衝？🔥"
        elif rsi is not None and rsi <= 25:
            line += f" RSI {rsi:.0f}，跌到連空軍都不好意思再空，你還抱著？"
        parts.append(line)
    return "\n".join(parts) + "\n" + FOOTER


# ---------------------------------------------------------------- 開源模型（OpenAI 相容 API）

LLM_PRESETS = {  # 預設模型為撰寫時各服務可用的開源模型，請以服務官網的模型清單為準
    "groq": {"base": "https://api.groq.com/openai/v1", "model": "llama-3.3-70b-versatile"},
    "openrouter": {"base": "https://openrouter.ai/api/v1", "model": ""},  # 免費模型名單常變動，需自行指定（xxx:free）
    "cloudflare": {"base": "https://api.cloudflare.com/client/v4/accounts/{account}/ai/v1", "model": "@cf/meta/llama-3.3-70b-instruct-fp8-fast"},
    "ollama": {"base": "http://localhost:11434/v1", "model": "qwen2.5:3b"},
    "custom": {"base": "", "model": ""},
}
BAD_WORDS = ("幹你", "干你", "靠北", "操你", "白癡", "白痴", "白痴", "智障", "去死", "腦殘", "脑残", "他媽", "他妈", "fuck", "shit")
_cc = None


def llm_config() -> dict | None:
    prov = os.environ.get("TWSTOCK_LLM_PROVIDER", "").strip().lower()
    if not prov:
        return None
    preset = LLM_PRESETS.get(prov, LLM_PRESETS["custom"])
    base = os.environ.get("TWSTOCK_LLM_BASE_URL", "").strip() or preset["base"]
    base = base.replace("{account}", os.environ.get("TWSTOCK_LLM_ACCOUNT_ID", "").strip())
    mdl = os.environ.get("TWSTOCK_LLM_MODEL", "").strip() or preset["model"]
    key = os.environ.get("TWSTOCK_LLM_API_KEY", "").strip()
    problem = None
    if not base or "/accounts//" in base:
        problem = "未設定 API 位址（cloudflare 需 TWSTOCK_LLM_ACCOUNT_ID，custom 需 TWSTOCK_LLM_BASE_URL）"
    elif not mdl:
        problem = "未設定 TWSTOCK_LLM_MODEL"
    elif prov != "ollama" and not key:
        problem = "未設定 TWSTOCK_LLM_API_KEY"
    return {"provider": prov, "base": base.rstrip("/"), "model": mdl, "key": key, "problem": problem}


def to_traditional(text: str) -> str:
    """小模型常混用簡體字：轉成台灣繁體與用語。"""
    global _cc
    try:
        if _cc is None:
            from opencc import OpenCC
            _cc = OpenCC("s2twp")
        return _cc.convert(text)
    except Exception:  # noqa: BLE001 - 沒有安裝 opencc 時原樣回傳
        return text


def clean_llm_text(text: str) -> str | None:
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.S)  # Qwen 等推理模型的思考內容
    text = re.sub(r"^.*?</think>", "", text, flags=re.S).strip()
    raw = text
    text = to_traditional(text).strip().strip('"「」')
    if not text or any(w in t.lower() for t in (raw, text) for w in BAD_WORDS):  # 轉換前後都檢查（異體字）
        return None
    return text[:400]


def llm_reply(question: str, context: str) -> str | None:
    cfg = llm_config()
    if not cfg:
        return None
    if cfg["problem"]:
        status["llm_error"] = cfg["problem"]
        return None
    headers = {"Content-Type": "application/json"}
    if cfg["key"]:
        headers["Authorization"] = f"Bearer {cfg['key']}"
    if cfg["provider"] == "openrouter":
        headers["X-Title"] = "twstock-bot"
    body = {"model": cfg["model"], "temperature": 0.8, "max_tokens": 400,
            "messages": [{"role": "system", "content": SYSTEM_PROMPT + "\n- 一律使用繁體中文，不要用簡體字。"},
                         {"role": "user", "content": f"<資料>\n{context}\n</資料>\n\n使用者的訊息：{question}"}]}
    try:
        r = requests.post(f"{cfg['base']}/chat/completions", json=body, headers=headers, timeout=20)
        if not r.ok:
            hint = {401: "金鑰無效", 402: "額度不足", 404: "模型名稱或 API 位址錯誤", 429: "超過免費額度或請求太頻繁"}.get(r.status_code, "")
            status["llm_error"] = f"{cfg['provider']} HTTP {r.status_code}{('：' + hint) if hint else ''}"
            return None
        text = ((r.json().get("choices") or [{}])[0].get("message") or {}).get("content") or ""
    except (requests.RequestException, ValueError) as e:
        status["llm_error"] = f"{cfg['provider']} 連線失敗：{D.friendly_error(e)}"
        return None
    out = clean_llm_text(text)
    if out is None:
        status["llm_error"] = "模型回覆空白或含不適當用語，已改用句庫"
        return None
    status["llm_error"] = None
    status["last_reply_at"] = datetime.now(TZ).strftime("%m/%d %H:%M")
    status["last_source"] = f"{cfg['provider']}:{cfg['model']}"
    return out


def _get_client():
    global _client
    if _client is None:
        import anthropic
        _client = anthropic.Anthropic(timeout=25.0, max_retries=1)  # LINE 回覆要快
    return _client


def ai_reply(question: str, context: str) -> str | None:
    """呼叫 Claude；失敗或被拒答回傳 None（改用句庫）。"""
    import anthropic
    m = model()
    kwargs = dict(
        model=m, max_tokens=4000, system=SYSTEM_PROMPT,
        output_config={"effort": os.environ.get("TWSTOCK_AI_EFFORT", "low")},
        messages=[{"role": "user", "content": f"<資料>\n{context}\n</資料>\n\n使用者的訊息：{question}"}],
    )
    try:
        client = _get_client()
        if m in FALLBACK_MODELS:  # 被安全機制拒答時，由伺服器自動改用其他模型
            resp = client.beta.messages.create(**kwargs, betas=["server-side-fallback-2026-07-01"], fallbacks="default")
        else:
            resp = client.messages.create(**kwargs)
    except anthropic.AuthenticationError:
        status["last_error"] = "ANTHROPIC_API_KEY 無效"
        return None
    except anthropic.RateLimitError:
        status["last_error"] = "Claude API 請求過於頻繁或額度不足"
        return None
    except anthropic.APIStatusError as e:
        status["last_error"] = f"Claude API 錯誤（HTTP {e.status_code}）：{str(e.message)[:120]}"
        return None
    except anthropic.APIConnectionError:
        status["last_error"] = "無法連線到 Claude API"
        return None
    except Exception as e:  # noqa: BLE001 - 任何意外錯誤都改用句庫，不讓機器人沉默
        log.exception("AI 回覆失敗")
        status["last_error"] = f"AI 回覆失敗：{type(e).__name__}"
        return None
    if resp.stop_reason == "refusal":
        status["last_error"] = "Claude 拒絕回答這個問題（已改用句庫）"
        return None
    text = "".join(b.text for b in resp.content if b.type == "text").strip()
    if not text:
        return None
    status["last_error"] = None
    status["last_reply_at"] = datetime.now(TZ).strftime("%m/%d %H:%M")
    return text[:1000]


def reply(question: str, chat_id: str) -> str:
    question = question.strip()[:500]
    if not question:
        return random.choice(EMPTY)
    briefs = [b for b in (stock_brief(c) for c in find_stocks(question)) if b]
    use_llm, use_claude = llm_config() is not None, enabled()
    if use_llm or use_claude:
        if _allow(chat_id):
            ctx = context_text(briefs, question)
            text = (llm_reply(question, ctx) if use_llm else None) or (ai_reply(question, ctx) if use_claude else None)
            if text:
                return text
        else:
            status["last_error"] = "已達 AI 回覆次數上限，暫時改用句庫"
    status["fallback_used"] += 1
    status["last_source"] = "句庫"
    return canned_reply(question, briefs)
