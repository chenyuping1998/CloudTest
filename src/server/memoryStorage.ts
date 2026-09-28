import type { AccountRecord, ServerStorage, WorldRecord } from './GameServer';

/** 記憶體存檔（測試用，也作為其他存檔實作的參考） */
export class MemoryStorage implements ServerStorage {
  accounts = new Map<string, AccountRecord>();
  world?: WorldRecord;
  audits: { kind: string; actor: string; data: unknown }[] = [];

  async loadAccount(name: string): Promise<AccountRecord | undefined> {
    const r = this.accounts.get(name);
    return r ? structuredClone(r) : undefined;
  }

  async loadAccountBySteamId(steamId: string): Promise<AccountRecord | undefined> {
    const r = [...this.accounts.values()].find((a) => a.steamId === steamId);
    return r ? structuredClone(r) : undefined;
  }

  async saveAccount(rec: AccountRecord): Promise<void> {
    this.accounts.set(rec.name, structuredClone(rec));
  }

  async loadWorld(): Promise<WorldRecord | undefined> {
    return this.world ? structuredClone(this.world) : undefined;
  }

  async saveWorld(rec: WorldRecord): Promise<void> {
    this.world = structuredClone(rec);
  }

  async audit(kind: string, actor: string, data: unknown): Promise<void> {
    this.audits.push({ kind, actor, data: structuredClone(data) });
  }
}
