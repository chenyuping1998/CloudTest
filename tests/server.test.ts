import { describe, expect, it } from 'vitest';
import { SeededRng } from '../src/core/rng';
import type { ClientMsg, ServerMsg } from '../src/net/protocol';
import { PROTOCOL_VERSION } from '../src/net/protocol';
import { GameServer, type Conn } from '../src/server/GameServer';
import { MemoryStorage } from '../src/server/memoryStorage';
import { NPC_POSITIONS } from '../src/shared/maps';

class FakeConn implements Conn {
  msgs: ServerMsg[] = [];
  send(m: ServerMsg): void {
    this.msgs.push(JSON.parse(JSON.stringify(m)));
  }
  of<T extends ServerMsg['t']>(t: T): Extract<ServerMsg, { t: T }>[] {
    return this.msgs.filter((m) => m.t === t) as Extract<ServerMsg, { t: T }>[];
  }
  last<T extends ServerMsg['t']>(t: T): Extract<ServerMsg, { t: T }> | undefined {
    const xs = this.of(t);
    return xs[xs.length - 1];
  }
}

function setup(online = false) {
  let time = 1_000_000;
  const storage = new MemoryStorage();
  const server = new GameServer({
    online, storage, rng: new SeededRng(1), marketBots: false, now: () => time,
    hashPassword: (p) => `h:${p}`, verifyPassword: (p, h) => h === `h:${p}`,
  });
  const advance = (sec: number, step = 0.05) => {
    for (let t = 0; t < sec; t += step) {
      time += step * 1000;
      server.tick(step);
    }
  };
  const join = (name: string, password?: string) => {
    const c = new FakeConn();
    server.handle(c, { t: 'login', name, password, version: PROTOCOL_VERSION });
    return c;
  };
  const send = (c: FakeConn, m: ClientMsg) => server.handle(c, m);
  return { server, storage, advance, join, send, now: () => time };
}

describe('GameServer: login & persistence', () => {
  it('offline login creates a character with starter gear and sends state', () => {
    const { join } = setup();
    const c = join('測試者');
    expect(c.last('welcome')?.name).toBe('測試者');
    expect(c.last('zone')?.zone).toBe('field');
    const self = c.last('self')!.data;
    expect(self.equipment.weapon?.defId).toBe('novice_knife');
    expect(self.inventory.items.some((i) => i.defId === 'red_potion')).toBe(true);
  });

  it('online mode requires the right password and rejects duplicate logins', () => {
    const { join, server, storage } = setup(true);
    const c = join('Alice', 'secret');
    expect(c.last('welcome')).toBeDefined();
    expect(join('Alice', 'secret').last('loginFailed')?.reason).toContain('線上');
    server.disconnect(c);
    expect(storage.accounts.get('Alice')?.passwordHash).toBe('h:secret');
    expect(join('Alice', 'wrong').last('loginFailed')?.reason).toBe('密碼錯誤。');
    expect(join('Alice', 'secret').last('welcome')).toBeDefined();
  });

  it('rejects bad names and wrong protocol versions', () => {
    const { server } = setup();
    const c = new FakeConn();
    server.handle(c, { t: 'login', name: '<script>', version: PROTOCOL_VERSION });
    expect(c.last('loginFailed')).toBeDefined();
    server.handle(c, { t: 'login', name: 'Bob', version: 999 });
    expect(c.last('loginFailed')?.reason).toContain('版本');
  });

  it('progress survives logout / login', () => {
    const { join, server, send } = setup();
    const c = join('Saver');
    send(c, { t: 'raiseStat', stat: 'str' });
    server.disconnect(c);
    const c2 = join('Saver');
    expect(c2.last('self')!.data.stats.str).toBe(2);
  });
});

describe('GameServer: movement & combat', () => {
  it('moves the player toward the clicked point, server-side', () => {
    const { join, send, advance, server } = setup();
    const c = join('Walker');
    const start = server.debugPlayer('Walker')!;
    send(c, { t: 'move', x: start.x + 3, z: start.z });
    advance(2);
    expect(server.debugPlayer('Walker')!.x).toBeCloseTo(start.x + 3, 1);
    expect(c.of('snap').length).toBeGreaterThan(5);
  });

  it('killing a monster grants exp and drops loot with loot priority', () => {
    const { join, send, advance, server } = setup();
    const a = join('Hunter');
    const b = join('Thief');
    const dbg = server.debugPlayer('Hunter')!;
    dbg.ch.data.stats.str = 99; // 一擊必殺
    dbg.ch.data.stats.dex = 99;
    const slime = server.debugMonsters().find((m) => m.def === 'jelly_slime')!;
    dbg.setPos(slime.x + 1, slime.z);
    send(a, { t: 'attack', id: slime.id });
    advance(3);
    expect(server.debugMonsters().find((m) => m.id === slime.id)!.dead).toBe(true);
    expect(a.of('log').some((l) => l.msg.includes('擊敗'))).toBe(true);
    const items = a.last('snap')!.items;
    expect(items.length).toBeGreaterThan(0); // 果凍 70%（seed 固定）
    expect(items[0].owner).toBe('Hunter');
    // 其他玩家在優先權期間撿不到
    server.debugPlayer('Thief')!.setPos(items[0].x, items[0].z);
    send(b, { t: 'pickup', id: items[0].id });
    advance(0.5);
    expect(b.of('log').some((l) => l.msg.includes('戰利品'))).toBe(true);
    // 擁有者可以撿
    send(a, { t: 'pickup', id: items[0].id });
    advance(2);
    expect(a.of('log').some((l) => l.msg.startsWith('獲得'))).toBe(true);
  });

  it('ignores attacks on invalid targets and malformed messages', () => {
    const { join, send, advance, server } = setup();
    const c = join('Hacker');
    send(c, { t: 'attack', id: 999999 });
    send(c, { t: 'move', x: NaN, z: 1 } as ClientMsg);
    server.handle(c, { t: 'nonsense' } as unknown as ClientMsg);
    server.handle(c, null as unknown as ClientMsg);
    advance(0.5);
    expect(server.debugPlayer('Hacker')).toBeDefined();
  });
});

describe('GameServer: economy', () => {
  it('crafting is only allowed in your own homestead near the station', () => {
    const { join, send } = setup();
    const c = join('Crafter');
    send(c, { t: 'craft', recipe: 'plank_oak', times: 1 });
    expect(c.last('log')?.msg).toContain('家園');
  });

  it('player-to-player trade via messages swaps items atomically', () => {
    const { join, send, advance, server } = setup();
    const a = join('Alice');
    const b = join('Bob');
    server.debugPlayer('Bob')!.setPos(server.debugPlayer('Alice')!.x + 1, server.debugPlayer('Alice')!.z);
    const potion = a.last('self')!.data.inventory.items.find((i) => i.defId === 'red_potion')!;
    send(a, { t: 'tradeRequest', target: 'Bob' });
    expect(b.last('tradeInvite')?.from).toBe('Alice');
    send(b, { t: 'tradeRespond', from: 'Alice', accept: true });
    expect(a.last('trade')?.view?.partner).toBe('Bob');
    send(a, { t: 'tradeItem', uid: potion.uid, qty: 4 });
    send(b, { t: 'tradeGold', gold: 100 });
    expect(b.last('trade')!.view!.theirs.items[0].qty).toBe(4);
    send(a, { t: 'tradeLock' });
    send(b, { t: 'tradeLock' });
    send(a, { t: 'tradeConfirm' });
    send(b, { t: 'tradeConfirm' });
    advance(0.1);
    expect(a.last('trade')?.view).toBeNull();
    const aSelf = a.last('self')!.data;
    const bSelf = b.last('self')!.data;
    expect(aSelf.inventory.items.find((i) => i.defId === 'red_potion')!.qty).toBe(6);
    expect(bSelf.inventory.items.filter((i) => i.defId === 'red_potion').reduce((s, i) => s + i.qty, 0)).toBe(14);
    expect(aSelf.gold).toBe(600);
    expect(bSelf.gold).toBe(400);
  });

  it('shared exchange: one player lists, another buys, seller is paid live', () => {
    const { join, send, advance, server } = setup();
    const a = join('Seller');
    const b = join('Buyer');
    const npc = NPC_POSITIONS.find((n) => n.id === 'market')!;
    server.debugPlayer('Seller')!.setPos(npc.x + 1, npc.z);
    server.debugPlayer('Buyer')!.setPos(npc.x - 1, npc.z);
    const potion = a.last('self')!.data.inventory.items.find((i) => i.defId === 'red_potion')!;
    send(a, { t: 'marketList', uid: potion.uid, qty: 5, price: 200 });
    const listing = a.last('market')!.view.listings.find((l) => l.seller === 'Seller')!;
    expect(listing.item.qty).toBe(5);
    send(b, { t: 'marketBuy', id: listing.id });
    advance(0.1);
    expect(b.last('self')!.data.gold).toBe(300);
    expect(a.last('self')!.data.gold).toBe(500 - 10 + 190);
    expect(a.of('announce').some((m) => m.msg.includes('Buyer'))).toBe(true);
  });

  it('market actions require standing near the exchange NPC', () => {
    const { join, send, server } = setup();
    const a = join('Faraway');
    server.debugPlayer('Faraway')!.setPos(20, 20);
    send(a, { t: 'marketBuy', id: 'x' });
    expect(a.last('log')?.msg).toContain('NPC');
  });

  it('chat is broadcast and rate limited', () => {
    const { join, send, advance } = setup();
    const a = join('Talker');
    const b = join('Listener');
    send(a, { t: 'chat', text: '  哈囉！ ' });
    send(a, { t: 'chat', text: 'spam' });
    expect(b.of('chat').filter((m) => m.from === 'Talker').map((m) => m.text)).toEqual(['哈囉！']);
    advance(1);
    send(a, { t: 'chat', text: 'again' });
    expect(b.last('chat')?.text).toBe('again');
  });
});
