import type { StatKey } from '../core/types';

export type ClassId = 'novice' | 'swordsman' | 'archer' | 'mage' | 'merchant' | 'knight' | 'hunter' | 'wizard' | 'blacksmith';

export interface ClassDef {
  id: ClassId;
  name: string;
  /** 0 初心者、1 一轉、2 二轉 */
  tier: 0 | 1 | 2;
  /** 由哪個職業轉職而來 */
  from?: ClassId;
  hpMul: number;
  spMul: number;
  /** 遠距離普攻 */
  ranged?: boolean;
  /** 普攻使用 MATK */
  magic?: boolean;
  /** 每 5 Job 等級依序給一點的加成素質 */
  jobBonusOrder: StatKey[];
  /** 職業特性（商人系偏經營） */
  perks: {
    marketTaxReductionPct?: number;
    npcSellBonusPct?: number;
    craftSuccessBonusPct?: number;
    extraWeight?: number;
  };
  desc: string;
}

export const CLASSES: Record<ClassId, ClassDef> = {
  novice: { id: 'novice', name: '初心者', tier: 0, hpMul: 1, spMul: 1, jobBonusOrder: ['str', 'agi', 'vit', 'int', 'dex', 'luk'], perks: {}, desc: '所有冒險者的起點。Job Lv 10 可以轉職。' },
  swordsman: { id: 'swordsman', name: '劍士', tier: 1, from: 'novice', hpMul: 1.6, spMul: 0.8, jobBonusOrder: ['str', 'vit', 'dex', 'str', 'agi', 'vit'], perks: {}, desc: '高血量近戰，前排坦克與輸出。' },
  archer: { id: 'archer', name: '弓箭手', tier: 1, from: 'novice', hpMul: 1.15, spMul: 1, ranged: true, jobBonusOrder: ['dex', 'agi', 'dex', 'luk', 'str', 'dex'], perks: {}, desc: '遠距離物理輸出，高命中與爆擊。' },
  mage: { id: 'mage', name: '魔法師', tier: 1, from: 'novice', hpMul: 0.85, spMul: 1.8, ranged: true, magic: true, jobBonusOrder: ['int', 'dex', 'int', 'agi', 'int', 'luk'], perks: {}, desc: '範圍魔法傷害，SP 豐沛但脆弱。' },
  merchant: {
    id: 'merchant', name: '商人', tier: 1, from: 'novice', hpMul: 1.3, spMul: 0.9,
    jobBonusOrder: ['str', 'dex', 'luk', 'vit', 'str', 'luk'],
    perks: { marketTaxReductionPct: 2, npcSellBonusPct: 15, craftSuccessBonusPct: 5, extraWeight: 1000 },
    desc: '經營專家：市場稅減免、NPC 高價收購、製作成功率提升、額外負重。',
  },
  knight: {
    id: 'knight', name: '騎士', tier: 2, from: 'swordsman', hpMul: 2.1, spMul: 0.9,
    jobBonusOrder: ['str', 'vit', 'str', 'dex', 'agi', 'vit', 'str', 'luk'], perks: {},
    desc: '劍士的進階職業。雙手劍大師，最堅固的前排。',
  },
  hunter: {
    id: 'hunter', name: '獵人', tier: 2, from: 'archer', hpMul: 1.4, spMul: 1.1, ranged: true,
    jobBonusOrder: ['dex', 'agi', 'dex', 'luk', 'dex', 'str', 'agi', 'int'], perks: {},
    desc: '弓箭手的進階職業。與獵鷹並肩作戰，爆擊專家。',
  },
  wizard: {
    id: 'wizard', name: '巫師', tier: 2, from: 'mage', hpMul: 1.05, spMul: 2.2, ranged: true, magic: true,
    jobBonusOrder: ['int', 'dex', 'int', 'agi', 'int', 'vit', 'int', 'luk'], perks: {},
    desc: '魔法師的進階職業。擅長毀天滅地的大範圍魔法。',
  },
  blacksmith: {
    id: 'blacksmith', name: '鐵匠', tier: 2, from: 'merchant', hpMul: 1.6, spMul: 1,
    jobBonusOrder: ['str', 'dex', 'luk', 'vit', 'str', 'dex', 'agi', 'luk'],
    perks: { marketTaxReductionPct: 3, npcSellBonusPct: 20, craftSuccessBonusPct: 10, extraWeight: 1500 },
    desc: '商人的進階職業。頂尖工匠：更高的製作成功率與戰鬥能力，經營與冒險兼顧。',
  },
};

/** 初心者 Job 10 可選的一轉職業 */
export const JOB_CHOICES: ClassId[] = ['swordsman', 'archer', 'mage', 'merchant'];

/** 一轉 Job 40 以上可轉的二轉職業 */
export const SECOND_JOB_OF: Partial<Record<ClassId, ClassId>> = { swordsman: 'knight', archer: 'hunter', mage: 'wizard', merchant: 'blacksmith' };

export const SECOND_JOB_LEVEL = 40;

/** 職業的傳承鏈（技能可以沿用前一職業的） */
export function classLineage(id: ClassId): ClassId[] {
  const out: ClassId[] = [];
  let cur: ClassId | undefined = id;
  while (cur) {
    out.push(cur);
    cur = CLASSES[cur].from;
  }
  return out;
}
