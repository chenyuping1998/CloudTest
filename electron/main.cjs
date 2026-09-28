/**
 * 餘燼王國 — Electron 主程序（桌面版 / Steam 版）
 *
 * 環境變數：
 *   STEAM_APP_ID       Steam App ID（預設讀 steam_appid.txt，再預設 480 = Spacewar 測試用）
 *   DISABLE_STEAM=1    不初始化 Steam（例如在非 Steam 平台發行）
 *   ELECTRON_DEV_URL   開發時載入 Vite dev server，例如 http://localhost:5173
 *   ROE_SMOKE_TEST     啟動後截圖到這個路徑並自動結束（CI 用）
 *   ROE_SMOKE_START=1  煙霧測試時自動按下「開始冒險」，驗證 3D 遊戲畫面能正常執行
 *   ROE_SOFTWARE_GL=1  強制軟體繪圖（沒有顯示卡的環境）
 */
const { app, BrowserWindow, ipcMain, Menu, session, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

// 沒有 GPU 的環境（CI、遠端桌面）改用軟體繪圖
if (process.env.ROE_SMOKE_TEST || process.env.ROE_SOFTWARE_GL === '1') {
  app.commandLine.appendSwitch('use-angle', 'swiftshader');
  app.commandLine.appendSwitch('enable-unsafe-swiftshader');
}

// ------------------------------------------------------------ Steam

function readAppId() {
  if (process.env.STEAM_APP_ID) return Number(process.env.STEAM_APP_ID);
  for (const dir of [process.cwd(), ROOT, path.dirname(process.execPath)]) {
    const f = path.join(dir, 'steam_appid.txt');
    if (fs.existsSync(f)) return Number(fs.readFileSync(f, 'utf8').trim());
  }
  return 480;
}

let steamworks = null;
let steam = null;

function initSteam() {
  if (process.env.DISABLE_STEAM === '1') return;
  try {
    steamworks = require('steamworks.js');
    steam = steamworks.init(readAppId());
    console.log(`[steam] 已連線：${steam.localplayer.getName()}`);
  } catch (e) {
    steam = null;
    console.log(`[steam] 未啟用（Steam 沒有執行或非 Steam 版）：${e && e.message}`);
  }
}

initSteam();
// Steam Overlay（Shift+Tab）需要在建立視窗前啟用
try {
  if (steam && steamworks) steamworks.electronEnableSteamOverlay();
} catch {
  /* ignore */
}

ipcMain.on('steam:info', (e) => {
  e.returnValue = steam
    ? { available: true, personaName: steam.localplayer.getName(), steamId: String(steam.localplayer.getSteamId().steamId64) }
    : { available: false };
});
ipcMain.handle('steam:achievement', (_e, id) => {
  if (!steam || typeof id !== 'string' || !/^[A-Z0-9_]{1,64}$/.test(id)) return false;
  return steam.achievement.activate(id);
});
ipcMain.handle('steam:presence', (_e, key, value) => {
  if (!steam || typeof key !== 'string' || typeof value !== 'string') return false;
  steam.localplayer.setRichPresence(key.slice(0, 64), value.slice(0, 256));
  return true;
});
// Steam 登入票證（給連線伺服器驗證用；identity 必須與伺服器 steamAuth.ts 的 STEAM_TICKET_IDENTITY 相同）
ipcMain.handle('steam:ticket', async () => {
  if (!steam) return null;
  try {
    const ticket = await steam.auth.getAuthTicketForWebApi('realm-of-embers', 10);
    return ticket.getBytes().toString('hex');
  } catch (e) {
    console.warn('[steam] 取得登入票證失敗', e && e.message);
    return null;
  }
});
ipcMain.handle('desktop:fullscreen', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win) win.setFullScreen(!win.isFullScreen());
});
ipcMain.handle('desktop:quit', () => app.quit());
ipcMain.on('desktop:version', (e) => {
  e.returnValue = app.getVersion();
});

// ------------------------------------------------------------ 視窗

if (!app.requestSingleInstanceLock()) app.quit();

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    title: '餘燼王國 Realm of Embers',
    backgroundColor: '#0b0a10',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  Menu.setApplicationMenu(null);
  win.once('ready-to-show', () => win.show());

  // 外部連結用系統瀏覽器開啟，不在遊戲視窗內導航
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file:') && !url.startsWith(process.env.ELECTRON_DEV_URL || '\0')) e.preventDefault();
  });

  if (process.env.ELECTRON_DEV_URL) void win.loadURL(process.env.ELECTRON_DEV_URL);
  else void win.loadFile(path.join(ROOT, 'dist', 'index.html'));

  if (process.env.ROE_SMOKE_TEST) {
    win.webContents.on('console-message', (e) => {
      if (e.level === 'error' || e.level === 'warning') console.log(`[renderer:${e.level}] ${e.message}`);
    });
    win.webContents.once('did-finish-load', () => {
      if (process.env.ROE_SMOKE_START === '1') {
        setTimeout(() => void win.webContents.executeJavaScript("document.querySelector('.title-form .btn-primary')?.click()"), 1500);
      }
      setTimeout(async () => {
        const img = await win.webContents.capturePage();
        fs.writeFileSync(process.env.ROE_SMOKE_TEST, img.toPNG());
        console.log(`[smoke] 截圖已存到 ${process.env.ROE_SMOKE_TEST}`);
        app.quit();
      }, Number(process.env.ROE_SMOKE_DELAY || 4000));
    });
  }
  return win;
}

app.whenReady().then(() => {
  // 內容安全政策：只允許載入自己的檔案；連線模式需要 ws/wss
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    cb({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws: wss:",
        ],
      },
    });
  });
  createWindow();
});

app.on('window-all-closed', () => app.quit());
