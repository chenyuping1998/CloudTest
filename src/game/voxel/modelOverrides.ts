/**
 * 美術模型替換：把 Blockbench 等工具匯出的 .glb 放到 art/models/<key>.glb，
 * 遊戲就會用它取代程序化方塊模型（原本的方塊部位保留為隱形的點擊範圍）。
 *
 * key 命名：class_<職業>、monster_<怪物>、npc_<shop|market|guide>，
 * 例如 class_knight.glb、monster_slime.glb。規格見 art/README.md。
 */
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { Rig } from './models';

// ?inline 讓模型變成 data URL 打包進程式碼：Electron 以 file:// 載入時 fetch 無法讀本機檔，這樣就不用開放任何額外權限。
// 不是 eager，用到的模型才會載入。
const MODEL_FILES = import.meta.glob('/art/models/*.glb', { query: '?inline', import: 'default' }) as Record<string, () => Promise<string>>;

export type AnimClip = 'idle' | 'walk' | 'attack';
const CLIPS: AnimClip[] = ['idle', 'walk', 'attack'];

export interface RigAnim {
  mixer: THREE.AnimationMixer;
  actions: Partial<Record<AnimClip, THREE.AnimationAction>>;
  current?: AnimClip;
}

const cache = new Map<string, Promise<GLTF | null>>();

export function modelOverrideKeys(): string[] {
  return Object.keys(MODEL_FILES).map((f) => f.slice(f.lastIndexOf('/') + 1, -4));
}

export function hasModelOverride(key: string): boolean {
  return `/art/models/${key}.glb` in MODEL_FILES;
}

function dataUrlToBuffer(url: string): ArrayBuffer {
  const bin = atob(url.slice(url.indexOf(',') + 1));
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

function loadModel(key: string): Promise<GLTF | null> {
  let p = cache.get(key);
  if (!p) {
    const importer = MODEL_FILES[`/art/models/${key}.glb`];
    p = importer()
      .then((url) => new GLTFLoader().parseAsync(dataUrlToBuffer(url), ''))
      .catch((e: unknown) => {
        console.warn(`[art] ${key}.glb 載入失敗，改用方塊模型`, e);
        return null;
      });
    cache.set(key, p);
  }
  return p;
}

/**
 * 依 key 套用美術模型（非同步；沒有檔案或載入失敗時什麼都不做）。
 * 模型會自動縮放到與原本方塊模型相同高度、腳底貼地、水平置中，
 * 所以美術不用管單位，只要面向 +Z（Blockbench 的「北」朝後）。
 */
export function applyModelOverride(rig: Rig, key: string): void {
  if (!hasModelOverride(key)) return;
  void loadModel(key).then((gltf) => {
    if (!gltf) return;
    const model = cloneSkinned(gltf.scene);
    const box = new THREE.Box3().setFromObject(model);
    const h = box.max.y - box.min.y;
    const s = h > 0 ? rig.height / h : 1;
    const wrap = new THREE.Group();
    wrap.name = `art:${key}`;
    wrap.scale.setScalar(s);
    model.position.set(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
    wrap.add(model);

    // 原本的方塊部位：材質設為不可見（不畫、不投影），但保留給滑鼠點擊判定
    let pick: unknown;
    rig.yaw.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      pick ??= mesh.userData.pick;
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) m.visible = false;
    });
    model.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      if (pick) mesh.userData.pick = pick;
      // 每個實體一份材質（受擊閃紅不會整群一起變紅）；像素材質維持銳利
      const mats = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).map((m) => {
        const c = m.clone() as THREE.MeshStandardMaterial;
        if (c.map) {
          c.map.magFilter = THREE.NearestFilter;
          c.map.minFilter = THREE.NearestFilter;
          c.map.generateMipmaps = false;
        }
        return c;
      });
      mesh.material = Array.isArray(mesh.material) ? mats : mats[0];
    });
    rig.yaw.add(wrap);

    if (gltf.animations.length) {
      const mixer = new THREE.AnimationMixer(model);
      const actions: RigAnim['actions'] = {};
      for (const clip of gltf.animations) {
        const name = CLIPS.find((c) => clip.name.toLowerCase().includes(c));
        if (name && !actions[name]) actions[name] = mixer.clipAction(clip);
      }
      if (actions.attack) {
        actions.attack.setLoop(THREE.LoopOnce, 1);
        actions.attack.clampWhenFinished = true;
      }
      rig.anim = { mixer, actions };
    }
    rig.override = wrap;
  });
}

/** 依移動 / 攻擊狀態切換動畫片段並推進 */
export function animateOverride(rig: Rig, dt: number, moving: boolean, attack: number): void {
  const a = rig.anim;
  if (!a) {
    // 沒有動畫的靜態模型：走路時上下彈跳，攻擊時前傾
    if (rig.override) {
      rig.override.position.y = moving ? Math.abs(Math.sin(performance.now() / 110)) * 0.08 : 0;
      rig.override.rotation.x = attack > 0 ? Math.sin(attack * Math.PI) * 0.25 : 0;
    }
    return;
  }
  const want: AnimClip = attack > 0 && a.actions.attack ? 'attack' : moving && a.actions.walk ? 'walk' : 'idle';
  if (want !== a.current) {
    const next = a.actions[want];
    const prev = a.current ? a.actions[a.current] : undefined;
    if (next) {
      next.reset().play();
      if (prev && prev !== next) next.crossFadeFrom(prev, 0.15, false);
      a.current = want;
    }
  }
  a.mixer.update(dt);
}
