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
- TWSTOCK_LLM_MODEL：模型名稱，可用逗號列多個（前一個下架或失敗時依序改用下一個；各服務有預設值）
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

SYSTEM_PROMPT = """你是 LINE 群組裡的台股機器人「股市老司機」。看盤多年，講話直接、機智，帶點冷幽默和嘴砲，但不刻薄。

回覆原則：
- 先回答對方真正問的事。問股票就用數據講重點；閒聊或嗆你，就簡短機智地回一句，不用硬扯回股市。
- 不要預設對方的狀況：不要假設他有持股、做多、被套、賠錢或追高。只有他自己提到（例如「我被套了」「想追」）才針對那件事調侃。
- 幽默是點到為止的調侃，不是罵人：不羞辱提問者，不罵髒話，不拿外貌、性別、族群、身心障礙開玩笑，不開自我傷害的玩笑。
- 簡短：1～3 句、80 字以內，不要長篇說教，不要重複對方的問題，不要結尾喊口號。
- 數字只能用使用者訊息 <資料> 區塊裡的；資料沒有的就說不知道。只有 <資料> 寫著「沒有提到可查詢的股票」而他又在問個股時，才請他給代號。
- 不給「現在買 / 一定漲」這種明確買賣指令或保證；可以用一句話點出風險。
- 用繁體中文和台灣用語，最多一個 emoji。

示範（只示範語氣和長度，數字以實際資料為準）：
使用者：你今年賺多少那麼跩
老司機：我是機器人，沒薪水也沒帳戶，所以一毛都沒賠——光這點就贏不少人了。😎
使用者：分析台積電（資料：收 1050，+1.2%，站上月線季線，RSI 68）
老司機：台積電 1050，站上月線季線，RSI 68 偏熱但還沒過頭。趨勢在多方，只是現在進場的成本，比上週的人貴不少。
使用者：我被套在 300 了怎麼辦
老司機：先別急著攤平，想清楚當初買的理由還在不在。理由沒了，價格再便宜也只是比較便宜的錯誤。
使用者：今天晚餐吃什麼
老司機：看你今天的損益決定——賺了吃牛排，賠了吃泡麵，沒進場就吃自助餐。🍜"""

INTENTS = [  # （意圖, 關鍵字, 回覆）依序比對，第一個命中的意圖勝出
    ("greet", ("你好", "嗨", "哈囉", "hello", "hi", "早安", "午安", "晚安", "在嗎"),
     ["在，盯盤中。要問哪檔？", "嗨，今天想看哪一檔？", "在啊，比收盤鐘還準時。⏰"]),
    ("thanks", ("謝謝", "感謝", "感恩", "thx", "thank"),
     ["不客氣，賺了記得請客。", "小事，賺錢是你的本事，賠錢是市場的問題。😎", "不用謝，免費的，責任也是免費的。"]),
    ("trapped", ("套牢", "被套", "賠", "虧", "住套房", "斷頭", "畢業"),
     ["先別急著攤平，想清楚當初買的理由還在不在。理由沒了，便宜也只是比較便宜的錯誤。",
      "套牢的第一步是停止加碼，第二步是想好最多能忍到哪裡。",
      "賠錢是學費，重點是這堂課學到了什麼，不要每學期都重修。"]),
    ("sell", ("賣", "出場", "停損", "停利", "跑", "砍"),
     ["該不該賣，看你當初設的條件；沒設的話，現在設也不遲。",
      "賣了怕漲、不賣怕跌，這題市場沒有標準答案，只有你的停損點有。",
      "想清楚是看錯了才賣，還是只是嚇到了才賣，兩種結局不一樣。"]),
    ("target", ("目標價", "目標", "會到", "漲到", "跌到", "支撐", "壓力", "價位", "合理價", "多少錢", "撐得住"),
     ["目標價我不報，報了也只是猜。給你技術面價位，拿去設停損停利比較實用：",
      "與其問會不會到，不如先看上下的關卡在哪：🎯"]),
    ("fundamental", ("本益比", "殖利率", "eps", "營收", "財報", "基本面", "配息", "股利", "淨值"),
     ["看基本面，好習慣。", "先看數字再說故事，這樣問就對了。"]),
    ("buy", ("買", "進場", "追", "上車", "加碼", "抄底", "接"),
     ["要買可以，先想好錯了怎麼下車。"]),
    ("rise", ("會漲", "會不會漲", "漲嗎", "會跌", "跌嗎", "噴", "明天", "走勢"),
     ["明天會不會漲我不知道，知道的話我就不會在這裡當機器人了。📉",
      "會漲還是會跌？會動，這是我唯一能保證的。", "走勢我猜不準，但風險我算得出來：傳代號給我看看。"]),
    ("recommend", ("推薦", "明牌", "買什麼", "哪檔", "哪支", "哪隻", "選股"),
     ["明牌沒有，算過的有：傳「精選」看今天的名單。", "要明牌去菜市場，要有根據的傳「精選」。🥬"]),
    ("market", ("大盤", "台股", "指數", "加權", "崩盤", "股災"),
     ["大盤的事傳「0050」給我，我用數據講。", "大盤短期誰都猜不準，長期大家都說會漲，中間就是考驗心臟。"]),
    ("analyze", ("分析", "怎麼看", "看法", "技術面", "健檢", "如何", "怎樣", "怎麼樣", "評價", "解讀", "診斷"),
     ["幫你看一下：", "重點整理給你：🔍", "數據說話："]),
]

BUY_DIP = ["跌成這樣想進場，記得分批，別一次把子彈打光。", "想接跌下來的刀，先確認自己有手套。🧤", "便宜可以更便宜，抄底記得留後路。"]
BUY_CHASE = ["漲了一段才想上車，記得先想好下車的位置。🚌", "追高不是不行，只是停損要設得比勇氣還清楚。", "車還在跑，只是票價比剛剛貴了。"]

GENERIC = [
    "這題超出我的守備範圍，股票的事我比較在行，傳個代號來。",
    "我只是個看盤機器人，這題就交給人類了。🤖",
    "問得好，可惜我只懂 K 線跟財報。",
    "市場永遠是對的，錯的通常是說「這次不一樣」的人。",
    "傳「說明」給我，看看我會什麼。",
]
CHEERS = ["多空分數 {score}，技術面偏強，只是強勢股也有回檔的時候。", "多空分數 {score}，線型漂亮，現在的問題不是好不好，是貴不貴。"]
GLOOMS = ["多空分數 {score}，技術面偏弱，還沒看到止跌訊號。", "多空分數 {score}，空方占優，想接的話耐心比資金重要。"]
MEH = ["多空分數 {score}，多空拉鋸，方向還不明確。", "多空分數 {score}，不上不下，適合觀察，不適合衝動。"]
EMPTY = ["叫我幹嘛？問題呢？", "tag 了又不講話，是在測試我有沒有在線嗎？在。😑"]
FOOTER = "（僅供參考，自己判斷）"

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
        if nxt and nxt in "元塊點張股萬億買賣進出成":  # 「1100 元」「2400 買的」「23000 點」是價格，不是代號
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
    known = code in D.STOCK_NAMES or code in _ALIASES.values()
    try:
        # 不認識的數字只用 Yahoo 快速查一次：查不到就當作不是股票，不拖慢回覆、也不會跑去逐月查證交所
        p = D.get_history(code, years=1, source=None if known or D.SOURCE == "demo" else "yahoo")
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
        "ma5": i.get("ma5"), "atr": i.get("atr"), "hist": i.get("hist"),
        "hi20": float(df["high"].iloc[-20:].max()), "lo20": float(df["low"].iloc[-20:].min()),
        "ret_3m": (s["returns"].get("3M") or 0) * 100 if s["returns"].get("3M") is not None else None,
        "bull": [g["text"] for g in s["signals"] if g["type"] == "bull"],
        "bear": [g["text"] for g in s["signals"] if g["type"] == "bear"],
        "fund": _cached_fundamentals(p.code),
    }


def _cached_fundamentals(code: str) -> dict | None:
    """只讀已載入記憶體的基本面（每天第一次選股時才會抓），不在回覆時下載。"""
    try:
        from . import fundamentals as F
        df = next(iter(F._mem.values()), None)
        if df is None or code not in df.index:
            return None
        row = df.loc[code]
        return {k: (None if (not isinstance(v, str) and v != v) else v) for k, v in row.items()}
    except Exception:  # noqa: BLE001
        return None


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
        lv = levels(b)
        lines.append(f"  趨勢：{_trend(b)}；上方壓力 {'、'.join(f'{v:,.2f}（{n}）' for v, n in lv['above']) or '無'}；"
                     f"下方支撐 {'、'.join(f'{v:,.2f}（{n}）' for v, n in lv['below']) or '無'}"
                     + (f"；近期正常波動 {lv['band'][0]:,.2f}～{lv['band'][1]:,.2f}" if lv["band"] else ""))
        f = b.get("fund") or {}
        fund_txt = "，".join(f"{n} {f[k]:.2f}" for k, n in (("pe", "本益比"), ("dividend_yield", "殖利率%"), ("rev_yoy", "月營收年增%"), ("eps", "EPS"))
                            if isinstance(f.get(k), (int, float)))
        if fund_txt:
            lines.append("  基本面：" + fund_txt)
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


_recent: dict[str, deque] = defaultdict(lambda: deque(maxlen=8))


def _pick(pool: list[str], chat_id: str | None) -> str:
    """從句庫挑一句，避開這個聊天室最近用過的。"""
    used = _recent[chat_id or "_"]
    fresh = [x for x in pool if x not in used] or pool
    choice = random.choice(fresh)
    used.append(choice)
    return choice


def _trend(b: dict) -> str:
    p, m5, m20, m60 = b["price"], b.get("ma5"), b.get("ma20"), b.get("ma60")
    if None in (m20, m60):
        return "資料不足"
    parts = [f"{'站上' if p >= m20 else '跌破'}月線（{m20:,.2f}）", f"{'站上' if p >= m60 else '跌破'}季線（{m60:,.2f}）"]
    if m5 is not None and m5 > m20 > m60:
        parts.append("均線多頭排列")
    elif m5 is not None and m5 < m20 < m60:
        parts.append("均線空頭排列")
    return "、".join(parts)


def _verdict(b: dict, chat_id: str | None) -> str:
    pool = CHEERS if b["score"] >= 70 else GLOOMS if b["score"] <= 30 else MEH
    return _pick(pool, chat_id).format(score=b["score"])


def _move_quip(b: dict, chat_id: str | None) -> str:
    chg, rsi, out = b["change_pct"], b.get("rsi"), ""
    if chg <= -3:
        out += " " + _pick([f"今天跌 {abs(chg):.1f}%，想抄底的先確認地板在哪。",
                            f"單日 -{abs(chg):.1f}%，這不是回檔，這是自由落體。🪂",
                            f"單日 -{abs(chg):.1f}%，跌幅不小，先看支撐守不守得住。"], chat_id)
    elif chg >= 3:
        out += " " + _pick([f"今天噴 {chg:.1f}%，現在才上車的要想好下車點。",
                            f"單日 +{chg:.1f}%，漲多了也要防回吐。"], chat_id)
    if rsi is not None and rsi >= 75:
        out += f" RSI {rsi:.0f} 過熱了。🔥"
    elif rsi is not None and rsi <= 25:
        out += f" RSI {rsi:.0f}，已經超賣。"
    return out


def _head(b: dict) -> str:
    return f"{b['name']}（{b['code']}）{b['date']} 收 {b['price']:,.2f}（{b['change_pct']:+.2f}%）"


def analyze_block(b: dict, chat_id: str | None = None) -> str:
    hi = b.get("high_52w")
    lines = [
        "📊 " + _head(b),
        "趨勢：" + _trend(b),
        f"指標：RSI {_fmt(b.get('rsi'), 0)}｜K/D {_fmt(b.get('k'), 0)}/{_fmt(b.get('d'), 0)}｜近一月 {_fmt(b.get('ret_1m'))}%｜近三月 {_fmt(b.get('ret_3m'))}%"
        + (f"｜距一年高點 {(b['price'] / hi - 1) * 100:+.1f}%" if hi else ""),
    ]
    if b.get("bull"):
        lines.append("偏多：" + "、".join(b["bull"][:3]))
    if b.get("bear"):
        lines.append("偏空：" + "、".join(b["bear"][:3]))
    lines.append("結論：" + _verdict(b, chat_id) + _move_quip(b, chat_id))
    return "\n".join(lines)


def levels(b: dict) -> dict:
    """技術面價位：上方壓力、下方支撐、近期波動區間（±2 倍 ATR）。"""
    p = b["price"]
    cands = [("近 20 日高點", b.get("hi20")), ("近 20 日低點", b.get("lo20")), ("月線", b.get("ma20")),
             ("季線", b.get("ma60")), ("一年高點", b.get("high_52w")), ("一年低點", b.get("low_52w"))]
    cands = [(n, v) for n, v in cands if v]
    above = sorted([(v, n) for n, v in cands if v > p * 1.002])[:2]
    below = sorted([(v, n) for n, v in cands if v < p * 0.998], reverse=True)[:2]
    atr = b.get("atr")
    band = (p - 2 * atr, p + 2 * atr) if atr else None
    return {"above": above, "below": below, "band": band}


def target_block(b: dict) -> str:
    lv = levels(b)
    fmt = lambda xs: "、".join(f"{v:,.2f}（{n}）" for v, n in xs) or "上方沒有明顯壓力（接近一年新高）"  # noqa: E731
    fmt_b = lambda xs: "、".join(f"{v:,.2f}（{n}）" for v, n in xs) or "下方沒有明顯支撐（跌破一年低點）"  # noqa: E731
    lines = ["🎯 " + _head(b), "上方壓力：" + fmt(lv["above"]), "下方支撐：" + fmt_b(lv["below"])]
    if lv["band"]:
        lines.append(f"近期正常波動：{lv['band'][0]:,.2f}～{lv['band'][1]:,.2f}（±2 倍 ATR）")
    return "\n".join(lines)


def fundamental_block(b: dict) -> str:
    f = b.get("fund")
    if not f:
        return "📑 " + _head(b) + "\n基本面資料今天還沒載入（每天第一次算精選後才有），先傳「精選」或晚點再問。"
    items = [("本益比", f.get("pe"), "{:.1f} 倍"), ("殖利率", f.get("dividend_yield"), "{:.2f}%"), ("淨值比", f.get("pb"), "{:.2f}"),
             ("月營收年增", f.get("rev_yoy"), "{:+.1f}%"), ("EPS", f.get("eps"), "{:.2f} 元"), ("ROE", f.get("roe"), "{:.1f}%"),
             ("財務體質", f.get("quality_score"), "{:.0f}/6")]
    shown = "｜".join(f"{n} {fmt.format(v)}" for n, v, fmt in items if v is not None)
    extra = f"（財報 {f['fs_period']}）" if f.get("fs_period") else ""
    return "📑 " + _head(b) + (f"［{f['industry']}］" if f.get("industry") else "") + "\n" + (shown or "查無基本面數據") + extra


def canned_reply(question: str, briefs: list[dict], chat_id: str | None = None) -> str:
    """不用模型的嘲諷回覆：依問題意圖挑句子與資料呈現方式，提到股票時附真實數據。"""
    it = intent(question)
    if it is None and briefs:
        it = "analyze"  # 只丟股票名稱 → 直接給分析
    lead = _pick(next(r for n, _, r in INTENTS if n == it), chat_id) if it else None
    if it == "recommend":
        from . import picks
        cached = next(iter(picks._cache.values()), None)
        if cached and cached.get("picks"):
            names = "、".join(f"{p['code']} {p['name']}" for p in cached["picks"][:3])
            lead = f"今天算出來的是 {names}，詳細傳「精選」。照抄之前記得自己看過。😏"
    if not briefs:
        if it in ("analyze", "target", "fundamental"):
            return _pick(["要分析哪檔？給我代號或名稱，我不會通靈。", "股票名稱呢？🙄"], chat_id)
        return lead or _pick(GENERIC, chat_id)
    if it == "buy":  # 想買的時候，依當天漲跌換說法：跌是接刀、漲是追高
        lead = _pick(BUY_DIP if briefs[0]["change_pct"] < 0 else BUY_CHASE, chat_id)
    parts = [lead] if lead and it not in ("greet", "thanks") else []
    for b in briefs[:2] if it in ("analyze", "target", "fundamental") else briefs:
        if it == "analyze":
            parts.append(analyze_block(b, chat_id))
        elif it == "target":
            parts.append(target_block(b))
        elif it == "fundamental":
            parts.append(fundamental_block(b))
        else:
            parts.append(f"{b['name']} {b['price']:,.2f}（{b['change_pct']:+.2f}%），" + _verdict(b, chat_id) + _move_quip(b, chat_id))
    return "\n\n".join(parts) + "\n" + FOOTER


# ---------------------------------------------------------------- 開源模型（OpenAI 相容 API）

LLM_PRESETS = {  # 預設模型為撰寫時各服務可用的開源模型，請以服務官網的模型清單為準
    "groq": {"base": "https://api.groq.com/openai/v1", "model": "qwen/qwen3.8-27b,openai/gpt-oss-120b"},  # 2026-11 實測可用
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


def _call_model(cfg: dict, model_name: str, question: str, context: str) -> tuple[str | None, bool]:
    """呼叫一個模型。回傳（回覆, 是否值得改用下一個模型）。"""
    headers = {"Content-Type": "application/json"}
    if cfg["key"]:
        headers["Authorization"] = f"Bearer {cfg['key']}"
    if cfg["provider"] == "openrouter":
        headers["X-Title"] = "twstock-bot"
    body = {"model": model_name, "temperature": 0.7, "max_tokens": 1200,
            "messages": [{"role": "system", "content": SYSTEM_PROMPT + "\n- 一律使用繁體中文，不要用簡體字。"},
                         {"role": "user", "content": f"<資料>\n{context}\n</資料>\n\n使用者的訊息：{question}"}]}
    if "gpt-oss" in model_name:
        body["reasoning_effort"] = "low"  # 推理模型：思考少一點，避免把 token 用光導致正文空白
    label = f"{cfg['provider']}:{model_name}"
    try:
        r = requests.post(f"{cfg['base']}/chat/completions", json=body, headers=headers, timeout=20)
        if not r.ok:
            hint = {401: "金鑰無效", 402: "額度不足", 404: "模型名稱或 API 位址錯誤", 429: "超過免費額度或請求太頻繁"}.get(r.status_code, "")
            try:
                detail = str((r.json().get("error") or {}).get("message") or "")[:200]
            except ValueError:
                detail = r.text[:200]
            status["llm_error"] = f"{label} HTTP {r.status_code}{('：' + hint) if hint else ''}{('｜' + detail) if detail else ''}"
            log.warning("開源模型回覆失敗：%s", status["llm_error"])
            return None, r.status_code in (400, 404, 413, 422, 503)  # 模型下架 / 不支援 → 換下一個
        text = ((r.json().get("choices") or [{}])[0].get("message") or {}).get("content") or ""
    except (requests.RequestException, ValueError) as e:
        status["llm_error"] = f"{label} 連線失敗：{D.friendly_error(e)}"
        log.warning("開源模型回覆失敗：%s", status["llm_error"])
        return None, False
    out = clean_llm_text(text)
    if out is None:
        status["llm_error"] = f"{label} 回覆空白或含不適當用語，已改用其他來源（原文：{text[:80]!r}）"
        log.warning("%s", status["llm_error"])
        return None, True
    status["llm_error"] = None
    status["last_reply_at"] = datetime.now(TZ).strftime("%m/%d %H:%M")
    status["last_source"] = label
    return out, False


def llm_reply(question: str, context: str) -> str | None:
    cfg = llm_config()
    if not cfg:
        return None
    if cfg["problem"]:
        status["llm_error"] = cfg["problem"]
        return None
    for name in [m.strip() for m in cfg["model"].split(",") if m.strip()][:3]:
        out, try_next = _call_model(cfg, name, question, context)
        if out or not try_next:
            return out
    return None


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
    return canned_reply(question, briefs, chat_id)
