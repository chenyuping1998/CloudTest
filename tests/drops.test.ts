import { describe, expect, it } from 'vitest';
import {
  DROP_RULES, dropLevelModifier, finalRatePpm, killsForConfidence, personalBonusPct, rollDrops, validateDropProfile,
  type DropContext,
} from '../src/core/drops';
import { PPM, SeededRng } from '../src/core/rng';
import { Rarity } from '../src/core/types';
import { ITEM_DB, MONSTERS, MONSTER_DB, POOL_DB, RESOURCE_NODES } from '../src/data';

const baseCtx = (over: Partial<DropContext> = {}): DropContext => ({
  playerLevel: 10, sourceLevel: 10, luk: 0, personalBonusPct: 0, eventMultiplier: 1, ...over,
});

describe('drop table data', () => {
  it('every monster drop table passes validation (rarity bands, cards, pools)', () => {
    const issues = MONSTERS.flatMap((m) => validateDropProfile(m.drops, ITEM_DB, POOL_DB));
    expect(issues).toEqual([]);
  });

  it('every resource node yield table passes validation', () => {
    const issues = RESOURCE_NODES.flatMap((n) => validateDropProfile({ sourceId: n.id, drops: n.yields }, ITEM_DB, POOL_DB));
    expect(issues).toEqual([]);
  });

  it('validation catches a legendary item with a too-high rate', () => {
    const issues = validateDropProfile({ sourceId: 'x', drops: [{ itemId: 'frost_whisper', ratePpm: 50_000 }] }, ITEM_DB, POOL_DB);
    expect(issues).toHaveLength(1);
  });

  it('validation rejects cards not at the standard rate and pity outside MVP', () => {
    const issues = validateDropProfile(
      { sourceId: 'x', drops: [{ itemId: 'card_wolf', ratePpm: 1000, category: 'card' }, { itemId: 'frost_whisper', ratePpm: 100, pity: { startAfter: 1, stepPpm: 1 } }] },
      ITEM_DB, POOL_DB,
    );
    expect(issues).toHaveLength(2);
  });
});

describe('drop modifiers', () => {
  it('level penalty reduces drops when player out-levels the monster', () => {
    expect(dropLevelModifier(10, 10)).toBe(1);
    expect(dropLevelModifier(10, 20)).toBe(1);
    expect(dropLevelModifier(30, 10)).toBe(0.5);
    expect(dropLevelModifier(99, 1)).toBe(0.1);
  });

  it('personal bonus includes LUK and is capped', () => {
    expect(personalBonusPct({ luk: 50, personalBonusPct: 10 })).toBe(15);
    expect(personalBonusPct({ luk: 999, personalBonusPct: 999 })).toBe(DROP_RULES.personalBonusCapPct);
  });

  it('rarer items benefit less from personal bonus; cards ignore it', () => {
    const ctx = baseCtx({ personalBonusPct: 100 });
    expect(finalRatePpm({ itemId: 'jelly', ratePpm: 100_000 }, Rarity.Common, ctx)).toBe(200_000);
    expect(finalRatePpm({ itemId: 'x', ratePpm: 100 }, Rarity.Legendary, ctx)).toBe(125);
    expect(finalRatePpm({ itemId: 'x', ratePpm: 100 }, Rarity.Mythic, ctx)).toBe(100);
    expect(finalRatePpm({ itemId: 'card', ratePpm: 100, category: 'card' }, Rarity.Epic, ctx)).toBe(100);
  });

  it('event multiplier applies and final rate is clamped; guaranteed drops stay guaranteed', () => {
    const ctx = baseCtx({ eventMultiplier: 3, personalBonusPct: 100 });
    expect(finalRatePpm({ itemId: 'jelly', ratePpm: 700_000 }, Rarity.Common, ctx)).toBe(DROP_RULES.maxRatePpm);
    expect(finalRatePpm({ itemId: 'lich_ash', ratePpm: PPM }, Rarity.Rare, baseCtx({ playerLevel: 99, sourceLevel: 1 }))).toBe(PPM);
  });

  it('killsForConfidence matches geometric distribution', () => {
    expect(killsForConfidence(100, 0.5)).toBe(6932); // 0.01% 卡片：約 6932 隻有 50% 機率
    expect(killsForConfidence(PPM, 0.99)).toBe(1);
  });
});

describe('drop simulation (Monte Carlo)', () => {
  it('observed rates converge to configured rates', () => {
    const slime = MONSTER_DB.get('jelly_slime')!;
    const rng = new SeededRng(42);
    const N = 200_000;
    const counts = new Map<string, number>();
    for (let i = 0; i < N; i++) {
      for (const d of rollDrops(slime.drops, ITEM_DB, POOL_DB, baseCtx({ playerLevel: 1, sourceLevel: 1 }), rng)) {
        counts.set(d.itemId, (counts.get(d.itemId) ?? 0) + 1);
      }
    }
    for (const e of slime.drops.drops) {
      const expected = (e.ratePpm / PPM) * N;
      const observed = counts.get(e.itemId) ?? 0;
      // 4 個標準差內
      const sd = Math.sqrt(N * (e.ratePpm / PPM) * (1 - e.ratePpm / PPM));
      expect(Math.abs(observed - expected)).toBeLessThanOrEqual(4 * sd + 1);
    }
  });

  it('treasure pool triggers at configured rate', () => {
    const wolf = MONSTER_DB.get('grey_wolf')!;
    const rng = new SeededRng(7);
    const N = 100_000;
    let pool = 0;
    for (let i = 0; i < N; i++) pool += rollDrops(wolf.drops, ITEM_DB, POOL_DB, baseCtx(), rng).filter((d) => d.category === 'pool').length;
    const p = POOL_DB.get('field_t1')!.triggerPpm / PPM;
    expect(Math.abs(pool - p * N)).toBeLessThan(4 * Math.sqrt(N * p * (1 - p)));
  });

  it('MVP drops only go to the MVP winner, and pity raises the rate over time', () => {
    const lich = MONSTER_DB.get('bone_lich')!;
    const rng = new SeededRng(1);
    const nonWinner = rollDrops(lich.drops, ITEM_DB, POOL_DB, baseCtx({ playerLevel: 45, sourceLevel: 45 }), rng);
    expect(nonWinner.some((d) => d.category === 'mvp')).toBe(false);
    const winner = rollDrops(lich.drops, ITEM_DB, POOL_DB, baseCtx({ playerLevel: 45, sourceLevel: 45, isMvpWinner: true }), rng);
    expect(winner.some((d) => d.itemId === 'scroll_protect')).toBe(true);

    const pity = new Map<string, number>([['bone_lich:lich_scepter', 140]]);
    const r = new SeededRng(3);
    const ctx = baseCtx({ playerLevel: 45, sourceLevel: 45, isMvpWinner: true, pityCounters: pity });
    // 140 次沒掉 → 50 + (140-40)*25 = 2550 ppm；確認計數器在掉落後歸零或持續累加
    rollDrops(lich.drops, ITEM_DB, POOL_DB, ctx, r);
    const v = pity.get('bone_lich:lich_scepter')!;
    expect(v === 0 || v === 141).toBe(true);
  });

  it('same seed gives identical results (server replay / anti-cheat audit)', () => {
    const g = MONSTER_DB.get('goblin')!;
    const run = () => {
      const rng = new SeededRng(999);
      return Array.from({ length: 500 }, () => rollDrops(g.drops, ITEM_DB, POOL_DB, baseCtx(), rng));
    };
    expect(run()).toEqual(run());
  });
});

describe('pity stats', () => {
  it('without pity equals geometric expectation', async () => {
    const { pityKillStats } = await import('../src/core/drops');
    const s = pityKillStats({ itemId: 'x', ratePpm: 10_000 });
    expect(Math.round(s.expected)).toBe(100);
    expect(s.atConfidence[0]).toBe(killsForConfidence(10_000, 0.5));
  });

  it('pity greatly lowers expected kills for the mythic MVP drop', async () => {
    const { pityKillStats } = await import('../src/core/drops');
    const entry = MONSTER_DB.get('bone_lich')!.drops.mvpDrops!.find((d) => d.itemId === 'lich_scepter')!;
    const s = pityKillStats(entry);
    expect(s.expected).toBeLessThan(400);
    expect(s.expected).toBeGreaterThan(100);
  });
});
