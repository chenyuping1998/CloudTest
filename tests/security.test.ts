import { describe, expect, it } from 'vitest';
import { SeededRng } from '../src/core/rng';
import { TradeSession } from '../src/core/trade';
import { ITEM_DB } from '../src/data';
import { PROTOCOL_VERSION, type ClientMsg, type ServerMsg } from '../src/net/protocol';
import { GameServer, type Conn } from '../src/server/GameServer';
import { MemoryStorage } from '../src/server/memoryStorage';
import { give, makeChar } from './helpers';

class FakeConn implements Conn {
  msgs: ServerMsg[] = [];
  send(m: ServerMsg): void {
    this.msgs.push(m);
  }
}

async function setup() {
  const server = new GameServer({ online: false, storage: new MemoryStorage(), rng: new SeededRng(1), marketBots: false, now: () => 1e6 });
  const c = new FakeConn();
  server.handle(c, { t: 'login', name: 'Evil', version: PROTOCOL_VERSION });
  await new Promise((r) => setTimeout(r, 0));
  return { server, c, send: (m: unknown) => server.handle(c, m as ClientMsg) };
}

/** 惡意用戶端可能送的東西：原型鏈名稱、錯誤型別、極端數值 */
const HOSTILE: unknown[] = [
  { t: 'unequip', slot: '__proto__' }, { t: 'unequip', slot: 'constructor' }, { t: 'unequip', slot: 'toString' },
  { t: 'changeJob', job: 'toString' }, { t: 'changeJob', job: '__proto__' }, { t: 'changeJob', job: 'constructor' },
  { t: 'upgradeStation', station: 'toString' }, { t: 'upgradeStation', station: '__proto__' }, { t: 'upgradeStation', station: 'hasOwnProperty' },
  { t: 'interact', kind: 'station', id: 'constructor' }, { t: 'interact', kind: 'npc', id: 'toString' },
  { t: 'raiseStat', stat: '__proto__' }, { t: 'learnSkill', skill: '__proto__' }, { t: 'learnSkill', skill: { a: 1 } },
  { t: 'skill', skill: 'toString' }, { t: 'craft', recipe: '__proto__', times: 1 }, { t: 'craft', recipe: 'plank_oak', times: 1e12 },
  { t: 'npcBuy', itemId: '__proto__', qty: 1 }, { t: 'npcBuy', itemId: 'red_potion', qty: -5 }, { t: 'npcBuy', itemId: 'red_potion', qty: NaN },
  { t: 'npcSell', uid: '__proto__', qty: 1 }, { t: 'useItem', uid: { toString: 1 } }, { t: 'equip', uid: '__proto__' },
  { t: 'discard', uid: '__proto__', qty: 1 }, { t: 'chat', text: 'x'.repeat(100_000) }, { t: 'chat', text: 12 },
  { t: 'enchant', scrollUid: null, targetUid: undefined }, { t: 'compound', cardUid: '__proto__', equipUid: 'constructor' },
  { t: 'marketList', uid: 'x', qty: 1e308, price: 1e308 }, { t: 'partyKick', name: { length: 3 } },
  { t: 'tradeRequest', target: ['a'] }, { t: 'partyShare', mode: 'toString' }, { t: 'tradeGold', gold: -1e9 },
  { t: 'move', x: 1e308, z: -1e308 }, { t: 'move', x: NaN, z: 0 }, { t: 'attack', id: -1 }, { t: 'gather', node: 1e9 },
  { t: 'nope' }, { t: 5 }, null, 'string', [],
];

describe('hostile client messages', () => {
  it('never corrupt character state or crash a handler', async () => {
    const { server, c, send } = await setup();
    for (const m of HOSTILE) {
      send(m);
      for (let i = 0; i < 3; i++) server.tick(0.05);
    }
    const failures = c.msgs.filter((m) => m.t === 'log' && m.msg.includes('操作失敗'));
    expect(failures, '處理函式拋出例外').toHaveLength(0);
    const d = server.debugPlayer('Evil')!;
    expect(Number.isSafeInteger(d.ch.data.gold) && d.ch.data.gold >= 0).toBe(true);
    expect(d.ch.data.classId).toBe('novice');
    expect(Object.keys(d.ch.data.equipment).sort()).toEqual(['armor', 'weapon']);
    expect(d.ch.inventory.items.every((it) => ITEM_DB.has(it.defId) && Number.isSafeInteger(it.qty) && it.qty > 0)).toBe(true);
    expect(Object.values(d.ch.data.stats).every((v) => v === 1)).toBe(true);
    expect(Number.isFinite(d.x) && Number.isFinite(d.z)).toBe(true);
    expect(() => d.ch.derived()).not.toThrow();
  });

  it('station upgrades with prototype names cannot poison gold (regression)', async () => {
    const { server, send } = await setup();
    send({ t: 'upgradeStation', station: 'toString' });
    server.tick(0.05);
    expect(server.debugPlayer('Evil')!.ch.data.gold).toBe(500);
  });
});

describe('trade tampering after lock', () => {
  it('cancels the trade if an offered item is downgraded after both sides lock', () => {
    const a = makeChar('Seller');
    const b = makeChar('Buyer');
    const sword = give(a, 'longsword');
    sword.enchant = 8;
    b.data.gold = 100_000;
    const t = new TradeSession(ITEM_DB, a, b);
    t.setItem('a', sword.uid, 1);
    t.setGold('b', 50_000);
    t.lock('a');
    t.lock('b');
    t.confirm('b');
    // 賣家在買家確認後偷偷降級（例如強化失敗被保護卷軸 -1）
    sword.enchant = 7;
    const r = t.confirm('a');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('鎖定後被改動');
    expect(b.data.gold).toBe(100_000);
    expect(a.inventory.get(sword.uid)).toBeDefined();
  });

  it('server blocks inventory actions while a trade window is open', async () => {
    let time = 1e6;
    const server = new GameServer({ online: false, storage: new MemoryStorage(), rng: new SeededRng(1), marketBots: false, now: () => time });
    const ca = new FakeConn();
    const cb = new FakeConn();
    server.handle(ca, { t: 'login', name: 'Anna', version: PROTOCOL_VERSION });
    server.handle(cb, { t: 'login', name: 'Bert', version: PROTOCOL_VERSION });
    await new Promise((r) => setTimeout(r, 0));
    server.debugPlayer('Bert')!.setPos(server.debugPlayer('Anna')!.x + 1, server.debugPlayer('Anna')!.z);
    server.handle(ca, { t: 'tradeRequest', target: 'Bert' });
    server.handle(cb, { t: 'tradeRespond', from: 'Anna', accept: true });
    expect(ca.msgs.some((m) => m.t === 'trade' && m.view)).toBe(true);
    const pot = server.debugPlayer('Anna')!.ch.inventory.items.find((i) => i.defId === 'red_potion')!;
    const before = pot.qty;
    server.handle(ca, { t: 'discard', uid: pot.uid, qty: 1 });
    time += 50;
    server.tick(0.05);
    expect(server.debugPlayer('Anna')!.ch.inventory.get(pot.uid)!.qty).toBe(before);
    expect(ca.msgs.some((m) => m.t === 'log' && m.msg.includes('交易中無法'))).toBe(true);
  });
});
