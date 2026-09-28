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

describe('GameServer: pacing safeguards', () => {
  it('rested EXP is granted after being offline and doubles kill EXP', () => {
    const { join, server, send, advance, storage } = setup();
    const c = join('Rester');
    server.disconnect(c);
    const rec = storage.accounts.get('Rester')!;
    rec.lastLogin -= 16 * 3_600_000; // 16 小時前
    storage.accounts.set('Rester', rec);
    const c2 = join('Rester');
    expect(c2.of('log').some((l) => l.msg.includes('休息經驗'))).toBe(true);
    const dbg = server.debugPlayer('Rester')!;
    expect(dbg.ch.data.restedExp).toBeGreaterThan(0);
    dbg.ch.data.stats.str = 99;
    dbg.ch.data.stats.dex = 99;
    const slime = server.debugMonsters().find((m) => m.def === 'jelly_slime' && !m.dead)!;
    dbg.setPos(slime.x + 1, slime.z);
    send(c2, { t: 'attack', id: slime.id });
    advance(3);
    expect(c2.of('log').some((l) => l.msg.includes('休息加成'))).toBe(true);
  });
});

describe('GameServer: party', () => {
  function killSlime(s: ReturnType<typeof setup>, killer: string, conn: FakeConn) {
    const dbg = s.server.debugPlayer(killer)!;
    dbg.ch.data.stats.str = 99;
    dbg.ch.data.stats.dex = 99;
    const slime = s.server.debugMonsters().find((m) => m.def === 'jelly_slime' && !m.dead)!;
    dbg.setPos(slime.x + 1, slime.z);
    s.send(conn, { t: 'attack', id: slime.id });
    s.advance(3);
    return slime;
  }

  it('invite → accept forms a party; even share gives exp to nearby members with bonus', () => {
    const s = setup();
    const a = s.join('Leader');
    const b = s.join('Member');
    s.send(a, { t: 'partyInvite', target: 'Member' });
    expect(b.last('partyInvite')?.from).toBe('Leader');
    s.send(b, { t: 'partyRespond', from: 'Leader', accept: true });
    expect(a.last('party')?.view?.members.map((m) => m.name)).toEqual(['Leader', 'Member']);
    const slime = killSlime(s, 'Leader', a);
    s.server.debugPlayer('Member')!.setPos(slime.x + 2, slime.z);
    const expB = () => s.server.debugPlayer('Member')!.ch.progression.baseExp + s.server.debugPlayer('Member')!.ch.progression.baseLevel * 1000;
    const before = expB();
    killSlime(s, 'Leader', a);
    expect(expB()).toBeGreaterThan(before);
    expect(b.of('log').some((l) => l.msg.includes('擊敗'))).toBe(true);
  });

  it('party members share loot priority; outsiders do not', () => {
    const s = setup();
    const a = s.join('Looter');
    const b = s.join('Buddy');
    const c = s.join('Stranger');
    s.send(a, { t: 'partyInvite', target: 'Buddy' });
    s.send(b, { t: 'partyRespond', from: 'Looter', accept: true });
    killSlime(s, 'Looter', a);
    const item = a.last('snap')!.items[0];
    expect(item.party).toContain('Buddy');
    s.server.debugPlayer('Stranger')!.setPos(item.x, item.z);
    s.send(c, { t: 'pickup', id: item.id });
    s.advance(0.3);
    expect(c.of('log').some((l) => l.msg.includes('戰利品'))).toBe(true);
    s.server.debugPlayer('Buddy')!.setPos(item.x, item.z);
    s.send(b, { t: 'pickup', id: item.id });
    s.advance(0.3);
    expect(b.of('log').some((l) => l.msg.startsWith('獲得'))).toBe(true);
  });

  it('party chat with % only reaches members; leaving dissolves a 2-person party', () => {
    const s = setup();
    const a = s.join('P1');
    const b = s.join('P2');
    const c = s.join('P3');
    s.send(a, { t: 'partyInvite', target: 'P2' });
    s.send(b, { t: 'partyRespond', from: 'P1', accept: true });
    s.send(a, { t: 'chat', text: '%集合！' });
    expect(b.of('chat').some((m) => m.channel === 'party' && m.text === '集合！')).toBe(true);
    expect(c.of('chat').some((m) => m.text === '集合！')).toBe(false);
    s.send(b, { t: 'partyLeave' });
    expect(a.last('party')?.view).toBeNull();
    expect(b.last('party')?.view).toBeNull();
  });

  it('only the leader can invite, and parties are capped at 6', () => {
    const s = setup();
    const conns = ['Lead', 'M1', 'M2', 'M3', 'M4', 'M5', 'M6'].map((n) => s.join(n));
    for (let i = 1; i <= 5; i++) {
      s.send(conns[0], { t: 'partyInvite', target: `M${i}` });
      s.send(conns[i], { t: 'partyRespond', from: 'Lead', accept: true });
    }
    s.send(conns[1], { t: 'partyInvite', target: 'M6' });
    expect(conns[1].last('log')?.msg).toContain('隊長');
    s.send(conns[0], { t: 'partyInvite', target: 'M6' });
    expect(conns[0].last('log')?.msg).toContain('最多');
  });
});

describe('GameServer: second map', () => {
  it('walking into the field portal leads to the Frostwhisper Peaks and back, arriving at the portal', () => {
    const s = setup();
    const c = s.join('Explorer');
    const dbg = s.server.debugPlayer('Explorer')!;
    dbg.setPos(29.5, 8.5);
    s.send(c, { t: 'move', x: 31.5, z: 8.5 });
    s.advance(2);
    expect(c.last('zone')?.zone).toBe('frost');
    const inFrost = s.server.debugPlayer('Explorer')!;
    expect(inFrost.zone).toBe('frost');
    expect(Math.hypot(inFrost.x + 32, inFrost.z - 0.5)).toBeLessThan(4);
    expect(s.server.debugMonsters('frost').some((m) => m.def === 'frost_queen')).toBe(true);
    s.send(c, { t: 'move', x: -32, z: 0.5 });
    s.advance(3);
    expect(c.last('zone')?.zone).toBe('field');
    const back = s.server.debugPlayer('Explorer')!;
    expect(Math.hypot(back.x - 31.5, back.z - 8.5)).toBeLessThan(4);
  });
});

describe('GameServer: achievements', () => {
  it('unlocks FIRST_BLOOD once, persists it, and syncs job change / party achievements', () => {
    const s = setup();
    const a = s.join('Achiever');
    const b = s.join('Friend');
    const dbg = s.server.debugPlayer('Achiever')!;
    dbg.ch.data.stats.str = 99;
    dbg.ch.data.stats.dex = 99;
    for (let i = 0; i < 2; i++) {
      const slime = s.server.debugMonsters().find((m) => m.def === 'jelly_slime' && !m.dead)!;
      dbg.setPos(slime.x + 1, slime.z);
      s.send(a, { t: 'attack', id: slime.id });
      s.advance(3);
    }
    expect(a.of('achievement').filter((x) => x.id === 'FIRST_BLOOD')).toHaveLength(1);
    dbg.ch.progression.jobLevel = 10;
    s.send(a, { t: 'changeJob', job: 'archer' });
    s.advance(0.1);
    expect(a.of('achievement').some((x) => x.id === 'JOB_CHANGE')).toBe(true);
    s.send(a, { t: 'partyInvite', target: 'Friend' });
    s.send(b, { t: 'partyRespond', from: 'Achiever', accept: true });
    expect(b.of('achievement').some((x) => x.id === 'PARTY_UP')).toBe(true);
    s.server.disconnect(a);
    const a2 = s.join('Achiever');
    expect(a2.last('self')!.data.achievements).toContain('FIRST_BLOOD');
    s.advance(0.5);
    expect(a2.of('achievement')).toHaveLength(0);
  });
});

describe('GameServer: skills', () => {
  function swordsman(s: ReturnType<typeof setup>, name: string) {
    const c = s.join(name);
    const d = s.server.debugPlayer(name)!;
    d.ch.progression.jobLevel = 10;
    d.ch.changeJob('swordsman');
    d.ch.progression.skillPoints = 20;
    return { c, d };
  }

  it('learn via message, cast with SP and cooldown, deals damage', () => {
    const s = setup();
    const { c, d } = swordsman(s, 'Basher');
    for (let i = 0; i < 5; i++) s.send(c, { t: 'learnSkill', skill: 'bash' });
    expect(d.ch.skillLevel('bash')).toBe(5);
    const wolf = s.server.debugMonsters().find((m) => m.def === 'grey_wolf')!;
    d.setPos(wolf.x + 1, wolf.z);
    d.ch.data.sp = 100;
    s.send(c, { t: 'skill', skill: 'bash', target: wolf.id });
    s.advance(0.3);
    expect(c.of('skillUsed').some((m) => m.skill === 'bash')).toBe(true);
    expect(c.of('fx').some((f) => f.kind === 'skill' && f.text === '重擊')).toBe(true);
    expect(d.ch.data.sp).toBeLessThan(100);
    // 冷卻中再施放會被拒絕
    const spAfter = d.ch.data.sp;
    s.send(c, { t: 'skill', skill: 'bash', target: wolf.id });
    s.advance(0.05);
    expect(d.ch.data.sp).toBe(spAfter);
  });

  it('area skills hit every monster in range; unlearned skills are refused', () => {
    const s = setup();
    const { c, d } = swordsman(s, 'Boomer');
    s.send(c, { t: 'skill', skill: 'magnum_break' });
    expect(c.last('log')?.msg).toContain('尚未學會');
    d.ch.data.skills = { bash: 5, magnum_break: 10 };
    d.ch.data.stats.str = 99;
    d.ch.data.stats.dex = 99;
    d.ch.data.sp = 500;
    const slimes = s.server.debugMonsters().filter((m) => m.def === 'jelly_slime' && !m.dead);
    // 站在史萊姆群中間
    d.setPos(slimes[0].x, slimes[0].z);
    const near = s.server.debugMonsters().filter((m) => !m.dead && Math.hypot(m.x - slimes[0].x, m.z - slimes[0].z) <= 2.8).length;
    s.send(c, { t: 'skill', skill: 'magnum_break' });
    const hits = new Set(c.of('fx').filter((f) => f.kind === 'dmg' && f.color === '#ff8a3a').map((f) => f.target));
    expect(hits.size).toBe(near);
  });

  it('gold-costing skills need gold; SP shortage is reported', () => {
    const s = setup();
    const c = s.join('Moneybags');
    const d = s.server.debugPlayer('Moneybags')!;
    d.ch.progression.jobLevel = 10;
    d.ch.changeJob('merchant');
    d.ch.data.skills = { mammonite: 10 };
    d.ch.data.gold = 100;
    d.ch.data.sp = 100;
    const slime = s.server.debugMonsters().find((m) => m.def === 'jelly_slime' && !m.dead)!;
    d.setPos(slime.x + 1, slime.z);
    s.send(c, { t: 'skill', skill: 'mammonite', target: slime.id });
    s.advance(0.3);
    expect(c.of('log').some((l) => l.msg.includes('金幣不足'))).toBe(true);
    d.ch.data.gold = 10_000;
    d.ch.data.sp = 0;
    s.send(c, { t: 'skill', skill: 'mammonite', target: slime.id });
    s.advance(0.3);
    expect(c.of('log').some((l) => l.msg.includes('SP 不足'))).toBe(true);
  });

  it('second job change through the server grants the achievement', () => {
    const s = setup();
    const { c, d } = swordsman(s, 'Veteran');
    d.ch.progression.jobLevel = 40;
    s.send(c, { t: 'changeJob', job: 'wizard' });
    expect(d.ch.data.classId).toBe('swordsman');
    s.send(c, { t: 'changeJob', job: 'knight' });
    expect(d.ch.data.classId).toBe('knight');
    s.advance(0.1);
    expect(c.of('achievement').some((a) => a.id === 'SECOND_JOB')).toBe(true);
  });
});
