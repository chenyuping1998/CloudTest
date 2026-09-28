# 台股監控分析平台

一個自架的台股網站，功能包含：**自選股監控**、**個股技術分析**、**策略回測**、**自訂條件選股**、**走勢比較**。
後端使用 Python（FastAPI + pandas），前端為純 HTML/JS，圖表使用 TradingView Lightweight Charts（已內附，不依賴 CDN）。

> ⚠ 僅供研究學習，不構成投資建議。

## 功能

| 分頁 | 功能 |
| --- | --- |
| 自選監控 | 自選股清單（存在各訪客自己的瀏覽器）、60 日走勢縮圖、盤中即時價（證交所 MIS）、RSI / KD；盤中每 60 秒自動更新。管理員可設定伺服器警示（股價、漲跌幅、RSI、爆量、均線突破/跌破、KD / MACD 黃金/死亡交叉），支援瀏覽器桌面通知與 Telegram 推播 |
| 個股分析 | K 線（紅漲綠跌）＋ MA5/10/20/60/120/240、布林通道，成交量、KD、MACD、RSI 副圖（同步縮放、十字線數值）；技術訊號摘要與多空分數；區間報酬、52 週高低、波動率；**近 20 日三大法人買賣超** |
| 策略回測 | 內建均線交叉、RSI、MACD、KD、布林通道、通道突破、買進持有；台股手續費（可設折扣、最低 20 元）與證交稅（股票 0.3%、ETF 0.1%）、零股/整張、停損停利；隔日開盤成交避免未來函數。輸出總報酬、CAGR、MDD、夏普、Sortino、勝率、獲利因子、淨值/回撤曲線、買賣點與交易明細；**參數格點最佳化** |
| 條件選股 | 勾選任意條件組合並指定統計天數（1~60 日），依指定欄位排序取前 N 檔。條件包含：外資 / 投信 / 自營商 / 三大法人 N 日買賣超、買超天數、連續買超天數、買超佔成交量比、收盤價、漲跌幅、均量、均成交值、量比；技術面（站上月線/季線、多頭排列、KD/MACD 黃金交叉、RSI 區間、創新高）。內建常用範本，例如「投信近 10 日買超前 10」 |
| 走勢比較 | 多檔股票累積報酬比較 |

## 本機執行

```bash
pip install -r requirements.txt
uvicorn twstock.main:app --reload
# 開啟 http://localhost:8000
```

無法連網或只想看介面時可使用示範資料（隨機產生，**非真實行情**，頁面上方會顯示黃色標籤）：

```bash
TWSTOCK_SOURCE=demo uvicorn twstock.main:app
```

執行測試：`pip install -r requirements-dev.txt && pytest`

## 部署到雲端（24 小時運作，用網址隨時進入）

伺服器需要一台常駐的主機，以下兩種方式擇一。

網站**預設為公開**，任何人打開網址即可使用，不需登入：

- 個股分析、回測、選股、走勢比較：所有人都能用。
- 自選股：存在每位訪客自己的瀏覽器，彼此看不到、改不到。
- 伺服器警示（會推播到 Telegram）：只有輸入**管理員密碼**（`TWSTOCK_PASSWORD`）的人能設定。沒設密碼時，警示功能只能在本機使用。
- 每位訪客（IP）每分鐘最多 120 次 API、6 次選股 / 最佳化，避免伺服器被證交所封鎖。
- 若想改成整個網站都要登入，設定 `TWSTOCK_PRIVATE=1`（帳號 `TWSTOCK_USER`，密碼 `TWSTOCK_PASSWORD`）。

### 方式 A：Render（最簡單，全程網頁操作）

1. 到 [render.com](https://render.com) 註冊並連結 GitHub。
2. New → **Blueprint** → 選這個 repo，Render 會讀取 `render.yaml`。
3. 填入環境變數 `TWSTOCK_PASSWORD`（管理員密碼，用來設定警示），選填 `TELEGRAM_BOT_TOKEN`、`TELEGRAM_CHAT_ID`。
4. 部署完成後會得到 `https://twstock-xxxx.onrender.com` 公開網址，任何人都可以直接進入。

> Render 免費方案閒置 15 分鐘會休眠且沒有持久化磁碟，`render.yaml` 預設使用 starter 方案（約 US$7/月）以常駐運作並保存自選股與警示。之後 push 到 main 會自動重新部署。

### 方式 B：Fly.io（東京機房，延遲低）

```bash
fly launch --copy-config --no-deploy
fly volumes create twstock_data --region nrt --size 1
fly secrets set TWSTOCK_PASSWORD=管理員密碼
fly deploy
```

### 其他（VPS / 家用主機）

```bash
docker build -t twstock .
docker run -d --restart=always -p 8000:8000 -v twstock-data:/data -e TWSTOCK_PASSWORD=管理員密碼 twstock
```

### Telegram 警示推播（選用）

1. 在 Telegram 找 `@BotFather` 建立 bot 取得 token。
2. 傳一則訊息給你的 bot，再開 `https://api.telegram.org/bot<token>/getUpdates` 找到 `chat.id`。
3. 設定環境變數 `TELEGRAM_BOT_TOKEN`、`TELEGRAM_CHAT_ID`。伺服器會在盤中（09:00–13:35）每 60 秒檢查警示，同一警示每天推播一次；瀏覽器不用開著。

## 環境變數

| 變數 | 預設 | 說明 |
| --- | --- | --- |
| `TWSTOCK_PASSWORD` | （空） | 管理員密碼：設定伺服器警示用；`TWSTOCK_PRIVATE=1` 時也是整站登入密碼 |
| `TWSTOCK_PRIVATE` | `0` | `1` = 整個網站都需要登入（HTTP Basic Auth） |
| `TWSTOCK_USER` | `admin` | 整站登入帳號（僅 `TWSTOCK_PRIVATE=1` 時使用） |
| `TWSTOCK_RATE_LIMIT` | `120` | 每個 IP 每分鐘 API 次數上限（0 = 不限） |
| `TWSTOCK_HEAVY_RATE_LIMIT` | `6` | 每個 IP 每分鐘選股 / 最佳化次數上限 |
| `TWSTOCK_SOURCE` | `auto` | `auto`（Yahoo → 證交所 → 連線失敗時改用示範資料）、`yahoo`、`twse`、`demo` |
| `TWSTOCK_DATA_DIR` | `./data` | 快取、自選股、警示的存放位置 |
| `TWSTOCK_CACHE_TTL` | `1800` | 日線快取秒數 |
| `TWSTOCK_BACKGROUND_MONITOR` | `1` | 是否啟用背景警示檢查 |
| `TWSTOCK_MONITOR_INTERVAL` | `60` | 背景檢查間隔（秒） |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | | Telegram 推播 |

## 資料來源與限制

- **日線**：Yahoo Finance（`2330.TW` / 上櫃 `.TWO`），失敗時改用證交所 `STOCK_DAY`（僅上市）。
- **即時報價**：證交所 MIS（盤中約 5 秒更新）。
- **選股 / 法人資料**：證交所 `T86`（三大法人買賣超）與 `MI_INDEX`（每日收盤行情），每個交易日各 1 次請求。證交所有頻率限制，程式每次請求間隔 2 秒，所以**第一次**查 10 日約需 40~50 秒，之後過去日期的資料會永久快取、秒出結果。上櫃（櫃買中心）為盡力支援，官方格式變動時可能失效。
- 連續買超天數最多只計算到所選的統計天數內。
- 部分雲端機房 IP 可能被 Yahoo 或證交所限流，建議選擇亞洲區域（Render singapore / Fly nrt）。

## 專案結構

```
twstock/
  main.py         FastAPI 路由、管理員驗證、限流
  data.py         日線 / 即時報價 / 示範資料 / 快取
  market.py       全市場每日法人與行情資料（選股用）
  screener.py     自訂條件選股
  indicators.py   MA、EMA、RSI、MACD、KD、布林、ATR
  analysis.py     個股技術訊號摘要
  backtest.py     回測引擎、策略、參數最佳化
  monitor.py      自選股與警示
  notifier.py     背景警示檢查與 Telegram 推播
  static/         前端（index.html、app.js、style.css、vendor/）
tests/            pytest 測試
Dockerfile, render.yaml, fly.toml   部署設定
```
