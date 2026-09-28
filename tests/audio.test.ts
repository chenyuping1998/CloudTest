import { describe, expect, it } from 'vitest';
import { composeLoop } from '../src/game/audio';

describe('procedural music', () => {
  const song = { bpm: 100, scale: [60, 62, 64, 65, 67, 69, 71, 72], chords: [0, 5, 3, 4, 0, 5, 3, 4], lead: 'square' as OscillatorType, drums: true, seed: 7 };

  it('produces an 8-bar loop (64 eighth notes) with bass on every downbeat', () => {
    const loop = composeLoop(song);
    expect(loop).toHaveLength(64);
    for (let bar = 0; bar < 8; bar++) expect(loop[bar * 8].some((n) => n.kind === 'bass')).toBe(true);
  });

  it('melody stays in the scale and never overlaps itself', () => {
    const loop = composeLoop(song);
    let busyUntil = 0;
    loop.forEach((step, i) => {
      for (const n of step.filter((x) => x.kind === 'lead')) {
        expect(song.scale.map((p) => p + 12)).toContain(n.pitch);
        expect(i).toBeGreaterThanOrEqual(busyUntil);
        busyUntil = i + n.len;
      }
    });
    expect(busyUntil).toBeLessThanOrEqual(64);
  });

  it('is deterministic for the same seed', () => {
    expect(composeLoop(song)).toEqual(composeLoop(song));
    expect(composeLoop({ ...song, seed: 8 })).not.toEqual(composeLoop(song));
  });
});
