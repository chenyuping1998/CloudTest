/**
 * 天堂式強化（衝裝）
 * - 安定值以內 100% 成功（武器 +6、防具 +4）。
 * - 超過安定值後成功率遞減，失敗時「裝備蒸發」— 這是整個經濟最重要的物品回收機制 (item sink)，
 *   高強化裝備因此稀少、有交易價值。
 * - 祝福卷軸：安定值內有機率一次 +2~+3；超過安定值與一般卷軸相同。
 * - 保護卷軸：強化前使用，失敗時改為「-1」而不蒸發（可製作取得，避免 P2W）。
 */
import type { Rng } from './rng';

export type EnchantKind = 'weapon' | 'armor';

export const ENCHANT_RULES: Record<EnchantKind, { safe: number; max: number }> = {
  weapon: { safe: 6, max: 15 },
  armor: { safe: 4, max: 12 },
};

/** 超過安定值後第 n 次（從 0 開始）的成功率 */
const OVER_SAFE_RATES = [0.5, 0.4, 0.33, 0.25, 0.2, 0.15, 0.1, 0.07, 0.05, 0.03, 0.02];

export function enchantSuccessRate(kind: EnchantKind, current: number): number {
  const { safe, max } = ENCHANT_RULES[kind];
  if (current >= max) return 0;
  if (current < safe) return 1;
  return OVER_SAFE_RATES[Math.min(current - safe, OVER_SAFE_RATES.length - 1)];
}

export type EnchantOutcome = 'success' | 'destroyed' | 'downgraded' | 'blocked';

export interface EnchantResult {
  outcome: EnchantOutcome;
  newLevel: number;
}

export function tryEnchant(
  kind: EnchantKind,
  current: number,
  opts: { blessed: boolean; protectedByScroll: boolean },
  rng: Rng,
): EnchantResult {
  const { safe, max } = ENCHANT_RULES[kind];
  if (current >= max) return { outcome: 'blocked', newLevel: current };
  const rate = enchantSuccessRate(kind, current);
  if (rng.next() < rate) {
    let gain = 1;
    if (opts.blessed && current < safe) {
      const r = rng.next();
      gain = r < 0.1 ? 3 : r < 0.3 ? 2 : 1;
    }
    return { outcome: 'success', newLevel: Math.min(current + gain, max) };
  }
  if (opts.protectedByScroll) return { outcome: 'downgraded', newLevel: Math.max(current - 1, 0) };
  return { outcome: 'destroyed', newLevel: 0 };
}

/** 武器：每 +1 攻擊 +2；超過安定值的部分每級再 +3（過安定才是真正的價值） */
export function enchantAtkBonus(level: number): number {
  const over = Math.max(0, level - ENCHANT_RULES.weapon.safe);
  return level * 2 + over * 3;
}

export function enchantDefBonus(level: number): number {
  const over = Math.max(0, level - ENCHANT_RULES.armor.safe);
  return level + over * 2;
}

/** 從 +0 衝到 target 的期望卷軸數與期望消耗的裝備數（用於定價與經濟平衡） */
export function expectedEnchantCost(kind: EnchantKind, target: number): { scrolls: number; items: number } {
  // 無保護時失敗即蒸發：每件裝備是一次「從 +0 一路衝」的嘗試。
  // 一次嘗試的期望卷軸 = Σ(到達第 lv 級的機率)，嘗試成功率 = Π(各級成功率)
  let scrollsPerAttempt = 0;
  let pReach = 1;
  for (let lv = 0; lv < target; lv++) {
    scrollsPerAttempt += pReach;
    pReach *= enchantSuccessRate(kind, lv);
  }
  return { scrolls: scrollsPerAttempt / pReach, items: 1 / pReach };
}
