/**
 * 世界渲染器：只負責「畫出伺服器傳來的狀態」與「把點擊轉成意圖送出」。
 * 遊戲規則全部在 GameServer；這裡沒有任何會影響遊戲結果的計算。
 */
import * as THREE from 'three';
import type { ClientState } from '../client/ClientState';
import type { StationId } from '../core/homestead';
import { getDef } from '../core/items';
import { randRange, mathRng } from '../core/rng';
import { RARITY_INFO } from '../core/types';
import { ITEM_DB, MONSTER_DB, NODE_DB, STATION_NAMES } from '../data';
import type { MonsterDef } from '../data/monsters';
import type { ClassId } from '../data/classes';
import type { ItemSnap, MonsterSnap, NodeSnap, PlayerSnap, ServerMsg } from '../net/protocol';
import { homesteadLayout, worldLayout, ZONE_LEVELS, ZONE_NAMES, ZONE_SIZE, type MapLayout, type NpcId, type ZoneId } from '../shared/maps';
import type { TileName } from '../shared/tiles';
import { groundItemTexture } from './sprites';
import {
  animateRig, cloudMesh, spruceMesh, fenceMesh, gravestone, houseMesh, monsterRig, npcRig, oreMesh, playerRig, portalMeshes, stationMesh, treeMesh,
  type Rig,
} from './voxel/models';
import { applyModelOverride } from './voxel/modelOverrides';
import { tickMaterials } from './voxel/mesher';
import { Terrain } from './voxel/terrain';

export type { ZoneId, NpcId };

interface View {
  rig: Rig;
  pos: THREE.Vector3;
  target: THREE.Vector3;
  yaw: number;
  moving: boolean;
  animT: number;
  attackT: number;
  swing: number;
}

interface PlayerView extends View {
  id: number;
  name: string;
  cls: ClassId;
  hp: number;
  maxHp: number;
}

interface MonsterView extends View {
  id: number;
  def: MonsterDef;
  hp: number;
  dead: boolean;
  lastHit: number;
}

interface ItemView {
  id: number;
  defId: string;
  qty: number;
  owner?: string;
  party?: string[];
  sprite: THREE.Sprite;
  pos: THREE.Vector3;
}

interface NodeView {
  i: number;
  group: THREE.Group;
  pos: THREE.Vector3;
  depleted?: boolean;
  hitsLeft: number;
}

interface NpcView extends View {
  id: NpcId;
  name: string;
}

type Pick =
  | { type: 'monster'; id: number }
  | { type: 'player'; id: number }
  | { type: 'item'; id: number }
  | { type: 'node'; i: number }
  | { type: 'station'; id: StationId }
  | { type: 'npc'; id: NpcId };

export interface WorldEvents {
  floatText(worldPos: THREE.Vector3, text: string, color: string, big?: boolean): void;
  playerMenu(name: string, clientX: number, clientY: number): void;
}

const ORE_TILE: Record<string, TileName> = { copper_vein: 'copper_ore', iron_vein: 'iron_ore', mithril_vein: 'mithril_ore' };

function skyTexture(top: string, bottom: string): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 2;
  c.height = 256;
  const g = c.getContext('2d')!;
  const grd = g.createLinearGradient(0, 0, 0, 256);
  grd.addColorStop(0, top);
  grd.addColorStop(1, bottom);
  g.fillStyle = grd;
  g.fillRect(0, 0, 2, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class World {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  zone: ZoneId = 'field';
  layout?: MapLayout;

  private zoneRoot = new THREE.Group();
  private terrain?: Terrain;
  private players = new Map<number, PlayerView>();
  private monsters = new Map<number, MonsterView>();
  private items = new Map<number, ItemView>();
  private nodes: NodeView[] = [];
  private npcs: NpcView[] = [];
  private portalPanes: THREE.Mesh[] = [];
  private clouds: THREE.Mesh[] = [];
  /** 天氣粒子：雪往下飄（fall > 0）、火星往上飄（fall < 0） */
  private snow?: THREE.Points;
  private snowFall = 2.2;
  private hemi!: THREE.HemisphereLight;
  private occluders: THREE.Object3D[] = [];
  private time = 0;
  private camYaw = Math.PI / 4;
  private camDist = 19;
  private camTarget = new THREE.Vector3();
  private raycaster = new THREE.Raycaster();
  private clickMarker: THREE.Mesh;
  private sun: THREE.DirectionalLight;
  /** 目前鎖定攻擊的怪物（僅供標籤顯示） */
  private targetId?: number;
  hovered?: Pick;

  constructor(
    private readonly container: HTMLElement,
    private readonly cs: ClientState,
    private readonly ev: WorldEvents,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    container.appendChild(this.renderer.domElement);
    this.camera = new THREE.PerspectiveCamera(30, 1, 0.5, 400);

    this.hemi = new THREE.HemisphereLight(0xdfefff, 0x6a5a40, 1.5);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xfff2d8, 2.0);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -26;
    sc.right = 26;
    sc.top = 26;
    sc.bottom = -26;
    sc.near = 1;
    sc.far = 120;
    this.sun.shadow.bias = -0.0008;
    this.sun.shadow.normalBias = 0.03;
    this.scene.add(this.sun, this.sun.target);
    this.scene.add(this.zoneRoot);

    this.clickMarker = new THREE.Mesh(
      new THREE.RingGeometry(0.25, 0.4, 4),
      new THREE.MeshBasicMaterial({ color: 0xffe680, transparent: true, opacity: 0.9, side: THREE.DoubleSide }),
    );
    this.clickMarker.rotation.x = -Math.PI / 2;
    this.clickMarker.visible = false;
    this.scene.add(this.clickMarker);
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  // ============================================================ 伺服器訊息

  apply(msg: ServerMsg): void {
    switch (msg.t) {
      case 'zone':
        this.loadZone(msg.zone, msg.homestead?.nodes ?? []);
        break;
      case 'snap':
        this.applySnap(msg.players, msg.monsters, msg.items, msg.nodes);
        break;
      case 'fx':
        this.applyFx(msg);
        break;
    }
  }

  private me(): PlayerView | undefined {
    return this.players.get(this.cs.myId);
  }

  groundY(x: number, z: number): number {
    return this.terrain?.heightAt(x, z) ?? 1;
  }

  private newView(rig: Rig, x: number, z: number, yaw: number, artKey: string): View {
    // 同種角色共用材質快取；每個實體複製一份材質（貼圖仍共用），受擊閃紅才不會整群一起變紅
    rig.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map((m) => m.clone()) : mesh.material.clone();
    });
    const y = this.groundY(x, z);
    rig.root.position.set(x, y, z);
    rig.yaw.rotation.y = yaw;
    // 有美術 .glb 就換上（非同步，載入完才替換）
    applyModelOverride(rig, artKey);
    return { rig, pos: new THREE.Vector3(x, y, z), target: new THREE.Vector3(x, y, z), yaw, moving: false, animT: Math.random() * 10, attackT: 0, swing: 0 };
  }

  private tagPick(obj: THREE.Object3D, pick: Pick): void {
    obj.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.userData.pick = pick;
    });
  }

  private applySnap(players: PlayerSnap[], monsters: MonsterSnap[], items: ItemSnap[], nodes: NodeSnap[]): void {
    // 玩家
    const seenP = new Set<number>();
    for (const s of players) {
      seenP.add(s.id);
      let v = this.players.get(s.id);
      if (v && v.cls !== s.cls) {
        this.zoneRoot.remove(v.rig.root);
        this.players.delete(s.id);
        v = undefined;
      }
      if (!v) {
        v = { ...this.newView(playerRig(s.cls), s.x, s.z, s.yaw, `class_${s.cls}`), id: s.id, name: s.name, cls: s.cls, hp: s.hp, maxHp: s.maxHp };
        v.swing = s.swing;
        this.tagPick(v.rig.root, { type: 'player', id: s.id });
        this.zoneRoot.add(v.rig.root);
        this.players.set(s.id, v);
      }
      this.syncView(v, s.x, s.z, s.yaw, s.moving, s.swing);
      v.hp = s.hp;
      v.maxHp = s.maxHp;
    }
    for (const [id, v] of this.players) {
      if (!seenP.has(id)) {
        this.zoneRoot.remove(v.rig.root);
        this.players.delete(id);
      }
    }
    // 怪物
    const seenM = new Set<number>();
    for (const s of monsters) {
      seenM.add(s.id);
      let v = this.monsters.get(s.id);
      if (!v) {
        const def = MONSTER_DB.get(s.def)!;
        v = { ...this.newView(monsterRig(def), s.x, s.z, s.yaw, `monster_${def.id}`), id: s.id, def, hp: s.hp, dead: s.dead, lastHit: -99 };
        v.swing = s.swing;
        this.tagPick(v.rig.root, { type: 'monster', id: s.id });
        this.zoneRoot.add(v.rig.root);
        this.monsters.set(s.id, v);
      }
      if (v.dead && !s.dead) v.pos.set(s.x, this.groundY(s.x, s.z), s.z); // 重生：直接瞬移
      v.dead = s.dead;
      v.rig.root.visible = !s.dead;
      v.hp = s.hp;
      this.syncView(v, s.x, s.z, s.yaw, s.moving, s.swing);
      if (s.dead && this.targetId === s.id) this.targetId = undefined;
    }
    for (const [id, v] of this.monsters) {
      if (!seenM.has(id)) {
        this.zoneRoot.remove(v.rig.root);
        this.monsters.delete(id);
      }
    }
    // 地上物品
    const seenI = new Set<number>();
    for (const s of items) {
      seenI.add(s.id);
      let v = this.items.get(s.id);
      if (!v) {
        const def = getDef(ITEM_DB, s.defId);
        const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: groundItemTexture(def), alphaTest: 0.1, transparent: true }));
        sprite.center.set(0.5, 0.2);
        sprite.scale.set(0.7, 0.7, 1);
        const pos = new THREE.Vector3(s.x, this.groundY(s.x, s.z), s.z);
        sprite.position.copy(pos);
        sprite.userData.pick = { type: 'item', id: s.id } satisfies Pick;
        this.zoneRoot.add(sprite);
        v = { id: s.id, defId: s.defId, qty: s.qty, sprite, pos };
        this.items.set(s.id, v);
      }
      v.owner = s.owner;
      v.party = s.party;
    }
    for (const [id, v] of this.items) {
      if (!seenI.has(id)) {
        this.zoneRoot.remove(v.sprite);
        this.items.delete(id);
      }
    }
    // 資源點
    for (const s of nodes) {
      const n = this.nodes[s.i];
      if (!n) continue;
      n.hitsLeft = s.hitsLeft;
      if (n.depleted !== s.depleted) this.setNodeVisual(n, s.depleted);
    }
  }

  private syncView(v: View, x: number, z: number, yaw: number, moving: boolean, swing: number): void {
    v.target.set(x, this.groundY(x, z), z);
    if (v.target.distanceTo(v.pos) > 4) v.pos.copy(v.target);
    v.yaw = yaw;
    v.moving = moving;
    if (swing !== v.swing) {
      v.swing = swing;
      v.attackT = 0.001;
    }
  }

  private applyFx(f: Extract<ServerMsg, { t: 'fx' }>): void {
    let at = new THREE.Vector3(f.x, this.groundY(f.x, f.z) + f.y, f.z);
    if (f.target !== undefined) {
      const m = this.monsters.get(f.target);
      const p = this.players.get(f.target);
      const v = m ?? p;
      if (v) at = v.pos.clone().setY(v.pos.y + v.rig.height + 0.3);
      if (m && (f.kind === 'dmg' || f.kind === 'crit' || f.kind === 'miss')) m.lastHit = this.time;
      if (v && (f.kind === 'dmg' || f.kind === 'crit' || f.kind === 'hurt')) this.flash(v.rig);
    }
    switch (f.kind) {
      case 'poof':
        this.particles(at, 0xeeeeee, 10, 0.15, 0.6, 700, false);
        return;
      case 'chips':
        this.particles(at, new THREE.Color(f.color ?? '#888').getHex(), 6, 0.1, 2, 600, true);
        return;
      case 'skill':
        this.skillEffect(new THREE.Vector3(f.x, this.groundY(f.x, f.z), f.z), f.color ?? '#fff', f.radius ?? 0, f.element ?? 'physical');
        if (f.caster !== undefined) {
          const c = this.players.get(f.caster);
          if (c) this.ev.floatText(c.pos.clone().setY(c.pos.y + c.rig.height + 0.9), f.text ?? '', '#ffe680');
        }
        return;
      default:
        if (f.text) this.ev.floatText(at, f.text, f.color ?? '#fff', f.kind === 'crit' || f.kind === 'levelup');
    }
  }

  // ============================================================ 場景建構

  private clearZone(): void {
    this.zoneRoot.clear();
    this.players.clear();
    this.monsters.clear();
    this.items.clear();
    this.nodes = [];
    this.npcs = [];
    this.portalPanes = [];
    this.occluders = [];
    this.clouds = [];
    this.targetId = undefined;
    this.clickMarker.visible = false;
  }

  private place(obj: THREE.Object3D, x: number, z: number): THREE.Object3D {
    obj.position.set(x, this.groundY(x, z), z);
    this.zoneRoot.add(obj);
    return obj;
  }

  loadZone(zone: ZoneId, homeNodes: import('../core/homestead').NodeState[]): void {
    this.clearZone();
    this.zone = zone;
    const layout = zone === 'homestead' ? homesteadLayout(homeNodes) : worldLayout(zone);
    this.layout = layout;
    this.scene.background = skyTexture(layout.sky.top, layout.sky.bottom);
    const fog: [number, number] = zone === 'homestead' ? [45, 90] : zone === 'frost' ? [40, 95] : zone === 'ember' ? [30, 80] : [55, 110];
    this.scene.fog = new THREE.Fog(layout.sky.fog, fog[0], fog[1]);
    // 餘燼深淵：昏暗的紅色環境光，主光源像遠方的火光
    const ember = zone === 'ember';
    this.hemi.color.set(ember ? 0xff9a70 : 0xdfefff);
    this.hemi.groundColor.set(ember ? 0x3a1a10 : 0x6a5a40);
    this.hemi.intensity = ember ? 1.1 : 1.5;
    this.sun.color.set(ember ? 0xffa070 : 0xfff2d8);
    this.sun.intensity = ember ? 1.4 : 2.0;
    this.terrain = new Terrain(layout.grid);
    this.zoneRoot.add(this.terrain.build());

    for (const t of layout.trees) {
      const mesh = t.spruce ? spruceMesh(t.trunk) : treeMesh(t.leaves, t.trunk);
      this.place(mesh, t.x, t.z);
      this.occluders.push(mesh);
    }
    for (const g of layout.graves) {
      const mesh = gravestone();
      mesh.rotation.y = g.rot;
      this.place(mesh, g.x, g.z);
    }
    for (const n of layout.npcs) {
      const v: NpcView = { ...this.newView(npcRig(n.id), n.x, n.z, Math.atan2(-n.x, -n.z + 6), `npc_${n.id}`), id: n.id, name: n.name };
      this.tagPick(v.rig.root, { type: 'npc', id: n.id });
      this.zoneRoot.add(v.rig.root);
      this.npcs.push(v);
    }
    for (const p of layout.portals) {
      const { frame, pane } = portalMeshes();
      const g = new THREE.Group();
      g.add(frame, pane);
      this.place(g, p.x, p.z);
      this.portalPanes.push(pane);
    }
    if (layout.house) {
      const house = houseMesh();
      this.place(house, layout.house.x, layout.house.z);
      this.occluders.push(house);
    }
    for (const s of layout.stations) {
      const mesh = stationMesh(s.id);
      this.place(mesh, s.x, s.z);
      this.tagPick(mesh, { type: 'station', id: s.id });
    }
    for (const f of layout.fences) this.zoneRoot.add(fenceMesh(f, (x, z) => this.groundY(x, z)));
    layout.nodes.forEach((pos, i) => {
      const g = new THREE.Group();
      this.place(g, pos.x, pos.z);
      const n: NodeView = { i, group: g, pos: g.position.clone(), hitsLeft: 0 };
      this.nodes.push(n);
      this.setNodeVisual(n, false);
    });
    this.snow = undefined;
    if (zone === 'ember') {
      // 火星：從地面緩緩往上飄的橘色光點
      const n = 700;
      const pos = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        pos[i * 3] = randRange(mathRng, -30, 30);
        pos[i * 3 + 1] = randRange(mathRng, 0, 25);
        pos[i * 3 + 2] = randRange(mathRng, -30, 30);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      this.snow = new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xffa040, size: 0.1, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
      this.snowFall = -1.1;
      this.zoneRoot.add(this.snow);
    } else if (zone === 'frost') {
      this.snowFall = 2.2;
      // 下雪：在相機周圍循環掉落的白色方塊粒子
      const n = 1500;
      const pos = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        pos[i * 3] = randRange(mathRng, -30, 30);
        pos[i * 3 + 1] = randRange(mathRng, 0, 25);
        pos[i * 3 + 2] = randRange(mathRng, -30, 30);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      this.snow = new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xffffff, size: 0.12, transparent: true, opacity: 0.9, depthWrite: false }));
      this.zoneRoot.add(this.snow);
    }
    for (let i = 0; i < (zone === 'ember' ? 0 : 14); i++) {
      const c = cloudMesh(i * 97 + 13);
      c.position.set(randRange(mathRng, -layout.size, layout.size), 26 + Math.random() * 4, randRange(mathRng, -layout.size, layout.size));
      this.zoneRoot.add(c);
      this.clouds.push(c);
    }
    this.camTarget.set(layout.spawn.x, 1, layout.spawn.z);
  }

  private setNodeVisual(n: NodeView, depleted: boolean): void {
    n.depleted = depleted;
    n.group.clear();
    const state = this.cs.homestead.data.nodes[n.i];
    const def = state ? NODE_DB.get(state.defId) : undefined;
    if (!def) return;
    const mesh = def.kind === 'tree'
      ? treeMesh(def.id === 'maple_tree' ? 'maple_leaves' : 'leaves', 4, depleted)
      : oreMesh(ORE_TILE[def.id] ?? 'coal_ore', depleted);
    n.group.add(mesh);
    this.tagPick(n.group, { type: 'node', i: n.i });
    const idx = this.occluders.indexOf(n.group);
    if (def.kind === 'tree' && idx < 0) this.occluders.push(n.group);
  }

  // ============================================================ 輸入

  resize(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  rotateCamera(dx: number): void {
    this.camYaw += dx;
  }

  zoomCamera(delta: number): void {
    this.camDist = Math.min(40, Math.max(10, this.camDist + delta));
  }

  private ndc(clientX: number, clientY: number): THREE.Vector2 {
    const r = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
  }

  private pickAt(clientX: number, clientY: number): Pick | undefined {
    this.raycaster.setFromCamera(this.ndc(clientX, clientY), this.camera);
    const objs: THREE.Object3D[] = [];
    this.zoneRoot.traverse((o) => {
      if (o.userData.pick && o.visible) objs.push(o);
    });
    for (const h of this.raycaster.intersectObjects(objs, false)) {
      const p = h.object.userData.pick as Pick;
      if (p.type === 'monster' && this.monsters.get(p.id)?.dead) continue;
      if (p.type === 'player' && p.id === this.cs.myId) continue;
      if (!h.object.parent?.visible && p.type === 'monster') continue;
      return p;
    }
    return undefined;
  }

  hover(clientX: number, clientY: number): Pick | undefined {
    this.hovered = this.pickAt(clientX, clientY);
    return this.hovered;
  }

  hoveredItem(): { defId: string; qty: number } | undefined {
    const h = this.hovered;
    if (h?.type !== 'item') return undefined;
    return this.items.get(h.id);
  }

  click(clientX: number, clientY: number): void {
    const p = this.pickAt(clientX, clientY);
    if (p) {
      switch (p.type) {
        case 'monster':
          this.targetId = p.id;
          this.cs.send({ t: 'attack', id: p.id });
          return;
        case 'item':
          this.cs.send({ t: 'pickup', id: p.id });
          return;
        case 'node':
          this.cs.send({ t: 'gather', node: p.i });
          return;
        case 'station':
          this.cs.send({ t: 'interact', kind: 'station', id: p.id });
          return;
        case 'npc':
          this.cs.send({ t: 'interact', kind: 'npc', id: p.id });
          return;
        case 'player': {
          const pl = this.players.get(p.id);
          if (pl) this.ev.playerMenu(pl.name, clientX, clientY);
          return;
        }
      }
    }
    if (!this.terrain) return;
    this.raycaster.setFromCamera(this.ndc(clientX, clientY), this.camera);
    const hit = this.raycaster.intersectObject(this.terrain.mesh, false)[0];
    if (!hit) return;
    const pt = hit.point;
    const half = ZONE_SIZE[this.zone] / 2 - 1.5;
    pt.x = Math.max(-half, Math.min(half, pt.x));
    pt.z = Math.max(-half, Math.min(half, pt.z));
    this.cs.send({ t: 'move', x: pt.x, z: pt.z });
    this.targetId = undefined;
    this.clickMarker.position.set(pt.x, this.groundY(pt.x, pt.z) + 0.03, pt.z);
    this.clickMarker.visible = true;
  }

  pickupNearest(): void {
    const me = this.me();
    if (!me) return;
    let best: ItemView | undefined;
    let bd = 6;
    for (const it of this.items.values()) {
      const d = it.pos.distanceTo(me.pos);
      if (d < bd && (!it.owner || it.owner === this.cs.name || it.party?.includes(this.cs.name))) {
        bd = d;
        best = it;
      }
    }
    if (best) this.cs.send({ t: 'pickup', id: best.id });
  }

  /** 技能目標：已鎖定的怪 → 滑鼠指著的怪 → 身邊最近的怪 */
  currentTarget(): number | undefined {
    if (this.targetId !== undefined && !this.monsters.get(this.targetId)?.dead) return this.targetId;
    if (this.hovered?.type === 'monster') return this.hovered.id;
    const me = this.me();
    if (!me) return undefined;
    let best: MonsterView | undefined;
    let bd = 10;
    for (const m of this.monsters.values()) {
      if (m.dead) continue;
      const d = m.pos.distanceTo(me.pos);
      if (d < bd) {
        bd = d;
        best = m;
      }
    }
    if (best) this.targetId = best.id;
    return best?.id;
  }

  attackNearest(): void {
    const me = this.me();
    if (!me) return;
    let best: MonsterView | undefined;
    let bd = 12;
    for (const m of this.monsters.values()) {
      if (m.dead) continue;
      const d = m.pos.distanceTo(me.pos);
      if (d < bd) {
        bd = d;
        best = m;
      }
    }
    if (best) {
      this.targetId = best.id;
      this.cs.send({ t: 'attack', id: best.id });
    }
  }

  // ============================================================ 每幀

  update(dt: number): void {
    this.time += dt;
    tickMaterials(this.time);
    const lerp = Math.min(1, dt * 12);
    const animate = (v: View) => {
      v.pos.lerp(v.target, lerp);
      v.rig.root.position.copy(v.pos);
      let dy = v.yaw - v.rig.yaw.rotation.y;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      v.rig.yaw.rotation.y += dy * Math.min(1, dt * 12);
      v.animT += v.moving ? dt : dt * 0.3;
      if (v.attackT > 0) {
        v.attackT += dt * 3.5;
        if (v.attackT >= 1) v.attackT = 0;
      }
      animateRig(v.rig, v.moving ? v.animT : this.time, v.moving, v.attackT, dt);
    };
    for (const v of this.players.values()) animate(v);
    for (const v of this.monsters.values()) if (!v.dead) animate(v);
    for (const v of this.npcs) animate(v);
    for (const it of this.items.values()) it.sprite.position.y = it.pos.y + 0.1 + Math.sin(this.time * 3 + it.pos.x) * 0.08;
    for (const pane of this.portalPanes) (pane.material as THREE.MeshBasicMaterial).opacity = 0.65 + Math.sin(this.time * 3) * 0.15;
    if (this.snow) {
      const arr = this.snow.geometry.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < arr.count; i++) {
        let y = arr.getY(i) - dt * this.snowFall;
        if (y < 0) y += 25;
        else if (y > 25) y -= 25;
        arr.setY(i, y);
        arr.setX(i, arr.getX(i) + Math.sin(this.time + i) * dt * 0.3);
      }
      arr.needsUpdate = true;
      this.snow.position.set(this.camTarget.x, this.camTarget.y, this.camTarget.z);
    }
    for (const c of this.clouds) {
      c.position.x += dt * 0.6;
      if (c.position.x > ZONE_SIZE[this.zone]) c.position.x = -ZONE_SIZE[this.zone];
    }
    const me = this.me();
    if (me && this.clickMarker.visible && me.pos.distanceTo(this.clickMarker.position) < 0.6) this.clickMarker.visible = false;
    this.updateCamera(dt);
    this.fadeOccluders();
  }

  /** 從相機往玩家身上打射線，擋住視線的樹 / 房子改成半透明 */
  private fadeOccluders(): void {
    const me = this.me();
    if (!me) return;
    const cam = this.camera.position;
    const blocking = new Set<THREE.Object3D>();
    const meshes: THREE.Object3D[] = [];
    const owner = new Map<THREE.Object3D, THREE.Object3D>();
    for (const o of this.occluders) o.traverse((c) => {
      if ((c as THREE.Mesh).isMesh) {
        meshes.push(c);
        owner.set(c, o);
      }
    });
    for (const dy of [0.3, 1, 1.8]) {
      const target = me.pos.clone().add(new THREE.Vector3(0, dy, 0));
      const dir = target.clone().sub(cam);
      const dist = dir.length();
      this.raycaster.set(cam, dir.normalize());
      this.raycaster.far = dist - 0.3;
      for (const h of this.raycaster.intersectObjects(meshes, false)) blocking.add(owner.get(h.object)!);
    }
    this.raycaster.far = Infinity;
    for (const o of this.occluders) {
      const block = blocking.has(o);
      o.traverse((c) => {
        const mesh = c as THREE.Mesh;
        if (!mesh.isMesh) return;
        if (!c.userData.baseMat) c.userData.baseMat = mesh.material;
        if (block) {
          if (!c.userData.fadeMat) {
            const fm = (mesh.material as THREE.Material).clone() as THREE.MeshLambertMaterial;
            fm.transparent = true;
            fm.opacity = 0.3;
            fm.depthWrite = false;
            c.userData.fadeMat = fm;
          }
          mesh.material = c.userData.fadeMat;
        } else if (mesh.material !== c.userData.baseMat) {
          mesh.material = c.userData.baseMat;
        }
      });
    }
  }

  /** 受擊時變紅（Minecraft 的受傷閃爍） */
  private flash(rig: Rig): void {
    const mats = new Set<THREE.MeshLambertMaterial>();
    rig.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        if ((m as THREE.MeshLambertMaterial).emissive) mats.add(m as THREE.MeshLambertMaterial);
      }
    });
    mats.forEach((m) => m.emissive.setRGB(0.6, 0, 0));
    setTimeout(() => mats.forEach((m) => m.emissive.setRGB(0, 0, 0)), 150);
  }

  /** 技能特效：範圍技能畫出擴散光環，並依元素噴出不同顏色、方向的方塊粒子 */
  private skillEffect(at: THREE.Vector3, color: string, radius: number, element: string): void {
    const col = new THREE.Color(color).getHex();
    if (radius > 0) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(radius * 0.85, radius, 40),
        new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.copy(at).setY(at.y + 0.05);
      this.zoneRoot.add(ring);
      const start = performance.now();
      const tick = () => {
        const t = (performance.now() - start) / 600;
        ring.scale.setScalar(0.3 + t * 0.7);
        (ring.material as THREE.MeshBasicMaterial).opacity = 0.8 * (1 - t);
        if (t < 1) requestAnimationFrame(tick);
        else this.zoneRoot.remove(ring);
      };
      tick();
    }
    const count = radius > 0 ? 28 : 14;
    const center = at.clone().setY(at.y + (element === 'lightning' ? 4 : element === 'fire' && radius > 3.5 ? 6 : 0.8));
    // 雷與隕石從上往下，其他向外爆開
    this.particles(center, col, count, element === 'lightning' ? 0.12 : 0.18, element === 'lightning' || radius > 3.5 ? 3 : 1.6, 700, element !== 'holy');
  }

  private particles(at: THREE.Vector3, color: number, count: number, size: number, speed: number, lifeMs: number, gravity: boolean): void {
    const mat = new THREE.MeshLambertMaterial({ color, transparent: true, opacity: 0.95 });
    const geo = new THREE.BoxGeometry(size, size, size);
    const parts: THREE.Mesh[] = [];
    for (let i = 0; i < count; i++) {
      const p = new THREE.Mesh(geo, mat);
      p.position.copy(at).add(new THREE.Vector3(randRange(mathRng, -0.4, 0.4), randRange(mathRng, 0, 0.8), randRange(mathRng, -0.4, 0.4)));
      p.userData.v = new THREE.Vector3(randRange(mathRng, -1, 1) * speed, randRange(mathRng, 1, 2) * speed, randRange(mathRng, -1, 1) * speed);
      this.zoneRoot.add(p);
      parts.push(p);
    }
    const start = performance.now();
    const tick = () => {
      const t = (performance.now() - start) / lifeMs;
      for (const p of parts) {
        const v = p.userData.v as THREE.Vector3;
        if (gravity) v.y -= 0.25;
        p.position.addScaledVector(v, 0.016);
      }
      mat.opacity = 0.95 * (1 - t);
      if (t < 1) requestAnimationFrame(tick);
      else parts.forEach((p) => this.zoneRoot.remove(p));
    };
    tick();
  }

  private updateCamera(dt: number): void {
    const me = this.me();
    if (me) this.camTarget.lerp(me.pos, Math.min(1, dt * 8));
    const pitch = THREE.MathUtils.degToRad(48);
    const off = new THREE.Vector3(
      Math.sin(this.camYaw) * Math.cos(pitch) * this.camDist,
      Math.sin(pitch) * this.camDist,
      Math.cos(this.camYaw) * Math.cos(pitch) * this.camDist,
    );
    this.camera.position.copy(this.camTarget).add(off);
    this.camera.lookAt(this.camTarget.x, this.camTarget.y + 0.9, this.camTarget.z);
    this.sun.position.copy(this.camTarget).add(new THREE.Vector3(-18, 34, 12));
    this.sun.target.position.copy(this.camTarget);
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  // ============================================================ 給 HUD 用的查詢

  toScreen(p: THREE.Vector3): { x: number; y: number; visible: boolean } {
    const v = p.clone().project(this.camera);
    const r = this.renderer.domElement.getBoundingClientRect();
    return { x: ((v.x + 1) / 2) * r.width, y: ((1 - v.y) / 2) * r.height, visible: v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1 };
  }

  labelsToDraw(): { pos: THREE.Vector3; text: string; color: string; hp?: number; kind: 'monster' | 'item' | 'npc' | 'player' | 'node' | 'station' }[] {
    const out: ReturnType<World['labelsToDraw']> = [];
    const above = (v: View, extra = 0.35) => v.pos.clone().setY(v.pos.y + v.rig.height + extra);
    for (const p of this.players.values()) {
      const mine = p.id === this.cs.myId;
      const ally = !mine && this.cs.isPartyMember(p.name);
      out.push({ pos: above(p), text: ally ? `♦ ${p.name}` : p.name, color: mine ? '#fff' : ally ? '#8fe07a' : '#8fe0ff', kind: 'player', hp: mine ? undefined : p.hp / p.maxHp });
    }
    for (const m of this.monsters.values()) {
      if (m.dead) continue;
      const hovered = this.hovered?.type === 'monster' && this.hovered.id === m.id;
      if (hovered || this.targetId === m.id || m.def.mvp || this.time - m.lastHit < 5) {
        out.push({
          pos: above(m, m.def.mvp ? 0.8 : 0.35),
          text: `${m.def.mvp ? '【MVP】' : ''}${m.def.name} Lv${m.def.level}`,
          color: m.def.mvp ? '#ff9f1a' : m.def.aggressive ? '#ff9a9a' : '#fff',
          hp: m.hp / m.def.hp,
          kind: 'monster',
        });
      }
    }
    for (const it of this.items.values()) {
      const def = getDef(ITEM_DB, it.defId);
      const locked = it.owner && it.owner !== this.cs.name && !it.party?.includes(this.cs.name);
      out.push({ pos: it.pos.clone().setY(it.pos.y + 0.8), text: `${def.name}${it.qty > 1 ? ` x${it.qty}` : ''}${locked ? `（${it.owner}）` : ''}`, color: locked ? '#8a8a8a' : RARITY_INFO[def.rarity].color, kind: 'item' });
    }
    for (const n of this.npcs) out.push({ pos: above(n), text: n.name, color: '#9fe0ff', kind: 'npc' });
    if (this.layout) {
      for (const s of this.layout.stations) out.push({ pos: new THREE.Vector3(s.x + 0.5, this.groundY(s.x, s.z) + 1.7, s.z), text: `${STATION_NAMES[s.id]} Lv${this.cs.homestead.buildingLevel(s.id)}`, color: '#ffe0a0', kind: 'station' });
      for (const p of this.layout.portals) {
        const name = p.to === 'homestead' ? '我的家園' : `${ZONE_NAMES[p.to]}${ZONE_LEVELS[p.to] ? `（${ZONE_LEVELS[p.to]}）` : ''}`;
        out.push({ pos: new THREE.Vector3(p.x, this.groundY(p.x, p.z) + 5.6, p.z), text: `▶ ${name}`, color: '#d9b0ff', kind: 'npc' });
      }
    }
    if (this.hovered?.type === 'node') {
      const n = this.nodes[this.hovered.i];
      const state = this.cs.homestead.data.nodes[this.hovered.i];
      const def = state ? NODE_DB.get(state.defId) : undefined;
      if (n && def) {
        out.push({
          pos: n.pos.clone().setY(n.pos.y + (def.kind === 'tree' && !n.depleted ? 6.8 : 1.8)),
          text: `${def.name}${n.depleted ? '（枯竭中）' : ` ${n.hitsLeft}/${def.hits}`}`,
          color: n.depleted ? '#999' : '#b0ffb0',
          kind: 'node',
        });
      }
    }
    return out;
  }

  minimapBase(): { size: number; colors: string[]; zone: ZoneId } {
    const TILE_COLOR: Partial<Record<TileName, string>> = {
      grass_top: '#5f9a3a', path: '#a88a58', cobble: '#8a8a8a', sand: '#d8cb96', gravel: '#857f7a', stone: '#7d7d7d',
      darkstone: '#3a2f4a', stone_brick: '#4a4a4a', dirt: '#7a5234', hay: '#c8a440', leaves: '#2f6a20',
      snow_top: '#e8eef4', ice: '#9cc8f0', packed_ice: '#7aa4d0', frozen_grass: '#8aa890',
      basalt_top: '#3a3538', ash: '#6a625e', lava: '#e8581a', obsidian: '#1a1426',
    };
    const grid = this.layout?.grid;
    if (!grid) return { size: 1, colors: ['#000'], zone: this.zone };
    return {
      size: grid.size,
      zone: this.zone,
      colors: grid.cols.map((c) => (c.water ? '#3a6fd8' : c.blocked && (c.top === 'grass_top' || c.top === 'snow_top') ? (c.top === 'snow_top' ? '#2a4a32' : '#2f6a20') : TILE_COLOR[c.top] ?? '#5f9a3a')),
    };
  }

  minimapMarkers(): { x: number; z: number; kind: 'player' | 'other' | 'monster' | 'mvp' | 'npc' | 'portal' | 'station' | 'node' }[] {
    const out: ReturnType<World['minimapMarkers']> = [];
    for (const m of this.monsters.values()) if (!m.dead) out.push({ x: m.pos.x, z: m.pos.z, kind: m.def.mvp ? 'mvp' : 'monster' });
    for (const n of this.npcs) out.push({ x: n.pos.x, z: n.pos.z, kind: 'npc' });
    if (this.layout) {
      for (const p of this.layout.portals) out.push({ x: p.x, z: p.z, kind: 'portal' });
      for (const s of this.layout.stations) out.push({ x: s.x, z: s.z, kind: 'station' });
    }
    for (const n of this.nodes) if (!n.depleted) out.push({ x: n.pos.x, z: n.pos.z, kind: 'node' });
    for (const p of this.players.values()) if (p.id !== this.cs.myId) out.push({ x: p.pos.x, z: p.pos.z, kind: 'other' });
    const me = this.me();
    out.push({ x: me?.pos.x ?? 0, z: me?.pos.z ?? 0, kind: 'player' });
    return out;
  }

  get playerYaw(): number {
    return this.me()?.rig.yaw.rotation.y ?? 0;
  }

  get cameraYaw(): number {
    return this.camYaw;
  }

  playerScreenPos(): { x: number; y: number } {
    const me = this.me();
    return me ? this.toScreen(me.pos.clone().setY(me.pos.y + 2)) : { x: 0, y: 0 };
  }
}
