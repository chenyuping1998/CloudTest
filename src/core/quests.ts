/**
 * 任務進度（純邏輯，伺服器權威執行；用戶端用同一份程式顯示進度）。
 *
 * 進度分兩種：
 * - 事件型（擊殺、製作、造訪、對話）：存在 progress 陣列，由伺服器在事件發生時累加
 * - 狀態型（收集、職業階級）：每次都看目前狀態，不存（丟掉物品進度就會倒退，符合直覺）
 */
import type { Character } from './character';
import { createItem, type ItemDb, type UidGen } from './items';
import { CLASSES } from '../data/classes';
import { MAX_ACTIVE_QUESTS, QUEST_DB, type QuestDef, type QuestObjective, type QuestReward } from '../data/quests';
import type { NpcId, ZoneId } from '../shared/maps';

export interface QuestLog {
  active: { id: string; progress: number[] }[];
  done: string[];
  /** 每日任務最後完成的日子（questDay） */
  dailyDone: Record<string, number>;
}

export type QuestEvent =
  | { kind: 'kill'; monster: string }
  | { kind: 'craft'; recipe: string; count: number }
  | { kind: 'visit'; zone: ZoneId }
  | { kind: 'talk'; npc: NpcId };

export type QuestStatus = 'locked' | 'available' | 'active' | 'ready' | 'done';

/** 每日重置：台灣時間（UTC+8）午夜 */
export function questDay(now: number): number {
  return Math.floor((now + 8 * 3_600_000) / 86_400_000);
}

export function questLog(ch: Character): QuestLog {
  const d = ch.data;
  d.quests ??= { active: [], done: [], dailyDone: {} };
  d.quests.dailyDone ??= {};
  return d.quests;
}

function tierOf(ch: Character): number {
  return CLASSES[ch.data.classId].tier ?? 0;
}

export function objectiveProgress(ch: Character, o: QuestObjective, stored: number): { have: number; need: number } {
  switch (o.kind) {
    case 'collect': return { have: Math.min(o.count, ch.inventory.count(o.item)), need: o.count };
    case 'tier': return { have: tierOf(ch) >= o.tier ? 1 : 0, need: 1 };
    case 'kill':
    case 'craft': return { have: Math.min(o.count, stored), need: o.count };
    case 'visit':
    case 'talk': return { have: Math.min(1, stored), need: 1 };
  }
}

export function questStatus(ch: Character, def: QuestDef, day: number): QuestStatus {
  const log = questLog(ch);
  const act = log.active.find((a) => a.id === def.id);
  if (act) return def.objectives.every((o, i) => { const p = objectiveProgress(ch, o, act.progress[i] ?? 0); return p.have >= p.need; }) ? 'ready' : 'active';
  if (def.daily ? log.dailyDone[def.id] === day : log.done.includes(def.id)) return 'done';
  const r = def.requires;
  const lv = ch.progression.baseLevel;
  if (r?.quest && !log.done.includes(r.quest)) return 'locked';
  if (r?.level && lv < r.level) return 'locked';
  if (r?.maxLevel && lv > r.maxLevel) return 'locked';
  if (r?.tier && tierOf(ch) < r.tier) return 'locked';
  return 'available';
}

/** NPC 頭上的記號：? = 有任務可以回報（優先），! = 有新任務可接 */
export function npcQuestMarker(ch: Character, npc: NpcId, day: number): '!' | '?' | undefined {
  let marker: '!' | undefined;
  for (const def of QUEST_DB.values()) {
    if (def.giver !== npc) continue;
    const st = questStatus(ch, def, day);
    if (st === 'ready') return '?';
    if (st === 'available') marker = '!';
  }
  return marker;
}

export function acceptQuest(ch: Character, id: string, day: number): { ok: boolean; reason?: string } {
  const def = QUEST_DB.get(id);
  if (!def) return { ok: false, reason: '沒有這個任務' };
  const st = questStatus(ch, def, day);
  if (st !== 'available') return { ok: false, reason: st === 'locked' ? '還不能接這個任務' : '已經接過了' };
  const log = questLog(ch);
  if (log.active.length >= MAX_ACTIVE_QUESTS) return { ok: false, reason: `最多同時進行 ${MAX_ACTIVE_QUESTS} 個任務` };
  log.active.push({ id, progress: def.objectives.map(() => 0) });
  return { ok: true };
}

export function abandonQuest(ch: Character, id: string): boolean {
  const log = questLog(ch);
  const i = log.active.findIndex((a) => a.id === id);
  if (i < 0) return false;
  log.active.splice(i, 1);
  return true;
}

/** 事件發生時累加進度；回傳有進度的任務（用來通知玩家） */
export function questEvent(ch: Character, ev: QuestEvent): { def: QuestDef; objective: number; have: number; need: number }[] {
  const out: { def: QuestDef; objective: number; have: number; need: number }[] = [];
  for (const act of questLog(ch).active) {
    const def = QUEST_DB.get(act.id);
    if (!def) continue;
    def.objectives.forEach((o, i) => {
      let add = 0;
      if (ev.kind === 'kill' && o.kind === 'kill' && o.monster === ev.monster) add = 1;
      else if (ev.kind === 'craft' && o.kind === 'craft' && o.recipe === ev.recipe) add = ev.count;
      else if (ev.kind === 'visit' && o.kind === 'visit' && o.zone === ev.zone) add = 1;
      else if (ev.kind === 'talk' && o.kind === 'talk' && o.npc === ev.npc) add = 1;
      if (!add) return;
      const before = objectiveProgress(ch, o, act.progress[i] ?? 0);
      if (before.have >= before.need) return;
      act.progress[i] = (act.progress[i] ?? 0) + add;
      const p = objectiveProgress(ch, o, act.progress[i]);
      out.push({ def, objective: i, ...p });
    });
  }
  return out;
}

/**
 * 交任務：全部檢查通過才動手（先確認收集物、背包空間），
 * 回傳經驗讓伺服器走一般的升級流程（升級公告、成就）。
 */
export function turnInQuest(ch: Character, id: string, day: number, db: ItemDb, uids: UidGen, now: number): { ok: boolean; reason?: string; reward?: QuestReward } {
  const def = QUEST_DB.get(id);
  if (!def) return { ok: false, reason: '沒有這個任務' };
  if (questStatus(ch, def, day) !== 'ready') return { ok: false, reason: '任務目標還沒完成' };
  const items = (def.reward.items ?? []).map(([itemId, qty]) => createItem(db, uids, itemId, qty, { kind: 'quest', sourceId: def.id, at: now }));
  // 收集物交出去之後會空出位置，但保守起見用「交出前」的背包計算
  if (!ch.inventory.canAdd(items)) return { ok: false, reason: '背包空間不足，請先整理背包' };
  for (const o of def.objectives) if (o.kind === 'collect' && o.consume) ch.inventory.consume(o.item, o.count);
  for (const it of items) ch.inventory.add(it);
  ch.data.gold += def.reward.gold ?? 0;
  const log = questLog(ch);
  log.active = log.active.filter((a) => a.id !== id);
  if (def.daily) log.dailyDone[id] = day;
  else if (!log.done.includes(id)) log.done.push(id);
  return { ok: true, reward: def.reward };
}
