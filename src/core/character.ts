import { CLASSES, type ClassId } from '../data/classes';
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
}

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

  constructor(
    private readonly db: ItemDb,
    uids: UidGen,
    readonly data: CharacterData,
  ) {
    this.inventory = Inventory.from(db, uids, data.inventory);
  }

  /** 存檔用：背包以 Inventory 物件為準 */
  serialize(): CharacterData {
    return structuredClone({ ...this.data, inventory: this.inventory.toJSON() });
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

  derived(): DerivedStats {
    const total = { ...this.data.stats };
    const jb = this.jobBonus();
    let weaponAtk = 0;
    let weaponMatk = 0;
    let def = 0;
    let dropBonusPct = 0;
    for (const k of STAT_KEYS) total[k] += jb[k];
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
    return {
      totalStats: total,
      maxHp: Math.floor((40 + lv * 12 + lv * lv * 0.35) * cls.hpMul * (1 + total.vit / 100)),
      maxSp: Math.floor((10 + lv * 2.5) * cls.spMul * (1 + total.int / 100)),
      atk: total.str + strBonus * strBonus + Math.floor(total.dex / 5) + Math.floor(total.luk / 5) + weaponAtk,
      matk: total.int + intBonus * intBonus + weaponMatk,
      def: def + Math.floor(total.vit / 2),
      hit: lv + total.dex,
      flee: lv + total.agi,
      critPct: 1 + total.luk * 0.3,
      attacksPerSec: Math.min(0.8 + total.agi * 0.025 + total.dex * 0.005, 5),
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

  canChangeJob(): boolean {
    return this.data.classId === 'novice' && this.data.progression.jobLevel >= JOB_CHANGE_LEVEL;
  }

  changeJob(to: ClassId): boolean {
    if (!this.canChangeJob() || to === 'novice') return false;
    this.data.classId = to;
    this.data.progression.jobLevel = 1;
    this.data.progression.jobExp = 0;
    return true;
  }

  isOverweight(): boolean {
    return this.inventory.totalWeight() > this.derived().maxWeight;
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
    const bonus = 1 + (this.classDef.perks.npcSellBonusPct ?? 0) / 100;
    const gold = Math.floor(def.sellPrice * taken.qty * bonus);
    this.data.gold += gold;
    return gold;
  }

  tradeableItems(): ItemInstance[] {
    return this.inventory.items.filter((i) => isTradeable(getDef(this.db, i.defId), i));
  }
}
