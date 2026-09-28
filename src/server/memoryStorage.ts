import type { AccountRecord, ServerStorage, WorldRecord } from './GameServer';

/** 記憶體存檔（測試用，也作為其他存檔實作的參考） */
export class MemoryStorage implements ServerStorage {
  accounts = new Map<string, AccountRecord>();
  world?: WorldRecord;

  loadAccount(name: string): AccountRecord | undefined {
    const r = this.accounts.get(name);
    return r ? structuredClone(r) : undefined;
  }

  saveAccount(rec: AccountRecord): void {
    this.accounts.set(rec.name, structuredClone(rec));
  }

  loadWorld(): WorldRecord | undefined {
    return this.world ? structuredClone(this.world) : undefined;
  }

  saveWorld(rec: WorldRecord): void {
    this.world = structuredClone(rec);
  }
}
