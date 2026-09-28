# 伺服器部署手冊

正式環境架構：

```
玩家（Steam 桌面版 / 網頁版）
        │  https / wss://DOMAIN/ws
        ▼
   Caddy（自動 HTTPS、提供網頁版靜態檔）
        │  ws://game:8787
        ▼
   遊戲伺服器（Node.js，權威邏輯，20 tick/s）
        │
        ▼
   PostgreSQL（帳號、角色存檔、世界狀態、稽核日誌）
```

## 0. 快速封測：自己的電腦 + Cloudflare Tunnel（免費）

不用租主機、不用設定路由器，適合找朋友小規模測試。玩家連線期間電腦要保持開機。

**1. 在自己電腦啟動測試伺服器**（需要 Node.js 22 以上）

```bash
npm install
npm run host          # 建置後啟動，網頁版 + 連線都在 http://localhost:8787
```

先自己開 http://localhost:8787 →「連線遊玩」確認能登入。存檔在 `server-data/`。

**2. 安裝 cloudflared**

- Windows：`winget install --id Cloudflare.cloudflared`
- Mac：`brew install cloudflared`
- Linux：到 https://github.com/cloudflare/cloudflared/releases 下載

**3. 開通道**（另開一個終端機）

```bash
cloudflared tunnel --url http://localhost:8787
```

畫面會出現一個網址，例如 `https://random-words.trycloudflare.com`，把它傳給朋友：

- **網頁版**：直接開這個網址 →「連線遊玩」，伺服器位址會自動填成 `wss://…/ws`
- **桌面版**：伺服器位址填 `wss://random-words.trycloudflare.com/ws`

注意事項：

- 這種「快速通道」不用註冊，但**每次重開網址都會變**。想要固定網址，註冊免費 Cloudflare 帳號並把網域交給 Cloudflare 管理，改用具名通道（`cloudflared tunnel create`，見 Cloudflare 文件）。
- `npm run host` 已開啟 `TRUST_PROXY=1`：每個玩家的真實 IP 由 Cloudflare 提供，每 IP 連線數限制才會正常運作。
  **不要**在沒有通道、直接對外開 port 的情況下使用 `npm run host`（IP 可被偽造）。
- 經由通道的 `/metrics` 會回 404，只有本機能看。
- 測試資料在 `server-data/`，封測結束想重來就刪掉這個資料夾。

## 1. 需求

- 一台 Linux 主機（2 vCPU / 2 GB RAM 足以支撐封閉測試約 200 人同時在線）
- Docker 與 Docker Compose v2
- 一個網域，A 記錄指向主機 IP；防火牆開放 80、443

## 2. 第一次部署

```bash
git clone <repo> && cd <repo>/deploy
cp .env.example .env
# 編輯 .env：DOMAIN、POSTGRES_PASSWORD（openssl rand -hex 32）、STEAM_WEB_API_KEY
docker compose up -d --build
docker compose logs -f game      # 看到 {"msg":"餘燼王國伺服器啟動",...} 即完成
curl https://你的網域/health
```

資料表會在伺服器啟動時自動建立（`PgStorage.migrate()`，可重複執行）。

## 3. 環境變數

| 變數 | 預設 | 說明 |
|---|---|---|
| `PORT` | 8787 | WebSocket / HTTP 埠 |
| `DATABASE_URL` | — | 有設就用 PostgreSQL；沒設就用檔案存檔（`DATA_DIR`，只適合測試） |
| `DATA_DIR` | `./server-data` | 檔案存檔位置 |
| `STEAM_WEB_API_KEY` | — | 發行商 Web API 金鑰；有設才開放 Steam 登入 |
| `STEAM_APP_ID` | 480 | 正式 App ID（480 是 Valve 的測試用 Spacewar） |
| `ALLOW_PASSWORD_LOGIN` | 1 | 設 0 則只允許 Steam 登入（正式上架建議） |
| `MARKET_BOTS` | 1 | 交易所 NPC 商人（人少時維持流動性，人多後可關閉） |
| `MAX_CONN_PER_IP` | 5 | 同一 IP 最多連線數 |
| `TRUST_PROXY` | — | 設 1 時信任 `CF-Connecting-IP` / `X-Forwarded-For`（放在 Caddy 或 Cloudflare Tunnel 後面必須開） |
| `STATIC_DIR` | — | 設定後伺服器同時提供網頁版用戶端（`npm run host` 會設為 `dist`） |

## 4. Steam 登入流程

1. 桌面版透過 steamworks.js 呼叫 `getAuthTicketForWebApi("realm-of-embers")` 取得票證。
2. 用戶端送出 `login { steamTicket }`。
3. 伺服器呼叫 `ISteamUserAuth/AuthenticateUserTicket/v1`，確認 `result: OK`、未被 VAC / 發行商封鎖，取得 SteamID。
4. 帳號以 SteamID 為主鍵，角色名稱第一次登入時設定。

票證只能用一次、而且伺服器會驗證 `identity`，被攔截也無法重放到別的服務。

## 5. 更新版本

```bash
git pull
cd deploy && docker compose up -d --build game
```

- 伺服器收到 SIGTERM 會停止接新連線、把所有線上玩家存檔、關閉資料庫連線後才結束（`stop_grace_period: 30s`）。
- 網頁版用戶端在每次啟動時同步到 Caddy，不需要另外處理。
- 用戶端與伺服器的通訊協定版本不同時，登入會被拒絕並提示更新（`PROTOCOL_VERSION`）。

## 6. 備份與還原

```bash
# 每日備份（加到 crontab）
docker compose exec -T db pg_dump -U roe -Fc roe > backup/roe-$(date +%F).dump

# 還原
docker compose exec -T db pg_restore -U roe -d roe --clean < backup/roe-2026-01-01.dump
```

建議把備份再同步到異地（S3 / B2），保留 30 天。**上線前務必演練一次還原。**

## 7. 監控

- `GET /health`：存活檢查（對外開放）
- `GET /metrics`：Prometheus 格式（在線人數、活躍地圖、交易所掛單、金幣回收量、交易所成交額）。Caddy 對外回 404，請由內網抓取 `game:8787/metrics`。
- 日誌為一行一筆 JSON，可直接送進 Loki / CloudWatch。

## 8. 稽核日誌（客服用）

牽涉價值的操作會寫入 `audit_log`：登入（`login`）、玩家交易（`trade`）、交易所成交（`market_sale`）、強化失敗蒸發（`enchant_destroyed`）、稀有掉寶（`rare_drop`）。

```sql
-- 查某玩家最近的紀錄（actor 為角色名稱）
SELECT at, kind, data FROM audit_log
WHERE actor = '玩家名稱' ORDER BY at DESC LIMIT 50;
```

## 9. 上線前安全檢查清單

- [ ] `.env` 權限 600，未進版本控制
- [ ] `POSTGRES_PASSWORD` 為隨機長字串，資料庫埠未對外開放（compose 預設沒開）
- [ ] 正式上架後 `ALLOW_PASSWORD_LOGIN=0`
- [ ] `/metrics` 未對外開放
- [ ] 主機只開 22（限制來源 IP）、80、443
- [ ] 備份排程已設定並演練還原
- [ ] 伺服器以非 root 使用者執行（映像已設定 `USER node`）

## 10. 擴充

目前是單一行程、所有地圖同一台。估計上限約 500~800 人同時在線（瓶頸在 tick 的怪物 AI 與廣播）。
人數超過時的路線：

1. **依地圖分片**：每張地圖一個行程，傳送門切換時轉移連線（角色存檔已經在資料庫，轉移只需重新登入流程）。
2. **交易所 / 聊天獨立服務**：用 PostgreSQL 交易 + Redis pub/sub 讓各分片共用。
3. **頻道制**：同一張地圖開多個頻道（RO / 天堂常見做法），最簡單也最符合這類遊戲的習慣。
