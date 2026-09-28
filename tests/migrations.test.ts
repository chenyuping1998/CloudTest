import { describe, expect, it } from 'vitest';
import { SeededRng } from '../src/core/rng';
import { initialHomestead } from '../src/data';
import { PROTOCOL_VERSION, type ServerMsg } from '../src/net/protocol';
import { GameServer, type AccountRecord } from '../src/server/GameServer';
import { MemoryStorage } from '../src/server/memoryStorage';
import { migrateAccount, migrateWorld, MIGRATIONS, SAVE_VERSION } from '../src/server/migrations';
import { makeChar } from './helpers';

const item = (defId: string, qty = 1, extra: Record<string, unknown> = {}) =>
  ({ uid: `old-${defId}-${qty}`, defId, qty, enchant: 0, cards: [], bound: false, origin: { kind: 'system', at: 0 }, ...extra });

/** 模擬最早期的存檔：沒有 version、沒有技能 / 成就 / 倉庫欄位，還帶著已被刪除的東西 */
function legacyRecord(): AccountRecord {
  const c = makeChar('Oldtimer').serialize() as unknown as Record<string, unknown>;
  delete c.restedExp;
  delete c.achievements;
  delete c.skills;
  delete c.buffs;
  delete c.storage;
  const ch = c as unknown as AccountRecord['character'];
  ch.inventory.items.push(item('removed_legacy_item', 5) as never, item('longsword', 1, { cards: ['card_that_was_deleted'] }) as never);
  ch.equipment.helm = item('longsword') as never; // 武器被塞在頭盔欄
  (ch as { skills?: Record<string, number> }).skills = { bash: 3, deleted_skill: 4 };
  ch.progression.skillPoints = 0;
  return { name: 'Oldtimer', character: ch, homestead: initialHomestead(), pity: [], createdAt: 0, lastLogin: 0 };
}

describe('save migrations', () => {
  it('versions are strictly increasing and SAVE_VERSION is the last one', () => {
    const tos = MIGRATIONS.map((m) => m.to);
    expect(tos).toEqual([...tos].sort((a, b) => a - b));
    expect(new Set(tos).size).toBe(tos.length);
    expect(tos[tos.length - 1]).toBe(SAVE_VERSION);
  });

  it('upgrades a legacy save and removes things that no longer exist', () => {
    const { rec, report } = migrateAccount(legacyRecord());
    expect(report.from).toBe(0);
    expect(rec.version).toBe(SAVE_VERSION);
    const c = rec.character;
    expect(c.storage).toBeDefined();
    expect(c.achievements).toEqual([]);
    expect(c.inventory.items.some((i) => i.defId === 'removed_legacy_item')).toBe(false);
    expect(c.inventory.items.find((i) => i.defId === 'longsword' && i.uid.startsWith('old'))?.cards).toEqual([]);
    // 放錯部位的裝備回到背包
    expect(c.equipment.helm).toBeUndefined();
    expect(c.inventory.items.filter((i) => i.defId === 'longsword')).toHaveLength(2);
    // 刪除的技能退還點數
    expect(c.skills).toEqual({ bash: 3 });
    expect(c.progression.skillPoints).toBe(4);
    expect(report.fixes.length).toBeGreaterThanOrEqual(4);
  });

  it('is idempotent: migrating a current save changes nothing', () => {
    const once = migrateAccount(legacyRecord()).rec;
    const twice = migrateAccount(once);
    expect(twice.report.fixes).toEqual([]);
    expect(twice.rec).toEqual(once);
  });

  it('a legacy save logs in cleanly and the fix is audited', async () => {
    const storage = new MemoryStorage();
    storage.accounts.set('Oldtimer', legacyRecord());
    const server = new GameServer({ online: false, storage, rng: new SeededRng(1), marketBots: false, now: () => 1e6 });
    const msgs: ServerMsg[] = [];
    server.handle({ send: (m) => msgs.push(m) }, { t: 'login', name: 'Oldtimer', version: PROTOCOL_VERSION });
    await new Promise((r) => setTimeout(r, 0));
    expect(msgs.some((m) => m.t === 'welcome')).toBe(true);
    expect(() => server.debugPlayer('Oldtimer')!.ch.derived()).not.toThrow();
    expect(storage.audits.some((a) => a.kind === 'save_migrated' && a.actor === 'Oldtimer')).toBe(true);
    await server.saveAll();
    expect(storage.accounts.get('Oldtimer')!.version).toBe(SAVE_VERSION);
  });

  it('drops market listings for deleted items', () => {
    const world = {
      uidCounter: 1,
      market: {
        listings: [
          { id: 'a', seller: 'X', item: item('removed_legacy_item'), price: 10, listedAt: 0, expiresAt: 1e12 },
          { id: 'b', seller: 'Y', item: item('longsword'), price: 10, listedAt: 0, expiresAt: 1e12 },
        ],
        history: [], stats: { feesCollected: 0, taxCollected: 0, volume: 0 }, pendingPayouts: [],
      },
    } as unknown as Parameters<typeof migrateWorld>[0];
    const { rec, fixes } = migrateWorld(world);
    expect(rec.market.listings.map((l) => l.id)).toEqual(['b']);
    expect(fixes).toHaveLength(1);
  });
});
