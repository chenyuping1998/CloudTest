/**
 * 技能資料。每個職業 4 個技能（主動 + 被動），二轉可以沿用一轉的技能。
 * 數值設計原則：技能靠 SP 限制使用頻率，整體 DPS 提升約 20~35%（已納入練功節奏模擬）。
 */
import type { ClassId } from './classes';

export type SkillElement = 'physical' | 'fire' | 'ice' | 'lightning' | 'holy' | 'gold';

export interface PassiveBonus {
  atk?: number;
  matk?: number;
  def?: number;
  hit?: number;
  flee?: number;
  critPct?: number;
  aspdPct?: number;
  maxHpPct?: number;
  maxSpPct?: number;
  dex?: number;
  craftPct?: number;
  npcBuyDiscountPct?: number;
  npcSellPct?: number;
}

export interface BuffBonus {
  atkPct?: number;
  matkPct?: number;
  aspdPct?: number;
  critPct?: number;
  hit?: number;
  defPct?: number;
}

export interface SkillDef {
  id: string;
  name: string;
  classId: ClassId;
  maxLevel: number;
  kind: 'active' | 'passive';
  desc: string;
  /** 主動技能目標：敵人、自身、以自身為中心的範圍 */
  target?: 'enemy' | 'self' | 'selfArea';
  element?: SkillElement;
  sp?: (lv: number) => number;
  cooldownMs?: (lv: number) => number;
  /** 施放距離；undefined = 使用職業普攻距離 */
  range?: number;
  damage?: {
    type: 'physical' | 'magic';
    mul: (lv: number) => number;
    hits?: number;
    /** 範圍半徑（以目標或自身為中心） */
    aoe?: number;
    /** 命中加成（物理） */
    hitBonus?: number;
    ignoreDef?: boolean;
    goldCost?: (lv: number) => number;
  };
  heal?: (lv: number) => number;
  buff?: { durationMs: (lv: number) => number; bonus: (lv: number) => BuffBonus };
  passive?: (lv: number) => PassiveBonus;
  requires?: { skill: string; level: number }[];
}

const S = (lv: number) => lv; // 可讀性用

export const SKILLS: SkillDef[] = [
  // ============================ 初心者
  {
    id: 'first_aid', name: '急救', classId: 'novice', maxLevel: 1, kind: 'active', target: 'self', element: 'holy',
    desc: '簡單包紮，恢復少量 HP。', sp: () => 3, cooldownMs: () => 2000, heal: () => 30,
  },

  // ============================ 劍士
  {
    id: 'bash', name: '重擊', classId: 'swordsman', maxLevel: 10, kind: 'active', target: 'enemy', element: 'physical',
    desc: '用力揮砍單一目標，傷害 130%~430%，命中提升。',
    sp: (lv) => 8 + S(lv), cooldownMs: () => 700,
    damage: { type: 'physical', mul: (lv) => 1.0 + 0.3 * lv, hitBonus: 20 },
  },
  {
    id: 'magnum_break', name: '怒爆', classId: 'swordsman', maxLevel: 10, kind: 'active', target: 'selfArea', element: 'fire',
    desc: '以自身為中心引爆火焰，攻擊周圍所有敵人，傷害 140%~320%。',
    sp: (lv) => 14 + S(lv), cooldownMs: () => 2000,
    damage: { type: 'physical', mul: (lv) => 1.2 + 0.2 * lv, aoe: 2.8, hitBonus: 10 },
    requires: [{ skill: 'bash', level: 5 }],
  },
  {
    id: 'sword_mastery', name: '劍術修練', classId: 'swordsman', maxLevel: 10, kind: 'passive',
    desc: '攻擊力 +4 / 級。', passive: (lv) => ({ atk: 4 * lv }),
  },
  {
    id: 'endure', name: '強健體魄', classId: 'swordsman', maxLevel: 10, kind: 'passive',
    desc: '最大 HP +2% / 級、防禦 +1 / 級。', passive: (lv) => ({ maxHpPct: 2 * lv, def: lv }),
  },

  // ============================ 騎士
  {
    id: 'pierce', name: '連刺攻擊', classId: 'knight', maxLevel: 10, kind: 'active', target: 'enemy', element: 'physical',
    desc: '連續突刺兩次，每次 110%~200%。',
    sp: (lv) => 10 + S(lv), cooldownMs: () => 900,
    damage: { type: 'physical', mul: (lv) => 1.0 + 0.1 * lv, hits: 2, hitBonus: 15 },
    requires: [{ skill: 'bash', level: 5 }],
  },
  {
    id: 'whirlwind', name: '旋風斬', classId: 'knight', maxLevel: 10, kind: 'active', target: 'selfArea', element: 'physical',
    desc: '揮舞雙手劍旋轉，攻擊周圍所有敵人，傷害 190%~550%。',
    sp: (lv) => 18 + 2 * S(lv), cooldownMs: () => 1800,
    damage: { type: 'physical', mul: (lv) => 1.5 + 0.4 * lv, aoe: 3.2, hitBonus: 15 },
    requires: [{ skill: 'magnum_break', level: 3 }],
  },
  {
    id: 'two_hand_mastery', name: '雙手劍修練', classId: 'knight', maxLevel: 10, kind: 'passive',
    desc: '攻擊力 +6 / 級、攻擊速度 +1% / 級。', passive: (lv) => ({ atk: 6 * lv, aspdPct: lv }),
    requires: [{ skill: 'sword_mastery', level: 5 }],
  },
  {
    id: 'aura_blade', name: '靈氣劍', classId: 'knight', maxLevel: 5, kind: 'active', target: 'self', element: 'holy',
    desc: '劍身纏繞靈氣：攻擊力 +6% / 級，持續 60 秒。',
    sp: (lv) => 20 + 4 * S(lv), cooldownMs: () => 60_000,
    buff: { durationMs: () => 60_000, bonus: (lv) => ({ atkPct: 6 * lv }) },
  },

  // ============================ 弓箭手
  {
    id: 'double_strafe', name: '二連矢', classId: 'archer', maxLevel: 10, kind: 'active', target: 'enemy', element: 'physical',
    desc: '連續射出兩箭，每箭 100%~190%。',
    sp: () => 12, cooldownMs: () => 800,
    damage: { type: 'physical', mul: (lv) => 0.9 + 0.1 * lv, hits: 2, hitBonus: 10 },
  },
  {
    id: 'arrow_shower', name: '箭雨', classId: 'archer', maxLevel: 10, kind: 'active', target: 'enemy', element: 'physical',
    desc: '向目標區域降下箭雨，範圍傷害 100%~190%。',
    sp: (lv) => 14 + S(lv), cooldownMs: () => 1500,
    damage: { type: 'physical', mul: (lv) => 0.9 + 0.1 * lv, aoe: 2.5, hitBonus: 5 },
    requires: [{ skill: 'double_strafe', level: 5 }],
  },
  {
    id: 'owls_eye', name: '鷹眼', classId: 'archer', maxLevel: 10, kind: 'passive',
    desc: 'DEX +1 / 級。', passive: (lv) => ({ dex: lv }),
  },
  {
    id: 'vultures_eye', name: '禿鷹之眼', classId: 'archer', maxLevel: 10, kind: 'passive',
    desc: '命中 +2 / 級、爆擊 +0.5% / 級。', passive: (lv) => ({ hit: 2 * lv, critPct: 0.5 * lv }),
    requires: [{ skill: 'owls_eye', level: 3 }],
  },

  // ============================ 獵人
  {
    id: 'blitz_beat', name: '獵鷹襲擊', classId: 'hunter', maxLevel: 5, kind: 'active', target: 'enemy', element: 'physical',
    desc: '命令獵鷹攻擊目標周圍，無視防禦，三連擊，每擊 60%~120%。',
    sp: (lv) => 10 + 3 * S(lv), cooldownMs: () => 1200,
    damage: { type: 'physical', mul: (lv) => 0.45 + 0.15 * lv, hits: 3, aoe: 1.5, ignoreDef: true },
  },
  {
    id: 'sharp_shooting', name: '銳利射擊', classId: 'hunter', maxLevel: 10, kind: 'active', target: 'enemy', element: 'physical',
    desc: '瞄準要害的一箭，傷害 250%~700%。',
    sp: (lv) => 18 + 2 * S(lv), cooldownMs: () => 1500,
    damage: { type: 'physical', mul: (lv) => 2.0 + 0.5 * lv, hitBonus: 30 },
    requires: [{ skill: 'double_strafe', level: 5 }],
  },
  {
    id: 'beast_bane', name: '野獸剋星', classId: 'hunter', maxLevel: 10, kind: 'passive',
    desc: '攻擊力 +5 / 級。', passive: (lv) => ({ atk: 5 * lv }),
  },
  {
    id: 'true_sight', name: '真實之眼', classId: 'hunter', maxLevel: 5, kind: 'active', target: 'self', element: 'holy',
    desc: '看穿敵人弱點：攻擊力 +4%、爆擊 +2%、命中 +5 / 級，持續 60 秒。',
    sp: (lv) => 20 + 5 * S(lv), cooldownMs: () => 60_000,
    buff: { durationMs: () => 60_000, bonus: (lv) => ({ atkPct: 4 * lv, critPct: 2 * lv, hit: 5 * lv }) },
    requires: [{ skill: 'vultures_eye', level: 5 }],
  },

  // ============================ 魔法師
  {
    id: 'fire_bolt', name: '火球術', classId: 'mage', maxLevel: 10, kind: 'active', target: 'enemy', element: 'fire',
    desc: '發射火球，魔法傷害 125%~440%。',
    sp: (lv) => 10 + 2 * S(lv), cooldownMs: (lv) => 500 + 100 * lv,
    damage: { type: 'magic', mul: (lv) => 0.9 + 0.35 * lv },
  },
  {
    id: 'thunder_storm', name: '雷暴', classId: 'mage', maxLevel: 10, kind: 'active', target: 'enemy', element: 'lightning',
    desc: '在目標區域降下雷電，範圍魔法傷害 100%~370%。',
    sp: (lv) => 25 + 3 * S(lv), cooldownMs: (lv) => 2000 + 200 * lv,
    damage: { type: 'magic', mul: (lv) => 0.7 + 0.3 * lv, aoe: 3 },
    requires: [{ skill: 'fire_bolt', level: 4 }],
  },
  {
    id: 'mana_mastery', name: '魔力精通', classId: 'mage', maxLevel: 10, kind: 'passive',
    desc: '魔法攻擊 +4 / 級、最大 SP +2% / 級。', passive: (lv) => ({ matk: 4 * lv, maxSpPct: 2 * lv }),
  },
  {
    id: 'energy_coat', name: '能量外套', classId: 'mage', maxLevel: 5, kind: 'active', target: 'self', element: 'lightning',
    desc: '以魔力護身：防禦 +8% / 級，持續 120 秒。',
    sp: (lv) => 15 + 5 * S(lv), cooldownMs: () => 120_000,
    buff: { durationMs: () => 120_000, bonus: (lv) => ({ defPct: 8 * lv }) },
  },

  // ============================ 巫師
  {
    id: 'jupitel_thunder', name: '木星雷擊', classId: 'wizard', maxLevel: 10, kind: 'active', target: 'enemy', element: 'lightning',
    desc: '強力的雷球，魔法傷害 200%~650%。',
    sp: (lv) => 20 + 2 * S(lv), cooldownMs: () => 1200,
    damage: { type: 'magic', mul: (lv) => 1.5 + 0.5 * lv },
    requires: [{ skill: 'fire_bolt', level: 5 }],
  },
  {
    id: 'frost_nova', name: '冰霜新星', classId: 'wizard', maxLevel: 10, kind: 'active', target: 'selfArea', element: 'ice',
    desc: '以自身為中心爆發寒氣，範圍魔法傷害 130%~400%。',
    sp: (lv) => 30 + 2 * S(lv), cooldownMs: () => 3000,
    damage: { type: 'magic', mul: (lv) => 1.0 + 0.3 * lv, aoe: 3.5 },
  },
  {
    id: 'meteor_storm', name: '隕石術', classId: 'wizard', maxLevel: 10, kind: 'active', target: 'enemy', element: 'fire',
    desc: '召喚隕石轟炸目標區域，大範圍魔法傷害 160%~520%。',
    sp: (lv) => 40 + 4 * S(lv), cooldownMs: () => 4000,
    damage: { type: 'magic', mul: (lv) => 1.2 + 0.4 * lv, aoe: 4.2 },
    requires: [{ skill: 'thunder_storm', level: 5 }],
  },
  {
    id: 'magic_amp', name: '魔力增幅', classId: 'wizard', maxLevel: 5, kind: 'active', target: 'self', element: 'holy',
    desc: '魔法攻擊 +6% / 級，持續 60 秒。',
    sp: (lv) => 25 + 5 * S(lv), cooldownMs: () => 60_000,
    buff: { durationMs: () => 60_000, bonus: (lv) => ({ matkPct: 6 * lv }) },
    requires: [{ skill: 'mana_mastery', level: 5 }],
  },

  // ============================ 商人
  {
    id: 'mammonite', name: '金錢攻擊', classId: 'merchant', maxLevel: 10, kind: 'active', target: 'enemy', element: 'gold',
    desc: '用金幣砸向敵人，傷害 150%~600%，每次消耗 50×等級 金幣。',
    sp: () => 5, cooldownMs: () => 800,
    damage: { type: 'physical', mul: (lv) => 1.0 + 0.5 * lv, hitBonus: 10, goldCost: (lv) => 50 * lv },
  },
  {
    id: 'cart_revolution', name: '手推車攻擊', classId: 'merchant', maxLevel: 5, kind: 'active', target: 'enemy', element: 'physical',
    desc: '揮舞手推車攻擊目標周圍，範圍傷害 140%~220%。',
    sp: () => 12, cooldownMs: () => 1500,
    damage: { type: 'physical', mul: (lv) => 1.2 + 0.2 * lv, aoe: 2.5, hitBonus: 20 },
    requires: [{ skill: 'mammonite', level: 3 }],
  },
  {
    id: 'discount', name: '折價', classId: 'merchant', maxLevel: 10, kind: 'passive',
    desc: '向 NPC 購買時折扣 5% + 1.5% / 級。', passive: (lv) => ({ npcBuyDiscountPct: 5 + 1.5 * lv }),
  },
  {
    id: 'overcharge', name: '高價出售', classId: 'merchant', maxLevel: 10, kind: 'passive',
    desc: '賣給 NPC 時價格 +1% / 級（與職業加成疊加）。', passive: (lv) => ({ npcSellPct: lv }),
    requires: [{ skill: 'discount', level: 3 }],
  },

  // ============================ 鐵匠
  {
    id: 'weaponry_research', name: '武器研究', classId: 'blacksmith', maxLevel: 10, kind: 'passive',
    desc: '攻擊力 +3 / 級、命中 +2 / 級、製作成功率 +1% / 級。', passive: (lv) => ({ atk: 3 * lv, hit: 2 * lv, craftPct: lv }),
  },
  {
    id: 'master_smith', name: '鍛造精通', classId: 'blacksmith', maxLevel: 5, kind: 'passive',
    desc: '製作成功率再 +2% / 級。', passive: (lv) => ({ craftPct: 2 * lv }),
    requires: [{ skill: 'weaponry_research', level: 5 }],
  },
  {
    id: 'hammer_fall', name: '大地之擊', classId: 'blacksmith', maxLevel: 10, kind: 'active', target: 'selfArea', element: 'physical',
    desc: '以鐵鎚重擊地面，攻擊周圍所有敵人，傷害 140%~320%。',
    sp: (lv) => 12 + S(lv), cooldownMs: () => 1800,
    damage: { type: 'physical', mul: (lv) => 1.2 + 0.2 * lv, aoe: 3, hitBonus: 15 },
  },
  {
    id: 'adrenaline_rush', name: '狂暴', classId: 'blacksmith', maxLevel: 5, kind: 'active', target: 'self', element: 'fire',
    desc: '腎上腺素激增：攻擊速度 +6% / 級，持續 60 秒。',
    sp: (lv) => 20 + 4 * S(lv), cooldownMs: () => 60_000,
    buff: { durationMs: () => 60_000, bonus: (lv) => ({ aspdPct: 6 * lv }) },
  },
];

export const SKILL_DB = new Map(SKILLS.map((s) => [s.id, s]));
