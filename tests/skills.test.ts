import { describe, expect, it } from 'vitest';
import { SKILLS } from '../src/data/skills';
import { CLASSES } from '../src/data/classes';
import { makeChar } from './helpers';

describe('skill data', () => {
  it('every skill has a valid class, requirements that exist, and sane numbers', () => {
    const ids = new Set(SKILLS.map((s) => s.id));
    expect(ids.size).toBe(SKILLS.length);
    for (const s of SKILLS) {
      expect(CLASSES[s.classId]).toBeDefined();
      for (const r of s.requires ?? []) expect(ids.has(r.skill)).toBe(true);
      if (s.kind === 'active') {
        expect(s.sp).toBeDefined();
        for (let lv = 1; lv <= s.maxLevel; lv++) {
          expect(s.sp!(lv)).toBeGreaterThan(0);
          if (s.damage) expect(s.damage.mul(lv)).toBeGreaterThan(0);
        }
      }
    }
    // 每個一轉 / 二轉職業都有 4 個技能
    for (const cls of Object.values(CLASSES).filter((c) => c.tier > 0)) {
      expect(SKILLS.filter((s) => s.classId === cls.id)).toHaveLength(4);
    }
  });
});

describe('learning skills', () => {
  it('uses skill points, respects prerequisites and class lineage', () => {
    const c = makeChar('Learner');
    c.progression.skillPoints = 20;
    expect(c.learnSkill('bash').ok).toBe(false); // 初心者不能學劍士技能
    c.progression.jobLevel = 10;
    c.changeJob('swordsman');
    expect(c.learnSkill('magnum_break').reason).toContain('重擊');
    for (let i = 0; i < 5; i++) expect(c.learnSkill('bash').ok).toBe(true);
    expect(c.learnSkill('magnum_break').ok).toBe(true);
    expect(c.progression.skillPoints).toBe(14);
    expect(c.learnSkill('fire_bolt').ok).toBe(false);
  });

  it('second job keeps first-job skills and unlocks new ones at Job 40', () => {
    const c = makeChar('Knighted');
    c.progression.jobLevel = 10;
    c.changeJob('swordsman');
    c.progression.skillPoints = 10;
    c.learnSkill('bash');
    expect(c.jobChoices()).toEqual([]);
    c.progression.jobLevel = 40;
    expect(c.jobChoices()).toEqual(['knight']);
    expect(c.changeJob('wizard')).toBe(false);
    expect(c.changeJob('knight')).toBe(true);
    expect(c.skillLevel('bash')).toBe(1);
    expect(c.availableSkills().some((s) => s.id === 'bash')).toBe(true);
    expect(c.availableSkills().some((s) => s.id === 'whirlwind')).toBe(true);
    expect(c.derived().maxHp).toBeGreaterThan(0);
  });
});

describe('passives and buffs', () => {
  it('passive skills change derived stats; buffs only apply while active', () => {
    const c = makeChar('Buffed');
    c.progression.jobLevel = 10;
    c.changeJob('swordsman');
    const base = c.derived();
    c.progression.skillPoints = 30;
    for (let i = 0; i < 10; i++) c.learnSkill('sword_mastery');
    for (let i = 0; i < 5; i++) c.learnSkill('endure');
    const withPassive = c.derived();
    expect(withPassive.atk).toBe(base.atk + 40);
    expect(withPassive.maxHp).toBeGreaterThan(base.maxHp);
    c.data.classId = 'knight';
    c.data.skills!.aura_blade = 5;
    c.addBuff('aura_blade', 5, 10_000);
    expect(c.derived(5_000).atk).toBeGreaterThan(withPassive.atk);
    expect(c.derived(20_000).atk).toBe(c.derived().atk);
    expect(c.pruneBuffs(20_000)).toBe(true);
  });
});
