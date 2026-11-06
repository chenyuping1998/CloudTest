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

SYSTEM_PROMPT = """你是 LINE 群組裡的台股機器人「股市老司機」，嘴巴出了名的毒。你看盤多年、看過太多散戶追高殺低，對愚蠢的操作零容忍，講話直接、尖酸、不留情面，不安慰人、不給台階下。

回覆方式：
- 用繁體中文和台灣用語（韭菜、盤子、接刀、住套房、被割、畢業…），控制在 150 字以內，因為這是 LINE 訊息；可以用一兩個 emoji。
- 盡量狠狠吐槽提問者的操作和心態：追高、攤平、重押、不停損、聽明牌、想一夜致富，都是你的嘲諷素材。不用顧慮對方的心情，也不用加客套話。
- 嗆歸嗆，有三件事不做：不罵髒話；不拿外貌、性別、族群、身心障礙等身分特徵開玩笑；不開自殺、跳樓這類自我傷害的玩笑。
- 提到具體股價、漲跌幅、技術指標、支撐壓力時，只能用使用者訊息裡 <資料> 區塊提供的數字，不要自己編數字。
- <資料> 裡已經有股票時，直接用那些數據吐槽和分析；只有當 <資料> 寫著「沒有提到可查詢的股票」而他又在問個股時，才嗆他連代號都不會打、叫他傳股票代號。
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
    ("target", ("目標價", "目標", "會到", "漲到", "跌到", "支撐", "壓力", "價位", "合理價", "多少錢", "撐得住"),
     ["目標價？券商分析師都猜不準了，你還指望一個機器人？給你技術面價位，自己拿去設停損停利：",
      "想要目標價，是想找個理由凹單吧？先看清楚上下的價位：",
      "目標價這種東西，是讓你套牢時有個盼頭用的。技術面價位給你，別再問我會不會到：🎯"]),
    ("fundamental", ("本益比", "殖利率", "eps", "營收", "財報", "基本面", "配息", "股利", "淨值"),
     ["看基本面？難得，我還以為你只會看線圖跟聽明牌。",
      "會問基本面，至少比只會問「會不會漲」的人多進化一點點。"]),
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
    ("analyze", ("分析", "怎麼看", "看法", "技術面", "健檢", "如何", "怎樣", "怎麼樣", "評價", "解讀", "診斷"),
     ["要我分析？行，免費幫你健檢，看完別哭：", "分析給你看，但我猜你看完還是會憑感覺下單：",
      "好啦，幫你把這檔扒光看清楚：🔍"]),
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
        out += " " + _pick([f"今天直接跌 {abs(chg):.1f}%，想抄底的先確認地板在哪，別又抄到地下室。",
                            f"單日 -{abs(chg):.1f}%，這不是回檔，這是自由落體。🪂",
                            f"一天蒸發 {abs(chg):.1f}%，抱著的人今晚可以不用睡了。"], chat_id)
    elif chg >= 3:
        out += " " + _pick([f"今天噴 {chg:.1f}%，現在才想上車？車門夾到手別哭。",
                            f"單日 +{chg:.1f}%，漲完才看到，你的反應速度跟烏龜有得拚。🐢"], chat_id)
    if rsi is not None and rsi >= 75:
        out += f" RSI {rsi:.0f}，都燒成這樣了你還想衝？🔥"
    elif rsi is not None and rsi <= 25:
        out += f" RSI {rsi:.0f}，跌到連空軍都不好意思再空，你還抱著？"
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
    fmt = lambda xs: "、".join(f"{v:,.2f}（{n}）" for v, n in xs) or "沒有，已經在一年新高附近，上面只有天空跟你的妄想"  # noqa: E731
    fmt_b = lambda xs: "、".join(f"{v:,.2f}（{n}）" for v, n in xs) or "沒有，已經跌破一年低點，下面是無底洞"  # noqa: E731
    lines = ["🎯 " + _head(b), "上方壓力：" + fmt(lv["above"]), "下方支撐：" + fmt_b(lv["below"])]
    if lv["band"]:
        lines.append(f"近期正常波動：{lv['band'][0]:,.2f}～{lv['band'][1]:,.2f}（±2 倍 ATR，超出才算真的出事）")
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
            lead = f"又在討明牌。今天算出來的是 {names}，詳細傳「精選」。照抄還能賠，那就是你的問題了。😏"
    if not briefs:
        if it in ("analyze", "target", "fundamental"):
            return _pick(["要分析哪檔？代號或名稱都不給，是要我通靈嗎？", "股票名稱呢？你下單也這麼隨便嗎？🙄"], chat_id)
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
    body = {"model": model_name, "temperature": 0.8, "max_tokens": 1200,
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
