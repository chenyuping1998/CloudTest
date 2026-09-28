import type { StatKey } from '../core/types';

export type ClassId = 'novice' | 'swordsman' | 'archer' | 'mage' | 'merchant';

export interface ClassDef {
  id: ClassId;
  name: string;
  hpMul: number;
  spMul: number;
  /** 每 5 Job 等級依序給一點的加成素質 */
  jobBonusOrder: StatKey[];
  /** 職業特性（商人偏經營） */
  perks: {
    marketTaxReductionPct?: number;
    npcSellBonusPct?: number;
    craftSuccessBonusPct?: number;
    extraWeight?: number;
  };
  desc: string;
}

export const CLASSES: Record<ClassId, ClassDef> = {
  novice: { id: 'novice', name: '初心者', hpMul: 1, spMul: 1, jobBonusOrder: ['str', 'agi', 'vit', 'int', 'dex', 'luk'], perks: {}, desc: '所有冒險者的起點。Job Lv 10 可以轉職。' },
  swordsman: { id: 'swordsman', name: '劍士', hpMul: 1.6, spMul: 0.8, jobBonusOrder: ['str', 'vit', 'dex', 'str', 'agi', 'vit'], perks: {}, desc: '高血量近戰，前排坦克與輸出。' },
  archer: { id: 'archer', name: '弓箭手', hpMul: 1.15, spMul: 1, jobBonusOrder: ['dex', 'agi', 'dex', 'luk', 'str', 'dex'], perks: {}, desc: '遠距離物理輸出，高命中與爆擊。' },
  mage: { id: 'mage', name: '魔法師', hpMul: 0.85, spMul: 1.8, jobBonusOrder: ['int', 'dex', 'int', 'agi', 'int', 'luk'], perks: {}, desc: '範圍魔法傷害，SP 豐沛但脆弱。' },
  merchant: {
    id: 'merchant',
    name: '商人',
    hpMul: 1.3,
    spMul: 0.9,
    jobBonusOrder: ['str', 'dex', 'luk', 'vit', 'str', 'luk'],
    perks: { marketTaxReductionPct: 2, npcSellBonusPct: 15, craftSuccessBonusPct: 5, extraWeight: 1000 },
    desc: '經營專家：市場稅減免、NPC 高價收購、製作成功率提升、額外負重。',
  },
};

export const JOB_CHOICES: ClassId[] = ['swordsman', 'archer', 'mage', 'merchant'];
