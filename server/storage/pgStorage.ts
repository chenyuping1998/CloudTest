/**
 * PostgreSQL 存檔（正式營運用）。
 * - accounts：一個角色一列，完整資料放 JSONB，常用查詢欄位（名稱、SteamID）獨立建索引
 * - world_state：交易所等全伺服器共用資料
 * - audit_log：交易、稀有掉落、強化蒸發等稽核紀錄
 * 接受任何有 query(text, params) 的物件：正式環境是 pg.Pool，測試用 PGlite（真正的 Postgres 引擎）。
 */
import type { AccountRecord, ServerStorage, WorldRecord } from '../../src/server/GameServer';

export interface Queryable {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  name TEXT PRIMARY KEY,
  steam_id TEXT UNIQUE,
  password_hash TEXT,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS world_state (
  key TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind TEXT NOT NULL,
  actor TEXT NOT NULL,
  data JSONB
);
CREATE INDEX IF NOT EXISTS audit_log_kind_at ON audit_log (kind, at DESC);
CREATE INDEX IF NOT EXISTS audit_log_actor_at ON audit_log (actor, at DESC);
`;

export class PgStorage implements ServerStorage {
  constructor(private readonly db: Queryable) {}

  /** 建立資料表（可重複執行） */
  async migrate(): Promise<void> {
    for (const stmt of SCHEMA.split(';').map((x) => x.trim()).filter(Boolean)) await this.db.query(stmt);
  }

  private parse(row: { data: unknown } | undefined): AccountRecord | undefined {
    if (!row) return undefined;
    return (typeof row.data === 'string' ? JSON.parse(row.data) : row.data) as AccountRecord;
  }

  async loadAccount(name: string): Promise<AccountRecord | undefined> {
    const r = await this.db.query<{ data: unknown }>('SELECT data FROM accounts WHERE name = $1', [name]);
    return this.parse(r.rows[0]);
  }

  async loadAccountBySteamId(steamId: string): Promise<AccountRecord | undefined> {
    const r = await this.db.query<{ data: unknown }>('SELECT data FROM accounts WHERE steam_id = $1', [steamId]);
    return this.parse(r.rows[0]);
  }

  async saveAccount(rec: AccountRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO accounts (name, steam_id, password_hash, data) VALUES ($1, $2, $3, $4)
       ON CONFLICT (name) DO UPDATE SET steam_id = EXCLUDED.steam_id, password_hash = EXCLUDED.password_hash, data = EXCLUDED.data, updated_at = now()`,
      [rec.name, rec.steamId ?? null, rec.passwordHash ?? null, JSON.stringify(rec)],
    );
  }

  async loadWorld(): Promise<WorldRecord | undefined> {
    const r = await this.db.query<{ data: unknown }>("SELECT data FROM world_state WHERE key = 'main'");
    const row = r.rows[0];
    if (!row) return undefined;
    return (typeof row.data === 'string' ? JSON.parse(row.data) : row.data) as WorldRecord;
  }

  async saveWorld(rec: WorldRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO world_state (key, data) VALUES ('main', $1)
       ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
      [JSON.stringify(rec)],
    );
  }

  async audit(kind: string, actor: string, data: unknown): Promise<void> {
    await this.db.query('INSERT INTO audit_log (kind, actor, data) VALUES ($1, $2, $3)', [kind, actor, JSON.stringify(data ?? null)]);
  }

  /** 營運查詢：某玩家最近的稽核紀錄 */
  async recentAudit(actor: string, limit = 50): Promise<{ at: string; kind: string; data: unknown }[]> {
    const r = await this.db.query<{ at: string; kind: string; data: unknown }>(
      'SELECT at, kind, data FROM audit_log WHERE actor = $1 ORDER BY at DESC LIMIT $2',
      [actor, limit],
    );
    return r.rows;
  }
}
