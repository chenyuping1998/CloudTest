import { CLASSES, classLineage, SECOND_JOB_LEVEL, SECOND_JOB_OF, JOB_CHOICES, type ClassId } from '../data/classes';
import { SKILL_DB, SKILLS, type BuffBonus, type PassiveBonus, type SkillDef } from '../data/skills';
import { Inventory, type InventoryData } from './inventory';
import { getDef, isTradeable, type ItemDb, type UidGen } from './items';
import { JOB_CHANGE_LEVEL, MAX_STAT, statRaiseCost, type LifeSkill, type Progression } from './leveling';
import { enchantAtkBonus, enchantDefBonus } from './enchant';
import { emptyStats, STAT_KEYS, type EquipSlot, type ItemInstance, type StatKey, type Stats } from './types';

export type LifeSkillId = 'mining' | 'woodcutting' | 'smithing' | 'carpentry' | 'alchemy';

export interface CharacterData {
  name: string;
  classId: ClassId;
  progression: Progression;
  stats: Stats;
  hp: number;
  sp: number;
  gold: number;
  inventory: InventoryData;
  equipment: Partial<Record<EquipSlot, ItemInstance>>;
  lifeSkills: Record<LifeSkillId, LifeSkill>;
  /** 休息經驗池（離線累積） */
  restedExp?: number;
  /** 已解鎖的成就 id */
  achievements?: string[];
  /** 已學技能等級 */
  skills?: Record<string, number>;
  /** 進行中的增益效果（伺服器時間） */
  buffs?: { id: string; level: number; until: number }[];
  /** 倉庫（城鎮倉庫管理員 / 家園管家）：格數多、不計負重 */
  storage?: InventoryData;
}

export const STORAGE_CAPACITY = 300;

/** RO 式負重分級：超過 50% 停止自然回復，超過 90% 無法攻擊、施法、採集 */
export const WEIGHT_NO_REGEN = 0.5;
export const WEIGHT_NO_ACTION = 0.9;
export type WeightTier = 'ok' | 'heavy' | 'overloaded';

export interface DerivedStats {
  totalStats: Stats;
  maxHp: number;
  maxSp: number;
  atk: number;
  matk: number;
  def: number;
  hit: number;
  flee: number;
  critPct: number;
  /** 每秒攻擊次數 */
  attacksPerSec: number;
  maxWeight: number;
  dropBonusPct: number;
}

export function newCharacter(name: string, db: ItemDb, uids: UidGen): Character {
  const data: CharacterData = {
    name,
    classId: 'novice',
    progression: { baseLevel: 1, baseExp: 0, jobLevel: 1, jobExp: 0, statPoints: 48, skillPoints: 0 },
    stats: emptyStats(1),
    hp: 1,
    sp: 1,
    gold: 500,
    inventory: { capacity: 100, items: [] },
    equipment: {},
    lifeSkills: {
      mining: { level: 1, exp: 0 },
      woodcutting: { level: 1, exp: 0 },
      smithing: { level: 1, exp: 0 },
      carpentry: { level: 1, exp: 0 },
      alchemy: { level: 1, exp: 0 },
    },
  };
  const c = new Character(db, uids, data);
  const d = c.derived();
  c.data.hp = d.maxHp;
  c.data.sp = d.maxSp;
  return c;
}

export class Character {
  readonly inventory: Inventory;
  readonly storage: Inventory;

  constructor(
    private readonly db: ItemDb,
    uids: UidGen,
    readonly data: CharacterData,
  ) {
    this.inventory = Inventory.from(db, uids, data.inventory);
    this.storage = Inventory.from(db, uids, data.storage ?? { capacity: STORAGE_CAPACITY, items: [] });
  }

  /** 存檔用：背包與倉庫以 Inventory 物件為準 */
  serialize(): CharacterData {
    return structuredClone({ ...this.data, inventory: this.inventory.toJSON(), storage: this.storage.toJSON() });
  }

  get name(): string {
    return this.data.name;
  }
  get progression(): Progression {
    return this.data.progression;
  }
  get classDef() {
    return CLASSES[this.data.classId];
  }

  jobBonus(): Stats {
    const s = emptyStats(0);
    const order = this.classDef.jobBonusOrder;
    const n = Math.floor(this.data.progression.jobLevel / 5);
    for (let i = 0; i < n; i++) s[order[i % order.length]]++;
    return s;
  }

  /**
   * 衍生能力值。
   * @param now 伺服器時間；有給才會套用進行中的增益效果（buff）
   */
  derived(now?: number): DerivedStats {
    const pb = this.passiveBonus();
    const bb = now === undefined ? {} : this.buffBonus(now);
    const total = { ...this.data.stats };
    const jb = this.jobBonus();
    let weaponAtk = 0;
    let weaponMatk = 0;
    let def = 0;
    let dropBonusPct = 0;
    for (const k of STAT_KEYS) total[k] += jb[k];
    total.dex += pb.dex ?? 0;
    for (const [slot, item] of Object.entries(this.data.equipment) as [EquipSlot, ItemInstance][]) {
      const d = getDef(this.db, item.defId);
      weaponAtk += d.atk ?? 0;
      weaponMatk += d.matk ?? 0;
      def += d.def ?? 0;
      dropBonusPct += d.dropBonusPct ?? 0;
      if (slot === 'weapon') weaponAtk += enchantAtkBonus(item.enchant);
      else def += enchantDefBonus(item.enchant);
      for (const k of STAT_KEYS) total[k] += d.bonus?.[k] ?? 0;
      for (const cardId of item.cards) {
        const cd = getDef(this.db, cardId);
        for (const k of STAT_KEYS) total[k] += cd.bonus?.[k] ?? 0;
        weaponAtk += cd.atk ?? 0;
        def += cd.def ?? 0;
        dropBonusPct += cd.dropBonusPct ?? 0;
      }
    }
    const lv = this.data.progression.baseLevel;
    const cls = this.classDef;
    const strBonus = Math.floor(total.str / 10);
    const intBonus = Math.floor(total.int / 7);
    const pct = (base: number, p?: number) => base * (1 + (p ?? 0) / 100);
    const atk = total.str + strBonus * strBonus + Math.floor(total.dex / 5) + Math.floor(total.luk / 5) + weaponAtk + (pb.atk ?? 0);
    const matk = total.int + intBonus * intBonus + weaponMatk + (pb.matk ?? 0);
    return {
      totalStats: total,
      maxHp: Math.floor(pct((40 + lv * 12 + lv * lv * 0.35) * cls.hpMul * (1 + total.vit / 100), pb.maxHpPct)),
      maxSp: Math.floor(pct((10 + lv * 2.5) * cls.spMul * (1 + total.int / 100), pb.maxSpPct)),
      atk: Math.floor(pct(atk, bb.atkPct)),
      matk: Math.floor(pct(matk, bb.matkPct)),
      def: Math.floor(pct(def + Math.floor(total.vit / 2) + (pb.def ?? 0), bb.defPct)),
      hit: lv + total.dex + (pb.hit ?? 0) + (bb.hit ?? 0),
      flee: lv + total.agi + (pb.flee ?? 0),
      critPct: 1 + total.luk * 0.3 + (pb.critPct ?? 0) + (bb.critPct ?? 0),
      attacksPerSec: Math.min((0.8 + total.agi * 0.025 + total.dex * 0.005) * (1 + ((pb.aspdPct ?? 0) + (bb.aspdPct ?? 0)) / 100), 5),
      maxWeight: 2000 + total.str * 30 + (cls.perks.extraWeight ?? 0),
      dropBonusPct,
    };
  }

  raiseStat(stat: StatKey): boolean {
    const cur = this.data.stats[stat];
    const cost = statRaiseCost(cur);
    if (cur >= MAX_STAT || this.data.progression.statPoints < cost) return false;
    this.data.progression.statPoints -= cost;
    this.data.stats[stat]++;
    return true;
  }

  /** 目前可以轉的職業（初心者 Job 10 → 一轉；一轉 Job 40 → 二轉） */
  jobChoices(): ClassId[] {
    const cls = this.data.classId;
    const jl = this.data.progression.jobLevel;
    if (cls === 'novice') return jl >= JOB_CHANGE_LEVEL ? JOB_CHOICES : [];
    const next = SECOND_JOB_OF[cls];
    return next && jl >= SECOND_JOB_LEVEL ? [next] : [];
  }

  canChangeJob(): boolean {
    return this.jobChoices().length > 0;
  }

  changeJob(to: ClassId): boolean {
    if (!this.jobChoices().includes(to)) return false;
    this.data.classId = to;
    this.data.progression.jobLevel = 1;
    this.data.progression.jobExp = 0;
    return true;
  }

  // ------------------------------------------------------------ 技能

  skillLevel(id: string): number {
    return this.data.skills?.[id] ?? 0;
  }

  /** 目前職業（含前置職業）可學的技能 */
  availableSkills(): SkillDef[] {
    const lineage = classLineage(this.data.classId);
    return SKILLS.filter((s) => lineage.includes(s.classId));
  }

  canLearn(id: string): { ok: boolean; reason?: string } {
    const def = SKILL_DB.get(id);
    if (!def) return { ok: false, reason: '沒有這個技能' };
    if (!classLineage(this.data.classId).includes(def.classId)) return { ok: false, reason: `需要 ${CLASSES[def.classId].name} 系職業` };
    if (this.skillLevel(id) >= def.maxLevel) return { ok: false, reason: '已達最高等級' };
    if (this.data.progression.skillPoints <= 0) return { ok: false, reason: '技能點數不足' };
    for (const r of def.requires ?? []) {
      if (this.skillLevel(r.skill) < r.level) return { ok: false, reason: `需要 ${SKILL_DB.get(r.skill)?.name} Lv ${r.level}` };
    }
    return { ok: true };
  }

  learnSkill(id: string): { ok: boolean; reason?: string } {
    const r = this.canLearn(id);
    if (!r.ok) return r;
    this.data.skills ??= {};
    this.data.skills[id] = this.skillLevel(id) + 1;
    this.data.progression.skillPoints--;
    return { ok: true };
  }

  /** 所有被動技能的加成總和 */
  passiveBonus(): PassiveBonus {
    const out: Record<string, number> = {};
    for (const [id, lv] of Object.entries(this.data.skills ?? {})) {
      const def = SKILL_DB.get(id);
      if (!def?.passive || lv <= 0) continue;
      for (const [k, v] of Object.entries(def.passive(lv))) out[k] = (out[k] ?? 0) + (v ?? 0);
    }
    return out as PassiveBonus;
  }

  /** 進行中增益效果的加成總和 */
  buffBonus(now: number): BuffBonus {
    const out: Record<string, number> = {};
    for (const b of this.data.buffs ?? []) {
      if (b.until <= now) continue;
      const def = SKILL_DB.get(b.id);
      if (!def?.buff) continue;
      for (const [k, v] of Object.entries(def.buff.bonus(b.level))) out[k] = (out[k] ?? 0) + (v ?? 0);
    }
    return out as BuffBonus;
  }

  addBuff(id: string, level: number, until: number): void {
    this.data.buffs = (this.data.buffs ?? []).filter((b) => b.id !== id);
    this.data.buffs.push({ id, level, until });
  }

  /** 移除過期的增益；回傳是否有變動 */
  pruneBuffs(now: number): boolean {
    const before = this.data.buffs?.length ?? 0;
    this.data.buffs = (this.data.buffs ?? []).filter((b) => b.until > now);
    return this.data.buffs.length !== before;
  }

  isOverweight(): boolean {
    return this.inventory.totalWeight() > this.derived().maxWeight;
  }

  weightRatio(): number {
    return this.inventory.totalWeight() / this.derived().maxWeight;
  }

  weightTier(): WeightTier {
    const r = this.weightRatio();
    return r >= WEIGHT_NO_ACTION ? 'overloaded' : r >= WEIGHT_NO_REGEN ? 'heavy' : 'ok';
  }

  /** 背包 → 倉庫（整筆成功或完全不動） */
  deposit(uid: string, qty: number): { ok: boolean; reason?: string } {
    return this.moveBetween(this.inventory, this.storage, uid, qty, false);
  }

  /** 倉庫 → 背包：要檢查背包格數與負重 */
  withdraw(uid: string, qty: number): { ok: boolean; reason?: string } {
    return this.moveBetween(this.storage, this.inventory, uid, qty, true);
  }

  private moveBetween(from: Inventory, to: Inventory, uid: string, qty: number, checkWeight: boolean): { ok: boolean; reason?: string } {
    const it = from.get(uid);
    if (!it) return { ok: false, reason: '物品不存在' };
    if (!Number.isSafeInteger(qty) || qty <= 0 || qty > it.qty) return { ok: false, reason: '數量不正確' };
    const moving = { ...it, qty };
    if (!to.canAdd([moving])) return { ok: false, reason: to === this.storage ? '倉庫已滿' : '背包已滿' };
    if (checkWeight && this.inventory.totalWeight() + getDef(this.db, it.defId).weight * qty > this.derived().maxWeight) {
      return { ok: false, reason: '負重不足，拿不動了' };
    }
    const taken = from.take(uid, qty)!;
    to.add(taken);
    return { ok: true };
  }

  /** 裝備：bindOnEquip 物品在此綁定 */
  equip(uid: string): { ok: boolean; reason?: string } {
    const item = this.inventory.get(uid);
    if (!item) return { ok: false, reason: '物品不存在' };
    const def = getDef(this.db, item.defId);
    if (!def.slot) return { ok: false, reason: '無法裝備' };
    if ((def.levelReq ?? 0) > this.data.progression.baseLevel) return { ok: false, reason: `需要等級 ${def.levelReq}` };
    const taken = this.inventory.take(uid, 1)!;
    const prev = this.data.equipment[def.slot];
    if (prev && !this.inventory.add(prev)) {
      this.inventory.add(taken);
      return { ok: false, reason: '背包已滿' };
    }
    if (def.bind === 'bindOnEquip') taken.bound = true;
    this.data.equipment[def.slot] = taken;
    return { ok: true };
  }

  unequip(slot: EquipSlot): boolean {
    const item = this.data.equipment[slot];
    if (!item || !this.inventory.add(item)) return false;
    delete this.data.equipment[slot];
    return true;
  }

  /** RO 式插卡：卡片消耗掉、永久鑲嵌，無法取出 */
  compoundCard(cardUid: string, equipUid: string): { ok: boolean; reason?: string } {
    const card = this.inventory.get(cardUid);
    const equip = this.inventory.get(equipUid);
    if (!card || !equip) return { ok: false, reason: '物品不存在（請先卸下裝備再插卡）' };
    const cd = getDef(this.db, card.defId);
    const ed = getDef(this.db, equip.defId);
    if (cd.type !== 'card') return { ok: false, reason: '不是卡片' };
    if (cd.cardTarget !== ed.slot) return { ok: false, reason: '卡片部位不符' };
    if (equip.cards.length >= (ed.cardSlots ?? 0)) return { ok: false, reason: '沒有空的卡槽' };
    this.inventory.take(cardUid, 1);
    equip.cards.push(card.defId);
    return { ok: true };
  }

  /** 賣給 NPC（最大的金幣來源之一；商人有加成） */
  sellToNpc(uid: string, qty: number): number {
    const it = this.inventory.get(uid);
    if (!it) return 0;
    const def = getDef(this.db, it.defId);
    const taken = this.inventory.take(uid, Math.min(qty, it.qty));
    if (!taken) return 0;
    const bonus = 1 + ((this.classDef.perks.npcSellBonusPct ?? 0) + (this.passiveBonus().npcSellPct ?? 0)) / 100;
    const gold = Math.floor(def.sellPrice * taken.qty * bonus);
    this.data.gold += gold;
    return gold;
  }

  tradeableItems(): ItemInstance[] {
    return this.inventory.items.filter((i) => isTradeable(getDef(this.db, i.defId), i));
  }
}
