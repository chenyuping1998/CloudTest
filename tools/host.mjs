// npm run host：在自己電腦開一台「網頁 + 連線」合一的測試伺服器（http://localhost:8787）
// 搭配 Cloudflare Tunnel 對外開放，步驟見 docs/deploy.md「自己的電腦 + Cloudflare Tunnel」
import { spawn } from 'node:child_process';

const child = spawn(process.execPath, ['dist-server/main.js'], {
  stdio: 'inherit',
  env: { STATIC_DIR: 'dist', TRUST_PROXY: '1', DATA_DIR: 'server-data', ...process.env },
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
child.on('exit', (code) => process.exit(code ?? 0));
