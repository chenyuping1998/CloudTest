/**
 * 程序化繪製的「暫代美術」。
 * 正式版會換成美術外包的 2D 角色序列圖（8 方向 × 動作），介面保持相同：
 * 給一個 key 回傳左右兩個方向的 Texture。
 */
import * as THREE from 'three';
import type { ClassId } from '../data/classes';
import type { MonsterDef } from '../data/monsters';
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

function eyes(g: CanvasRenderingContext2D, x: number, y: number, gap: number, r = 4, color = '#1a1320') {
  for (const dx of [-gap / 2, gap / 2]) {
    g.beginPath();
    g.arc(x + dx, y, r, 0, Math.PI * 2);
    g.fillStyle = color;
    g.fill();
    g.beginPath();
    g.arc(x + dx + 1.5, y - 1.5, r / 3, 0, Math.PI * 2);
    g.fillStyle = '#fff';
    g.fill();
  }
}

function shade(hex: string, amt: number): string {
  const n = parseInt(hex.slice(1), 16);
  const c = (s: number) => Math.max(0, Math.min(255, ((n >> s) & 255) + amt));
  return `rgb(${c(16)},${c(8)},${c(0)})`;
}

const CLASS_LOOK: Record<ClassId, { hair: string; body: string; accent: string }> = {
  novice: { hair: '#8b5a2b', body: '#d9c7a3', accent: '#8a6d4b' },
  swordsman: { hair: '#3b2a1a', body: '#4f6fb3', accent: '#c0c6d0' },
  archer: { hair: '#c9772b', body: '#4f8f4a', accent: '#8a5a2b' },
  mage: { hair: '#6b4fa3', body: '#3a2f6b', accent: '#d9b44a' },
  merchant: { hair: '#2b2b2b', body: '#b8733b', accent: '#e0c070' },
};

export function playerTextures(cls: ClassId): FacingTextures {
  const look = CLASS_LOOK[cls];
  return makeFacing(`player:${cls}`, 64, 96, (g) => {
    // 腿
    g.fillStyle = '#3a2d25';
    g.fillRect(24, 72, 7, 18);
    g.fillRect(35, 72, 7, 18);
    // 身體
    g.beginPath();
    g.moveTo(18, 74);
    g.lineTo(22, 48);
    g.lineTo(42, 48);
    g.lineTo(46, 74);
    g.closePath();
    g.fillStyle = look.body;
    g.fill();
    outline(g);
    g.fillStyle = look.accent;
    g.fillRect(21, 62, 22, 4);
    // 手臂與武器
    g.fillStyle = '#f2d2b5';
    g.fillRect(44, 52, 6, 14);
    g.fillStyle = cls === 'mage' ? '#8a5a2b' : '#c9d1dc';
    if (cls === 'mage') g.fillRect(49, 26, 4, 50);
    else if (cls === 'archer') {
      g.beginPath();
      g.arc(50, 58, 16, -Math.PI / 2.2, Math.PI / 2.2);
      g.lineWidth = 3;
      g.strokeStyle = '#8a5a2b';
      g.stroke();
    } else g.fillRect(48, 38, 4, 26);
    // 頭
    ellipse(g, 32, 32, 18, 17, '#f2d2b5');
    g.beginPath();
    g.ellipse(32, 24, 19, 12, 0, Math.PI, Math.PI * 2);
    g.fillStyle = look.hair;
    g.fill();
    g.fillRect(13, 22, 8, 16);
    eyes(g, 36, 34, 12, 3.2);
    if (cls === 'mage') {
      g.beginPath();
      g.moveTo(12, 20);
      g.lineTo(32, -2);
      g.lineTo(52, 20);
      g.closePath();
      g.fillStyle = look.body;
      g.fill();
      outline(g);
    }
  });
}

export function monsterTextures(m: MonsterDef): FacingTextures {
  const c = m.look.color;
  switch (m.look.shape) {
    case 'slime':
      return makeFacing(`m:${m.id}`, 64, 56, (g) => {
        g.beginPath();
        g.moveTo(6, 50);
        g.quadraticCurveTo(4, 10, 32, 8);
        g.quadraticCurveTo(60, 10, 58, 50);
        g.closePath();
        g.fillStyle = c;
        g.fill();
        outline(g);
        ellipse(g, 22, 20, 6, 4, 'rgba(255,255,255,0.6)');
        eyes(g, 36, 32, 14, 4);
        g.beginPath();
        g.arc(36, 40, 4, 0, Math.PI);
        g.stroke();
      });
    case 'shroom':
      return makeFacing(`m:${m.id}`, 64, 72, (g) => {
        g.fillStyle = '#f3e3c3';
        g.fillRect(20, 34, 24, 32);
        g.strokeRect(20, 34, 24, 32);
        eyes(g, 34, 48, 10, 3);
        g.beginPath();
        g.ellipse(32, 30, 30, 22, 0, Math.PI, Math.PI * 2);
        g.lineTo(62, 34);
        g.lineTo(2, 34);
        g.fillStyle = c;
        g.fill();
        outline(g);
        for (const [x, y, r] of [[18, 20, 5], [36, 14, 6], [50, 26, 4]]) ellipse(g, x, y, r, r, '#fff');
      });
    case 'beast':
      return makeFacing(`m:${m.id}`, 96, 64, (g) => {
        g.fillStyle = shade(c, -30);
        for (const x of [22, 34, 60, 72]) g.fillRect(x, 40, 7, 20);
        ellipse(g, 46, 36, 30, 15, c);
        g.beginPath();
        g.moveTo(16, 30);
        g.lineTo(2, 16);
        g.lineTo(18, 38);
        g.fillStyle = c;
        g.fill();
        ellipse(g, 76, 24, 15, 13, c);
        g.beginPath();
        g.moveTo(66, 14);
        g.lineTo(70, 0);
        g.lineTo(76, 12);
        g.moveTo(78, 12);
        g.lineTo(86, 0);
        g.lineTo(88, 16);
        g.fillStyle = shade(c, -20);
        g.fill();
        ellipse(g, 90, 28, 7, 5, shade(c, 20));
        eyes(g, 80, 22, 8, 2.5, '#c33');
      });
    case 'humanoid':
      return makeFacing(`m:${m.id}`, 64, 96, (g) => {
        g.fillStyle = shade(c, -40);
        g.fillRect(24, 70, 7, 22);
        g.fillRect(35, 70, 7, 22);
        g.beginPath();
        g.rect(20, 44, 26, 30);
        g.fillStyle = shade(c, -15);
        g.fill();
        outline(g);
        g.fillStyle = '#b9bec7';
        g.fillRect(48, 30, 5, 36);
        g.fillStyle = shade(c, -15);
        g.fillRect(44, 48, 6, 14);
        ellipse(g, 32, 30, 16, 16, c);
        eyes(g, 36, 30, 11, 3.5, m.id === 'skeleton' ? '#e33' : '#1a1320');
        if (m.id === 'goblin') {
          g.beginPath();
          g.moveTo(16, 26);
          g.lineTo(4, 18);
          g.lineTo(18, 34);
          g.moveTo(48, 26);
          g.lineTo(60, 18);
          g.lineTo(46, 34);
          g.fillStyle = c;
          g.fill();
        }
      });
    case 'golem':
      return makeFacing(`m:${m.id}`, 96, 96, (g) => {
        const blk = (x: number, y: number, w: number, h: number, col = c) => {
          g.beginPath();
          g.rect(x, y, w, h);
          g.fillStyle = col;
          g.fill();
          outline(g);
        };
        blk(28, 68, 14, 24, shade(c, -25));
        blk(54, 68, 14, 24, shade(c, -25));
        blk(20, 32, 56, 40);
        blk(6, 36, 14, 34, shade(c, -15));
        blk(76, 36, 14, 34, shade(c, -15));
        blk(34, 8, 28, 26, shade(c, 15));
        g.fillStyle = '#ffd24a';
        g.fillRect(40, 18, 5, 5);
        g.fillRect(52, 18, 5, 5);
        g.fillStyle = '#6fe0ff';
        g.fillRect(44, 46, 8, 8);
      });
    case 'lich':
      return makeFacing(`m:${m.id}`, 96, 128, (g) => {
        const grd = g.createRadialGradient(48, 70, 10, 48, 70, 60);
        grd.addColorStop(0, 'rgba(160,110,255,0.55)');
        grd.addColorStop(1, 'rgba(160,110,255,0)');
        g.fillStyle = grd;
        g.fillRect(0, 0, 96, 128);
        g.beginPath();
        g.moveTo(20, 124);
        g.lineTo(30, 50);
        g.lineTo(66, 50);
        g.lineTo(76, 124);
        g.closePath();
        g.fillStyle = c;
        g.fill();
        outline(g);
        g.fillStyle = '#d9b44a';
        g.fillRect(80, 20, 5, 100);
        ellipse(g, 82, 18, 8, 8, '#a6f');
        ellipse(g, 48, 40, 16, 17, '#eee6d0');
        eyes(g, 50, 40, 12, 4, '#7f3');
        g.beginPath();
        g.moveTo(32, 26);
        g.lineTo(36, 10);
        g.lineTo(42, 22);
        g.lineTo(48, 6);
        g.lineTo(54, 22);
        g.lineTo(60, 10);
        g.lineTo(64, 26);
        g.closePath();
        g.fillStyle = '#e6c44a';
        g.fill();
        outline(g);
      });
  }
}

export function npcTextures(key: string, body: string, hat: string): FacingTextures {
  return makeFacing(`npc:${key}`, 64, 96, (g) => {
    g.beginPath();
    g.moveTo(14, 92);
    g.lineTo(22, 46);
    g.lineTo(42, 46);
    g.lineTo(50, 92);
    g.closePath();
    g.fillStyle = body;
    g.fill();
    outline(g);
    ellipse(g, 32, 32, 16, 16, '#f2d2b5');
    eyes(g, 34, 34, 10, 3);
    g.beginPath();
    g.ellipse(32, 20, 24, 7, 0, 0, Math.PI * 2);
    g.fillStyle = hat;
    g.fill();
    outline(g);
    g.fillRect(22, 4, 20, 16);
  });
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
  iconCanvasCache.set(def.id, c);
  return c;
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
