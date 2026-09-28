import { describe, expect, it } from 'vitest';
import { STORAGE_CAPACITY, WEIGHT_NO_ACTION, WEIGHT_NO_REGEN } from '../src/core/character';
import { SeededRng } from '../src/core/rng';
import { ITEM_DB } from '../src/data';
import { PROTOCOL_VERSION, type ServerMsg } from '../src/net/protocol';
import { GameServer, type Conn } from '../src/server/GameServer';
import { MemoryStorage } from '../src/server/memoryStorage';
import { NPC_POSITIONS } from '../src/shared/maps';
import { give, makeChar } from './helpers';

describe('storage (倉庫)', () => {
  it('moves partial stacks both ways and keeps totals', () => {
    const c = makeChar('Keeper');
    give(c, 'iron_ore', 80);
    const ore = c.inventory.items.find((i) => i.defId === 'iron_ore')!;
    expect(c.deposit(ore.uid, 50).ok).toBe(true);
    expect(c.inventory.count('iron_ore')).toBe(30);
    expect(c.storage.count('iron_ore')).toBe(50);
    const stored = c.storage.items.find((i) => i.defId === 'iron_ore')!;
    expect(c.withdraw(stored.uid, 20).ok).toBe(true);
    expect(c.inventory.count('iron_ore') + c.storage.count('iron_ore')).toBe(80);
    // 存檔後讀回來倉庫還在
    expect(c.serialize().storage?.items.find((i) => i.defId === 'iron_ore')?.qty).toBe(30);
    expect(c.storage.capacity).toBe(STORAGE_CAPACITY);
  });

  it('rejects bad quantities and withdrawing beyond the weight limit', () => {
    const c = makeChar('Heavy');
    const sword = give(c, 'longsword');
    expect(c.deposit(sword.uid, 0).ok).toBe(false);
    expect(c.deposit(sword.uid, 2).ok).toBe(false);
    expect(c.deposit(sword.uid, 1.5).ok).toBe(false);
    expect(c.deposit('nope', 1).ok).toBe(false);
    give(c, 'iron_ore', 100);
    const ore = c.inventory.items.find((i) => i.defId === 'iron_ore')!;
    c.deposit(ore.uid, 100);
    // 把背包塞到接近上限，倉庫裡的礦石就領不出來
    const cap = c.derived().maxWeight;
    const w = ITEM_DB.get('iron_ore')!.weight;
    while (c.inventory.totalWeight() + 20 * w <= cap) give(c, 'bone', 20);
    const stored = c.storage.items.find((i) => i.defId === 'iron_ore')!;
    const r = c.withdraw(stored.uid, 100);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('負重');
    expect(c.storage.count('iron_ore')).toBe(100);
  });
});

describe('weight tiers (RO)', () => {
  it('classifies load at 50% and 90%', () => {
    const c = makeChar('Mule');
    expect(c.weightTier()).toBe('ok');
    const cap = c.derived().maxWeight;
    const w = ITEM_DB.get('bone')!.weight;
    give(c, 'bone', Math.ceil((cap * WEIGHT_NO_REGEN) / w));
    expect(c.weightTier()).toBe('heavy');
    give(c, 'bone', Math.ceil((cap * (WEIGHT_NO_ACTION - WEIGHT_NO_REGEN)) / w));
    expect(c.weightTier()).toBe('overloaded');
  });

  it('server: overloaded players cannot attack; storage works only near the keeper', async () => {
    let time = 1e6;
    const server = new GameServer({ online: false, storage: new MemoryStorage(), rng: new SeededRng(1), marketBots: false, now: () => time });
    const msgs: ServerMsg[] = [];
    const conn: Conn = { send: (m) => msgs.push(m) };
    server.handle(conn, { t: 'login', name: 'Porter', version: PROTOCOL_VERSION });
    await new Promise((r) => setTimeout(r, 0));
    const d = server.debugPlayer('Porter')!;
    const pot = d.ch.inventory.items.find((i) => i.defId === 'red_potion')!;
    // 離倉庫管理員很遠 → 拒絕
    d.setPos(-20, -20);
    server.handle(conn, { t: 'storageDeposit', uid: pot.uid, qty: 1 });
    expect(d.ch.storage.count('red_potion')).toBe(0);
    // 走到旁邊 → 成功
    const keeper = NPC_POSITIONS.find((n) => n.id === 'storage')!;
    d.setPos(keeper.x + 1, keeper.z);
    server.handle(conn, { t: 'storageDeposit', uid: pot.uid, qty: 1 });
    expect(d.ch.storage.count('red_potion')).toBe(1);
    // 超重：攻擊被拒絕
    const cap = d.ch.derived().maxWeight;
    d.give('bone', Math.ceil((cap * 0.95) / ITEM_DB.get('bone')!.weight));
    const target = server.debugMonsters('field')[0];
    d.setPos(target.x + 0.5, target.z);
    server.handle(conn, { t: 'attack', id: target.id });
    for (let i = 0; i < 20; i++) {
      time += 50;
      server.tick(0.05);
    }
    expect(server.debugMonsters('field').find((m) => m.id === target.id)!.hp).toBe(target.hp);
    expect(msgs.some((m) => m.t === 'log' && m.msg.includes('負重超過 90%'))).toBe(true);
  });
});

describe('UI descriptions', async () => {
  const { SKILLS } = await import('../src/data/skills');
  const { skillEffectLines, statPreview } = await import('../src/game/describe');
  it('every skill level has readable effect text (no NaN / undefined)', () => {
    for (const s of SKILLS) for (let lv = 1; lv <= s.maxLevel; lv++) {
      const lines = skillEffectLines(s, lv);
      expect(lines.length, `${s.id} Lv${lv}`).toBeGreaterThan(0);
      expect(lines.join(' '), `${s.id} Lv${lv}`).not.toMatch(/NaN|undefined/);
    }
  });
  it('stat preview shows what a point of STR changes', () => {
    const c = makeChar('Preview');
    const lines = statPreview(c, 'str');
    expect(lines.map((l) => l.label)).toEqual(expect.arrayContaining(['ATK', '負重上限']));
    expect(c.data.stats.str).toBe(1); // 預覽不會改到本尊
  });
});
