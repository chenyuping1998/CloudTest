/**
 * 方塊網格建構器：把大量方塊面合併成一個 BufferGeometry（一次 draw call）。
 * 面的明暗照 Minecraft：頂面最亮、側面較暗、底面最暗。
 */
import * as THREE from 'three';
import { atlasTexture, tileUV, type TileName } from './atlas';

export type Face = 'px' | 'nx' | 'py' | 'ny' | 'pz' | 'nz';
export const FACES: Face[] = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];
const SHADE: Record<Face, number> = { py: 1, ny: 0.5, px: 0.8, nx: 0.8, pz: 0.68, nz: 0.68 };

export type FaceTiles = TileName | Partial<Record<Face | 'side', TileName>> & { all?: TileName };

function tileFor(tiles: FaceTiles, f: Face): TileName {
  if (typeof tiles === 'string') return tiles;
  return tiles[f] ?? ((f === 'py' || f === 'ny') ? undefined : tiles.side) ?? tiles.all ?? tiles.side ?? 'stone';
}

export class GeoBuilder {
  private pos: number[] = [];
  private nor: number[] = [];
  private uv: number[] = [];
  private col: number[] = [];
  private idx: number[] = [];

  get empty(): boolean {
    return this.idx.length === 0;
  }

  /** 加一個四邊形；corners 依逆時針順序 (從外面看)，uv 從左下開始 */
  quad(c: number[][], n: number[], tile: TileName, shade: number, tint: [number, number, number] = [1, 1, 1], uvRect?: [number, number, number, number]): void {
    const [u0, v0, u1, v1] = tileUV(tile);
    const [a, b, cc, d] = uvRect ?? [0, 0, 1, 1];
    const us = [u0 + (u1 - u0) * a, u0 + (u1 - u0) * cc];
    const vs = [v0 + (v1 - v0) * b, v0 + (v1 - v0) * d];
    const base = this.pos.length / 3;
    const uvs = [[us[0], vs[0]], [us[1], vs[0]], [us[1], vs[1]], [us[0], vs[1]]];
    for (let i = 0; i < 4; i++) {
      this.pos.push(c[i][0], c[i][1], c[i][2]);
      this.nor.push(n[0], n[1], n[2]);
      this.uv.push(uvs[i][0], uvs[i][1]);
      this.col.push(shade * tint[0], shade * tint[1], shade * tint[2]);
    }
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  /** 以 (x0,y0,z0)-(x1,y1,z1) 的方塊加入指定面 */
  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, tiles: FaceTiles, opts: { faces?: Face[]; tint?: [number, number, number]; uvScale?: boolean } = {}): void {
    const faces = opts.faces ?? FACES;
    // uvScale：小於 1 格的方塊只取材質的一部分，讓像素大小一致
    const sx = opts.uvScale ? Math.min(1, x1 - x0) : 1;
    const sy = opts.uvScale ? Math.min(1, y1 - y0) : 1;
    const sz = opts.uvScale ? Math.min(1, z1 - z0) : 1;
    for (const f of faces) {
      const t = tileFor(tiles, f);
      const s = SHADE[f];
      const tint = opts.tint;
      switch (f) {
        case 'py': this.quad([[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], [0, 1, 0], t, s, tint, [0, 0, sx, sz]); break;
        case 'ny': this.quad([[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], [0, -1, 0], t, s, tint, [0, 0, sx, sz]); break;
        case 'pz': this.quad([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [0, 0, 1], t, s, tint, [0, 1 - sy, sx, 1]); break;
        case 'nz': this.quad([[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], [0, 0, -1], t, s, tint, [0, 1 - sy, sx, 1]); break;
        case 'px': this.quad([[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], [1, 0, 0], t, s, tint, [0, 1 - sy, sz, 1]); break;
        case 'nx': this.quad([[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], [-1, 0, 0], t, s, tint, [0, 1 - sy, sz, 1]); break;
      }
    }
  }

  /** 植物：兩片交叉的面（高草、花） */
  cross(x: number, y: number, z: number, tile: TileName, size = 0.9): void {
    const h = size;
    const r = size / 2;
    const n = [0, 1, 0];
    // 沿 x、z 軸擺放（而非對角線），45° 俯視時兩片都看得到，不會變成一條線
    this.quad([[x - r, y, z], [x + r, y, z], [x + r, y + h, z], [x - r, y + h, z]], n, tile, 1.05);
    this.quad([[x, y, z + r], [x, y, z - r], [x, y + h, z - r], [x, y + h, z + r]], n, tile, 1.05);
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

let solidMat: THREE.MeshLambertMaterial | undefined;
let cutoutMat: THREE.MeshLambertMaterial | undefined;
let waterMat: THREE.MeshLambertMaterial | undefined;

export function blockMaterial(): THREE.MeshLambertMaterial {
  return (solidMat ??= new THREE.MeshLambertMaterial({ map: atlasTexture(), vertexColors: true }));
}

/** 植物、玻璃等有透明像素的方塊 */
export function cutoutMaterial(): THREE.MeshLambertMaterial {
  return (cutoutMat ??= new THREE.MeshLambertMaterial({ map: atlasTexture(), vertexColors: true, alphaTest: 0.5, side: THREE.DoubleSide }));
}

export function waterMaterial(): THREE.MeshLambertMaterial {
  return (waterMat ??= new THREE.MeshLambertMaterial({ map: atlasTexture(), vertexColors: true, transparent: true, opacity: 0.72, depthWrite: false }));
}

/** 一次建好一個方塊模型（家具、礦石、樹等），回傳可投射陰影的 Mesh */
export function blockMesh(fill: (b: GeoBuilder) => void, material = blockMaterial()): THREE.Mesh {
  const b = new GeoBuilder();
  fill(b);
  const m = new THREE.Mesh(b.build(), material);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}
