/**
 * 程序化生成的 16×16 像素材質圖集（Minecraft 風格）。
 * 正式版可以直接換成美術繪製的 atlas.png，只要 tile 名稱與位置一致即可。
 */
import * as THREE from 'three';
import { SeededRng } from '../../core/rng';

export const TILE = 16;
const COLS = 16;

export type { TileName } from '../../shared/tiles';
import type { TileName } from '../../shared/tiles';

const TILES: TileName[] = [
  'grass_top', 'grass_side', 'dirt', 'stone', 'cobble', 'sand', 'gravel', 'path',
  'log_side', 'log_top', 'leaves', 'maple_leaves', 'planks', 'dark_planks',
  'copper_ore', 'iron_ore', 'mithril_ore', 'coal_ore', 'water',
  'roof', 'stone_brick', 'glass', 'furnace_front', 'furnace_side', 'table_top', 'table_side',
  'iron_block', 'darkstone', 'portal', 'tallgrass', 'flower_red', 'flower_yellow',
  'mushroom_cap', 'mushroom_stem', 'moss_stone', 'bookshelf', 'hay', 'wool_white',
  'snow_top', 'snow_side', 'ice', 'packed_ice', 'spruce_log', 'spruce_leaves', 'frozen_grass',
];

type RGB = [number, number, number];
const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

class Painter {
  readonly data: Uint8ClampedArray<ArrayBuffer>;
  constructor(private readonly rng: SeededRng) {
    this.data = new Uint8ClampedArray(TILE * TILE * 4);
  }
  set(x: number, y: number, c: RGB, a = 255): void {
    if (x < 0 || y < 0 || x >= TILE || y >= TILE) return;
    const i = (y * TILE + x) * 4;
    this.data[i] = c[0];
    this.data[i + 1] = c[1];
    this.data[i + 2] = c[2];
    this.data[i + 3] = a;
  }
  /** 以基礎色填滿並加入隨機明暗雜訊 */
  noise(base: string, amount = 18, palette?: string[]): void {
    const b = hex(base);
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        if (palette && this.rng.next() < 0.3) {
          this.set(x, y, hex(palette[Math.floor(this.rng.next() * palette.length)]));
          continue;
        }
        const d = (this.rng.next() - 0.5) * 2 * amount;
        this.set(x, y, [b[0] + d, b[1] + d, b[2] + d]);
      }
    }
  }
  r(): number {
    return this.rng.next();
  }
  blobs(color: string, count: number, size = 2): void {
    const c = hex(color);
    for (let i = 0; i < count; i++) {
      const cx = Math.floor(this.r() * 14) + 1;
      const cy = Math.floor(this.r() * 14) + 1;
      for (let k = 0; k < size + 1; k++) {
        const dx = Math.floor(this.r() * size) - (size >> 1);
        const dy = Math.floor(this.r() * size) - (size >> 1);
        const d = (this.r() - 0.5) * 30;
        this.set(cx + dx, cy + dy, [c[0] + d, c[1] + d, c[2] + d]);
      }
    }
  }
  rect(x0: number, y0: number, w: number, h: number, color: string, jitter = 0): void {
    const c = hex(color);
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
      const d = (this.r() - 0.5) * 2 * jitter;
      this.set(x, y, [c[0] + d, c[1] + d, c[2] + d]);
    }
  }
  clear(): void {
    this.data.fill(0);
  }
}

const P: Record<TileName, (p: Painter) => void> = {
  grass_top: (p) => p.noise('#6aa83f', 14, ['#5c9a35', '#79b84a', '#629f3a']),
  grass_side: (p) => {
    P.dirt(p);
    for (let x = 0; x < TILE; x++) {
      const depth = 3 + Math.floor(p.r() * 3);
      for (let y = 0; y < depth; y++) p.set(x, y, hex(p.r() < 0.3 ? '#5c9a35' : '#6aa83f'));
    }
  },
  dirt: (p) => p.noise('#8a5f3c', 16, ['#6f4a2d', '#9a6e48', '#7a5234']),
  stone: (p) => {
    p.noise('#7d7d7d', 10);
    p.blobs('#686868', 10, 3);
    p.blobs('#929292', 6, 2);
  },
  cobble: (p) => {
    p.noise('#6d6d6d', 8);
    for (let i = 0; i < 9; i++) {
      const x = (i % 3) * 5 + Math.floor(p.r() * 2);
      const y = Math.floor(i / 3) * 5 + Math.floor(p.r() * 2);
      p.rect(x + 1, y + 1, 3 + Math.floor(p.r() * 2), 3, p.r() < 0.5 ? '#8f8f8f' : '#a0a0a0', 10);
    }
  },
  sand: (p) => p.noise('#dccf9a', 10, ['#d2c38c', '#e6dba8']),
  gravel: (p) => p.noise('#857f7a', 22, ['#6a6460', '#9a948e', '#a8a097', '#5a5552']),
  path: (p) => p.noise('#a88a58', 12, ['#9a7c4c', '#b8996a']),
  log_side: (p) => {
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
      const stripe = x % 4 === 0 || (x + y * 3) % 11 === 0;
      const d = (p.r() - 0.5) * 16;
      const c = hex(stripe ? '#4e3a22' : '#6b5032');
      p.set(x, y, [c[0] + d, c[1] + d, c[2] + d]);
    }
  },
  log_top: (p) => {
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
      const r = Math.hypot(x - 7.5, y - 7.5);
      const edge = r > 6.8;
      const ring = Math.floor(r) % 2 === 0;
      const d = (p.r() - 0.5) * 10;
      const c = hex(edge ? '#5a4329' : ring ? '#b89660' : '#a3834f');
      p.set(x, y, [c[0] + d, c[1] + d, c[2] + d]);
    }
  },
  leaves: (p) => {
    p.noise('#3f7f2c', 20, ['#2f6a20', '#4f9338', '#2a5a1c']);
  },
  maple_leaves: (p) => p.noise('#c8622c', 20, ['#a84a1c', '#e0823a', '#b8401a', '#d9a03a']),
  planks: (p) => {
    p.noise('#b08a55', 8);
    for (let y = 0; y < TILE; y += 4) {
      p.rect(0, y + 3, 16, 1, '#7a5c34');
      const cut = Math.floor(p.r() * 12) + 2;
      p.rect(cut, y, 1, 3, '#8a6a3e');
    }
  },
  dark_planks: (p) => {
    p.noise('#5c4128', 8);
    for (let y = 0; y < TILE; y += 4) p.rect(0, y + 3, 16, 1, '#3a2818');
  },
  copper_ore: (p) => {
    P.stone(p);
    p.blobs('#d9853f', 5, 3);
    p.blobs('#f0a860', 3, 2);
  },
  iron_ore: (p) => {
    P.stone(p);
    p.blobs('#d8b89a', 5, 3);
    p.blobs('#c09070', 3, 2);
  },
  mithril_ore: (p) => {
    P.stone(p);
    p.blobs('#6fe0ff', 5, 3);
    p.blobs('#c0f4ff', 3, 2);
  },
  coal_ore: (p) => {
    P.stone(p);
    p.blobs('#1e1e1e', 6, 3);
  },
  water: (p) => {
    p.noise('#3a6fd8', 10);
    for (let i = 0; i < 6; i++) p.rect(Math.floor(p.r() * 12), Math.floor(p.r() * 16), 3 + Math.floor(p.r() * 3), 1, '#6a9af0');
  },
  roof: (p) => {
    p.noise('#9a3a2a', 10);
    for (let y = 0; y < TILE; y += 4) {
      p.rect(0, y + 3, 16, 1, '#6a2418');
      for (let x = (y / 4) % 2 ? 0 : 4; x < 16; x += 8) p.rect(x, y, 1, 3, '#6a2418');
    }
  },
  stone_brick: (p) => {
    p.noise('#7a7a7a', 8);
    for (let y = 0; y < TILE; y += 8) {
      p.rect(0, y + 7, 16, 1, '#555');
      for (let x = (y / 8) % 2 ? 0 : 8; x < 16; x += 16) p.rect(x, y, 1, 7, '#555');
    }
  },
  glass: (p) => {
    p.rect(0, 0, 16, 16, '#bfe6f2');
    p.rect(1, 1, 14, 14, '#dff4fb');
    for (let i = 0; i < 4; i++) p.set(3 + i, 3 + i, hex('#ffffff'));
    for (let i = 0; i < 16; i++) {
      p.set(i, 0, hex('#9a7a50'));
      p.set(i, 15, hex('#9a7a50'));
      p.set(0, i, hex('#9a7a50'));
      p.set(15, i, hex('#9a7a50'));
      p.set(i, 7, hex('#9a7a50'));
      p.set(7, i, hex('#9a7a50'));
    }
  },
  furnace_side: (p) => P.cobble(p),
  furnace_front: (p) => {
    P.cobble(p);
    p.rect(3, 7, 10, 7, '#1a1a1a');
    p.rect(4, 10, 8, 3, '#ff8a20', 30);
    p.rect(5, 9, 6, 1, '#ffd24a', 20);
    p.rect(3, 2, 10, 2, '#4a4a4a');
  },
  table_top: (p) => {
    P.planks(p);
    p.rect(1, 1, 14, 14, '#9a7648', 6);
    p.rect(2, 3, 5, 1, '#7a7a7a');
    p.rect(9, 2, 1, 6, '#6b5032');
    p.rect(8, 2, 3, 2, '#9a9a9a');
  },
  table_side: (p) => {
    P.planks(p);
    p.rect(2, 4, 4, 5, '#6b5032');
    p.rect(10, 3, 2, 8, '#8a8a8a');
  },
  iron_block: (p) => {
    p.noise('#d8d8d8', 6);
    p.rect(0, 0, 16, 1, '#f0f0f0');
    p.rect(0, 15, 16, 1, '#9a9a9a');
  },
  darkstone: (p) => p.noise('#2e2638', 12, ['#3a2f4a', '#231c2c', '#4a3a60']),
  portal: (p) => {
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
      const v = Math.sin(x * 0.9 + y * 0.5) + Math.sin(y * 1.1 - x * 0.3);
      const c = v > 0.8 ? '#e0a0ff' : v > -0.2 ? '#9a4af0' : '#5a1ab0';
      p.set(x, y, hex(c), 220);
    }
  },
  tallgrass: (p) => {
    p.clear();
    for (let i = 0; i < 11; i++) {
      const x = 1 + Math.floor(p.r() * 13);
      const hgt = 5 + Math.floor(p.r() * 10);
      const lean = p.r() < 0.5 ? -1 : 1;
      for (let y = 0; y < hgt; y++) {
        const xx = x + (y > hgt * 0.6 ? lean : 0);
        const c = hex(y > hgt - 3 ? '#8fcf5a' : p.r() < 0.5 ? '#6aa83f' : '#79b84a');
        p.set(xx, 15 - y, c);
        if (y < hgt - 2) p.set(xx + 1, 15 - y, c);
      }
    }
  },
  flower_red: (p) => {
    p.clear();
    p.rect(7, 7, 1, 9, '#3f7f2c');
    p.set(6, 11, hex('#4f9338'));
    p.set(8, 12, hex('#4f9338'));
    p.rect(6, 3, 3, 3, '#d8282a');
    p.set(7, 2, hex('#e84848'));
    p.set(7, 4, hex('#ffd24a'));
  },
  flower_yellow: (p) => {
    p.clear();
    p.rect(7, 8, 1, 8, '#3f7f2c');
    p.rect(6, 5, 3, 3, '#f0d020');
    p.set(7, 4, hex('#f8e060'));
    p.set(5, 6, hex('#f0d020'));
    p.set(9, 6, hex('#f0d020'));
  },
  mushroom_cap: (p) => {
    p.noise('#c8302a', 8);
    p.blobs('#f4f0e8', 5, 2);
  },
  mushroom_stem: (p) => p.noise('#e8dcc4', 6),
  moss_stone: (p) => {
    P.cobble(p);
    p.blobs('#4f8f38', 7, 3);
  },
  bookshelf: (p) => {
    P.planks(p);
    const colors = ['#8a2a2a', '#2a4a8a', '#2a7a3a', '#8a7a2a', '#5a2a7a'];
    for (const y0 of [2, 9]) for (let x = 1; x < 15; x += 2) p.rect(x, y0, 2, 5, colors[Math.floor(p.r() * colors.length)], 8);
  },
  hay: (p) => {
    p.noise('#d8b440', 10);
    for (let y = 2; y < 16; y += 5) p.rect(0, y, 16, 1, '#9a6a1a');
  },
  wool_white: (p) => p.noise('#e8e8e8', 6),
  snow_top: (p) => p.noise('#f2f6fa', 6, ['#e6edf5', '#ffffff', '#dfe8f2']),
  snow_side: (p) => {
    P.dirt(p);
    for (let x = 0; x < TILE; x++) {
      const depth = 3 + Math.floor(p.r() * 3);
      for (let y = 0; y < depth; y++) p.set(x, y, hex(p.r() < 0.3 ? '#dfe8f2' : '#f2f6fa'));
    }
  },
  ice: (p) => {
    p.noise('#9cc8f0', 6);
    for (let i = 0; i < 5; i++) {
      const x0 = Math.floor(p.r() * 12);
      const y0 = Math.floor(p.r() * 12);
      for (let k = 0; k < 4; k++) p.set(x0 + k, y0 + k, hex('#e0f0ff'));
    }
  },
  packed_ice: (p) => {
    p.noise('#8ab4e0', 8);
    for (let y = 0; y < TILE; y += 5) p.rect(0, y, 16, 1, '#b8d4f0');
  },
  spruce_log: (p) => {
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
      const d = (p.r() - 0.5) * 12;
      const c = hex(x % 3 === 0 ? '#2e2016' : '#3e2c1c');
      p.set(x, y, [c[0] + d, c[1] + d, c[2] + d]);
    }
  },
  spruce_leaves: (p) => {
    p.noise('#2a4a32', 16, ['#1f3a26', '#35583c', '#e8f0f8']);
  },
  frozen_grass: (p) => p.noise('#8aa890', 12, ['#9ab8a0', '#e0e8ee', '#7a987f']),
};

let atlasTex: THREE.Texture | undefined;
const uvCache = new Map<TileName, [number, number, number, number]>();

export function atlasTexture(): THREE.Texture {
  if (atlasTex) return atlasTex;
  const rows = Math.ceil(TILES.length / COLS);
  const canvas = document.createElement('canvas');
  canvas.width = COLS * TILE;
  canvas.height = rows * TILE;
  const g = canvas.getContext('2d')!;
  TILES.forEach((name, i) => {
    const p = new Painter(new SeededRng(1000 + i * 7919));
    P[name](p);
    g.putImageData(new ImageData(p.data, TILE, TILE), (i % COLS) * TILE, Math.floor(i / COLS) * TILE);
  });
  const t = new THREE.CanvasTexture(canvas);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.colorSpace = THREE.SRGBColorSpace;
  atlasTex = t;
  return t;
}

/** 回傳 tile 的 UV 範圍（內縮半像素避免取樣到隔壁 tile） */
export function tileUV(name: TileName): [number, number, number, number] {
  let uv = uvCache.get(name);
  if (!uv) {
    const i = TILES.indexOf(name);
    const rows = Math.ceil(TILES.length / COLS);
    const w = COLS * TILE;
    const h = rows * TILE;
    const x = (i % COLS) * TILE;
    const y = Math.floor(i / COLS) * TILE;
    const e = 0.02;
    uv = [(x + e) / w, 1 - (y + TILE - e) / h, (x + TILE - e) / w, 1 - (y + e) / h];
    uvCache.set(name, uv);
  }
  return uv;
}
