# SteamPipe 上傳設定

1. 在 Steamworks 後台建立 App，記下 **App ID** 與各平台的 **Depot ID**，取代下方檔案中的 `1000000`、`1000001`…。
2. 在 Steamworks 後台「成就」頁面建立成就，**API 名稱必須與 `src/shared/achievements.ts` 的 id 完全相同**（例如 `FIRST_BLOOD`）。
3. 打包：
   ```bash
   npm run dist:win     # release/win-unpacked
   npm run dist:linux   # release/linux-unpacked
   npm run dist:mac     # release/mac（需在 macOS 上執行並簽章 / 公證）
   ```
4. 下載 Steamworks SDK，用 `steamcmd` 上傳：
   ```bash
   steamcmd +login <帳號> +run_app_build $(pwd)/steam/app_build.vdf +quit
   ```
5. 在 Steamworks 後台把上傳的 build 設為 `beta` 分支測試，確認成就、Overlay（Shift+Tab）、Rich Presence 正常後再推到 default。

啟動選項：Windows 執行檔 `Realm of Embers.exe`、Linux `realm-of-embers`。
正式版請刪除 `steam_appid.txt`（它只用於開發測試，會讓遊戲跳過 Steam 啟動檢查）。
