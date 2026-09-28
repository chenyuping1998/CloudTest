import { describe, expect, it } from 'vitest';
import { distributeExp, partyBonus, type ShareGroup } from '../src/core/party';

const party = (id: number, mode: 'even' | 'each', members: [string, number][]): ShareGroup => ({
  partyId: id, mode, eligible: members.map(([name, level]) => ({ name, level })),
});

describe('party exp distribution', () => {
  it('solo players get exp by damage share', () => {
    const r = distributeExp(new Map([['A', 30], ['B', 70]]), () => undefined);
    expect(r.get('A')).toBeCloseTo(0.3);
    expect(r.get('B')).toBeCloseTo(0.7);
  });

  it('even share splits the party portion with a bonus, including members who did no damage', () => {
    const g = party(1, 'even', [['A', 20], ['B', 22], ['Healer', 18]]);
    const r = distributeExp(new Map([['A', 100]]), () => g);
    const each = partyBonus(3) / 3;
    expect(r.get('A')).toBeCloseTo(each);
    expect(r.get('Healer')).toBeCloseTo(each);
    expect([...r.values()].reduce((s, v) => s + v, 0)).toBeCloseTo(partyBonus(3));
  });

  it('falls back to damage share when level gap is too large (anti power-leveling)', () => {
    const g = party(1, 'even', [['High', 60], ['Low', 10]]);
    const r = distributeExp(new Map([['High', 100]]), () => g);
    expect(r.get('High')).toBe(1);
    expect(r.has('Low')).toBe(false);
  });

  it('each mode ignores the party', () => {
    const g = party(1, 'each', [['A', 20], ['B', 20]]);
    const r = distributeExp(new Map([['A', 50], ['B', 50]]), () => g);
    expect(r.get('A')).toBeCloseTo(0.5);
  });

  it('mixed: party and outsider share by damage first', () => {
    const g = party(1, 'even', [['A', 20], ['B', 20]]);
    const r = distributeExp(new Map([['A', 50], ['X', 50]]), (n) => (n === 'X' ? undefined : g));
    expect(r.get('X')).toBeCloseTo(0.5);
    expect(r.get('A')).toBeCloseTo((0.5 * partyBonus(2)) / 2);
    expect(r.get('B')).toBeCloseTo((0.5 * partyBonus(2)) / 2);
  });
});
