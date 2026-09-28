/**
 * 把共用的高度圖（Grid）轉成方塊網格：只產生看得到的面。
 */
import * as THREE from 'three';
import type { Grid } from '../../shared/grid';
import type { TileName } from '../../shared/tiles';
import { blockMaterial, cutoutMaterial, GeoBuilder, waterMaterial } from './mesher';

const SIDE_OF: Partial<Record<TileName, TileName>> = { grass_top: 'grass_side' };

export class Terrain {
  readonly group = new THREE.Group();
  mesh!: THREE.Mesh;

  constructor(readonly grid: Grid) {}

  get size(): number {
    return this.grid.size;
  }

  heightAt(x: number, z: number): number {
    return this.grid.heightAt(x, z);
  }

  build(): THREE.Group {
    const solid = new GeoBuilder();
    const plants = new GeoBuilder();
    const water = new GeoBuilder();
    const size = this.grid.size;
    const half = size / 2;
    for (let j = 0; j < size; j++) {
      for (let i = 0; i < size; i++) {
        const c = this.grid.col(i, j)!;
        const x0 = i - half;
        const z0 = j - half;
        const H = c.height;
        solid.box(x0, H - 1, z0, x0 + 1, H, z0 + 1, c.top, { faces: ['py'] });
        const neigh: [number, number, 'px' | 'nx' | 'pz' | 'nz'][] = [[1, 0, 'px'], [-1, 0, 'nx'], [0, 1, 'pz'], [0, -1, 'nz']];
        for (const [di, dj, f] of neigh) {
          const n = this.grid.col(i + di, j + dj);
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
    if (!water.empty) this.group.add(new THREE.Mesh(water.build(), waterMaterial()));
    return this.group;
  }
}
