/**
 * 可重現的亂數產生器。
 * 掉寶、強化、採集全部走這裡，之後搬到伺服器端時只要換 seed 來源即可，
 * 測試時也能用固定 seed 重現結果。
 */
export interface Rng {
  /** 回傳 [0, 1) */
  next(): number;
}

/** 機率單位：百萬分率 (ppm)。1 ppm = 0.0001%，100 ppm = 0.01%（RO 卡片的經典掉率）。 */
export const PPM = 1_000_000;

export class SeededRng implements Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** mulberry32 */
  next(): number {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}

export const mathRng: Rng = { next: () => Math.random() };

export function rollPpm(rng: Rng, ppm: number): boolean {
  if (ppm >= PPM) return true;
  if (ppm <= 0) return false;
  return rng.next() * PPM < ppm;
}

/** 含頭含尾 */
export function randInt(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng.next() * (max - min + 1));
}

export function randRange(rng: Rng, min: number, max: number): number {
  return min + rng.next() * (max - min);
}

export function weightedPick<T extends { weight: number }>(rng: Rng, entries: readonly T[]): T {
  const total = entries.reduce((s, e) => s + e.weight, 0);
  if (total <= 0) throw new Error('weightedPick: total weight must be > 0');
  let r = rng.next() * total;
  for (const e of entries) {
    r -= e.weight;
    if (r < 0) return e;
  }
  return entries[entries.length - 1];
}

export function formatPpm(ppm: number): string {
  const pct = (ppm / PPM) * 100;
  if (pct >= 1) return `${+pct.toFixed(2)}%`;
  if (pct >= 0.01) return `${+pct.toFixed(3)}%`;
  return `${+pct.toFixed(4)}%`;
}
