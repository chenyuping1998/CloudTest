/**
 * 組隊規則（RO 式）
 * - 最多 6 人。
 * - 均分模式：同地圖、距離擊殺點 25 格內、且全隊等級差 ≤ 15 的成員平分經驗，
 *   每多一位成員全隊總經驗 +12%（組隊誘因，但不會讓單練變得沒意義）。
 * - 各自模式：依各自造成的傷害比例取得（與單人相同）。
 * - 掉寶優先權屬於整個隊伍。
 */
export type ShareMode = 'even' | 'each';

export const PARTY_MAX = 6;
export const PARTY_LEVEL_RANGE = 15;
export const PARTY_SHARE_DISTANCE = 25;
export const PARTY_BONUS_PER_MEMBER = 0.12;

export function partyBonus(members: number): number {
  return 1 + PARTY_BONUS_PER_MEMBER * Math.max(0, members - 1);
}

export function levelsCanShare(levels: readonly number[]): boolean {
  if (levels.length === 0) return false;
  return Math.max(...levels) - Math.min(...levels) <= PARTY_LEVEL_RANGE;
}

export interface ShareGroup {
  /** 隊伍識別；undefined 表示單人 */
  partyId?: number;
  mode: ShareMode;
  /** 可以分到均分經驗的成員（已篩選：同地圖、距離內） */
  eligible: { name: string; level: number }[];
}

/**
 * 計算每位玩家分到怪物經驗的「比例」（尚未套用等級差倍率、單次上限、休息經驗）。
 * @param damage 每位玩家造成的傷害
 * @param groupOf 查詢玩家所屬隊伍（單人回傳 undefined）
 */
export function distributeExp(damage: ReadonlyMap<string, number>, groupOf: (name: string) => ShareGroup | undefined): Map<string, number> {
  const out = new Map<string, number>();
  const total = [...damage.values()].reduce((s, v) => s + v, 0);
  if (total <= 0) return out;
  const add = (name: string, v: number) => out.set(name, (out.get(name) ?? 0) + v);
  const handled = new Set<number>();
  for (const [name, dmg] of damage) {
    const g = groupOf(name);
    if (!g || g.partyId === undefined || g.mode === 'each') {
      add(name, dmg / total);
      continue;
    }
    if (handled.has(g.partyId)) continue;
    handled.add(g.partyId);
    // 整隊的傷害合計
    let partyDmg = 0;
    const damagers: string[] = [];
    for (const [n2, d2] of damage) {
      if (groupOf(n2)?.partyId === g.partyId) {
        partyDmg += d2;
        damagers.push(n2);
      }
    }
    const share = partyDmg / total;
    const eligible = g.eligible;
    if (eligible.length >= 2 && levelsCanShare(eligible.map((e) => e.level))) {
      const each = (share * partyBonus(eligible.length)) / eligible.length;
      for (const e of eligible) add(e.name, each);
    } else {
      // 等級差太大或只有一人在場：退回各自依傷害取得
      for (const n2 of damagers) add(n2, (damage.get(n2) ?? 0) / total);
    }
  }
  return out;
}
