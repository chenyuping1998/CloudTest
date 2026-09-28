/**
 * 檔案存檔：每個帳號一個 JSON，先寫暫存檔再改名，避免寫到一半當機造成壞檔。
 * 適合小型測試伺服器；正式營運請用 PgStorage（設定 DATABASE_URL）。
 */
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AccountRecord, ServerStorage, WorldRecord } from '../../src/server/GameServer';

export class FileStorage implements ServerStorage {
  private ready: Promise<void>;

  constructor(private readonly dir: string) {
    this.ready = mkdir(join(dir, 'accounts'), { recursive: true }).then(() => undefined);
  }

  private accountPath(name: string): string {
    // 用雜湊當檔名，避免中文或特殊字元造成路徑問題
    return join(this.dir, 'accounts', `${createHash('sha256').update(name).digest('hex').slice(0, 32)}.json`);
  }

  private async writeAtomic(path: string, data: unknown): Promise<void> {
    await this.ready;
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(data));
    await rename(tmp, path);
  }

  async loadAccount(name: string): Promise<AccountRecord | undefined> {
    await this.ready;
    const p = this.accountPath(name);
    if (!existsSync(p)) return undefined;
    const rec = JSON.parse(await readFile(p, 'utf8')) as AccountRecord;
    return rec.name === name ? rec : undefined;
  }

  async loadAccountBySteamId(steamId: string): Promise<AccountRecord | undefined> {
    // 檔案存檔沒有索引，只適合少量帳號
    await this.ready;
    for (const f of await readdir(join(this.dir, 'accounts'))) {
      if (!f.endsWith('.json')) continue;
      const rec = JSON.parse(await readFile(join(this.dir, 'accounts', f), 'utf8')) as AccountRecord;
      if (rec.steamId === steamId) return rec;
    }
    return undefined;
  }

  saveAccount(rec: AccountRecord): Promise<void> {
    return this.writeAtomic(this.accountPath(rec.name), rec);
  }

  async loadWorld(): Promise<WorldRecord | undefined> {
    await this.ready;
    const p = join(this.dir, 'world.json');
    return existsSync(p) ? (JSON.parse(await readFile(p, 'utf8')) as WorldRecord) : undefined;
  }

  saveWorld(rec: WorldRecord): Promise<void> {
    return this.writeAtomic(join(this.dir, 'world.json'), rec);
  }

  async audit(kind: string, actor: string, data: unknown): Promise<void> {
    await this.ready;
    await appendFile(join(this.dir, 'audit.log'), `${JSON.stringify({ at: new Date().toISOString(), kind, actor, data })}\n`);
  }
}
