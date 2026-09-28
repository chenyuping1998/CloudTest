/**
 * 把共用的高度圖（Grid）轉成方塊網格：只產生看得到的面。
 */
import * as THREE from 'three';
import type { Grid } from '../../shared/grid';
import type { TileName } from '../../shared/tiles';
import { blockMaterial, GeoBuilder, plantMaterial, waterMaterial } from './mesher';

/** 頂面角落被 0~3 個較高鄰格遮住時的亮度（Minecraft 平滑光照的簡化版） */
const AO_LEVEL = [0.58, 0.74, 0.88, 1];
/** 牆面最下緣貼地處的亮度（接觸陰影） */
const WALL_BASE_AO = 0.72;
/** 頂面四個角（依 GeoBuilder 的 py 頂點順序）朝向的 x、z 方向 */
const TOP_CORNERS: [number, number][] = [[-1, 1], [1, 1], [1, -1], [-1, -1]];

const SIDE_OF: Partial<Record<TileName, TileName>> = { grass_top: 'grass_side', snow_top: 'snow_side', frozen_grass: 'snow_side' };

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
        const higher = (di: number, dj: number) => (this.grid.col(i + di, j + dj)?.height ?? -99) > H ? 1 : 0;
        const ao = TOP_CORNERS.map(([dx, dz]) => {
          const s1 = higher(dx, 0);
          const s2 = higher(0, dz);
          return AO_LEVEL[s1 && s2 ? 0 : 3 - (s1 + s2 + higher(dx, dz))];
        });
        solid.box(x0, H - 1, z0, x0 + 1, H, z0 + 1, c.top, { faces: ['py'], ao });
        const neigh: [number, number, 'px' | 'nx' | 'pz' | 'nz'][] = [[1, 0, 'px'], [-1, 0, 'nx'], [0, 1, 'pz'], [0, -1, 'nz']];
        for (const [di, dj, f] of neigh) {
          const n = this.grid.col(i + di, j + dj);
          const nh = n ? n.height : -2;
          for (let y = nh; y < H; y++) {
            const tile = y === H - 1 ? SIDE_OF[c.top] ?? c.top : c.under;
            // 側面頂點順序前兩個是下緣
            const wallAo = n && y === nh ? [WALL_BASE_AO, WALL_BASE_AO, 1, 1] : undefined;
            solid.box(x0, y, z0, x0 + 1, y + 1, z0 + 1, tile, { faces: [f], ao: wallAo });
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
    if (!plants.empty) this.group.add(new THREE.Mesh(plants.build(), plantMaterial()));
    if (!water.empty) this.group.add(new THREE.Mesh(water.build(), waterMaterial()));
    return this.group;
  }
}
