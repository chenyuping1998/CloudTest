import { describe, expect, it } from 'vitest';
import { addExp, applyDeathPenalty, baseExpToNext, MAX_BASE_LEVEL, statRaiseCost } from '../src/core/leveling';
import { enchantSuccessRate, expectedEnchantCost, tryEnchant } from '../src/core/enchant';
import { resolveAttack, hitChance } from '../src/core/combat';
import { SeededRng } from '../src/core/rng';
import { give, makeChar } from './helpers';

describe('leveling', () => {
  it('levels up and grants stat points', () => {
    const c = makeChar('A');
    const p = c.progression;
    const before = p.statPoints;
    const res = addExp(p, baseExpToNext(1) + baseExpToNext(2), 0);
    expect(res.baseLevelsGained).toBe(2);
    expect(p.baseLevel).toBe(3);
    expect(p.statPoints).toBe(before + 3 + 3);
  });

  it('caps at max level', () => {
    const c = makeChar('B');
    addExp(c.progression, 1e12, 1e12);
    expect(c.progression.baseLevel).toBe(MAX_BASE_LEVEL);
    expect(c.progression.baseExp).toBe(0);
  });

  it('stat cost grows like RO', () => {
    expect(statRaiseCost(1)).toBe(2);
    expect(statRaiseCost(11)).toBe(3);
    expect(statRaiseCost(91)).toBe(11);
  });

  it('death penalty never de-levels', () => {
    const c = makeChar('C');
    c.progression.baseExp = 0;
    expect(applyDeathPenalty(c.progression)).toBe(0);
    expect(c.progression.baseLevel).toBe(1);
  });

  it('job change at job level 10', () => {
    const c = makeChar('D');
    expect(c.changeJob('merchant')).toBe(false);
    c.progression.jobLevel = 10;
    expect(c.changeJob('merchant')).toBe(true);
    expect(c.classDef.perks.marketTaxReductionPct).toBe(2);
  });
});

describe('equipment', () => {
  it('bindOnEquip binds on equip and cards compound permanently', () => {
    const c = makeChar('E');
    c.progression.baseLevel = 50;
    const sword = give(c, 'frost_whisper');
    give(c, 'card_skeleton');
    const card = c.inventory.items.find((i) => i.defId === 'card_skeleton')!;
    expect(c.compoundCard(card.uid, sword.uid).ok).toBe(true);
    expect(c.inventory.count('card_skeleton')).toBe(0);
    const atkBefore = c.derived().atk;
    expect(c.equip(sword.uid).ok).toBe(true);
    expect(c.data.equipment.weapon!.bound).toBe(true);
    expect(c.derived().atk).toBeGreaterThan(atkBefore + 175);
  });
});

describe('enchant', () => {
  it('safe zone always succeeds', () => {
    const rng = new SeededRng(5);
    let lv = 0;
    for (let i = 0; i < 6; i++) lv = tryEnchant('weapon', lv, { blessed: false, protectedByScroll: false }, rng).newLevel;
    expect(lv).toBe(6);
    expect(enchantSuccessRate('armor', 3)).toBe(1);
    expect(enchantSuccessRate('armor', 4)).toBeLessThan(1);
  });

  it('protection scroll downgrades instead of destroying', () => {
    const alwaysFail = { next: () => 0.9999 };
    expect(tryEnchant('weapon', 9, { blessed: false, protectedByScroll: true }, alwaysFail)).toEqual({ outcome: 'downgraded', newLevel: 8 });
    expect(tryEnchant('weapon', 9, { blessed: false, protectedByScroll: false }, alwaysFail).outcome).toBe('destroyed');
  });

  it('expected cost grows steeply past safe level', () => {
    expect(expectedEnchantCost('weapon', 6).items).toBe(1);
    expect(expectedEnchantCost('weapon', 9).items).toBeGreaterThan(10);
  });
});

describe('combat', () => {
  it('hit chance is clamped', () => {
    expect(hitChance(1000, 0)).toBe(0.95);
    expect(hitChance(0, 1000)).toBe(0.05);
  });

  it('damage is always positive on hit', () => {
    const rng = new SeededRng(11);
    for (let i = 0; i < 100; i++) {
      const r = resolveAttack({ atk: 1, def: 0, hit: 100, flee: 0, critPct: 0 }, { def: 999, flee: 0 }, rng);
      if (r.kind !== 'miss') expect(r.damage).toBeGreaterThanOrEqual(1);
    }
  });
});
