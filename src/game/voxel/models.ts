/**
 * Minecraft 風格的方塊模型：人形角色、怪物、樹、礦石、房屋、設施。
 * 角色的每個部位都是一個方塊，面上貼程序化繪製的像素材質（像 MC 的 skin）。
 */
import * as THREE from 'three';
import type { ClassId } from '../../data/classes';
import type { MonsterDef } from '../../data/monsters';
import type { TileName } from './atlas';
import { blockMaterial, blockMesh, GeoBuilder, type Face } from './mesher';

/** 1 像素的世界長度：人物 32px 高 ≈ 1.8 格，與 Minecraft 相同比例 */
export const PX = 0.056;

// ------------------------------------------------------------ 像素面材質

type Paint = (g: PixelCanvas) => void;

class PixelCanvas {
  constructor(readonly ctx: CanvasRenderingContext2D, readonly w: number, readonly h: number, private seed: number) {}
  rand(): number {
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
    return this.seed / 4294967296;
  }
  px(x: number, y: number, c: string): void {
    this.ctx.fillStyle = c;
    this.ctx.fillRect(x, y, 1, 1);
  }
  rect(x: number, y: number, w: number, h: number, c: string): void {
    this.ctx.fillStyle = c;
    this.ctx.fillRect(x, y, w, h);
  }
  /** 帶一點雜訊的底色（讓色塊不死板） */
  fill(c: string, amount = 10): void {
    const col = new THREE.Color(c);
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) {
      const d = (this.rand() - 0.5) * amount / 255;
      this.px(x, y, `rgb(${Math.round((col.r + d) * 255)},${Math.round((col.g + d) * 255)},${Math.round((col.b + d) * 255)})`);
    }
  }
}

const faceTexCache = new Map<string, THREE.Texture>();

function faceTexture(key: string, w: number, h: number, base: string, paint?: Paint): THREE.Texture {
  const k = `${key}:${w}x${h}`;
  const hit = faceTexCache.get(k);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const pc = new PixelCanvas(c.getContext('2d')!, w, h, [...k].reduce((s, ch) => s * 31 + ch.charCodeAt(0), 7) >>> 0);
  pc.fill(base);
  paint?.(pc);
  const t = new THREE.CanvasTexture(c);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.colorSpace = THREE.SRGBColorSpace;
  faceTexCache.set(k, t);
  return t;
}

interface PartSpec {
  key: string;
  /** 像素尺寸 */
  size: [number, number, number];
  base: string;
  faces?: Partial<Record<'front' | 'back' | 'left' | 'right' | 'top' | 'bottom' | 'side', Paint>>;
  bases?: Partial<Record<'front' | 'back' | 'left' | 'right' | 'top' | 'bottom', string>>;
  transparent?: number;
}

const matCache = new Map<string, THREE.Material[]>();

/** 建立一個部位方塊，原點在方塊底部中心 */
function part(spec: PartSpec): THREE.Mesh {
  const [w, h, d] = spec.size;
  const cacheKey = `${spec.key}:${w}:${h}:${d}`;
  let mats = matCache.get(cacheKey);
  if (!mats) {
    // three.js BoxGeometry 面順序：+x, -x, +y, -y, +z(前), -z(後)
    const order: ['right' | 'left' | 'top' | 'bottom' | 'front' | 'back', number, number, number][] = [
      ['right', d, h, 0.8], ['left', d, h, 0.8], ['top', w, d, 1], ['bottom', w, d, 0.5], ['front', w, h, 0.9], ['back', w, h, 0.75],
    ];
    mats = order.map(([f, fw, fh, shade]) => {
      const paint = spec.faces?.[f] ?? (f === 'left' || f === 'right' ? spec.faces?.side : undefined);
      const base = spec.bases?.[f] ?? spec.base;
      const m = new THREE.MeshLambertMaterial({ map: faceTexture(`${spec.key}:${f}`, fw, fh, base, paint), color: new THREE.Color(shade, shade, shade) });
      if (spec.transparent !== undefined) {
        m.transparent = true;
        m.opacity = spec.transparent;
        m.depthWrite = false;
      }
      return m;
    });
    matCache.set(cacheKey, mats);
  }
  const geo = new THREE.BoxGeometry(w * PX, h * PX, d * PX);
  geo.translate(0, (h * PX) / 2, 0);
  const mesh = new THREE.Mesh(geo, mats);
  mesh.castShadow = true;
  return mesh;
}

/** 讓部位以「頂端」為樞紐（手臂、腿擺動用） */
function pivotTop(mesh: THREE.Mesh, heightPx: number): THREE.Group {
  const g = new THREE.Group();
  mesh.position.y = -heightPx * PX;
  g.add(mesh);
  return g;
}

// ------------------------------------------------------------ Rig 與動畫

export type RigKind = 'humanoid' | 'quad' | 'hopper' | 'float';

export interface Rig {
  root: THREE.Group;
  /** 轉向用 */
  yaw: THREE.Group;
  kind: RigKind;
  height: number;
  head?: THREE.Object3D;
  armL?: THREE.Object3D;
  armR?: THREE.Object3D;
  legs: THREE.Object3D[];
  bodyBob?: THREE.Object3D;
  tail?: THREE.Object3D;
}

export function animateRig(rig: Rig, t: number, moving: boolean, attack: number): void {
  const swing = moving ? Math.sin(t * 9) : 0;
  switch (rig.kind) {
    case 'humanoid':
      rig.legs[0] && (rig.legs[0].rotation.x = swing * 0.7);
      rig.legs[1] && (rig.legs[1].rotation.x = -swing * 0.7);
      if (rig.armL) rig.armL.rotation.x = -swing * 0.6;
      if (rig.armR) rig.armR.rotation.x = attack > 0 ? -Math.sin(attack * Math.PI) * 2 : swing * 0.6;
      if (rig.head) rig.head.rotation.y = moving ? 0 : Math.sin(t * 0.7) * 0.25;
      break;
    case 'quad':
      rig.legs.forEach((l, i) => (l.rotation.x = swing * 0.8 * (i % 2 === 0 ? 1 : -1) * (i < 2 ? 1 : -1)));
      if (rig.tail) rig.tail.rotation.y = Math.sin(t * 6) * 0.4;
      if (rig.head) rig.head.rotation.x = attack > 0 ? Math.sin(attack * Math.PI) * 0.5 : 0;
      break;
    case 'hopper': {
      const hop = Math.abs(Math.sin(t * (moving ? 6 : 2.5)));
      if (rig.bodyBob) {
        rig.bodyBob.position.y = hop * (moving ? 0.35 : 0.06);
        rig.bodyBob.scale.set(1 + (1 - hop) * 0.08, 1 - (1 - hop) * 0.12, 1 + (1 - hop) * 0.08);
      }
      break;
    }
    case 'float':
      if (rig.bodyBob) rig.bodyBob.position.y = 0.3 + Math.sin(t * 2) * 0.15;
      if (rig.armR) rig.armR.rotation.x = attack > 0 ? -Math.sin(attack * Math.PI) * 1.8 : -0.4 + Math.sin(t * 2) * 0.1;
      if (rig.armL) rig.armL.rotation.x = -0.2 + Math.sin(t * 2 + 1) * 0.1;
      break;
  }
}

function makeRig(kind: RigKind, height: number): Rig {
  const root = new THREE.Group();
  const yaw = new THREE.Group();
  root.add(yaw);
  return { root, yaw, kind, height, legs: [] };
}

// ------------------------------------------------------------ 人形

export interface HumanoidLook {
  key: string;
  skin: string;
  hair: string;
  eyes?: string;
  shirt: string;
  shirtDetail?: Paint;
  pants: string;
  shoes: string;
  hat?: 'wizard' | 'cap' | 'crown' | 'hood' | 'helmet' | 'none';
  hatColor?: string;
  robe?: boolean;
  weapon?: 'sword' | 'bow' | 'staff' | 'none';
  face?: 'normal' | 'skull' | 'goblin';
  thin?: boolean;
  scale?: number;
}

function headFaces(l: HumanoidLook): PartSpec['faces'] {
  const eye = l.eyes ?? '#3a5fd8';
  if (l.face === 'skull') {
    return {
      front: (g) => {
        g.rect(1, 3, 2, 2, '#1a1a1a');
        g.rect(5, 3, 2, 2, '#1a1a1a');
        g.px(2, 3, eye);
        g.px(5, 3, eye);
        g.rect(3, 5, 2, 1, '#3a3a3a');
        for (let x = 1; x < 7; x += 2) g.px(x, 6, '#2a2a2a');
      },
    };
  }
  const hairTop = (g: PixelCanvas, rows: number) => g.rect(0, 0, g.w, rows, l.hair);
  return {
    front: (g) => {
      hairTop(g, 2);
      g.px(0, 2, l.hair);
      g.px(7, 2, l.hair);
      g.rect(1, 4, 2, 1, '#ffffff');
      g.rect(5, 4, 2, 1, '#ffffff');
      g.px(2, 4, eye);
      g.px(5, 4, eye);
      if (l.face === 'goblin') {
        g.rect(2, 6, 4, 1, '#3a1a1a');
        g.px(2, 7, '#f0f0d0');
        g.px(5, 7, '#f0f0d0');
      } else {
        g.rect(3, 6, 2, 1, '#9a5a4a');
      }
    },
    side: (g) => {
      hairTop(g, 3);
      g.rect(g.w - 3, 0, 3, 5, l.hair);
    },
    back: (g) => g.rect(0, 0, g.w, 6, l.hair),
    top: (g) => g.rect(0, 0, g.w, g.h, l.hair),
  };
}

function weaponMesh(kind: HumanoidLook['weapon']): THREE.Object3D | undefined {
  if (!kind || kind === 'none') return undefined;
  const g = new THREE.Group();
  if (kind === 'sword') {
    const blade = part({ key: 'sword-blade', size: [1, 12, 2], base: '#dfe6ef', faces: { side: (c) => c.rect(0, 0, 1, c.h, '#ffffff') } });
    const guard = part({ key: 'sword-guard', size: [1, 1, 6], base: '#8a6a2a' });
    const grip = part({ key: 'sword-grip', size: [1, 3, 1], base: '#5a3a1a' });
    grip.position.y = -3 * PX;
    guard.position.y = 0;
    blade.position.y = 1 * PX;
    g.add(blade, guard, grip);
    g.rotation.x = Math.PI / 2;
    g.position.set(0, -11 * PX, 3 * PX);
  } else if (kind === 'staff') {
    const pole = part({ key: 'staff-pole', size: [1, 22, 1], base: '#6b4a2a' });
    const gem = part({ key: 'staff-gem', size: [3, 3, 3], base: '#8a4af0', faces: { front: (c) => c.px(1, 1, '#e0c0ff') } });
    pole.position.y = -8 * PX;
    gem.position.y = 14 * PX;
    g.add(pole, gem);
    g.position.set(0, -11 * PX, 1 * PX);
  } else if (kind === 'bow') {
    for (let i = -4; i <= 4; i++) {
      const seg = part({ key: 'bow-seg', size: [1, 2, 1], base: '#7a5230' });
      seg.position.set(0, i * 2 * PX - 1 * PX, (Math.abs(i) * Math.abs(i) * 0.25 - 4) * PX);
      g.add(seg);
    }
    const string = part({ key: 'bow-string', size: [0.3, 18, 0.3], base: '#eeeeee' });
    string.position.set(0, -9 * PX, -4 * PX);
    g.add(string);
    g.position.set(0, -10 * PX, 3 * PX);
  }
  return g;
}

export function humanoid(l: HumanoidLook): Rig {
  const s = l.scale ?? 1;
  const rig = makeRig(l.robe ? 'humanoid' : 'humanoid', 32 * PX * s);
  const body = new THREE.Group();
  body.scale.setScalar(s);
  rig.yaw.add(body);
  const limbW = l.thin ? 2 : 4;

  if (!l.robe) {
    for (const side of [-1, 1]) {
      const leg = part({
        key: `${l.key}-leg`, size: [limbW, 12, limbW], base: l.pants,
        faces: { front: (g) => g.rect(0, 9, g.w, 3, l.shoes), side: (g) => g.rect(0, 9, g.w, 3, l.shoes), back: (g) => g.rect(0, 9, g.w, 3, l.shoes) },
        bases: { bottom: l.shoes },
      });
      const pivot = pivotTop(leg, 12);
      pivot.position.set(side * 2 * PX, 12 * PX, 0);
      body.add(pivot);
      rig.legs.push(pivot);
    }
  }
  const torsoH = l.robe ? 22 : 12;
  const torso = part({
    key: `${l.key}-torso`, size: [8, torsoH, l.robe ? 6 : 4], base: l.shirt,
    faces: { front: l.shirtDetail, back: l.robe ? (g) => g.rect(0, g.h - 2, g.w, 2, '#000000') : undefined },
  });
  torso.position.y = 24 * PX - torsoH * PX;
  body.add(torso);

  for (const side of [-1, 1]) {
    const arm = part({
      key: `${l.key}-arm`, size: [limbW, 12, limbW], base: l.skin,
      faces: { front: (g) => g.rect(0, 0, g.w, 4, l.shirt), side: (g) => g.rect(0, 0, g.w, 4, l.shirt), back: (g) => g.rect(0, 0, g.w, 4, l.shirt) },
      bases: { top: l.shirt },
    });
    const pivot = pivotTop(arm, 12);
    pivot.position.set(side * (4 + limbW / 2) * PX, 24 * PX, 0);
    body.add(pivot);
    if (side === 1) {
      rig.armR = pivot;
      const w = weaponMesh(l.weapon);
      if (w) pivot.add(w);
    } else rig.armL = pivot;
  }

  const head = new THREE.Group();
  head.position.y = 24 * PX;
  const headBox = part({ key: `${l.key}-head`, size: [8, 8, 8], base: l.face === 'skull' ? '#e8e2cf' : l.skin, faces: headFaces(l) });
  head.add(headBox);
  if (l.hat && l.hat !== 'none') {
    const hc = l.hatColor ?? '#3a2f6b';
    if (l.hat === 'wizard') {
      const brim = part({ key: `${l.key}-brim`, size: [12, 1, 12], base: hc });
      brim.position.y = 7 * PX;
      head.add(brim);
      [[8, 3], [6, 3], [4, 3], [2, 2]].reduce((y, [w, hgt]) => {
        const p = part({ key: `${l.key}-hat${w}`, size: [w, hgt, w], base: hc, faces: w === 8 ? { front: (g) => g.rect(0, 1, g.w, 1, '#d9b44a') } : undefined });
        p.position.set(0, y * PX, (8 - w) * 0.15 * -PX);
        head.add(p);
        return y + hgt;
      }, 8);
    } else if (l.hat === 'cap') {
      const cap = part({ key: `${l.key}-cap`, size: [9, 3, 9], base: hc });
      cap.position.y = 7 * PX;
      const brim = part({ key: `${l.key}-capbrim`, size: [9, 1, 4], base: hc });
      brim.position.set(0, 7 * PX, 6 * PX);
      head.add(cap, brim);
    } else if (l.hat === 'crown') {
      const band = part({ key: 'crown-band', size: [9, 2, 9], base: '#e6c44a', faces: { front: (g) => { g.px(2, 0, '#e0304a'); g.px(6, 0, '#3a6fe0'); } } });
      band.position.y = 8 * PX;
      head.add(band);
      for (const [x, z] of [[-3.5, -3.5], [3.5, -3.5], [-3.5, 3.5], [3.5, 3.5], [0, 3.5], [0, -3.5]]) {
        const spike = part({ key: 'crown-spike', size: [1, 2, 1], base: '#e6c44a' });
        spike.position.set(x * PX, 10 * PX, z * PX);
        head.add(spike);
      }
    } else if (l.hat === 'hood') {
      const hood = part({ key: `${l.key}-hood`, size: [10, 10, 10], base: hc, faces: { front: (g) => g.rect(2, 2, 6, 7, '#00000000') } });
      hood.position.y = -1 * PX;
      (hood.material as THREE.MeshLambertMaterial[]).forEach((m) => (m.side = THREE.BackSide));
      head.add(hood);
    } else if (l.hat === 'helmet') {
      const helm = part({ key: `${l.key}-helm`, size: [9, 5, 9], base: hc, faces: { front: (g) => g.rect(0, 3, g.w, 1, '#5a5f6a') } });
      helm.position.y = 5 * PX;
      head.add(helm);
    }
  }
  body.add(head);
  rig.head = head;
  if (l.robe) {
    rig.kind = 'float';
    rig.bodyBob = body;
  }
  return rig;
}

// ------------------------------------------------------------ 玩家與 NPC 外觀

const SKIN = '#e8b48a';

export const CLASS_LOOKS: Record<ClassId, HumanoidLook> = {
  novice: {
    key: 'novice', skin: SKIN, hair: '#6b4424', shirt: '#4fa0c8', pants: '#3a3a8a', shoes: '#4a3a2a', weapon: 'sword',
    shirtDetail: (g) => { g.rect(0, 8, g.w, 1, '#6b4424'); g.rect(3, 0, 2, 2, SKIN); },
  },
  swordsman: {
    key: 'swordsman', skin: SKIN, hair: '#3b2a1a', shirt: '#9aa4b4', pants: '#4a4a5a', shoes: '#2a2a2a', weapon: 'sword', hat: 'helmet', hatColor: '#aab4c4',
    shirtDetail: (g) => { g.rect(0, 0, g.w, 2, '#c0c8d8'); g.rect(3, 2, 2, 8, '#3a5fb0'); g.rect(0, 9, g.w, 1, '#6b4424'); },
  },
  archer: {
    key: 'archer', skin: SKIN, hair: '#c9772b', shirt: '#3f7f3a', pants: '#6b4a2a', shoes: '#3a2a1a', weapon: 'bow', hat: 'cap', hatColor: '#2f6a2a',
    shirtDetail: (g) => { for (let i = 0; i < 8; i++) g.px(i, i + 1, '#7a5230'); },
  },
  mage: {
    key: 'mage', skin: SKIN, hair: '#c0c0d0', shirt: '#3a2f7b', pants: '#2a2a4a', shoes: '#1a1a2a', weapon: 'staff', hat: 'wizard', hatColor: '#3a2f7b',
    shirtDetail: (g) => { g.rect(3, 0, 2, g.h, '#d9b44a'); },
  },
  merchant: {
    key: 'merchant', skin: SKIN, hair: '#2b2b2b', shirt: '#e0e0d0', pants: '#5a4a3a', shoes: '#3a2a1a', weapon: 'none', hat: 'cap', hatColor: '#b8733b',
    shirtDetail: (g) => { g.rect(1, 4, 6, 8, '#b8733b'); g.px(2, 7, '#ffd24a'); },
  },
};

export function playerRig(cls: ClassId): Rig {
  return humanoid(CLASS_LOOKS[cls]);
}

export function npcRig(id: 'shop' | 'market' | 'guide'): Rig {
  const looks: Record<string, HumanoidLook> = {
    shop: { key: 'npc-shop', skin: SKIN, hair: '#a0522d', shirt: '#b8733b', pants: '#4a3a2a', shoes: '#2a1a0a', hat: 'cap', hatColor: '#6b3a1a', shirtDetail: (g) => g.rect(1, 3, 6, 9, '#f0e0c0') },
    market: { key: 'npc-market', skin: SKIN, hair: '#d0d0d0', shirt: '#2a3f7f', pants: '#1a2a4a', shoes: '#111', hat: 'crown', shirtDetail: (g) => { g.rect(3, 0, 2, 12, '#d9b44a'); } },
    guide: { key: 'npc-guide', skin: SKIN, hair: '#e0a0c0', shirt: '#8f3a6b', pants: '#5a1a3a', shoes: '#2a0a1a', robe: true, shirtDetail: (g) => { g.rect(0, 6, g.w, 1, '#ffd24a'); } },
  };
  const rig = humanoid(looks[id]);
  if (id === 'guide') rig.kind = 'humanoid';
  return rig;
}

// ------------------------------------------------------------ 怪物

export function monsterRig(m: MonsterDef): Rig {
  const s = m.look.scale;
  switch (m.look.shape) {
    case 'slime': {
      // Minecraft 史萊姆：半透明外殼 + 內核 + 臉
      const rig = makeRig('hopper', 10 * PX * s * 1.3);
      const bob = new THREE.Group();
      bob.scale.setScalar(s * 1.3);
      const core = part({ key: `${m.id}-core`, size: [6, 6, 6], base: '#e05a90', faces: { front: (g) => { g.rect(1, 1, 2, 2, '#2a1a2a'); g.rect(4, 1, 1, 1, '#2a1a2a'); g.px(3, 4, '#2a1a2a'); } } });
      core.position.y = 1 * PX;
      const shell = part({ key: `${m.id}-shell`, size: [10, 10, 10], base: m.look.color, transparent: 0.6, faces: { front: (g) => { g.rect(2, 3, 2, 2, '#3a1a2a'); g.rect(6, 3, 2, 2, '#3a1a2a'); g.rect(4, 7, 2, 1, '#3a1a2a'); } } });
      shell.castShadow = true;
      bob.add(core, shell);
      rig.yaw.add(bob);
      rig.bodyBob = bob;
      return rig;
    }
    case 'shroom': {
      const rig = makeRig('hopper', 16 * PX * s);
      const bob = new THREE.Group();
      bob.scale.setScalar(s);
      const stem = part({ key: `${m.id}-stem`, size: [6, 8, 6], base: '#efe3c8', faces: { front: (g) => { g.px(1, 3, '#1a1a1a'); g.px(4, 3, '#1a1a1a'); g.rect(2, 5, 2, 1, '#8a4a3a'); } } });
      const cap = part({ key: `${m.id}-cap`, size: [12, 5, 12], base: m.look.color, faces: { top: (g) => { for (let i = 0; i < 8; i++) g.rect(Math.floor(g.rand() * 10), Math.floor(g.rand() * 10), 2, 2, '#f4f0e8'); }, side: (g) => { g.rect(2, 1, 2, 2, '#f4f0e8'); g.rect(8, 2, 2, 2, '#f4f0e8'); }, front: (g) => { g.rect(3, 1, 2, 2, '#f4f0e8'); g.rect(8, 2, 2, 2, '#f4f0e8'); } } });
      cap.position.y = 7 * PX;
      bob.add(stem, cap);
      rig.yaw.add(bob);
      rig.bodyBob = bob;
      return rig;
    }
    case 'beast': {
      const rig = makeRig('quad', 14 * PX * s);
      const body = new THREE.Group();
      body.scale.setScalar(s);
      rig.yaw.add(body);
      const fur = m.look.color;
      const torso = part({ key: `${m.id}-torso`, size: [7, 7, 14], base: fur, faces: { top: (g) => g.rect(2, 0, 3, g.h, '#6a6f78') } });
      torso.position.set(0, 8 * PX, 0);
      body.add(torso);
      const head = new THREE.Group();
      head.position.set(0, 11 * PX, 7 * PX);
      const skull = part({ key: `${m.id}-head`, size: [7, 6, 5], base: fur, faces: { front: (g) => { g.rect(1, 1, 2, 1, '#1a1a1a'); g.rect(4, 1, 2, 1, '#1a1a1a'); g.px(1, 1, '#d02020'); g.px(5, 1, '#d02020'); } } });
      skull.position.z = 2 * PX;
      const snout = part({ key: `${m.id}-snout`, size: [3, 3, 3], base: '#b8bcc4', faces: { front: (g) => g.rect(1, 0, 1, 1, '#1a1a1a') } });
      snout.position.set(0, 0, 5.5 * PX);
      head.add(skull, snout);
      for (const x of [-2, 2]) {
        const ear = part({ key: `${m.id}-ear`, size: [2, 2, 1], base: '#6a6f78' });
        ear.position.set(x * PX, 6 * PX, 2 * PX);
        head.add(ear);
      }
      body.add(head);
      rig.head = head;
      for (const [x, z] of [[-2, 5], [2, 5], [-2, -5], [2, -5]]) {
        const leg = pivotTop(part({ key: `${m.id}-leg`, size: [2, 8, 2], base: '#6a6f78' }), 8);
        leg.position.set(x * PX, 8 * PX, z * PX);
        body.add(leg);
        rig.legs.push(leg);
      }
      const tail = new THREE.Group();
      tail.position.set(0, 12 * PX, -7 * PX);
      const t = part({ key: `${m.id}-tail`, size: [2, 2, 8], base: fur });
      t.rotation.x = 0.5;
      t.position.z = -3 * PX;
      tail.add(t);
      body.add(tail);
      rig.tail = tail;
      return rig;
    }
    case 'humanoid':
      if (m.id === 'skeleton') {
        return humanoid({
          key: m.id, skin: '#d8d2bf', hair: '#d8d2bf', eyes: '#e03030', shirt: '#cfc8b4', pants: '#cfc8b4', shoes: '#b8b09a', face: 'skull', thin: true, weapon: 'sword', scale: s,
          shirtDetail: (g) => { for (let y = 1; y < 11; y += 2) g.rect(1, y, 6, 1, '#6a6458'); g.rect(3, 0, 2, 12, '#b8b09a'); },
        });
      }
      return humanoid({
        key: m.id, skin: m.look.color, hair: '#2a4a1a', eyes: '#f0d020', shirt: '#7a5230', pants: '#5a3a1a', shoes: '#3a2a1a', face: 'goblin', weapon: 'sword', scale: s * 0.8,
        shirtDetail: (g) => { g.rect(0, 5, g.w, 2, '#3a2a1a'); g.px(3, 5, '#d9b44a'); },
      });
    case 'golem': {
      const rig = makeRig('humanoid', 34 * PX * s);
      const body = new THREE.Group();
      body.scale.setScalar(s * 0.9);
      rig.yaw.add(body);
      const stone = '#b0a898';
      const moss = (g: PixelCanvas) => { for (let i = 0; i < 10; i++) g.rect(Math.floor(g.rand() * g.w), Math.floor(g.rand() * g.h), 2, 1, '#5a8a3a'); for (let i = 0; i < 12; i++) g.px(Math.floor(g.rand() * g.w), Math.floor(g.rand() * g.h), '#6a6258'); };
      for (const side of [-1, 1]) {
        const leg = pivotTop(part({ key: `${m.id}-leg`, size: [6, 10, 6], base: stone, faces: { front: moss, side: moss } }), 10);
        leg.position.set(side * 4 * PX, 10 * PX, 0);
        body.add(leg);
        rig.legs.push(leg);
      }
      const torso = part({ key: `${m.id}-torso`, size: [18, 14, 10], base: stone, faces: { front: (g) => { moss(g); g.rect(7, 4, 4, 4, '#6fe0ff'); g.rect(8, 5, 2, 2, '#c0f4ff'); }, side: moss, top: moss } });
      torso.position.y = 10 * PX;
      body.add(torso);
      for (const side of [-1, 1]) {
        const arm = pivotTop(part({ key: `${m.id}-arm`, size: [5, 20, 5], base: stone, faces: { front: moss, side: moss } }), 20);
        arm.position.set(side * 11.5 * PX, 23 * PX, 0);
        body.add(arm);
        if (side === 1) rig.armR = arm;
        else rig.armL = arm;
      }
      const head = new THREE.Group();
      head.position.y = 24 * PX;
      head.add(part({ key: `${m.id}-head`, size: [8, 8, 8], base: stone, faces: { front: (g) => { g.rect(1, 3, 2, 1, '#ffd24a'); g.rect(5, 3, 2, 1, '#ffd24a'); g.rect(3, 4, 2, 3, '#6a6258'); } } }));
      body.add(head);
      rig.head = head;
      return rig;
    }
    case 'lich': {
      const rig = humanoid({
        key: m.id, skin: '#e8e2cf', hair: '#e8e2cf', eyes: '#7fff3a', shirt: '#4a2f8f', pants: '#2a1a4a', shoes: '#1a1a1a', face: 'skull', robe: true,
        hat: 'crown', weapon: 'staff', scale: s * 0.8,
        shirtDetail: (g) => { g.rect(3, 0, 2, g.h, '#d9b44a'); for (let y = 4; y < g.h; y += 5) g.rect(0, y, g.w, 1, '#2a1a5a'); },
      });
      const glow = new THREE.PointLight(0xa06aff, 3, 8);
      glow.position.y = 1.5;
      rig.root.add(glow);
      return rig;
    }
  }
}

// ------------------------------------------------------------ 場景物件

/** Minecraft 橡樹：原木樹幹 + 兩層 5×5 樹葉 + 上方十字 */
export function treeMesh(leaves: TileName = 'leaves', trunk = 4, stumpOnly = false): THREE.Mesh {
  return blockMesh((b) => {
    if (stumpOnly) {
      b.box(-0.5, 0, -0.5, 0.5, 0.6, 0.5, { py: 'log_top', ny: 'log_top', side: 'log_side' }, { uvScale: true });
      return;
    }
    b.box(-0.5, 0, -0.5, 0.5, trunk, 0.5, { py: 'log_top', ny: 'log_top', side: 'log_side' });
    for (let y = trunk - 2; y < trunk; y++) {
      for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) {
        if (x === 0 && z === 0) continue;
        if (Math.abs(x) === 2 && Math.abs(z) === 2 && y === trunk - 1) continue;
        b.box(x - 0.5, y, z - 0.5, x + 0.5, y + 1, z + 0.5, leaves);
      }
    }
    for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) b.box(x - 0.5, trunk, z - 0.5, x + 0.5, trunk + 1, z + 0.5, leaves);
    for (const [x, z] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) b.box(x - 0.5, trunk + 1, z - 0.5, x + 0.5, trunk + 2, z + 0.5, leaves);
  });
}

/** 礦脈：一塊礦石方塊 + 旁邊的小礦塊與石頭 */
export function oreMesh(ore: TileName, depleted: boolean): THREE.Mesh {
  return blockMesh((b) => {
    if (depleted) {
      b.box(-0.5, 0, -0.5, 0.5, 0.5, 0.5, 'cobble', { uvScale: true });
      return;
    }
    b.box(-0.5, 0, -0.5, 0.5, 1, 0.5, ore);
    b.box(0.5, 0, -0.3, 1.1, 0.6, 0.3, ore, { uvScale: true });
    b.box(-1.1, 0, -0.1, -0.5, 0.45, 0.5, 'stone', { uvScale: true });
    b.box(-0.2, 1, -0.2, 0.3, 1.4, 0.3, ore, { uvScale: true });
  });
}

export function houseMesh(): THREE.Mesh {
  return blockMesh((b) => {
    const W = 3; // 半寬（x）
    const D = 3; // 半深（z）
    // 石頭地基
    b.box(-W - 0.5, 0, -D - 0.5, W + 0.5, 0.5, D + 0.5, 'cobble', { uvScale: true });
    // 牆壁（木板）與原木柱
    for (let y = 0; y < 4; y++) {
      const yy = 0.5 + y;
      for (let x = -W; x <= W; x++) {
        for (const z of [-D, D]) {
          const corner = Math.abs(x) === W;
          const door = z === D && x === 0 && y < 2;
          const window = !corner && y === 1 && (x === -2 || x === 2);
          if (door) continue;
          const tile: TileName = corner ? 'log_side' : window ? 'glass' : 'planks';
          b.box(x - 0.5, yy, z - 0.5, x + 0.5, yy + 1, z + 0.5, corner ? { side: 'log_side', py: 'log_top', ny: 'log_top' } : tile);
        }
      }
      for (let z = -D + 1; z <= D - 1; z++) {
        for (const x of [-W, W]) {
          const window = y === 1 && z === 0;
          b.box(x - 0.5, yy, z - 0.5, x + 0.5, yy + 1, z + 0.5, window ? 'glass' : 'planks');
        }
      }
    }
    // 門
    b.box(-0.5, 0.5, D + 0.35, 0.5, 2.5, D + 0.5, 'dark_planks');
    // 階梯式屋頂（沿 z 方向斜下）
    for (let step = 0; step <= D + 1; step++) {
      const y = 4.5 + step;
      const z0 = -D - 1 + step;
      const z1 = D + 1 - step;
      if (z1 <= z0) break;
      b.box(-W - 1, y, z0 - 0.5, W + 1, y + 1, z0 + 0.5, 'roof');
      if (z1 !== z0) b.box(-W - 1, y, z1 - 0.5, W + 1, y + 1, z1 + 0.5, 'roof');
      // 山牆
      if (step > 0) for (const x of [-W, W]) b.box(x - 0.5, y - 1, z0 + 0.5, x + 0.5, y, z1 - 0.5, 'planks', { faces: ['px', 'nx', 'pz', 'nz'] });
    }
    b.box(-W - 1, 4.5 + D + 1, -0.5, W + 1, 5.5 + D + 1, 0.5, 'roof');
    // 煙囪
    b.box(W - 1.5, 5, -1.5, W - 0.5, 10, -0.5, 'stone_brick');
  });
}

export function stationMesh(id: 'smelter' | 'workbench' | 'anvil' | 'alchemy'): THREE.Mesh {
  return blockMesh((b) => {
    const faceFront = (front: TileName, side: TileName, top: TileName): Partial<Record<Face | 'side', TileName>> => ({ pz: front, side, py: top, ny: side });
    switch (id) {
      case 'smelter':
        b.box(-0.5, 0, -0.5, 0.5, 1, 0.5, faceFront('furnace_front', 'furnace_side', 'stone'));
        b.box(0.5, 0, -0.5, 1.5, 1, 0.5, faceFront('furnace_front', 'furnace_side', 'stone'));
        break;
      case 'workbench':
        b.box(-0.5, 0, -0.5, 0.5, 1, 0.5, faceFront('table_side', 'table_side', 'table_top'));
        b.box(0.5, 0, -0.5, 1.5, 1, 0.5, { side: 'bookshelf', py: 'planks', ny: 'planks' });
        break;
      case 'anvil':
        b.box(-0.4, 0, -0.35, 0.4, 0.25, 0.35, 'iron_block', { uvScale: true });
        b.box(-0.2, 0.25, -0.15, 0.2, 0.6, 0.15, 'iron_block', { uvScale: true });
        b.box(-0.5, 0.6, -0.3, 0.5, 0.95, 0.3, 'iron_block', { uvScale: true });
        b.box(0.6, 0, -0.5, 1.6, 0.5, 0.5, 'hay', { uvScale: true });
        break;
      case 'alchemy':
        b.box(-0.5, 0, -0.5, 0.5, 1, 0.5, { side: 'bookshelf', py: 'planks', ny: 'planks' });
        b.box(0.55, 0, -0.45, 1.45, 0.7, 0.45, 'stone_brick', { uvScale: true });
        for (const [x, z] of [[-0.25, -0.2], [0.2, 0.15], [0.25, -0.25]]) b.box(x - 0.1, 1, z - 0.1, x + 0.1, 1.35, z + 0.1, 'glass', { uvScale: true });
        break;
    }
  });
}

/** Minecraft 風格的傳送門：黑曜石框 + 紫色門面 */
export function portalMeshes(): { frame: THREE.Mesh; pane: THREE.Mesh } {
  const frame = blockMesh((b) => {
    for (let x = -2; x <= 1; x++) {
      b.box(x, 0, -0.5, x + 1, 1, 0.5, 'darkstone');
      b.box(x, 4, -0.5, x + 1, 5, 0.5, 'darkstone');
    }
    for (let y = 1; y < 4; y++) {
      b.box(-2, y, -0.5, -1, y + 1, 0.5, 'darkstone');
      b.box(1, y, -0.5, 2, y + 1, 0.5, 'darkstone');
    }
  });
  const pb = new GeoBuilder();
  for (let x = -1; x <= 0; x++) for (let y = 1; y < 4; y++) {
    pb.box(x, y, -0.05, x + 1, y + 1, 0.05, 'portal', { faces: ['pz', 'nz'] });
  }
  const mat = new THREE.MeshBasicMaterial({ map: blockMaterial().map, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false });
  const pane = new THREE.Mesh(pb.build(), mat);
  return { frame, pane };
}

export function fenceMesh(points: [number, number][], y: (x: number, z: number) => number): THREE.Mesh {
  return blockMesh((b) => {
    for (let i = 0; i < points.length; i++) {
      const [x, z] = points[i];
      const gy = y(x, z);
      b.box(x - 0.12, gy, z - 0.12, x + 0.12, gy + 1.1, z + 0.12, 'planks', { uvScale: true });
      const next = points[i + 1];
      if (next && Math.hypot(next[0] - x, next[1] - z) <= 1.01) {
        const [nx, nz] = next;
        const x0 = Math.min(x, nx) - 0.05;
        const x1 = Math.max(x, nx) + 0.05;
        const z0 = Math.min(z, nz) - 0.05;
        const z1 = Math.max(z, nz) + 0.05;
        for (const ry of [0.4, 0.8]) b.box(x0, gy + ry, z0, x1, gy + ry + 0.14, z1, 'planks', { uvScale: true });
      }
    }
  });
}

export function gravestone(): THREE.Mesh {
  return blockMesh((b) => {
    b.box(-0.35, 0, -0.12, 0.35, 0.9, 0.12, 'moss_stone', { uvScale: true });
    b.box(-0.5, 0, -0.3, 0.5, 0.15, 0.3, 'cobble', { uvScale: true });
  });
}

export function cloudMesh(seed: number): THREE.Mesh {
  let s = seed;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const geo = new GeoBuilder();
  const w = 3 + Math.floor(rnd() * 4);
  const d = 2 + Math.floor(rnd() * 3);
  for (let x = 0; x < w; x++) for (let z = 0; z < d; z++) {
    if (rnd() < 0.25 && (x === 0 || z === 0 || x === w - 1 || z === d - 1)) continue;
    geo.box(x * 2, 0, z * 2, x * 2 + 2, 1, z * 2 + 2, 'wool_white');
  }
  const mesh = new THREE.Mesh(geo.build(), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, vertexColors: true }));
  return mesh;
}

/** Minecraft 式頭像：把角色頭部正面的 8×8 像素放大，用於狀態列 */
export function facePortrait(cls: ClassId, size = 64): string {
  const look = CLASS_LOOKS[cls];
  const c = document.createElement('canvas');
  c.width = c.height = 8;
  const pc = new PixelCanvas(c.getContext('2d')!, 8, 8, 42);
  pc.fill(look.skin, 6);
  headFaces(look)?.front?.(pc);
  if (look.hat && look.hat !== 'none' && look.hat !== 'crown') pc.rect(0, 0, 8, 2, look.hatColor ?? look.hair);
  const out = document.createElement('canvas');
  out.width = out.height = size;
  const g = out.getContext('2d')!;
  g.imageSmoothingEnabled = false;
  g.drawImage(c, 0, 0, size, size);
  return out.toDataURL();
}
