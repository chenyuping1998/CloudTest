import { describe, expect, it } from 'vitest';
import { baseExpToNext } from '../src/core/leveling';
import { acceptQuest, questDay, questEvent, questLog, questStatus, turnInQuest } from '../src/core/quests';
import { SeededRng } from '../src/core/rng';
import { ITEM_DB, MONSTER_DB, RECIPE_DB } from '../src/data';
import { QUEST_DB, QUESTS } from '../src/data/quests';
import { PROTOCOL_VERSION, type ServerMsg } from '../src/net/protocol';
import { GameServer } from '../src/server/GameServer';
import { MemoryStorage } from '../src/server/memoryStorage';
import { NPC_POSITIONS, ZONE_NAMES } from '../src/shared/maps';
import { give, makeChar, uids } from './helpers';

const DAY = questDay(1e12);

describe('quest data', () => {
  it('every reference points at something that exists', () => {
    for (const q of QUESTS) {
      if (q.requires?.quest) expect(QUEST_DB.has(q.requires.quest), q.id).toBe(true);
      for (const [id] of q.reward.items ?? []) expect(ITEM_DB.has(id), `${q.id} reward ${id}`).toBe(true);
      for (const o of q.objectives) {
        if (o.kind === 'kill') expect(MONSTER_DB.has(o.monster), `${q.id} ${o.monster}`).toBe(true);
        if (o.kind === 'collect') expect(ITEM_DB.has(o.item), `${q.id} ${o.item}`).toBe(true);
        if (o.kind === 'craft') expect(RECIPE_DB.has(o.recipe), `${q.id} ${o.recipe}`).toBe(true);
        if (o.kind === 'visit') expect(o.zone in ZONE_NAMES).toBe(true);
      }
    }
  });

  it('tutorial EXP stays small relative to the leveling curve (< 20% of Lv 1→10)', () => {
    let need = 0;
    for (let l = 1; l < 10; l++) need += baseExpToNext(l);
    const tutorial = QUESTS.filter((q) => !q.daily && !q.requires?.level).reduce((s, q) => s + (q.reward.baseExp ?? 0), 0);
    expect(tutorial / need).toBeLessThan(0.2);
  });

  it('daily bounties give at most ~half the EXP of the 30 kills they ask for', () => {
    for (const q of QUESTS.filter((x) => x.daily)) {
      const o = q.objectives[0] as { monster: string; count: number };
      const m = MONSTER_DB.get(o.monster)!;
      expect((q.reward.baseExp ?? 0) / (m.baseExp * o.count), q.id).toBeLessThanOrEqual(0.5);
    }
  });
});

describe('quest progress', () => {
  it('kill quest: locked → available → active → ready → done', () => {
    const c = makeChar('Hunter');
    const hunt = QUEST_DB.get('q_first_hunt')!;
    expect(questStatus(c, hunt, DAY)).toBe('locked');
    questLog(c).done.push('q_welcome');
    expect(questStatus(c, hunt, DAY)).toBe('available');
    expect(acceptQuest(c, 'q_first_hunt', DAY).ok).toBe(true);
    for (let i = 0; i < 4; i++) questEvent(c, { kind: 'kill', monster: 'jelly_slime' });
    questEvent(c, { kind: 'kill', monster: 'grey_wolf' });
    expect(questStatus(c, hunt, DAY)).toBe('active');
    questEvent(c, { kind: 'kill', monster: 'jelly_slime' });
    expect(questStatus(c, hunt, DAY)).toBe('ready');
    // 超過目標不會再累加
    expect(questEvent(c, { kind: 'kill', monster: 'jelly_slime' })).toHaveLength(0);
    const gold = c.data.gold;
    expect(turnInQuest(c, 'q_first_hunt', DAY, ITEM_DB, uids, 0).ok).toBe(true);
    expect(c.data.gold).toBe(gold + 200);
    expect(questStatus(c, hunt, DAY)).toBe('done');
    expect(acceptQuest(c, 'q_first_hunt', DAY).ok).toBe(false);
  });

  it('collect quest consumes the items only on turn-in, and only if complete', () => {
    const c = makeChar('Gatherer');
    questLog(c).done.push('q_welcome', 'q_first_hunt');
    acceptQuest(c, 'q_jelly', DAY);
    give(c, 'jelly', 5);
    expect(turnInQuest(c, 'q_jelly', DAY, ITEM_DB, uids, 0).ok).toBe(false);
    expect(c.inventory.count('jelly')).toBe(5);
    give(c, 'jelly', 5);
    expect(turnInQuest(c, 'q_jelly', DAY, ITEM_DB, uids, 0).ok).toBe(true);
    expect(c.inventory.count('jelly')).toBe(2);
    expect(c.inventory.count('orange_potion')).toBeGreaterThanOrEqual(5);
  });

  it('daily bounty can be done once per day and again the next day', () => {
    const c = makeChar('Daily');
    questLog(c).done.push('q_welcome', 'q_first_hunt');
    const id = 'd_jelly_slime';
    expect(acceptQuest(c, id, DAY).ok).toBe(true);
    for (let i = 0; i < 30; i++) questEvent(c, { kind: 'kill', monster: 'jelly_slime' });
    expect(turnInQuest(c, id, DAY, ITEM_DB, uids, 0).ok).toBe(true);
    expect(questStatus(c, QUEST_DB.get(id)!, DAY)).toBe('done');
    expect(questStatus(c, QUEST_DB.get(id)!, DAY + 1)).toBe('available');
  });

  it('refuses turn-in when reward items do not fit', () => {
    const c = makeChar('Packrat');
    questLog(c).done.push('q_welcome', 'q_first_hunt', 'q_jelly');
    // 塞滿背包（每把劍佔一格）
    while (c.inventory.usedSlots < c.inventory.capacity) give(c, 'knife');
    questLog(c).active.push({ id: 'q_plank', progress: [3] });
    questLog(c).done.push('q_home', 'q_wood');
    const r = turnInQuest(c, 'q_plank', DAY, ITEM_DB, uids, 0);
    expect(r.ok).toBe(false);
    expect(questLog(c).active.some((a) => a.id === 'q_plank')).toBe(true);
  });
});

describe('quests through the server', () => {
  it('tutorial: accept at Luna, talk to the shop, turn in for potions', async () => {
    const server = new GameServer({ online: false, storage: new MemoryStorage(), rng: new SeededRng(1), marketBots: false, now: () => 1e12 });
    const msgs: ServerMsg[] = [];
    const conn = { send: (m: ServerMsg) => msgs.push(m) };
    server.handle(conn, { t: 'login', name: 'Newbie', version: PROTOCOL_VERSION });
    await new Promise((r) => setTimeout(r, 0));
    const d = server.debugPlayer('Newbie')!;
    const at = (id: string) => {
      const n = NPC_POSITIONS.find((x) => x.id === id)!;
      d.setPos(n.x + 0.8, n.z);
    };
    // 離太遠不能接
    d.setPos(-20, -20);
    server.handle(conn, { t: 'questAccept', id: 'q_welcome' });
    expect(d.ch.data.quests?.active ?? []).toHaveLength(0);
    at('guide');
    server.handle(conn, { t: 'questAccept', id: 'q_welcome' });
    expect(d.ch.data.quests!.active.map((a) => a.id)).toEqual(['q_welcome']);
    // 走到商人旁邊互動
    at('shop');
    server.handle(conn, { t: 'interact', kind: 'npc', id: 'shop' });
    server.tick(0.05);
    expect(questStatus(d.ch, QUEST_DB.get('q_welcome')!, questDay(1e12))).toBe('ready');
    at('guide');
    const pots = d.ch.inventory.count('red_potion');
    server.handle(conn, { t: 'questTurnIn', id: 'q_welcome' });
    expect(d.ch.inventory.count('red_potion')).toBe(pots + 10);
    expect(d.ch.data.quests!.done).toContain('q_welcome');
    expect(msgs.some((m) => m.t === 'sfx' && m.name === 'quest')).toBe(true);
  });
});
