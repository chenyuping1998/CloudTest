/**
 * 高度圖地形：每一格是一疊方塊，只產生看得到的面。
 */
import * as THREE from 'three';
import type { TileName } from './atlas';
import { blockMaterial, cutoutMaterial, GeoBuilder, waterMaterial } from './mesher';

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

const SIDE_OF: Partial<Record<TileName, TileName>> = { grass_top: 'grass_side' };

export class Terrain {
  readonly cols: Column[];
  readonly group = new THREE.Group();
  mesh!: THREE.Mesh;

  constructor(readonly size: number, gen: (x: number, z: number) => Column) {
    this.cols = [];
    for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) this.cols.push(gen(i - size / 2 + 0.5, j - size / 2 + 0.5));
  }

  private col(i: number, j: number): Column | undefined {
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

  build(): THREE.Group {
    const solid = new GeoBuilder();
    const plants = new GeoBuilder();
    const water = new GeoBuilder();
    const half = this.size / 2;
    for (let j = 0; j < this.size; j++) {
      for (let i = 0; i < this.size; i++) {
        const c = this.col(i, j)!;
        const x0 = i - half;
        const z0 = j - half;
        const H = c.height;
        solid.box(x0, H - 1, z0, x0 + 1, H, z0 + 1, c.top, { faces: ['py'] });
        const neigh: [number, number, 'px' | 'nx' | 'pz' | 'nz'][] = [[1, 0, 'px'], [-1, 0, 'nx'], [0, 1, 'pz'], [0, -1, 'nz']];
        for (const [di, dj, f] of neigh) {
          const n = this.col(i + di, j + dj);
          const nh = n ? n.height : -2;
          for (let y = nh; y < H; y++) {
            const tile = y === H - 1 ? SIDE_OF[c.top] ?? c.top : c.under;
            solid.box(x0, y, z0, x0 + 1, y + 1, z0 + 1, tile, { faces: [f] });
          }
        }
        if (c.water) water.box(x0, H, z0, x0 + 1, H + 0.85, z0 + 1, 'water', { faces: ['py'] });
        if (c.plant) plants.cross(x0 + 0.5, H, z0 + 0.5, c.plant, c.plant === 'tallgrass' ? 0.8 : 0.7);
      }
    }
    this.group.clear();
    this.mesh = new THREE.Mesh(solid.build(), blockMaterial());
    this.mesh.receiveShadow = true;
    this.mesh.name = 'terrain';
    this.group.add(this.mesh);
    if (!plants.empty) this.group.add(new THREE.Mesh(plants.build(), cutoutMaterial()));
    if (!water.empty) {
      const w = new THREE.Mesh(water.build(), waterMaterial());
      w.name = 'water';
      this.group.add(w);
    }
    return this.group;
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
