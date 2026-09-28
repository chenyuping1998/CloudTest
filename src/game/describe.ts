/**
 * 介面用的文字描述（純函式，不碰 DOM，方便測試）：
 * 技能每一級的實際效果、裝備與身上裝備的比較、加素質前的能力值預覽。
 */
import { Character, type DerivedStats } from '../core/character';
import { getDef, UidGen } from '../core/items';
import type { ItemDef, ItemInstance, StatKey } from '../core/types';
import { ITEM_DB } from '../data';
import type { BuffBonus, PassiveBonus, SkillDef } from '../data/skills';

const PASSIVE_LABEL: Record<keyof PassiveBonus, [string, string]> = {
  atk: ['攻擊力', ''], matk: ['魔法攻擊', ''], def: ['防禦力', ''], hit: ['命中', ''], flee: ['迴避', ''],
  critPct: ['爆擊率', '%'], aspdPct: ['攻擊速度', '%'], maxHpPct: ['最大 HP', '%'], maxSpPct: ['最大 SP', '%'],
  dex: ['DEX', ''], craftPct: ['製作成功率', '%'], npcBuyDiscountPct: ['NPC 購買折扣', '%'], npcSellPct: ['NPC 收購價', '%'],
};

const BUFF_LABEL: Record<keyof BuffBonus, [string, string]> = {
  atkPct: ['攻擊力', '%'], matkPct: ['魔法攻擊', '%'], aspdPct: ['攻擊速度', '%'], critPct: ['爆擊率', '%'], hit: ['命中', ''], defPct: ['防禦力', '%'],
};

const sec = (ms: number) => `${+(ms / 1000).toFixed(1)} 秒`;

function bonusText<T extends object>(bonus: T, labels: Record<keyof T, [string, string]>): string[] {
  return (Object.entries(bonus) as [keyof T, number][])
    .filter(([, v]) => v)
    .map(([k, v]) => `${labels[k][0]} +${+v.toFixed(1)}${labels[k][1]}`);
}

/** 技能在指定等級的效果（lv ≤ 0 回傳空陣列） */
export function skillEffectLines(s: SkillDef, lv: number): string[] {
  if (lv <= 0) return [];
  const out: string[] = [];
  if (s.damage) {
    const hits = s.damage.hits ?? 1;
    out.push(`${s.damage.type === 'magic' ? '魔法' : '物理'}傷害 ${Math.round(s.damage.mul(lv) * 100)}%${hits > 1 ? ` × ${hits} 次` : ''}`);
    if (s.damage.aoe) out.push(`範圍半徑 ${s.damage.aoe} 格`);
    if (s.damage.hitBonus) out.push(`命中 +${s.damage.hitBonus}`);
    if (s.damage.ignoreDef) out.push('無視防禦');
    if (s.damage.goldCost) out.push(`消耗金幣 ${s.damage.goldCost(lv)}`);
  }
  if (s.heal) out.push(`恢復 HP ${s.heal(lv)}`);
  if (s.buff) out.push(`${bonusText(s.buff.bonus(lv), BUFF_LABEL).join('、')}，持續 ${sec(s.buff.durationMs(lv))}`);
  if (s.passive) out.push(...bonusText(s.passive(lv), PASSIVE_LABEL));
  if (s.kind === 'active') {
    const cost = [`SP ${s.sp?.(lv) ?? 0}`];
    if (s.cooldownMs && s.cooldownMs(lv) > 0) cost.push(`冷卻 ${sec(s.cooldownMs(lv))}`);
    out.push(cost.join(' · '));
  }
  return out;
}

const STAT_LINE: [keyof ItemDef, string][] = [['atk', '攻擊力'], ['matk', '魔法攻擊'], ['def', '防禦力']];

/** 和身上同部位裝備比較：回傳每一項的差值（正 = 變強） */
export function compareEquip(def: ItemDef, it: ItemInstance | undefined, worn: ItemInstance | undefined): { label: string; delta: number }[] {
  if (!def.slot) return [];
  const wdef = worn ? getDef(ITEM_DB, worn.defId) : undefined;
  const val = (d: ItemDef | undefined, key: keyof ItemDef) => Number(d?.[key] ?? 0);
  const out: { label: string; delta: number }[] = [];
  for (const [key, label] of STAT_LINE) {
    const delta = val(def, key) - val(wdef, key);
    if (delta) out.push({ label, delta });
  }
  const bonusKeys = new Set([...Object.keys(def.bonus ?? {}), ...Object.keys(wdef?.bonus ?? {})]) as Set<StatKey>;
  for (const k of bonusKeys) {
    const delta = (def.bonus?.[k] ?? 0) - (wdef?.bonus?.[k] ?? 0);
    if (delta) out.push({ label: k.toUpperCase(), delta });
  }
  const enchant = (it?.enchant ?? 0) - (worn?.enchant ?? 0);
  if (enchant) out.push({ label: '強化值', delta: enchant });
  const slots = (def.cardSlots ?? 0) - (wdef?.cardSlots ?? 0);
  if (slots) out.push({ label: '卡片插槽', delta: slots });
  return out;
}

const previewUids = new UidGen('preview');

export interface StatPreviewLine {
  label: string;
  from: string;
  to: string;
}

const DERIVED_LABELS: [keyof DerivedStats, string, (v: number) => string][] = [
  ['maxHp', '最大 HP', (v) => String(v)],
  ['maxSp', '最大 SP', (v) => String(v)],
  ['atk', 'ATK', (v) => String(v)],
  ['matk', 'MATK', (v) => String(v)],
  ['def', 'DEF', (v) => String(v)],
  ['hit', '命中', (v) => String(v)],
  ['flee', '迴避', (v) => String(v)],
  ['critPct', '爆擊', (v) => `${v.toFixed(1)}%`],
  ['attacksPerSec', '攻速', (v) => `${v.toFixed(2)}/秒`],
  ['maxWeight', '負重上限', (v) => String(v)],
];

/** 把某素質 +n 之後，哪些衍生能力會改變 */
export function statPreview(ch: Character, stat: StatKey, n = 1): StatPreviewLine[] {
  const before = ch.derived();
  const clone = new Character(ITEM_DB, previewUids, structuredClone(ch.serialize()));
  clone.data.stats[stat] += n;
  const after = clone.derived();
  const out: StatPreviewLine[] = [];
  for (const [key, label, fmt] of DERIVED_LABELS) {
    const a = before[key] as number;
    const b = after[key] as number;
    if (fmt(a) !== fmt(b)) out.push({ label, from: fmt(a), to: fmt(b) });
  }
  return out;
}
