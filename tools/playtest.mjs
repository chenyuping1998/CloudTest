// 一鍵封測：建置 → 啟動伺服器（網頁 + 連線同一個埠）→ 開 Cloudflare 通道 → 顯示要傳給朋友的網址
// 由「開始測試.bat」（Windows）或「開始測試.command」（Mac）呼叫，也可以直接 npm run playtest
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const PORT = 8787;
const isWin = process.platform === 'win32';
const children = [];

const say = (msg = '') => console.log(msg);
const line = () => say('='.repeat(56));

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: isWin });
  if (r.status !== 0) {
    say(`\n❌ 執行失敗：${cmd} ${args.join(' ')}`);
    process.exit(1);
  }
}

function findCloudflared() {
  const candidates = ['cloudflared'];
  if (isWin) {
    for (const base of [process.env['ProgramFiles(x86)'], process.env.ProgramFiles]) if (base) candidates.push(join(base, 'cloudflared', 'cloudflared.exe'));
    if (process.env.LOCALAPPDATA) candidates.push(join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'cloudflared.exe'));
  } else candidates.push('/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared');
  for (const c of candidates) {
    if (c !== 'cloudflared' && !existsSync(c)) continue;
    const r = spawnSync(c, ['--version'], { stdio: 'ignore', shell: isWin && c === 'cloudflared' });
    if (r.status === 0) return c;
  }
  return undefined;
}

function installCloudflared() {
  say('\n找不到 cloudflared，正在自動安裝…');
  if (isWin) spawnSync('winget', ['install', '--id', 'Cloudflare.cloudflared', '-e', '--accept-source-agreements', '--accept-package-agreements'], { stdio: 'inherit', shell: true });
  else if (process.platform === 'darwin') spawnSync('brew', ['install', 'cloudflared'], { stdio: 'inherit' });
  return findCloudflared();
}

function copyToClipboard(text) {
  try {
    if (isWin) spawnSync('clip', { input: text, shell: true });
    else if (process.platform === 'darwin') spawnSync('pbcopy', { input: text });
    return true;
  } catch {
    return false;
  }
}

function openBrowser(url) {
  if (isWin) spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' });
  else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' });
}

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://localhost:${PORT}/health`);
      if (r.ok) return true;
    } catch {
      /* 還沒起來 */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function shutdown() {
  say('\n正在關閉（伺服器會先把所有玩家存檔）…');
  for (const c of children) c.kill('SIGINT');
  setTimeout(() => process.exit(0), 4000);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ------------------------------------------------------------
line();
say('  餘燼王國　封閉測試伺服器');
line();
const major = Number(process.versions.node.split('.')[0]);
if (major < 22) {
  say(`❌ 需要 Node.js 22 以上（目前 ${process.versions.node}）。請到 https://nodejs.org 下載 LTS 版。`);
  process.exit(1);
}

say('\n[1/3] 建置遊戲（約 10~30 秒）…');
run('npm', ['run', 'build']);
run('npm', ['run', 'build:server']);

say('\n[2/3] 啟動伺服器…');
const server = spawn(process.execPath, ['dist-server/main.js'], {
  stdio: ['ignore', 'inherit', 'inherit'],
  env: { STATIC_DIR: 'dist', TRUST_PROXY: '1', DATA_DIR: 'server-data', PORT: String(PORT), ...process.env },
});
children.push(server);
server.on('exit', (code) => {
  say(`\n伺服器已結束（代碼 ${code}）。`);
  process.exit(code ?? 0);
});
if (!(await waitForServer())) {
  say('❌ 伺服器沒有啟動成功，請把上面的錯誤訊息貼給開發者。');
  shutdown();
}
say(`✅ 伺服器啟動：http://localhost:${PORT}（你自己用這個網址玩）`);
openBrowser(`http://localhost:${PORT}`);

say('\n[3/3] 開啟 Cloudflare 通道…');
const cf = findCloudflared() ?? installCloudflared();
if (!cf) {
  say('⚠ 沒辦法自動安裝 cloudflared，朋友暫時連不進來。');
  say('  Windows：開 PowerShell 執行  winget install --id Cloudflare.cloudflared');
  say('  Mac：    brew install cloudflared');
  say('  裝好後關掉這個視窗，再執行一次。你自己仍然可以用上面的網址玩。');
} else {
  const tunnel = spawn(cf, ['tunnel', '--url', `http://localhost:${PORT}`, '--no-autoupdate'], { stdio: ['ignore', 'pipe', 'pipe'], shell: isWin && cf === 'cloudflared' });
  children.push(tunnel);
  let shown = false;
  const onData = (buf) => {
    const m = String(buf).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (!m || shown) return;
    shown = true;
    const copied = copyToClipboard(m[0]);
    say('');
    line();
    say('  🎮 把這個網址傳給朋友：');
    say('');
    say(`     ${m[0]}`);
    say('');
    say(`  ${copied ? '（已複製到剪貼簿，直接貼上就好）' : ''}`);
    say('  朋友打開 →「連線遊玩」→ 取名字、設密碼 → 進入遊戲');
    say('  桌面版請填伺服器位址：' + m[0].replace('https://', 'wss://') + '/ws');
    line();
    say('\n測試中請不要關掉這個視窗。要結束請按 Ctrl + C。');
    say('玩家回報與練功數據：npm run report:playtest\n');
  };
  tunnel.stdout.on('data', onData);
  tunnel.stderr.on('data', onData);
  tunnel.on('exit', (code) => say(`\n⚠ Cloudflare 通道中斷（代碼 ${code}），朋友會斷線。重新執行即可（網址會改變）。`));
}
