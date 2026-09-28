/**
 * 連線伺服器：npm run server（開發） / node dist-server/main.js（正式）
 *
 * 環境變數：
 *   PORT                 WebSocket / HTTP 埠號（預設 8787）
 *   DATABASE_URL         PostgreSQL 連線字串；未設定時使用檔案存檔（DATA_DIR）
 *   DATA_DIR             檔案存檔目錄（預設 ./server-data）
 *   STEAM_WEB_API_KEY    Steam 發行商 Web API 金鑰（開放 Steam 登入時必填）
 *   STEAM_APP_ID         Steam App ID
 *   ALLOW_PASSWORD_LOGIN 設為 0 可關閉帳號密碼登入（只允許 Steam）
 *   MARKET_BOTS          設為 0 關閉交易所機器人
 *   MAX_CONN_PER_IP      同一 IP 最多連線數（預設 5）
 *   TRUST_PROXY          設為 1 時從 X-Forwarded-For 取得真實 IP（放在 Caddy / nginx 後面時）
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ClientMsg, ServerMsg } from '../src/net/protocol';
import { GameServer, type Conn, type ServerStorage } from '../src/server/GameServer';
import { steamVerifier } from './steamAuth';
import { FileStorage } from './storage/fileStorage';
import { PgStorage } from './storage/pgStorage';

const env = process.env;
const PORT = Number(env.PORT ?? 8787);
const TICK_MS = 50;
const MAX_MSG_BYTES = 4096;
const MAX_MSGS_PER_SEC = 40;
const MAX_CONN_PER_IP = Number(env.MAX_CONN_PER_IP ?? 5);
const startedAt = Date.now();

function log(level: 'info' | 'warn' | 'error', msg: string, extra: Record<string, unknown> = {}): void {
  // JSON 格式的日誌，方便丟進 Loki / CloudWatch 等系統
  console.log(JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra }));
}

function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32);
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [, saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(expected, actual);
}

async function createStorage(): Promise<{ storage: ServerStorage; close: () => Promise<void>; kind: string }> {
  if (env.DATABASE_URL) {
    const pg = await import('pg');
    const pool = new pg.default.Pool({ connectionString: env.DATABASE_URL, max: 10 });
    const storage = new PgStorage(pool);
    await storage.migrate();
    return { storage, close: () => pool.end(), kind: 'postgres' };
  }
  const dir = env.DATA_DIR ?? join(process.cwd(), 'server-data');
  return { storage: new FileStorage(dir), close: async () => undefined, kind: `file:${dir}` };
}

async function main(): Promise<void> {
  const { storage, close, kind } = await createStorage();
  const steamOn = !!env.STEAM_WEB_API_KEY;
  const passwordOn = env.ALLOW_PASSWORD_LOGIN !== '0';
  const game = new GameServer({
    online: true,
    storage,
    world: await storage.loadWorld(),
    hashPassword: passwordOn ? hashPassword : undefined,
    verifyPassword: passwordOn ? verifyPassword : () => false,
    verifySteamTicket: steamOn ? steamVerifier({ apiKey: env.STEAM_WEB_API_KEY!, appId: Number(env.STEAM_APP_ID ?? 480) }) : undefined,
    marketBots: env.MARKET_BOTS !== '0',
    // 伺服器每次啟動用不同前綴，重啟後物品 uid 也不會重複
    uidPrefix: `s${Date.now().toString(36)}`,
  });

  const connPerIp = new Map<string, number>();
  const clientIp = (req: IncomingMessage) =>
    (env.TRUST_PROXY === '1' ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() : '') || req.socket.remoteAddress || '?';

  const http = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, uptimeSec: Math.floor((Date.now() - startedAt) / 1000), ...game.stats() }));
      return;
    }
    if (req.url === '/metrics') {
      // Prometheus 格式
      const st = game.stats();
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
      res.end([
        `roe_players_online ${st.online}`,
        `roe_zones_active ${st.zones}`,
        `roe_market_listings ${st.listings}`,
        `roe_gold_sunk_fees_total ${st.goldSunkFees}`,
        `roe_gold_sunk_tax_total ${st.goldSunkTax}`,
        `roe_market_volume_total ${st.tradeVolume}`,
        `roe_uptime_seconds ${Math.floor((Date.now() - startedAt) / 1000)}`,
      ].join('\n') + '\n');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ name: '餘燼王國伺服器', online: game.onlineCount, steamLogin: steamOn, passwordLogin: passwordOn }));
  });

  const wss = new WebSocketServer({ server: http, maxPayload: MAX_MSG_BYTES });
  wss.on('connection', (ws: WebSocket, req) => {
    const ip = clientIp(req);
    const n = (connPerIp.get(ip) ?? 0) + 1;
    if (n > MAX_CONN_PER_IP) {
      ws.close(1008, 'too many connections');
      return;
    }
    connPerIp.set(ip, n);
    let budget = MAX_MSGS_PER_SEC;
    let strikes = 0;
    const refill = setInterval(() => (budget = MAX_MSGS_PER_SEC), 1000);
    const conn: Conn = {
      send: (msg: ServerMsg) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
      },
      close: () => ws.close(),
    };
    ws.on('message', (raw) => {
      if (--budget < 0) {
        // 洪水攻擊：超過配額的訊息丟棄，持續違規就斷線
        if (++strikes > 200) ws.close(1008, 'rate limit');
        return;
      }
      let msg: ClientMsg;
      try {
        msg = JSON.parse(raw.toString()) as ClientMsg;
      } catch {
        return;
      }
      game.handle(conn, msg);
    });
    ws.on('close', () => {
      clearInterval(refill);
      connPerIp.set(ip, (connPerIp.get(ip) ?? 1) - 1);
      if ((connPerIp.get(ip) ?? 0) <= 0) connPerIp.delete(ip);
      game.disconnect(conn);
    });
  });

  let last = performance.now();
  const loop = setInterval(() => {
    const now = performance.now();
    try {
      game.tick(Math.min((now - last) / 1000, 0.2));
    } catch (e) {
      log('error', 'tick failed', { error: String(e) });
    }
    last = now;
  }, TICK_MS);

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log('info', 'shutting down', { signal });
    clearInterval(loop);
    wss.clients.forEach((c) => c.close(1012, 'server restarting'));
    await game.saveAll();
    await close();
    log('info', 'saved, bye');
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  http.listen(PORT, () => log('info', '餘燼王國伺服器啟動', { port: PORT, storage: kind, steamLogin: steamOn, passwordLogin: passwordOn }));
}

main().catch((e) => {
  log('error', 'fatal', { error: String(e?.stack ?? e) });
  process.exit(1);
});
