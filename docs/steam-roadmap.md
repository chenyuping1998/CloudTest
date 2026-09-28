# 上架 Steam 技術路線

## 目前架構

```
src/core/   純遊戲邏輯（TypeScript，無畫面相依）
src/server/ 權威遊戲伺服器（單機模式在瀏覽器內跑、連線模式在 Node.js 跑）
src/net/    用戶端⇄伺服器訊息格式、連線（本機 / WebSocket）
src/shared/ 地圖配置等伺服器與用戶端共用資料
src/balance/ 練功節奏模擬器
server/     Node.js 伺服器進入點
src/data/   物品、怪物、掉寶表、配方
src/game/   Three.js 用戶端（方塊世界、UI）
tests/      單元測試（掉率蒙地卡羅驗證、交易防複製等）
tools/      掉寶平衡報表
```

## 為什麼是 TypeScript + Three.js

- 核心邏輯與伺服器共用同一份程式碼（交易、掉寶必須由伺服器計算）
- 用 **Electron** 包成 Windows / macOS / Linux 桌面版，透過 **steamworks.js** 串接 Steam（成就、雲端存檔、好友、Overlay）
- 方塊風格對效能需求低，整合顯示卡也能跑

## 里程碑

| 階段 | 內容 | 產出 |
|---|---|---|
| **M0 原型** ✅ | 單機可玩：打怪、掉寶、強化、插卡、家園、交易所 | 完成 |
| **M1 伺服器** ✅（原型） | Node.js 權威伺服器（WebSocket）、帳號密碼（scrypt）、檔案存檔、交易日誌、玩家交易、共用交易所、聊天。待辦：換 PostgreSQL、TLS、水平擴充 | `npm run server` |
| **M2 多人** ✅ | 同地圖多人同步、組隊、玩家交易視窗、真人交易所、聊天、成就 | 可進行封閉測試 |
| **M3 內容**（進行中） | 已完成：第二張地圖（Lv 50~70）。待辦：第三張地圖、第二轉職、主動技能、地下城 | Steam「搶先體驗」頁面 |
| **M4 Steam 整合** ✅（技術面） | Electron 打包（Win/Linux/Mac）、steamworks.js、成就、Overlay、Rich Presence、SteamPipe 設定。待辦：Steam 登入票證驗證（取代密碼）、雲端設定、商店頁素材、分級 | 搶先體驗上架 |
| **M5 營運** | 經濟儀表板、反作弊、RMT 偵測、活動系統 | 正式版 |

## Steam 上架清單

- [ ] Steamworks 開發者帳號（上架費 USD $100 / 款）
- [ ] 商店頁：膠囊圖、截圖 5 張以上、預告片、中英文說明
- [ ] 年齡分級問卷（IARC）
- [ ] 多人遊戲需說明「需要網路連線」
- [ ] 虛擬物品交易：若未來開放 Steam 市集交易，需使用 Steam Inventory Service；目前設計是遊戲內金幣交易，不涉及真錢
- [ ] 隱私權政策（有帳號與伺服器就需要）
- [ ] 原創性檢查：名稱、怪物、美術均為原創，不可使用天堂/RO/Minecraft 的名稱或素材

## 桌面版技術細節

- `electron/main.cjs`：主程序。安全設定：`contextIsolation`、`sandbox`、關閉 `nodeIntegration`、CSP（只允許自己的檔案與 ws/wss 連線）、禁止外部導航。
- `electron/preload.cjs`：只暴露 `window.steam`（名稱、成就、Rich Presence）與 `window.desktop`（全螢幕、版本）。
- `src/platform/platform.ts`：遊戲只透過這層呼叫 Steam；瀏覽器版全部是空操作。
- 沒有 Steam 時自動以一般模式執行；`DISABLE_STEAM=1` 可強制關閉。
- 自動化煙霧測試：`ROE_SMOKE_TEST=shot.png ROE_SMOKE_START=1 electron .`（會自動開始遊戲並截圖；沒有 GPU 的 CI 會自動改用軟體繪圖）。
- 顯示卡不支援 WebGL 時會顯示明確的錯誤訊息，而不是黑畫面。
- Windows 版目前未簽章：上架前需購買程式碼簽章憑證，並在 `package.json` 的 `build.win` 設定。

## 下一步建議

1. 美術：用 Blockbench 製作正式的方塊模型與 16×16 材質，替換程序化生成的暫代美術（介面已預留：`voxel/atlas.ts`、`voxel/models.ts`）
2. 伺服器上線準備：PostgreSQL、TLS（wss://）、Steam 登入票證驗證
3. 內容：第二轉職與主動技能（目前 Job Lv 50 約在 Base Lv 50 封頂）、第三張地圖
4. 找 10~20 位玩家做封閉測試，用 `npm run sim:drops`、`npm run sim:leveling` 的報表對照真實數據
