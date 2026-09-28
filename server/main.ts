/**
 * 連線伺服器：npm run server
 * - WebSocket 埠號：環境變數 PORT（預設 8787）
 * - 存檔目錄：環境變數 DATA_DIR（預設 ./server-data）
 * 上線營運時建議把 FileStorage 換成 PostgreSQL，並放在 TLS (wss://) 反向代理後面。
 */
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ClientMsg, ServerMsg } from '../src/net/protocol';
import { GameServer, type AccountRecord, type Conn, type ServerStorage, type WorldRecord } from '../src/server/GameServer';

const PORT = Number(process.env.PORT ?? 8787);
const DATA_DIR = process.env.DATA_DIR ?? join(process.cwd(), 'server-data');
const TICK_MS = 50;
const MAX_MSG_BYTES = 4096;
const MAX_MSGS_PER_SEC = 40;

/** 檔案存檔：每個帳號一個 JSON，先寫暫存檔再改名，避免寫到一半當機造成壞檔 */
class FileStorage implements ServerStorage {
  constructor(private readonly dir: string) {
    mkdirSync(join(dir, 'accounts'), { recursive: true });
  }
  private accountPath(name: string): string {
    // 用雜湊當檔名，避免中文或特殊字元造成路徑問題
    return join(this.dir, 'accounts', `${createHash('sha256').update(name).digest('hex').slice(0, 32)}.json`);
  }
  private writeAtomic(path: string, data: unknown): void {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(data));
    renameSync(tmp, path);
  }
  loadAccount(name: string): AccountRecord | undefined {
    const p = this.accountPath(name);
    if (!existsSync(p)) return undefined;
    const rec = JSON.parse(readFileSync(p, 'utf8')) as AccountRecord;
    return rec.name === name ? rec : undefined;
  }
  saveAccount(rec: AccountRecord): void {
    this.writeAtomic(this.accountPath(rec.name), rec);
  }
  loadWorld(): WorldRecord | undefined {
    const p = join(this.dir, 'world.json');
    return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as WorldRecord) : undefined;
  }
  saveWorld(rec: WorldRecord): void {
    this.writeAtomic(join(this.dir, 'world.json'), rec);
  }
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

const game = new GameServer({
  online: true,
  storage: new FileStorage(DATA_DIR),
  hashPassword,
  verifyPassword,
  marketBots: process.env.MARKET_BOTS !== '0',
  // 伺服器每次啟動用不同前綴，重啟後物品 uid 也不會重複
  uidPrefix: `s${Date.now().toString(36)}`,
});

const http = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ name: '餘燼王國伺服器', online: game.onlineCount }));
});
const wss = new WebSocketServer({ server: http, maxPayload: MAX_MSG_BYTES });

wss.on('connection', (ws: WebSocket, req) => {
  let budget = MAX_MSGS_PER_SEC;
  const refill = setInterval(() => (budget = MAX_MSGS_PER_SEC), 1000);
  const conn: Conn = {
    send: (msg: ServerMsg) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    },
    close: () => ws.close(),
  };
  console.log(`[conn] ${req.socket.remoteAddress}`);
  ws.on('message', (raw) => {
    if (--budget < 0) return; // 洪水攻擊保護
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
    game.disconnect(conn);
  });
});

let last = performance.now();
setInterval(() => {
  const now = performance.now();
  game.tick(Math.min((now - last) / 1000, 0.2));
  last = now;
}, TICK_MS);

const shutdown = () => {
  console.log('saving…');
  game.saveAll();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

http.listen(PORT, () => console.log(`餘燼王國伺服器啟動：ws://localhost:${PORT}  資料：${DATA_DIR}`));
