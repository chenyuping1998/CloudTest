"""LINE 官方帳號機器人（Messaging API）：警示推播＋對話查詢。

LINE Notify 已於 2025-03-31 停止服務，因此改用 Messaging API。

環境變數：
- LINE_CHANNEL_ACCESS_TOKEN：Messaging API 的 Channel access token（長期）
- LINE_CHANNEL_SECRET：Channel secret，用來驗證 webhook 簽章（使用對話查詢功能時必填）
- LINE_TO：推播對象 userId / groupId，可用逗號分隔多個
- LINE_BROADCAST=1：改為推播給所有加機器人好友的人（每位好友都會計入每月訊息額度）

對話指令（回覆訊息不計入每月推播額度）：
- 「2330」或「查 2330」：報價與技術訊號
- 「精選」/「推薦」：今日精選 5 檔
- 「id」：回覆目前聊天室的 userId / groupId（設定 LINE_TO 用）
- 「說明」/「help」：指令列表
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import logging
import os
import re

import requests

from . import analysis
from . import data as D
from . import indicators as ind
from . import picks

log = logging.getLogger("twstock.line")
API = "https://api.line.me/v2/bot/message"
MAX_TEXT = 5000  # LINE 單則文字上限

HELP = ("📈 台股機器人指令\n"
        "• 輸入股票代號（例如 2330）：報價與技術訊號\n"
        "• 精選：今日精選 5 檔與原因\n"
        "• id：顯示這個聊天室的 ID（設定推播對象用）\n"
        "• 說明：顯示本說明\n"
        "• 在群組 @我 或私訊我隨便問，我會用老司機的方式回答（毒舌附贈）\n"
        "盤中警示觸發時會自動推播。資訊僅供參考，不構成投資建議。")


def _token() -> str:
    return os.environ.get("LINE_CHANNEL_ACCESS_TOKEN", "").strip()  # 複製時常多帶空白或換行


def enabled() -> bool:
    return bool(_token()) and (bool(os.environ.get("LINE_TO")) or os.environ.get("LINE_BROADCAST") == "1")


last_error: str | None = None

_HINTS = {
    400: "請求內容錯誤（常見原因：LINE_TO 的 ID 錯誤、機器人不在該群組，或對方尚未加機器人好友）",
    401: "Channel access token 無效（請確認 LINE_CHANNEL_ACCESS_TOKEN 是 Messaging API 分頁中 Issue 的長期 token）",
    403: "沒有權限使用此 API",
    429: "超過每月免費訊息額度或請求太頻繁",
}


def _post(path: str, payload: dict) -> bool:
    global last_error
    try:
        r = requests.post(f"{API}/{path}", json=payload, timeout=10,
                          headers={"Authorization": f"Bearer {_token()}"})
        if not r.ok:
            try:
                detail = r.json().get("message", "")
            except ValueError:
                detail = r.text[:200]
            last_error = f"LINE {path} 失敗（HTTP {r.status_code}）：{_HINTS.get(r.status_code, '')} {detail}".strip()
            log.warning(last_error)
        else:
            last_error = None
        return r.ok
    except requests.RequestException as e:
        last_error = f"LINE {path} 連線失敗：{D.friendly_error(e)}"
        log.warning(last_error)
        return False


def status() -> dict:
    return {
        "access_token": bool(_token()), "channel_secret": bool(os.environ.get("LINE_CHANNEL_SECRET", "").strip()),
        "to": [t.strip()[:6] + "…" for t in os.environ.get("LINE_TO", "").split(",") if t.strip()],
        "broadcast": os.environ.get("LINE_BROADCAST") == "1", "enabled": enabled(), "last_error": last_error,
    }


def _messages(text: str) -> list[dict]:
    return [{"type": "text", "text": text[:MAX_TEXT]}]


def push(text: str) -> bool:
    """推播給 LINE_TO（或廣播給所有好友）。未設定時回傳 False。"""
    global last_error
    if not enabled():
        last_error = ("未設定 LINE_CHANNEL_ACCESS_TOKEN" if not _token()
                      else "未設定推播對象：請設定 LINE_TO（userId / groupId）或 LINE_BROADCAST=1")
        return False
    if os.environ.get("LINE_BROADCAST") == "1":
        return _post("broadcast", {"messages": _messages(text)})
    targets = [t.strip() for t in os.environ.get("LINE_TO", "").split(",") if t.strip()]
    if len(targets) == 1:
        return _post("push", {"to": targets[0], "messages": _messages(text)})
    ok = True
    for i in range(0, len(targets), 500):  # multicast 一次最多 500 人；群組 ID 只能用 push
        users = [t for t in targets[i:i + 500] if t.startswith("U")]
        if users:
            ok &= _post("multicast", {"to": users, "messages": _messages(text)})
    for t in targets:
        if not t.startswith("U"):
            ok &= _post("push", {"to": t, "messages": _messages(text)})
    return ok


def reply(reply_token: str, text: str) -> bool:
    return _post("reply", {"replyToken": reply_token, "messages": _messages(text)})


def verify_signature(body: bytes, signature: str) -> bool:
    secret = os.environ.get("LINE_CHANNEL_SECRET", "").strip()
    if not secret:
        log.warning("LINE webhook 驗證失敗：伺服器未設定環境變數 LINE_CHANNEL_SECRET")
        return False
    if not signature:
        log.warning("LINE webhook 驗證失敗：請求沒有 X-Line-Signature（不是 LINE 送來的請求）")
        return False
    digest = hmac.new(secret.encode(), body, hashlib.sha256).digest()
    if not hmac.compare_digest(base64.b64encode(digest).decode(), signature.strip()):
        log.warning("LINE webhook 驗證失敗：簽章不符，請確認 LINE_CHANNEL_SECRET 是此 Channel 的 Channel secret"
                    "（Basic settings 頁面），不是 Channel access token")
        return False
    return True


# ---------------------------------------------------------------- 對話

def quote_text(code: str) -> str:
    p = D.get_history(code, years=1)
    df = p.df
    s = analysis.summarize(df, ind.compute_all(df))
    arrow = "🔺" if s["change"] > 0 else "🔻" if s["change"] < 0 else "➖"
    i = s["indicators"]
    fmt = lambda v, d=1: "—" if v is None else f"{v:.{d}f}"  # noqa: E731
    sig = "\n".join(f"{'🔴' if g['type'] == 'bull' else '🟢' if g['type'] == 'bear' else '⚪'} {g['text']}"
                    for g in s["signals"][:6])
    lines = [
        f"{p.name} {p.code}（{s['date']}）",
        f"{arrow} {s['price']:.2f}　{s['change']:+.2f}（{(s['change_pct'] or 0) * 100:+.2f}%）",
        f"成交量 {s['volume'] / 1000:,.0f} 張",
        f"MA20 {fmt(i.get('ma20'), 2)}｜MA60 {fmt(i.get('ma60'), 2)}",
        f"RSI {fmt(i.get('rsi'))}｜K {fmt(i.get('k'))} / D {fmt(i.get('d'))}",
        f"多空分數 {s['score']}/100",
        "",
        sig,
    ]
    if p.source == "demo":
        lines.append("\n⚠ 示範資料，非真實行情")
    return "\n".join(lines)


CODE_RE = re.compile(r"^(?:查詢?|q)?\s*([0-9]{4,6}[A-Za-z]?)$", re.IGNORECASE)


def handle_text(text: str, source: dict) -> str | None:
    t = text.strip()
    low = t.lower()
    if low in ("id", "myid", "我的id"):
        kind = source.get("type", "user")
        sid = source.get(f"{kind}Id") or source.get("userId", "")
        label = {"user": "使用者", "group": "群組", "room": "聊天室"}.get(kind, kind)
        return f"這個{label}的 ID：\n{sid}\n\n把它填到環境變數 LINE_TO 即可接收警示推播。"
    if low in ("help", "說明", "?", "？", "指令"):
        return HELP
    if t in ("精選", "推薦", "今日精選", "選股"):
        try:
            return picks.format_message(picks.compute(use_demo=D.SOURCE == "demo"))
        except Exception as e:  # noqa: BLE001
            return f"今日精選計算失敗：{e}"
    m = CODE_RE.match(t)
    if m:
        try:
            return quote_text(m.group(1))
        except Exception as e:  # noqa: BLE001
            return f"查詢 {m.group(1)} 失敗：{e}"
    return None  # 其他訊息不回覆（避免在群組中洗版）


_bot_user_id: str | None = None


def bot_user_id() -> str | None:
    """機器人自己的 userId（判斷是否被 tag 的備援方法）。"""
    global _bot_user_id
    if _bot_user_id is None and _token():
        try:
            r = requests.get("https://api.line.me/v2/bot/info", headers={"Authorization": f"Bearer {_token()}"}, timeout=10)
            if r.ok:
                _bot_user_id = r.json().get("userId") or ""
        except requests.RequestException:
            pass
    return _bot_user_id or None


def mentioned_self(msg: dict) -> bool:
    mentionees = ((msg.get("mention") or {}).get("mentionees")) or []
    if any(m.get("isSelf") for m in mentionees):
        return True
    me = bot_user_id() if mentionees else None
    return bool(me) and any(m.get("userId") == me for m in mentionees)


def strip_mentions(msg: dict) -> str:
    """移除訊息中 @機器人 的文字，只留下真正的問題。"""
    text = msg.get("text", "")
    spans = sorted(((m.get("index", 0), m.get("length", 0)) for m in ((msg.get("mention") or {}).get("mentionees") or [])
                    if m.get("isSelf") or m.get("type") == "user"), reverse=True)
    for idx, length in spans:
        text = text[:idx] + text[idx + length:]
    return text.strip()


def handle_events(payload: dict) -> None:
    for ev in payload.get("events", []):
        if ev.get("type") == "follow" and ev.get("replyToken"):
            reply(ev["replyToken"], "感謝加入！\n" + HELP)
            continue
        if ev.get("type") == "join" and ev.get("replyToken"):  # 被邀請進群組 / 多人聊天室
            src = ev.get("source") or {}
            kind = src.get("type", "group")
            gid = src.get(f"{kind}Id", "")
            reply(ev["replyToken"], f"大家好！這個群組的 ID：\n{gid}\n\n把它填到環境變數 LINE_TO，盤中警示與每日精選就會推播到這裡。\n\n" + HELP)
            continue
        msg = ev.get("message") or {}
        if ev.get("type") != "message" or msg.get("type") != "text" or not ev.get("replyToken"):
            continue
        source = ev.get("source") or {}
        is_direct = source.get("type", "user") == "user"
        tagged = mentioned_self(msg)
        text = strip_mentions(msg) if tagged else msg.get("text", "")
        answer = handle_text(text, source)  # 指令（代號、精選、id、說明）照常回覆
        if answer is None and (is_direct or tagged):  # 私訊或在群組被 tag：對話回覆
            from . import chatbot
            chat_id = source.get("groupId") or source.get("roomId") or source.get("userId") or "unknown"
            answer = chatbot.reply(text, chat_id)
        if answer:
            reply(ev["replyToken"], answer)
