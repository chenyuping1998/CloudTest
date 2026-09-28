import type { Rng } from './rng';

export interface CombatantStats {
  atk: number;
  def: number;
  hit: number;
  flee: number;
  critPct: number;
}

export interface AttackResult {
  kind: 'miss' | 'hit' | 'crit';
  damage: number;
}

/** RO 式命中：80% + (HIT - FLEE)%，限制在 5%~95% */
export function hitChance(hit: number, flee: number): number {
  return Math.min(0.95, Math.max(0.05, 0.8 + (hit - flee) / 100));
}

/** 防禦減傷：DEF 越高效益遞減 */
export function defReduction(def: number): number {
  return 100 / (100 + Math.max(0, def));
}

export function resolveAttack(att: CombatantStats, target: Pick<CombatantStats, 'def' | 'flee'>, rng: Rng): AttackResult {
  // 爆擊必中且無視防禦（RO 經典設定）
  if (rng.next() * 100 < att.critPct) {
    return { kind: 'crit', damage: Math.max(1, Math.round(att.atk * 1.4 * (0.95 + rng.next() * 0.1))) };
  }
  if (rng.next() >= hitChance(att.hit, target.flee)) return { kind: 'miss', damage: 0 };
  const variance = 0.9 + rng.next() * 0.2;
  return { kind: 'hit', damage: Math.max(1, Math.round(att.atk * variance * defReduction(target.def))) };
}
