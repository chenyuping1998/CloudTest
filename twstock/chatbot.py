"""LINE 機器人的對話回覆：被 tag（群組）或私訊時，用毒舌、詼諧的語氣回答使用者的問題。

- 設定 ANTHROPIC_API_KEY 時使用 Claude 回答；問題提到的股票會先查即時報價與技術訊號當作「資料」，
  模型只能引用資料中的數字，避免亂編。
- 沒有 API key、超過次數上限、API 失敗或被拒答時，改用內建的嘲諷句庫＋真實報價回覆（免費）。

環境變數：
- ANTHROPIC_API_KEY：Claude API 金鑰（選填，未設定則只用句庫）
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

from . import analysis
from . import data as D
from . import indicators as ind

log = logging.getLogger("twstock.chatbot")
TZ = ZoneInfo("Asia/Taipei")
DEFAULT_MODEL = "claude-opus-5-5"
FALLBACK_MODELS = {"claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5"}  # 支援 server-side fallback
MAX_STOCKS = 3

SYSTEM_PROMPT = """你是 LINE 群組裡的台股機器人「股市老司機」。說話風格毒舌、愛吐槽、帶點自嘲，像是看盤多年、被市場教訓過很多次的老鳥——好笑但不刻薄。

回覆方式：
- 用繁體中文和台灣用語，控制在 150 字以內，因為這是 LINE 訊息；可以用一兩個 emoji。
- 嘲諷的對象是市場、追高殺低、當韭菜的行為，或你自己。不要針對提問者的人身、外貌、性別、族群或其他身分特徵開玩笑，也不要用髒話。
- 提到具體股價、漲跌幅、技術指標時，只能用使用者訊息裡 <資料> 區塊提供的數字。資料裡沒有的，就直說你不知道，或叫他傳股票代號給你，不要自己編。
- 不要給「現在買」「一定漲」這種明確買賣指令或保證報酬；可以用調侃的方式點出風險，例如追高、重押、沒停損。
- 問題跟股市無關時，用同樣的語氣簡短回應，再順手把話題拉回股市。"""

GENERIC = [
    "問我明天會不會漲？我要是知道早就去退休了，還在這裡陪你聊天？📉",
    "大盤怎麼走我不知道，但我很好奇你的停損點設在哪裡——還是根本沒設？",
    "這問題太深奧了，建議先把手上的套牢股處理完再來問。",
    "傳個股票代號給我，至少讓我吐槽得有根據。🙄",
    "市場永遠是對的，錯的通常是那個說「這次不一樣」的人。",
    "別急，韭菜要長好才會被割，你現在還在發芽階段。🌱",
    "你問我？我只是個機器人，賠錢的時候連個肩膀都沒得借你。",
    "想知道哪檔會漲？傳「精選」給我，至少那是有算過的，不是我亂猜。",
]
CHEERS = ["多空分數 {score}，技術面漂亮到有點可疑，你現在才問，是想幫主力抬轎嗎？",
          "多空分數 {score}，線型很美，美到讓人想起上一個被套在山頂的你。⛰️"]
GLOOMS = ["多空分數只有 {score}，一片綠油油，想接刀記得先戴手套。🧤",
          "多空分數 {score}，跌得比我的耐心還快，攤平之前先想想有沒有子彈。"]
MEH = ["多空分數 {score}，盤得跟你的投資方向一樣——沒方向。",
       "多空分數 {score}，不上不下，最適合拿來練習「不要亂動」。"]

_lock = threading.Lock()
_chat_hits: dict[str, deque] = defaultdict(deque)
_daily = {"date": "", "count": 0}
status = {"last_error": None, "last_reply_at": None, "fallback_used": 0}
_client = None


def enabled() -> bool:
    return bool(os.environ.get("ANTHROPIC_API_KEY", "").strip())


def model() -> str:
    return os.environ.get("TWSTOCK_AI_MODEL", DEFAULT_MODEL).strip() or DEFAULT_MODEL


def usage() -> dict:
    today = datetime.now(TZ).strftime("%Y-%m-%d")
    return {"configured": enabled(), "model": model(), "today": _daily["count"] if _daily["date"] == today else 0,
            "daily_limit": int(os.environ.get("TWSTOCK_AI_DAILY_LIMIT", "300")), **status}


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

def canned_reply(question: str, briefs: list[dict]) -> str:
    """不用 AI 的嘲諷回覆（句庫＋真實報價）。"""
    if not briefs:
        return random.choice(GENERIC)
    parts = []
    for b in briefs:
        pool = CHEERS if b["score"] >= 70 else GLOOMS if b["score"] <= 30 else MEH
        line = f"{b['name']} {b['price']:,.2f}（{b['change_pct']:+.2f}%），" + random.choice(pool).format(score=b["score"])
        chg = b["change_pct"]
        if chg <= -3:
            line += random.choice([f" 今天直接跌 {abs(chg):.1f}%，抄底的請先確認地板在哪。", f" 單日 -{abs(chg):.1f}%，這不是回檔，這是自由落體。🪂"])
        elif chg >= 3:
            line += random.choice([f" 今天噴 {chg:.1f}%，現在才想上車的，車門快夾到手了。", f" 單日 +{chg:.1f}%，追高之前先想好下車的地方。🚗"])
        rsi = b.get("rsi")
        if rsi is not None and rsi >= 75:
            line += f" RSI {rsi:.0f} 已經燒起來了🔥"
        elif rsi is not None and rsi <= 25:
            line += f" RSI {rsi:.0f}，跌到連空軍都不好意思。"
        parts.append(line)
    return "\n".join(parts) + "\n（以上純屬吐槽，自己判斷）"


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
        return random.choice(["叫我幹嘛？要問股票就把問題打完整啊。", "tag 我又不說話，是想考驗我的耐心嗎？😑"])
    briefs = [b for b in (stock_brief(c) for c in find_stocks(question)) if b]
    if enabled():
        if _allow(chat_id):
            text = ai_reply(question, context_text(briefs, question))
            if text:
                return text
        else:
            status["last_error"] = "已達 AI 回覆次數上限，暫時改用句庫"
    status["fallback_used"] += 1
    return canned_reply(question, briefs)
