/**
 * 地圖格子（高度圖）。純資料、無畫面相依：伺服器用來判斷能不能走，用戶端用來產生方塊網格。
 */
import type { TileName } from './tiles';

export interface Column {
  height: number;
  top: TileName;
  /** 地表下的材質 */
  under: TileName;
  water?: boolean;
  /** 高草、花 */
  plant?: TileName;
  blocked?: boolean;
}

export class Grid {
  readonly cols: Column[] = [];

  constructor(readonly size: number, gen: (x: number, z: number) => Column) {
    for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) this.cols.push(gen(i - size / 2 + 0.5, j - size / 2 + 0.5));
  }

  col(i: number, j: number): Column | undefined {
    if (i < 0 || j < 0 || i >= this.size || j >= this.size) return undefined;
    return this.cols[j * this.size + i];
  }

  columnAt(x: number, z: number): Column | undefined {
    return this.col(Math.floor(x + this.size / 2), Math.floor(z + this.size / 2));
  }

  heightAt(x: number, z: number): number {
    return this.columnAt(x, z)?.height ?? 0;
  }

  walkable(x: number, z: number): boolean {
    const c = this.columnAt(x, z);
    return !!c && !c.water && !c.blocked;
  }
}

/** 平滑的值雜訊（不需額外套件） */
export function valueNoise(seed: number): (x: number, z: number) => number {
  const hash = (x: number, z: number) => {
    let h = (x * 374761393 + z * 668265263 + seed * 982451653) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const smooth = (t: number) => t * t * (3 - 2 * t);
  const n = (x: number, z: number) => {
    const xi = Math.floor(x);
    const zi = Math.floor(z);
    const tx = smooth(x - xi);
    const tz = smooth(z - zi);
    const a = hash(xi, zi);
    const b = hash(xi + 1, zi);
    const c = hash(xi, zi + 1);
    const d = hash(xi + 1, zi + 1);
    return a + (b - a) * tx + (c - a) * tz + (a - b - c + d) * tx * tz;
  };
  return (x, z) => n(x, z) * 0.65 + n(x * 2.1, z * 2.1) * 0.35;
}
