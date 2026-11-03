# 台股監控分析平台

一個自架的台股網站，功能包含：**自選股監控**、**個股技術分析**、**策略回測**、**自訂條件選股**、**走勢比較**。
後端使用 Python（FastAPI + pandas），前端為純 HTML/JS，圖表使用 TradingView Lightweight Charts（已內附，不依賴 CDN）。

> ⚠ 僅供研究學習，不構成投資建議。

## 功能

| 分頁 | 功能 |
| --- | --- |
| 自選監控 | 自選股清單（存在各訪客自己的瀏覽器）、60 日走勢縮圖、盤中即時價（證交所 MIS）、RSI / KD；盤中每 60 秒自動更新。管理員可設定伺服器警示（股價、漲跌幅、RSI、爆量、均線突破/跌破、KD / MACD 黃金/死亡交叉），支援瀏覽器桌面通知與 Telegram 推播 |
| 我的持股 | 輸入持股（代號、股數、平均成本，存在各自的瀏覽器），計算市值、未實現損益（含預估賣出費用）、今日損益、資產配置比重；每檔給出「停損檢視 / 考慮減碼・停利 / 續抱觀察 / 可考慮加碼」建議與理由（技術面多空分數、ATR 移動停損價、RSI 過熱）；組合層級提示單一持股比重過高、集中度、高相關持股、Beta、近一年最大回撤，並以目前配置回推近一年走勢與 0050 比較。支援匯出 / 匯入備份 |
| 個股分析 | K 線（紅漲綠跌）＋ MA5/10/20/60/120/240、布林通道，成交量、KD、MACD、RSI 副圖（同步縮放、十字線數值）；技術訊號摘要與多空分數；區間報酬、52 週高低、波動率；**近 20 日三大法人買賣超** |
| 策略回測 | 內建均線交叉、RSI、MACD、KD、布林通道、通道突破、買進持有；台股手續費（可設折扣、最低 20 元）與證交稅（股票 0.3%、ETF 0.1%）、零股/整張、停損停利；隔日開盤成交避免未來函數。輸出總報酬、CAGR、MDD、夏普、Sortino、勝率、獲利因子、淨值/回撤曲線、買賣點與交易明細；**參數格點最佳化** |
| 每日精選 | 綜合籌碼面（投信認養、法人同步買超、量價突破）、技術面（均線多頭、KD / MACD 轉強）與四個選股模型（Minervini 趨勢模板、12-1 個月動能、月營收成長、價值 / 高殖利率），並對過熱、追高、跌破季線、營收衰退、本益比過高扣分，每天挑出 5 檔並附原因。週一至週五 08:30 自動推播到 LINE / Telegram，也顯示在「條件選股」頁上方，LINE 傳「精選」可隨時查詢 |
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

> `render.yaml` 使用 **免費方案**，有兩個限制：
>
> 1. **閒置 15 分鐘會休眠**，休眠時背景警示不會運作，下次開網頁要等約 1 分鐘喚醒。解法：到 [UptimeRobot](https://uptimerobot.com) 或 [cron-job.org](https://cron-job.org)（免費）設定每 10 分鐘請求一次 `https://你的網址/healthz`。免費方案每月 750 小時，足夠一個服務整月不休眠。
> 2. **沒有持久化磁碟**：伺服器重啟或重新部署後，伺服器警示要重新設定，選股快取也會清空（第一次選股需重新下載）。自選股存在訪客瀏覽器，不受影響。
>
> 需要資料永久保存時，可改用付費 starter 方案並加上 disk（見 `render.yaml` 註解），或改用 Oracle Cloud 永久免費主機以 Docker 執行。之後 push 到部署的分支會自動重新部署。

### 免費主機必做：外部排程（每日精選 / 警示推播才會準時）

Render 免費方案閒置會休眠，休眠時背景排程不會執行。請用免費的 [cron-job.org](https://cron-job.org) 定時呼叫網站，同時喚醒伺服器並執行推播工作：

1. 在 Render 的 Environment 新增 `TWSTOCK_CRON_KEY`，值自己取一串不易猜的英數字（例如 `k8Jq2xV9pT`）。
2. 到 cron-job.org 註冊 → **Create cronjob**：
   - URL：`https://你的網址/cron/tick?key=你設定的TWSTOCK_CRON_KEY`
   - Schedule：**Every 5 minutes**（或自訂週一至週五 08:00–13:40 每 5 分鐘）
3. 儲存後，網站「系統診斷」會顯示「排程最近一次執行：…（外部排程）」。

每次呼叫都會：喚醒伺服器；若已過 08:30 且今天還沒推播就推播每日精選（伺服器醒得晚時，13:30 前都會補發）；盤中檢查警示。

### 免費主機必做：保存警示設定

免費主機沒有永久磁碟，重新部署或重啟後警示會清空。設定好警示後，在「自選監控 → 伺服器警示」按 **複製警示設定**，到 Render 的 Environment 把內容貼到 `TWSTOCK_ALERTS` 並儲存；伺服器重啟時會自動還原。每次新增或刪除警示後要重新複製一次。

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

### LINE 機器人（選用）

> LINE Notify 已於 2025 年 3 月底停止服務，這裡使用 **LINE 官方帳號＋Messaging API**。

機器人可以做兩件事：

- **盤中警示推播**：和 Telegram 相同，兩者可同時開啟。
- **對話查詢**：傳 `2330` 回覆報價與技術訊號、傳 `id` 回覆聊天室 ID、傳 `說明` 顯示指令。回覆訊息不計入每月推播額度。

設定步驟：

1. 到 [LINE Official Account Manager](https://manager.line.biz) 建立官方帳號（免費）。
2. 在官方帳號的「設定 → Messaging API」按「啟用 Messaging API」，建立或選擇一個 Provider。
3. 到 [LINE Developers Console](https://developers.line.biz/console/) 打開這個 Channel：
   - **Basic settings**：複製 **Channel secret**；頁面下方的 **Your user ID** 就是你自己的 userId。
   - **Messaging API**：在 Channel access token（long-lived）按 **Issue** 並複製；用頁面上的 QR code 把機器人加為好友。
   - **Webhook URL** 填 `https://你的網址/line/webhook`，開啟 **Use webhook**，按 **Verify** 應顯示 Success。
4. 回到官方帳號後台的「回應設定」，**關閉「自動回應訊息」**，否則機器人會回覆預設訊息。
5. 在 Render 的 Environment 設定：
   - `LINE_CHANNEL_ACCESS_TOKEN`、`LINE_CHANNEL_SECRET`
   - `LINE_TO`：你的 userId（`U` 開頭）。要推到群組，先把機器人加進群組並在群組傳 `id` 取得群組 ID（`C` 開頭）；多個對象用逗號分隔。
   - 或設 `LINE_BROADCAST=1`：推播給所有加機器人好友的人（不需 `LINE_TO`）。
6. 到網站「自選監控 → 伺服器警示」以管理員登入，按「發送測試推播」確認收到。

> 官方帳號免費方案每月推播則數有限（台灣「輕用量」方案為每月 200 則，以 LINE 官網公告為準），每推給 1 位好友算 1 則；群組推播算 1 則。廣播給很多好友時容易用完額度，建議改用群組。

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
| `TWSTOCK_DAILY_PICKS` | `1` | 是否在開盤前推播每日精選 |
| `TWSTOCK_PICKS_TIME` | `08:30` | 每日精選推播時間（台北時間，週一至週五） |
| `TWSTOCK_PICKS_DEADLINE` | `13:30` | 伺服器醒得晚時，補發每日精選的最晚時間 |
| `TWSTOCK_CRON_KEY` | | 外部排程金鑰（`/cron/tick?key=…`） |
| `TWSTOCK_ALERTS` | | 警示設定 JSON（網站「複製警示設定」產生），重啟後自動還原 |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | | Telegram 推播 |
| `LINE_CHANNEL_ACCESS_TOKEN` / `LINE_CHANNEL_SECRET` | | LINE 機器人（Messaging API） |
| `LINE_TO` | | LINE 推播對象（userId / groupId，逗號分隔） |
| `LINE_BROADCAST` | `0` | `1` = 推播給所有好友 |

## 選股模型

| 模型 | 來源 | 規則 |
| --- | --- | --- |
| Minervini 趨勢模板 | Mark Minervini《超級績效》SEPA 方法的 8 項條件 | 股價 > 150 / 200 日均線、150 日 > 200 日、200 日線上揚 ≥ 1 個月、50 日 > 150 / 200 日、股價 > 50 日、距 52 週低點 ≥ +30%、距 52 週高點 25% 以內、相對強度優於 0050（原版為 IBD RS 排名 ≥ 70，需全市場排名，這裡以加權報酬優於 0050 近似） |
| 12-1 個月動能 | Jegadeesh & Titman (1993) 動能因子 | 過去 12 個月扣除最近 1 個月的報酬為正，且優於 0050 |
| 營收成長動能 | 台灣常見的月營收選股法 | 最新月營收年增 > 20% 且累計營收年增 > 10% |
| 價值 / 高殖利率 | 價值投資 / 存股常用條件 | 本益比 0~15 倍且現金殖利率 ≥ 4% |

這些模型也能在「條件選股」中單獨使用（技術面勾選「符合 Minervini 趨勢模板」、「12-1 個月動能」，基本面可篩月營收年增率、累計營收年增率、本益比、殖利率、股價淨值比），並內建「Minervini 趨勢模板」、「營收成長＋趨勢向上」、「高殖利率存股」範本。

> 參考過但未納入：Microsoft Qlib（MIT 授權的 AI 量化平台，Alpha158 因子＋LightGBM）需要全市場多年歷史資料訓練，記憶體需求也超過免費主機，適合之後改用 Oracle Cloud 等較大主機時再評估。

## 資料來源與限制

- **日線**：Yahoo Finance（`2330.TW` / 上櫃 `.TWO`），失敗時改用證交所 `STOCK_DAY`（僅上市）。
- **即時報價**：證交所 MIS（盤中約 5 秒更新）。
- **基本面**：證交所 OpenAPI 月營收（`t187ap05_L`）與本益比 / 殖利率 / 股價淨值比（`BWIBBU_ALL`），僅上市公司，每日快取一次；取得失敗時選股會略過基本面條件。
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
  portfolio.py    持股損益分析與建議
  notifier.py     背景警示檢查與推播（Telegram / LINE）
  line_bot.py     LINE 機器人：推播、webhook 對話查詢
  picks.py        每日精選（綜合選股法計分）
  models.py       選股模型（Minervini、12-1 動能、營收成長、價值）
  fundamentals.py 月營收、本益比、殖利率（證交所 OpenAPI）
  static/         前端（index.html、app.js、style.css、vendor/）
tests/            pytest 測試
Dockerfile, render.yaml, fly.toml   部署設定
```
