/**
 * 物品圖示（背包、地上掉落物）。先用向量繪製再縮成 16×16 像素，
 * 呈現與方塊世界一致的像素風格。正式版可直接換成美術繪製的圖示。
 */
import * as THREE from 'three';
import { RARITY_INFO, type ItemDef } from '../core/types';

export interface FacingTextures {
  right: THREE.Texture;
  left: THREE.Texture;
  aspect: number;
}

const cache = new Map<string, FacingTextures>();

function makeFacing(key: string, w: number, h: number, draw: (g: CanvasRenderingContext2D) => void): FacingTextures {
  const hit = cache.get(key);
  if (hit) return hit;
  const base = document.createElement('canvas');
  base.width = w;
  base.height = h;
  const g = base.getContext('2d')!;
  draw(g);
  const flipped = document.createElement('canvas');
  flipped.width = w;
  flipped.height = h;
  const fg = flipped.getContext('2d')!;
  fg.translate(w, 0);
  fg.scale(-1, 1);
  fg.drawImage(base, 0, 0);
  const tex = (c: HTMLCanvasElement) => {
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.magFilter = THREE.NearestFilter;
    t.minFilter = THREE.LinearMipMapLinearFilter;
    return t;
  };
  const res = { right: tex(base), left: tex(flipped), aspect: w / h };
  cache.set(key, res);
  return res;
}

function outline(g: CanvasRenderingContext2D, color = '#1a1320') {
  g.lineWidth = 3;
  g.strokeStyle = color;
  g.stroke();
}

function ellipse(g: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number, fill: string) {
  g.beginPath();
  g.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
  g.fillStyle = fill;
  g.fill();
  outline(g);
}

function shade(hex: string, amt: number): string {
  const n = parseInt(hex.slice(1), 16);
  const c = (s: number) => Math.max(0, Math.min(255, ((n >> s) & 255) + amt));
  return `rgb(${c(16)},${c(8)},${c(0)})`;
}

// ---------------- 物品圖示 ----------------

const iconUrlCache = new Map<string, string>();
const iconCanvasCache = new Map<string, HTMLCanvasElement>();
const ITEM_COLORS: Record<string, string> = {
  copper: '#c77b43', iron: '#8d9199', mithril: '#8fd3ff', oak: '#9a6a3a', maple: '#c8562c', coal: '#333',
  ruby: '#e0304a', sapphire: '#3a6fe0', star: '#ffe680', jelly: '#ff8fb8', spore: '#d9534f', wolf: '#8a8f99',
  goblin: '#5aa45a', bone: '#e8e2cf', rune: '#6fe0ff', golem: '#8c7b6b', lich: '#7b4fd6', ancient: '#7fe07f',
  red: '#e0304a', orange: '#f08a24', white: '#f0f0f0', blue: '#3a6fe0', apple: '#d33',
};

function colorFor(def: ItemDef): string {
  for (const [k, v] of Object.entries(ITEM_COLORS)) if (def.id.includes(k)) return v;
  return RARITY_INFO[def.rarity].color;
}

export function itemIcon(def: ItemDef): string {
  let url = iconUrlCache.get(def.id);
  if (!url) {
    url = iconCanvas(def).toDataURL();
    iconUrlCache.set(def.id, url);
  }
  return url;
}

function iconCanvas(def: ItemDef): HTMLCanvasElement {
  const hit = iconCanvasCache.get(def.id);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = c.height = 48;
  const g = c.getContext('2d')!;
  const col = colorFor(def);
  g.lineJoin = 'round';
  const path = (pts: [number, number][], fill: string) => {
    g.beginPath();
    pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.closePath();
    g.fillStyle = fill;
    g.fill();
    outline(g);
  };
  switch (def.type) {
    case 'weapon':
      if (def.id.includes('bow')) {
        g.beginPath();
        g.arc(18, 24, 18, -Math.PI / 2.3, Math.PI / 2.3);
        g.lineWidth = 5;
        g.strokeStyle = '#8a5a2b';
        g.stroke();
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(25, 8);
        g.lineTo(25, 40);
        g.strokeStyle = '#eee';
        g.stroke();
      } else if (def.id.includes('staff') || def.id.includes('scepter')) {
        path([[10, 42], [34, 12], [38, 16], [14, 46]], '#8a5a2b');
        ellipse(g, 36, 12, 7, 7, col);
      } else {
        path([[8, 44], [12, 36], [36, 8], [42, 6], [40, 12], [14, 38], [10, 44]], col === RARITY_INFO[def.rarity].color ? '#c9d1dc' : col);
        path([[10, 30], [20, 40], [17, 42], [7, 32]], '#d9b44a');
      }
      break;
    case 'armor':
      if (def.slot === 'helm') path([[8, 32], [12, 12], [36, 12], [40, 32]], '#8d9199');
      else if (def.slot === 'shield') path([[24, 44], [8, 30], [8, 8], [40, 8], [40, 30]], '#8a6d4b');
      else if (def.slot === 'boots') path([[14, 8], [26, 8], [26, 32], [40, 36], [40, 42], [14, 42]], '#6b4a2b');
      else path([[10, 12], [18, 6], [30, 6], [38, 12], [34, 20], [34, 42], [14, 42], [14, 20]], col === RARITY_INFO[def.rarity].color ? '#8d9199' : col);
      break;
    case 'accessory':
      g.beginPath();
      g.arc(24, 28, 12, 0, Math.PI * 2);
      g.lineWidth = 5;
      g.strokeStyle = '#d9b44a';
      g.stroke();
      ellipse(g, 24, 14, 6, 6, RARITY_INFO[def.rarity].color);
      break;
    case 'consumable':
      if (def.id === 'apple') ellipse(g, 24, 28, 14, 13, col);
      else {
        path([[20, 6], [28, 6], [28, 16], [38, 26], [38, 42], [10, 42], [10, 26], [20, 16]], col);
        g.fillStyle = 'rgba(255,255,255,0.5)';
        g.fillRect(14, 28, 4, 10);
      }
      break;
    case 'card':
      path([[10, 4], [38, 4], [38, 44], [10, 44]], '#f3ead2');
      ellipse(g, 24, 20, 9, 9, RARITY_INFO[def.rarity].color);
      g.fillStyle = '#7a5a2b';
      g.fillRect(14, 34, 20, 3);
      break;
    case 'scroll':
      path([[8, 12], [40, 12], [40, 36], [8, 36]], '#efe0b8');
      ellipse(g, 8, 24, 4, 12, '#d9c79a');
      ellipse(g, 40, 24, 4, 12, '#d9c79a');
      ellipse(g, 24, 24, 6, 6, def.scroll === 'protection' ? '#3a6fe0' : def.id.includes('blessed') ? '#ffd24a' : '#e0304a');
      break;
    case 'tool':
      path([[22, 44], [26, 44], [26, 14], [22, 14]], '#8a5a2b');
      if (def.toolKind === 'pickaxe') path([[6, 16], [24, 6], [42, 16], [24, 12]], def.toolTier === 3 ? '#8fd3ff' : def.toolTier === 2 ? '#8d9199' : '#a89f91');
      else path([[26, 8], [40, 6], [40, 24], [26, 20]], def.toolTier === 3 ? '#8fd3ff' : def.toolTier === 2 ? '#8d9199' : '#a89f91');
      break;
    default:
      if (def.id.includes('log') || def.id.includes('branch')) {
        g.save();
        g.translate(24, 24);
        g.rotate(-0.5);
        g.beginPath();
        g.rect(-18, -8, 36, 16);
        g.fillStyle = col;
        g.fill();
        outline(g);
        ellipse(g, 18, 0, 5, 8, '#e3c08a');
        g.restore();
      } else if (def.id.includes('ingot') || def.id.includes('plank')) {
        path([[6, 30], [14, 18], [42, 18], [34, 30]], col);
        path([[6, 30], [34, 30], [34, 38], [6, 38]], shade(col.startsWith('#') ? col : '#888888', -30));
      } else if (def.id.includes('ore') || def.id.includes('coal') || def.id.includes('rough') || def.id.includes('crystal')) {
        path([[8, 36], [12, 16], [26, 8], [40, 18], [40, 38]], def.id.includes('ore') ? '#6e6a64' : col);
        if (def.id.includes('ore')) for (const [x, y] of [[18, 22], [30, 28], [22, 32]]) ellipse(g, x, y, 4, 3, col);
      } else {
        ellipse(g, 24, 26, 15, 13, col);
      }
  }
  // 縮小到 16×16 再用最近鄰放大回 48×48 → 像素風
  const small = document.createElement('canvas');
  small.width = small.height = 16;
  const sg = small.getContext('2d')!;
  sg.imageSmoothingEnabled = true;
  sg.drawImage(c, 0, 0, 16, 16);
  // 去掉半透明邊緣，讓像素輪廓乾淨
  const img = sg.getImageData(0, 0, 16, 16);
  for (let i = 3; i < img.data.length; i += 4) img.data[i] = img.data[i] > 90 ? 255 : 0;
  sg.putImageData(img, 0, 0);
  const out = document.createElement('canvas');
  out.width = out.height = 48;
  const og = out.getContext('2d')!;
  og.imageSmoothingEnabled = false;
  og.drawImage(small, 0, 0, 48, 48);
  iconCanvasCache.set(def.id, out);
  return out;
}

/** 地上掉落物使用的小貼圖（圖示 + 稀有度光暈） */
export function groundItemTexture(def: ItemDef): THREE.Texture {
  return makeFacing(`ground:${def.id}`, 64, 64, (g) => {
    if (def.rarity >= 2) {
      const grd = g.createRadialGradient(32, 32, 4, 32, 32, 32);
      grd.addColorStop(0, RARITY_INFO[def.rarity].color);
      grd.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grd;
      g.fillRect(0, 0, 64, 64);
    }
    g.drawImage(iconCanvas(def), 8, 8);
  }).right;
}
