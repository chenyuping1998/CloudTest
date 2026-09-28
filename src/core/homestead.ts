/**
 * 家園系統：採礦、伐木、加工與製作。
 * 經營循環：採集原料 → 熔煉/加工 → 製作裝備、藥水、強化卷軸 → 自用或上市場賣。
 * 生產的物品都會帶「製作者」名稱（RO 鍛造武器的經典設計），讓生產玩家有品牌。
 */
import type { Character, LifeSkillId } from './character';
import { rollDrops, type DropEntry, type DropResult, type TreasurePool } from './drops';
import { createItem, getDef, type ItemDb, type UidGen } from './items';
import { addLifeSkillExp } from './leveling';
import type { Rng } from './rng';
import type { ItemInstance } from './types';

export type NodeKind = 'ore' | 'tree';

export interface ResourceNodeDef {
  id: string;
  name: string;
  kind: NodeKind;
  /** 需要的工具階級 (1 石、2 鐵、3 秘銀) */
  toolTier: number;
  skillReq: number;
  /** 敲幾下會枯竭 */
  hits: number;
  respawnSec: number;
  exp: number;
  /** 每一下擲的掉落（與怪物共用同一套掉寶引擎） */
  yields: DropEntry[];
  homesteadLevelReq: number;
  color: string;
}

export interface NodeState {
  defId: string;
  hitsLeft: number;
  /** 枯竭時間戳；undefined 表示可採集 */
  depletedAt?: number;
}

export interface GatherResult {
  ok: boolean;
  reason?: string;
  drops: DropResult[];
  items: ItemInstance[];
  expGained: number;
  levelUps: number;
  depleted: boolean;
}

export function nodeSkill(kind: NodeKind): LifeSkillId {
  return kind === 'ore' ? 'mining' : 'woodcutting';
}

export function refreshNode(state: NodeState, def: ResourceNodeDef, now: number): void {
  if (state.depletedAt !== undefined && now - state.depletedAt >= def.respawnSec * 1000) {
    state.depletedAt = undefined;
    state.hitsLeft = def.hits;
  }
}

export function bestTool(ch: Character, db: ItemDb, kind: NodeKind): number {
  const want = kind === 'ore' ? 'pickaxe' : 'axe';
  let best = 0;
  const candidates = [...ch.inventory.items, ...Object.values(ch.data.equipment)];
  for (const it of candidates) {
    const d = getDef(db, it.defId);
    if (d.toolKind === want) best = Math.max(best, d.toolTier ?? 0);
  }
  return best;
}

export function gather(
  ch: Character,
  state: NodeState,
  def: ResourceNodeDef,
  db: ItemDb,
  uids: UidGen,
  rng: Rng,
  now: number,
): GatherResult {
  const fail = (reason: string): GatherResult => ({ ok: false, reason, drops: [], items: [], expGained: 0, levelUps: 0, depleted: false });
  refreshNode(state, def, now);
  if (state.depletedAt !== undefined) return fail('資源已枯竭，稍後再來');
  const skillId = nodeSkill(def.kind);
  const skill = ch.data.lifeSkills[skillId];
  if (skill.level < def.skillReq) return fail(`需要${skillId === 'mining' ? '採礦' : '伐木'}等級 ${def.skillReq}`);
  const tier = bestTool(ch, db, def.kind);
  if (tier < def.toolTier) return fail(`需要 ${def.toolTier} 階以上的${def.kind === 'ore' ? '礦鎬' : '斧頭'}`);

  // 生活技能等級 → 稀有產出加成（每級 +1%），工具階級超出需求也有加成
  const drops = rollDrops(
    { sourceId: def.id, drops: def.yields },
    db,
    new Map<string, TreasurePool>(),
    {
      playerLevel: skill.level,
      sourceLevel: skill.level, // 生活技能不套用等級差懲罰
      luk: ch.derived().totalStats.luk,
      personalBonusPct: skill.level + (tier - def.toolTier) * 10,
      eventMultiplier: 1,
    },
    rng,
  );
  const items = drops.map((d) => createItem(db, uids, d.itemId, d.qty, { kind: 'gather', sourceId: def.id, at: now }));
  if (!ch.inventory.canAdd(items)) return fail('背包已滿');
  for (const it of items) ch.inventory.add(it);

  state.hitsLeft--;
  const depleted = state.hitsLeft <= 0;
  if (depleted) state.depletedAt = now;
  const levelUps = addLifeSkillExp(skill, def.exp);
  return { ok: true, drops, items, expGained: def.exp, levelUps, depleted };
}

// ---------------- 製作 ----------------

export type StationId = 'smelter' | 'workbench' | 'anvil' | 'alchemy';

export interface Recipe {
  id: string;
  station: StationId;
  skill: LifeSkillId;
  skillReq: number;
  inputs: { itemId: string; qty: number }[];
  goldCost: number;
  output: { itemId: string; qty: number };
  /** 基礎成功率 0~1；每高於需求 1 級 +2%，商人再 +5% */
  baseSuccess: number;
  exp: number;
  stationLevelReq: number;
}

export function craftSuccessRate(recipe: Recipe, ch: Character): number {
  const skill = ch.data.lifeSkills[recipe.skill].level;
  const bonus = (skill - recipe.skillReq) * 0.02 + (ch.classDef.perks.craftSuccessBonusPct ?? 0) / 100;
  return Math.min(1, recipe.baseSuccess + bonus);
}

export interface CraftResult {
  ok: boolean;
  reason?: string;
  success: boolean;
  item?: ItemInstance;
  levelUps: number;
}

/** 失敗時材料與金幣都會消耗（材料回收機制），但仍給一半經驗 */
export function craft(
  ch: Character,
  recipe: Recipe,
  homestead: Homestead,
  db: ItemDb,
  uids: UidGen,
  rng: Rng,
  now: number,
): CraftResult {
  const fail = (reason: string): CraftResult => ({ ok: false, reason, success: false, levelUps: 0 });
  const skill = ch.data.lifeSkills[recipe.skill];
  if (skill.level < recipe.skillReq) return fail(`技能等級不足（需要 ${recipe.skillReq}）`);
  if (homestead.buildingLevel(recipe.station) < recipe.stationLevelReq) return fail('設施等級不足');
  if (ch.data.gold < recipe.goldCost) return fail('金幣不足');
  for (const inp of recipe.inputs) {
    if (ch.inventory.count(inp.itemId) < inp.qty) return fail(`材料不足：${getDef(db, inp.itemId).name}`);
  }
  const outDef = getDef(db, recipe.output.itemId);
  const product = createItem(db, uids, recipe.output.itemId, recipe.output.qty, { kind: 'craft', sourceId: recipe.id, at: now });
  if (outDef.type === 'weapon' || outDef.type === 'armor' || outDef.type === 'tool') product.crafter = ch.name;
  if (!ch.inventory.canAdd([product])) return fail('背包已滿');

  for (const inp of recipe.inputs) ch.inventory.consume(inp.itemId, inp.qty);
  ch.data.gold -= recipe.goldCost;
  const success = rng.next() < craftSuccessRate(recipe, ch);
  const levelUps = addLifeSkillExp(skill, success ? recipe.exp : Math.floor(recipe.exp / 2));
  if (!success) return { ok: true, success: false, levelUps };
  ch.inventory.add(product);
  return { ok: true, success: true, item: product, levelUps };
}

// ---------------- 家園本體 ----------------

export interface HomesteadData {
  level: number;
  buildings: Record<StationId, number>;
  nodes: NodeState[];
}

export interface HomesteadUpgrade {
  toLevel: number;
  gold: number;
  materials: { itemId: string; qty: number }[];
  /** 升級後解鎖的資源點 */
  unlockNodes: string[];
}

export class Homestead {
  constructor(public data: HomesteadData) {}

  buildingLevel(id: StationId): number {
    return this.data.buildings[id] ?? 0;
  }

  /** 升級家園：消耗大量金幣與材料（主要的高階金幣回收點） */
  upgrade(ch: Character, upgrade: HomesteadUpgrade, nodeDefs: ReadonlyMap<string, ResourceNodeDef>): { ok: boolean; reason?: string } {
    if (upgrade.toLevel !== this.data.level + 1) return { ok: false, reason: '升級順序錯誤' };
    if (ch.data.gold < upgrade.gold) return { ok: false, reason: '金幣不足' };
    for (const m of upgrade.materials) if (ch.inventory.count(m.itemId) < m.qty) return { ok: false, reason: '材料不足' };
    for (const m of upgrade.materials) ch.inventory.consume(m.itemId, m.qty);
    ch.data.gold -= upgrade.gold;
    this.data.level = upgrade.toLevel;
    for (const id of upgrade.unlockNodes) {
      const def = nodeDefs.get(id);
      if (def) this.data.nodes.push({ defId: id, hitsLeft: def.hits });
    }
    return { ok: true };
  }

  upgradeBuilding(ch: Character, id: StationId, cost: { gold: number; materials: { itemId: string; qty: number }[] }, maxLevel: number): { ok: boolean; reason?: string } {
    const cur = this.buildingLevel(id);
    if (cur >= maxLevel) return { ok: false, reason: '已達最高等級' };
    if (cur >= this.data.level) return { ok: false, reason: '設施等級不能超過家園等級' };
    if (ch.data.gold < cost.gold) return { ok: false, reason: '金幣不足' };
    for (const m of cost.materials) if (ch.inventory.count(m.itemId) < m.qty) return { ok: false, reason: '材料不足' };
    for (const m of cost.materials) ch.inventory.consume(m.itemId, m.qty);
    ch.data.gold -= cost.gold;
    this.data.buildings[id] = cur + 1;
    return { ok: true };
  }
}
