/**
 * 單機模式的存檔：localStorage。
 * 也會把 v0.1（舊版單機存檔格式）自動轉換成帳號資料。
 */
import type { AccountRecord, ServerStorage, WorldRecord } from './GameServer';

const PREFIX = 'realm-of-embers:';
const LEGACY_KEY = 'realm-of-embers-save-v1';

function read<T>(key: string): T | undefined {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw ? (JSON.parse(raw) as T) : undefined;
  } catch {
    return undefined;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch (e) {
    console.warn('存檔失敗', e);
  }
}

export class BrowserStorage implements ServerStorage {
  constructor() {
    this.migrateLegacy();
  }

  private migrateLegacy(): void {
    try {
      const raw = localStorage.getItem(LEGACY_KEY);
      if (!raw) return;
      const s = JSON.parse(raw);
      const name = s.character?.name;
      if (name && !read(`account:${name}`)) {
        const now = Date.now();
        write(`account:${name}`, { name, character: s.character, homestead: s.homestead, pity: s.pity ?? [], createdAt: now, lastLogin: now } satisfies AccountRecord);
        write('lastPlayer', name);
      }
      localStorage.removeItem(LEGACY_KEY);
    } catch {
      /* 壞檔就略過 */
    }
  }

  async loadAccount(name: string): Promise<AccountRecord | undefined> {
    return read<AccountRecord>(`account:${name}`);
  }

  async saveAccount(rec: AccountRecord): Promise<void> {
    write(`account:${rec.name}`, rec);
    write('lastPlayer', rec.name);
  }

  /** 同步讀取世界資料（單機模式啟動時用） */
  loadWorldSync(): WorldRecord | undefined {
    return read<WorldRecord>('world');
  }

  async loadWorld(): Promise<WorldRecord | undefined> {
    return this.loadWorldSync();
  }

  async saveWorld(rec: WorldRecord): Promise<void> {
    write('world', rec);
  }

  /** 標題畫面用：上次玩的角色 */
  static lastPlayer(): { name: string; level: number } | undefined {
    const name = read<string>('lastPlayer');
    const rec = name ? read<AccountRecord>(`account:${name}`) : undefined;
    return rec ? { name: rec.name, level: rec.character.progression.baseLevel } : undefined;
  }

  static wipe(name: string): void {
    try {
      localStorage.removeItem(`${PREFIX}account:${name}`);
    } catch {
      /* ignore */
    }
  }
}
