import { describe, expect, it } from 'vitest';
import {
  CONTENT_LEVEL_CAP, DEFAULT_PACING, PACING_CHECKPOINTS, PACING_TOLERANCE, simulateLeveling, suggestMonsterExp, targetCumulativeHours,
} from '../src/balance/pacing';
import { accrueRested, baseExpToNext, capKillExp, consumeRested, expLevelModifier, RESTED_CAP_RATIO } from '../src/core/leveling';
import { MONSTERS } from '../src/data';

describe('leveling pace (simulation with real combat formulas)', () => {
  const rows = simulateLeveling(CONTENT_LEVEL_CAP + 1);
  const at = (lv: number) => rows.find((r) => r.level === lv - 1)!.cumulativeHours;

  it.each(PACING_CHECKPOINTS)('Lv %i is reached within ±30%% of the target curve', (lv) => {
    const ratio = at(lv) / targetCumulativeHours(lv);
    expect(ratio).toBeGreaterThan(1 - PACING_TOLERANCE);
    expect(ratio).toBeLessThan(1 + PACING_TOLERANCE);
  });

  it('no single level inside current content takes more than 3x the target (no dead zones)', () => {
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const target = targetCumulativeHours(r.level + 1) - targetCumulativeHours(r.level);
      expect(r.hoursThisLevel / target).toBeLessThan(3);
    }
  });

  it('job change (Job Lv 10) happens within about the first 1.5 hours', () => {
    const changed = rows.find((r) => r.classId === 'swordsman')!;
    expect(changed.cumulativeHours).toBeLessThan(1.5);
    expect(changed.level).toBeLessThanOrEqual(12);
  });

  it('players move on to level-appropriate monsters instead of farming the newbie area', () => {
    for (const r of rows.filter((x) => x.level >= 15)) {
      expect(r.level - r.best.monster.level).toBeLessThanOrEqual(15);
    }
  });

  it('casual and hardcore players stay within a reasonable spread', () => {
    const casual = simulateLeveling(31, { ...DEFAULT_PACING, efficiency: 0.4 });
    const hard = simulateLeveling(31, { ...DEFAULT_PACING, efficiency: 0.9 });
    const ratio = casual[casual.length - 1].cumulativeHours / hard[hard.length - 1].cumulativeHours;
    expect(ratio).toBeLessThan(2.5);
  });
});

describe('monster EXP follows the calibration formula', () => {
  it.each(MONSTERS.filter((m) => !m.mvp).map((m) => [m.id, m] as const))('%s EXP is within 15%% of the suggested value', (_, m) => {
    const s = suggestMonsterExp(m);
    expect(Math.abs(m.baseExp / s.baseExp - 1)).toBeLessThan(0.15);
  });
});

describe('pacing safeguards', () => {
  it('a single kill never gives more than half a level', () => {
    expect(capKillExp(10, 1e9)).toBe(Math.floor(baseExpToNext(10) / 2));
    expect(capKillExp(10, 5)).toBe(5);
  });

  it('killing far weaker monsters gives almost nothing', () => {
    expect(expLevelModifier(50, 10)).toBeLessThanOrEqual(0.05);
    expect(expLevelModifier(20, 13)).toBeLessThan(1);
    expect(expLevelModifier(20, 40)).toBeGreaterThan(1);
  });

  it('rested EXP accrues while offline, is capped, and is consumed 1:1', () => {
    const need = baseExpToNext(20);
    expect(accrueRested(20, 0, 8)).toBe(Math.floor(need * 0.2));
    expect(accrueRested(20, 0, 10_000)).toBe(Math.floor(need * RESTED_CAP_RATIO));
    expect(accrueRested(20, 100, 0)).toBe(100);
    expect(consumeRested(50, 30)).toEqual([30, 20]);
    expect(consumeRested(10, 30)).toEqual([10, 0]);
  });
});
