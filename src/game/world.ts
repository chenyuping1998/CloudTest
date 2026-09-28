import * as THREE from 'three';
import { resolveAttack } from '../core/combat';
import { rollDrops } from '../core/drops';
import { gather, refreshNode, type NodeState, type ResourceNodeDef, type StationId } from '../core/homestead';
import { createItem, getDef } from '../core/items';
import { addExp, applyDeathPenalty, expLevelModifier } from '../core/leveling';
import { mathRng, randRange, SeededRng } from '../core/rng';
import { Rarity, RARITY_INFO, type ItemInstance } from '../core/types';
import { ITEM_DB, MONSTER_DB, NODE_DB, POOL_DB, STATION_NAMES } from '../data';
import type { MonsterDef } from '../data/monsters';
import { groundItemTexture } from './sprites';
import type { GameState } from './state';
import type { TileName } from './voxel/atlas';
import {
  animateRig, cloudMesh, fenceMesh, gravestone, houseMesh, monsterRig, npcRig, oreMesh, playerRig, portalMeshes, stationMesh, treeMesh,
  type Rig,
} from './voxel/models';
import { Terrain, valueNoise, type Column } from './voxel/terrain';

export type ZoneId = 'field' | 'homestead';
export type NpcId = 'shop' | 'market' | 'guide';

interface Actor {
  rig: Rig;
  pos: THREE.Vector3;
  targetYaw: number;
  moving: boolean;
  animT: number;
  attackT: number;
}

interface MonsterRt extends Actor {
  def: MonsterDef;
  hp: number;
  spawnCenter: THREE.Vector3;
  spawnRadius: number;
  chasing: boolean;
  dead: boolean;
  respawnAt: number;
  nextAttack: number;
  nextWander: number;
  wander?: THREE.Vector3;
  lastHitAt: number;
}

interface GroundItemRt {
  item: ItemInstance;
  sprite: THREE.Sprite;
  pos: THREE.Vector3;
  expireAt: number;
}

interface NodeRt {
  state: NodeState;
  def: ResourceNodeDef;
  group: THREE.Group;
  pos: THREE.Vector3;
  depletedVisual?: boolean;
}

interface StationRt {
  id: StationId;
  group: THREE.Object3D;
  pos: THREE.Vector3;
}

interface NpcRt extends Actor {
  id: NpcId;
  name: string;
}

interface PortalRt {
  to: ZoneId;
  pos: THREE.Vector3;
  pane: THREE.Mesh;
}

type Intent =
  | { kind: 'move'; pos: THREE.Vector3 }
  | { kind: 'attack'; m: MonsterRt }
  | { kind: 'pickup'; gi: GroundItemRt }
  | { kind: 'gather'; node: NodeRt }
  | { kind: 'station'; st: StationRt }
  | { kind: 'npc'; npc: NpcRt };

type Pick =
  | { type: 'monster'; ref: MonsterRt }
  | { type: 'item'; ref: GroundItemRt }
  | { type: 'node'; ref: NodeRt }
  | { type: 'station'; ref: StationRt }
  | { type: 'npc'; ref: NpcRt };

export interface WorldEvents {
  log(msg: string, color?: string): void;
  announce(msg: string, color: string): void;
  floatText(worldPos: THREE.Vector3, text: string, color: string, big?: boolean): void;
  openStation(id: StationId): void;
  openNpc(id: NpcId): void;
  zoneChanged(zone: ZoneId): void;
  changed(): void;
}

const ZONE_SIZE: Record<ZoneId, number> = { field: 72, homestead: 40 };
const MELEE_RANGE = 1.6;
const RANGED_RANGE = 7;
const INTERACT_RANGE = 2.4;

/** 野外怪物分布：怪物 id、數量、中心點、半徑 */
const FIELD_SPAWNS: [string, number, [number, number], number][] = [
  ['jelly_slime', 10, [7, 7], 8],
  ['hop_shroom', 8, [-9, 11], 7],
  ['grey_wolf', 7, [22, -3], 7],
  ['goblin', 7, [0, -22], 8],
  ['skeleton', 6, [-22, -19], 7],
  ['rock_golem', 4, [-22, 22], 6],
  ['bone_lich', 1, [24, 24], 3],
];

const HOMESTEAD_NODE_SLOTS: [number, number][] = [
  [-12, -9], [-15, -3], [-11, 3], [11, -11], [15, -6], [-14, 10], [-8, 13], [12, 7], [16, 12], [7, 14], [-5, -14], [3, -15],
];

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

  private zoneRoot = new THREE.Group();
  private terrain!: Terrain;
  private player!: Actor;
  private monsters: MonsterRt[] = [];
  private items: GroundItemRt[] = [];
  private nodes: NodeRt[] = [];
  private stations: StationRt[] = [];
  private npcs: NpcRt[] = [];
  private portals: PortalRt[] = [];
  private clouds: THREE.Mesh[] = [];
  /** 會擋住視線的物件（樹、房子），角色走到後面時半透明 */
  private occluders: THREE.Object3D[] = [];
  private intent?: Intent;
  private nextPlayerAttack = 0;
  private nextGather = 0;
  private nextRegen = 0;
  private lastCombatAt = -99;
  private time = 0;
  private camYaw = Math.PI / 4;
  private camDist = 19;
  private camTarget = new THREE.Vector3();
  private raycaster = new THREE.Raycaster();
  private clickMarker: THREE.Mesh;
  private sun: THREE.DirectionalLight;
  hovered?: Pick;

  constructor(
    private readonly container: HTMLElement,
    private readonly state: GameState,
    private readonly ev: WorldEvents,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);
    this.camera = new THREE.PerspectiveCamera(30, 1, 0.5, 400);

    this.scene.add(new THREE.HemisphereLight(0xdfefff, 0x6a5a40, 1.5));
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

    this.player = this.makeActor(playerRig(state.player.data.classId));
    this.scene.add(this.player.rig.root);
    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.loadZone('field');
  }

  // ------------------------------------------------------------ 建構

  private makeActor(rig: Rig): Actor {
    return { rig, pos: new THREE.Vector3(), targetYaw: 0, moving: false, animT: Math.random() * 10, attackT: 0 };
  }

  private tagPick(obj: THREE.Object3D, pick: Pick): void {
    obj.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.userData.pick = pick;
    });
  }

  refreshPlayerLook(): void {
    this.scene.remove(this.player.rig.root);
    this.player.rig = playerRig(this.state.player.data.classId);
    this.scene.add(this.player.rig.root);
  }

  private clearZone(): void {
    this.zoneRoot.clear();
    this.monsters = [];
    this.items = [];
    this.nodes = [];
    this.stations = [];
    this.npcs = [];
    this.portals = [];
    this.occluders = [];
    this.clouds = [];
    this.intent = undefined;
  }

  groundY(x: number, z: number): number {
    return this.terrain.heightAt(x, z);
  }

  private place(obj: THREE.Object3D, x: number, z: number): THREE.Object3D {
    obj.position.set(x, this.groundY(x, z), z);
    this.zoneRoot.add(obj);
    return obj;
  }

  private addTree(x: number, z: number, leaves: TileName = 'leaves', trunk = 4 + Math.floor(Math.random() * 2)): void {
    const t = treeMesh(leaves, trunk);
    this.place(t, Math.floor(x) + 0.5, Math.floor(z) + 0.5);
    this.occluders.push(t);
    const col = this.terrain.columnAt(x, z);
    if (col) col.blocked = true;
  }

  private addPortal(to: ZoneId, x: number, z: number): void {
    const { frame, pane } = portalMeshes();
    const g = new THREE.Group();
    g.add(frame, pane);
    this.place(g, x, z);
    this.portals.push({ to, pos: new THREE.Vector3(x, this.groundY(x, z), z), pane });
  }

  private addNpc(id: NpcId, name: string, x: number, z: number): void {
    const npc: NpcRt = { ...this.makeActor(npcRig(id)), id, name };
    npc.pos.set(x, this.groundY(x, z), z);
    npc.targetYaw = Math.atan2(-x, -z + 6);
    this.tagPick(npc.rig.root, { type: 'npc', ref: npc });
    this.zoneRoot.add(npc.rig.root);
    this.npcs.push(npc);
  }

  private addClouds(size: number): void {
    for (let i = 0; i < 14; i++) {
      const c = cloudMesh(i * 97 + 13);
      c.position.set(randRange(mathRng, -size, size), 26 + Math.random() * 4, randRange(mathRng, -size, size));
      this.zoneRoot.add(c);
      this.clouds.push(c);
    }
  }

  private fieldColumn(x: number, z: number, noise: (x: number, z: number) => number, rng: SeededRng): Column {
    const half = ZONE_SIZE.field / 2;
    const edge = Math.max(Math.abs(x), Math.abs(z)) > half - 1;
    if (edge) return { height: 4, top: 'stone_brick', under: 'stone_brick', blocked: true };
    const n = noise(x * 0.09, z * 0.09);
    const distTown = Math.hypot(x, z);
    const inRegion = (cx: number, cz: number, r: number) => Math.hypot(x - cx, z - cz) < r;
    // 城鎮廣場：平坦的石磚與小路
    if (distTown < 6.5) return { height: 1, top: distTown < 4.5 ? 'cobble' : 'path', under: 'dirt' };
    if (Math.abs(x) < 1.2 || Math.abs(z) < 1.2) return { height: 1, top: 'path', under: 'dirt' };
    // 池塘
    if (inRegion(13, -13, 4.5) || inRegion(-12, -2, 2.5)) {
      const deep = inRegion(13, -13, 3.5) || inRegion(-12, -2, 1.6);
      return deep ? { height: 0, top: 'sand', under: 'dirt', water: true } : { height: 1, top: 'sand', under: 'dirt' };
    }
    let height = 1 + (n > 0.62 ? 1 : 0) + (n > 0.78 ? 1 : 0);
    let top: TileName = 'grass_top';
    let under: TileName = 'dirt';
    let plant: TileName | undefined;
    if (inRegion(-22, -19, 9)) {
      top = rng.next() < 0.5 ? 'gravel' : rng.next() < 0.5 ? 'dirt' : 'grass_top';
      height = 1;
    } else if (inRegion(-22, 22, 10)) {
      top = rng.next() < 0.7 ? 'stone' : 'gravel';
      under = 'stone';
      height = 1 + (n > 0.5 ? 1 : 0) + (n > 0.7 ? 1 : 0);
    } else if (inRegion(24, 24, 6)) {
      top = 'darkstone';
      under = 'darkstone';
      height = 1;
    } else if (inRegion(0, -22, 9)) {
      top = rng.next() < 0.6 ? 'sand' : 'path';
      height = 1;
    }
    if (top === 'grass_top') {
      const r = rng.next();
      if (r < 0.12) plant = 'tallgrass';
      else if (r < 0.14) plant = 'flower_red';
      else if (r < 0.16) plant = 'flower_yellow';
    }
    return { height, top, under, plant };
  }

  loadZone(zone: ZoneId): void {
    this.clearZone();
    this.zone = zone;
    const size = ZONE_SIZE[zone];
    const half = size / 2;
    if (zone === 'field') {
      this.scene.background = skyTexture('#5d9cf0', '#bfe0ff');
      this.scene.fog = new THREE.Fog(0xbfe0ff, 55, 110);
      const noise = valueNoise(7);
      const rng = new SeededRng(99);
      this.terrain = new Terrain(size, (x, z) => this.fieldColumn(x, z, noise, rng));
      this.zoneRoot.add(this.terrain.build());
      this.addNpc('shop', '道具商人 瑪莉', -3.5, -3);
      this.addNpc('market', '交易所管理員 奧斯卡', 3.5, -3);
      this.addNpc('guide', '新手導覽員 露娜', 0.5, 4);
      this.addPortal('homestead', -5, 4.5);
      // 城鎮圍籬與樹林
      const trees = new SeededRng(5);
      for (let i = 0; i < 70; i++) {
        const x = randRange(trees, -half + 3, half - 3);
        const z = randRange(trees, -half + 3, half - 3);
        const col = this.terrain.columnAt(x, z);
        if (!col || col.top !== 'grass_top' || Math.hypot(x, z) < 9 || Math.abs(x) < 2 || Math.abs(z) < 2) continue;
        if (FIELD_SPAWNS.some(([, , [cx, cz], r]) => Math.hypot(x - cx, z - cz) < r * 0.6)) continue;
        this.addTree(x, z, trees.next() < 0.15 ? 'maple_leaves' : 'leaves');
      }
      for (let i = 0; i < 9; i++) {
        const x = -22 + randRange(trees, -6, 6);
        const z = -19 + randRange(trees, -6, 6);
        const g = gravestone();
        g.rotation.y = Math.PI / 4 + randRange(trees, -0.3, 0.3);
        this.place(g, Math.floor(x) + 0.5, Math.floor(z) + 0.5);
      }
      for (const [id, count, [cx, cz], r] of FIELD_SPAWNS) {
        for (let i = 0; i < count; i++) this.spawnMonster(MONSTER_DB.get(id)!, new THREE.Vector3(cx, 0, cz), r);
      }
      this.player.pos.set(0.5, this.groundY(0.5, 1.5), 1.5);
    } else {
      this.scene.background = skyTexture('#f0a860', '#ffe4b8');
      this.scene.fog = new THREE.Fog(0xffe4b8, 45, 90);
      const rng = new SeededRng(3);
      this.terrain = new Terrain(size, (x, z) => {
        const edge = Math.max(Math.abs(x), Math.abs(z)) > half - 1;
        if (edge) return { height: 3, top: 'leaves', under: 'leaves', blocked: true };
        if (Math.abs(x) < 1.1 && z > 2) return { height: 1, top: 'path', under: 'dirt' };
        if (x > 4 && x < 10 && z > -2 && z < 4) return { height: 1, top: rng.next() < 0.5 ? 'dirt' : 'hay', under: 'dirt' };
        const r = rng.next();
        return { height: 1, top: 'grass_top', under: 'dirt', plant: r < 0.08 ? 'tallgrass' : r < 0.1 ? 'flower_red' : r < 0.12 ? 'flower_yellow' : undefined };
      });
      // 房子與設施位置不長草
      for (let x = -5; x <= 5; x++) for (let z = -9; z <= 6; z++) {
        const c = this.terrain.columnAt(x, z);
        if (c) c.plant = undefined;
      }
      this.zoneRoot.add(this.terrain.build());
      const house = houseMesh();
      this.place(house, 0.5, -4.5);
      this.occluders.push(house);
      for (let x = -4; x <= 4; x++) for (let z = -8; z <= -1; z++) {
        const c = this.terrain.columnAt(x, z);
        if (c) c.blocked = true;
      }
      this.buildStations();
      this.buildNodes();
      this.addPortal('field', 0.5, 15);
      const fence: [number, number][] = [];
      for (let x = -17; x <= 17; x++) if (Math.abs(x) > 1) fence.push([x + 0.5, 17.5]);
      this.zoneRoot.add(fenceMesh(fence.slice(0, 16), (x, z) => this.groundY(x, z)));
      this.zoneRoot.add(fenceMesh(fence.slice(16), (x, z) => this.groundY(x, z)));
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2;
        this.addTree(Math.cos(a) * 17.5, Math.sin(a) * 17.5 - 0.5, i % 3 === 0 ? 'maple_leaves' : 'leaves');
      }
      this.player.pos.set(0.5, this.groundY(0.5, 12.5), 12.5);
    }
    this.addClouds(size);
    this.camTarget.copy(this.player.pos);
    this.ev.zoneChanged(zone);
    this.ev.changed();
  }

  private buildStations(): void {
    const defs: [StationId, number, number][] = [
      ['smelter', -6, 3],
      ['workbench', -3, 4],
      ['anvil', 3, 4],
      ['alchemy', 6, 3],
    ];
    for (const [id, x, z] of defs) {
      const mesh = stationMesh(id);
      this.place(mesh, x, z);
      const st: StationRt = { id, group: mesh, pos: new THREE.Vector3(x + 0.5, this.groundY(x, z), z) };
      this.tagPick(mesh, { type: 'station', ref: st });
      this.stations.push(st);
    }
  }

  buildNodes(): void {
    for (const n of this.nodes) {
      this.zoneRoot.remove(n.group);
      const i = this.occluders.indexOf(n.group);
      if (i >= 0) this.occluders.splice(i, 1);
    }
    this.nodes = [];
    this.state.homestead.data.nodes.forEach((ns, i) => {
      const def = NODE_DB.get(ns.defId)!;
      const [x, z] = HOMESTEAD_NODE_SLOTS[i % HOMESTEAD_NODE_SLOTS.length];
      const g = new THREE.Group();
      this.place(g, x + 0.5, z + 0.5);
      const rt: NodeRt = { state: ns, def, group: g, pos: g.position.clone() };
      this.nodes.push(rt);
      if (def.kind === 'tree') this.occluders.push(g);
      const col = this.terrain.columnAt(x + 0.5, z + 0.5);
      if (col) col.blocked = true;
      this.updateNodeVisual(rt);
    });
  }

  private updateNodeVisual(n: NodeRt): void {
    refreshNode(n.state, n.def, Date.now());
    const depleted = n.state.depletedAt !== undefined;
    if (depleted === n.depletedVisual) return;
    n.depletedVisual = depleted;
    n.group.clear();
    const mesh = n.def.kind === 'tree'
      ? treeMesh(n.def.id === 'maple_tree' ? 'maple_leaves' : 'leaves', 4, depleted)
      : oreMesh(ORE_TILE[n.def.id] ?? 'coal_ore', depleted);
    n.group.add(mesh);
    this.tagPick(n.group, { type: 'node', ref: n });
  }

  private spawnMonster(def: MonsterDef, center: THREE.Vector3, radius: number): void {
    const m: MonsterRt = {
      ...this.makeActor(monsterRig(def)), def, hp: def.hp, spawnCenter: center.clone(), spawnRadius: radius, chasing: false, dead: false,
      respawnAt: 0, nextAttack: 0, nextWander: 0, lastHitAt: -99,
    };
    this.placeRandom(m);
    this.tagPick(m.rig.root, { type: 'monster', ref: m });
    this.zoneRoot.add(m.rig.root);
    this.monsters.push(m);
  }

  private placeRandom(m: MonsterRt): void {
    for (let tries = 0; tries < 20; tries++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * m.spawnRadius;
      const x = m.spawnCenter.x + Math.cos(a) * r;
      const z = m.spawnCenter.z + Math.sin(a) * r;
      if (!this.terrain.walkable(x, z)) continue;
      m.pos.set(x, this.groundY(x, z), z);
      m.targetYaw = Math.random() * Math.PI * 2;
      return;
    }
    m.pos.set(m.spawnCenter.x, this.groundY(m.spawnCenter.x, m.spawnCenter.z), m.spawnCenter.z);
  }

  // ------------------------------------------------------------ 輸入

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
      if (p.type === 'monster' && p.ref.dead) continue;
      return p;
    }
    return undefined;
  }

  hover(clientX: number, clientY: number): Pick | undefined {
    this.hovered = this.pickAt(clientX, clientY);
    return this.hovered;
  }

  click(clientX: number, clientY: number): void {
    const p = this.pickAt(clientX, clientY);
    if (p) {
      switch (p.type) {
        case 'monster': this.intent = { kind: 'attack', m: p.ref }; return;
        case 'item': this.intent = { kind: 'pickup', gi: p.ref }; return;
        case 'node': this.intent = { kind: 'gather', node: p.ref }; return;
        case 'station': this.intent = { kind: 'station', st: p.ref }; return;
        case 'npc': this.intent = { kind: 'npc', npc: p.ref }; return;
      }
    }
    this.raycaster.setFromCamera(this.ndc(clientX, clientY), this.camera);
    const hit = this.raycaster.intersectObject(this.terrain.mesh, false)[0];
    if (!hit) return;
    const pt = hit.point;
    const half = ZONE_SIZE[this.zone] / 2 - 1.5;
    pt.x = Math.max(-half, Math.min(half, pt.x));
    pt.z = Math.max(-half, Math.min(half, pt.z));
    this.intent = { kind: 'move', pos: pt.clone() };
    this.clickMarker.position.set(pt.x, this.groundY(pt.x, pt.z) + 0.03, pt.z);
    this.clickMarker.visible = true;
  }

  pickupNearest(): void {
    let best: GroundItemRt | undefined;
    let bd = 6;
    for (const gi of this.items) {
      const d = gi.pos.distanceTo(this.player.pos);
      if (d < bd) {
        bd = d;
        best = gi;
      }
    }
    if (best) this.intent = { kind: 'pickup', gi: best };
  }

  attackNearest(): void {
    let best: MonsterRt | undefined;
    let bd = 12;
    for (const m of this.monsters) {
      if (m.dead) continue;
      const d = m.pos.distanceTo(this.player.pos);
      if (d < bd) {
        bd = d;
        best = m;
      }
    }
    if (best) this.intent = { kind: 'attack', m: best };
  }

  // ------------------------------------------------------------ 更新

  private get playerRange(): number {
    const cls = this.state.player.data.classId;
    return cls === 'archer' || cls === 'mage' ? RANGED_RANGE : MELEE_RANGE;
  }

  /** 朝目標移動；遇到水或障礙物會停下。回傳是否已抵達 */
  private moveToward(a: Actor, target: THREE.Vector3, speed: number, dt: number, stopAt: number): boolean {
    const dx = target.x - a.pos.x;
    const dz = target.z - a.pos.z;
    const d = Math.hypot(dx, dz);
    if (d <= stopAt) return true;
    const step = Math.min(speed * dt, d - stopAt);
    let nx = a.pos.x + (dx / d) * step;
    let nz = a.pos.z + (dz / d) * step;
    // 簡單的沿牆滑動
    if (!this.terrain.walkable(nx, nz)) {
      if (this.terrain.walkable(nx, a.pos.z)) nz = a.pos.z;
      else if (this.terrain.walkable(a.pos.x, nz)) nx = a.pos.x;
      else return true;
    }
    // 一次最多爬一格
    if (this.groundY(nx, nz) - a.pos.y > 1.2) return true;
    a.pos.x = nx;
    a.pos.z = nz;
    a.targetYaw = Math.atan2(dx, dz);
    a.moving = true;
    return d - step <= stopAt + 1e-3;
  }

  private faceToward(a: Actor, p: THREE.Vector3): void {
    a.targetYaw = Math.atan2(p.x - a.pos.x, p.z - a.pos.z);
  }

  update(dt: number): void {
    this.time += dt;
    const ch = this.state.player;
    const d = ch.derived();
    const speed = 4.3 + d.totalStats.agi * 0.01;
    const intent = this.intent;
    this.player.moving = false;
    for (const m of this.monsters) m.moving = false;

    if (intent) {
      switch (intent.kind) {
        case 'move':
          if (this.moveToward(this.player, intent.pos, speed, dt, 0.05)) {
            this.intent = undefined;
            this.clickMarker.visible = false;
          }
          break;
        case 'attack': {
          const m = intent.m;
          if (m.dead) {
            this.intent = undefined;
            break;
          }
          if (this.moveToward(this.player, m.pos, speed, dt, this.playerRange)) {
            this.faceToward(this.player, m.pos);
            if (this.time >= this.nextPlayerAttack) {
              this.nextPlayerAttack = this.time + 1 / d.attacksPerSec;
              this.player.attackT = 0.001;
              this.playerAttack(m);
            }
          }
          break;
        }
        case 'pickup':
          if (!this.items.includes(intent.gi)) {
            this.intent = undefined;
            break;
          }
          if (this.moveToward(this.player, intent.gi.pos, speed, dt, 0.8)) {
            this.pickup(intent.gi);
            this.intent = undefined;
          }
          break;
        case 'gather':
          if (this.moveToward(this.player, intent.node.pos, speed, dt, 1.8)) {
            this.faceToward(this.player, intent.node.pos);
            if (this.time >= this.nextGather) {
              this.nextGather = this.time + 1.1;
              this.player.attackT = 0.001;
              if (!this.doGather(intent.node)) this.intent = undefined;
            }
          }
          break;
        case 'station':
          if (this.moveToward(this.player, intent.st.pos, speed, dt, INTERACT_RANGE)) {
            this.intent = undefined;
            this.ev.openStation(intent.st.id);
          }
          break;
        case 'npc':
          if (this.moveToward(this.player, intent.npc.pos, speed, dt, INTERACT_RANGE)) {
            this.intent = undefined;
            intent.npc.targetYaw = Math.atan2(this.player.pos.x - intent.npc.pos.x, this.player.pos.z - intent.npc.pos.z);
            this.ev.openNpc(intent.npc.id);
          }
          break;
      }
    }

    for (const p of this.portals) {
      (p.pane.material as THREE.MeshBasicMaterial).opacity = 0.65 + Math.sin(this.time * 3) * 0.15;
      if (Math.hypot(p.pos.x - this.player.pos.x, p.pos.z - this.player.pos.z) < 1.1 && (!this.intent || this.intent.kind === 'move')) {
        this.ev.log(p.to === 'homestead' ? '進入了你的家園。' : '回到了晨曦平原。', '#c99aff');
        this.loadZone(p.to);
        return;
      }
    }

    this.updateMonsters(dt);
    this.updateItems();
    for (const c of this.clouds) {
      c.position.x += dt * 0.6;
      if (c.position.x > ZONE_SIZE[this.zone]) c.position.x = -ZONE_SIZE[this.zone];
    }
    if (this.zone === 'homestead' && Math.floor(this.time) !== Math.floor(this.time - dt)) for (const n of this.nodes) this.updateNodeVisual(n);

    // 自然回復（脫離戰鬥 4 秒後加速，RO 的坐下回復概念）
    if (this.time >= this.nextRegen) {
      this.nextRegen = this.time + 2;
      const outOfCombat = this.time - this.lastCombatAt > 4;
      const hpRegen = Math.max(1, Math.floor(d.maxHp * (outOfCombat ? 0.03 : 0.005) + d.totalStats.vit / 5));
      const spRegen = Math.max(1, Math.floor(d.maxSp * (outOfCombat ? 0.03 : 0.01)));
      if (!ch.isOverweight() && (ch.data.hp < d.maxHp || ch.data.sp < d.maxSp)) {
        ch.data.hp = Math.min(d.maxHp, ch.data.hp + hpRegen);
        ch.data.sp = Math.min(d.maxSp, ch.data.sp + spRegen);
        this.ev.changed();
      }
    }

    this.syncActors(dt);
    this.updateCamera(dt);
    this.fadeOccluders();
  }

  /** 從相機往玩家身上幾個點打射線，擋住視線的樹 / 房子改成半透明 */
  private fadeOccluders(): void {
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
      const target = this.player.pos.clone().add(new THREE.Vector3(0, dy, 0));
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
        // 共用材質不能直接改，淡出時換成此物件專用的複本
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

  private playerAttack(m: MonsterRt): void {
    const ch = this.state.player;
    const d = ch.derived();
    const atk = ch.data.classId === 'mage' ? Math.max(d.atk, d.matk) : d.atk;
    const res = resolveAttack({ atk, def: d.def, hit: d.hit, flee: d.flee, critPct: d.critPct }, m.def, mathRng);
    this.lastCombatAt = this.time;
    m.lastHitAt = this.time;
    m.chasing = true;
    const head = m.pos.clone().setY(m.pos.y + m.rig.height + 0.3);
    if (res.kind === 'miss') {
      this.ev.floatText(head, 'Miss', '#cccccc');
      return;
    }
    m.hp -= res.damage;
    this.flash(m);
    this.ev.floatText(head, String(res.damage), res.kind === 'crit' ? '#ffd24a' : '#ffffff', res.kind === 'crit');
    if (m.hp <= 0) this.killMonster(m);
  }

  /** 受擊時變紅（Minecraft 的受傷閃爍） */
  private flash(a: Actor): void {
    const mats: THREE.MeshLambertMaterial[] = [];
    a.rig.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const arr = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of arr) if ((m as THREE.MeshLambertMaterial).emissive) mats.push(m as THREE.MeshLambertMaterial);
    });
    const uniq = [...new Set(mats)];
    uniq.forEach((m) => m.emissive.setRGB(0.6, 0, 0));
    setTimeout(() => uniq.forEach((m) => m.emissive.setRGB(0, 0, 0)), 150);
  }

  private killMonster(m: MonsterRt): void {
    const ch = this.state.player;
    m.dead = true;
    m.hp = 0;
    m.rig.root.visible = false;
    m.respawnAt = this.time + m.def.respawnSec;
    if (this.intent?.kind === 'attack' && this.intent.m === m) this.intent = undefined;
    this.poof(m.pos);

    const mod = expLevelModifier(ch.progression.baseLevel, m.def.level);
    const baseExp = Math.floor(m.def.baseExp * mod);
    const jobExp = Math.floor(m.def.jobExp * mod);
    const lv = addExp(ch.progression, baseExp, jobExp);
    this.ev.log(`擊敗 ${m.def.name}，獲得 Base EXP ${baseExp}、Job EXP ${jobExp}`, '#bcd');
    if (lv.baseLevelsGained) {
      const d = ch.derived();
      ch.data.hp = d.maxHp;
      ch.data.sp = d.maxSp;
      this.ev.announce(`等級提升！Base Lv ${ch.progression.baseLevel}`, '#ffe680');
      this.ev.floatText(this.player.pos.clone().setY(this.player.pos.y + 2.4), 'LEVEL UP!', '#ffe680', true);
    }
    if (lv.jobLevelsGained) this.ev.log(`Job Lv 提升至 ${ch.progression.jobLevel}${ch.canChangeJob() ? '（可以轉職了！按 S 開啟角色視窗）' : ''}`, '#ffe680');

    const d = ch.derived();
    const drops = rollDrops(
      m.def.drops, ITEM_DB, POOL_DB,
      {
        playerLevel: ch.progression.baseLevel,
        sourceLevel: m.def.level,
        luk: d.totalStats.luk,
        personalBonusPct: d.dropBonusPct,
        eventMultiplier: 1,
        isMvpWinner: m.def.mvp, // 單機版：擊殺者即為 MVP；上線版以總傷害排名決定
        pityCounters: this.state.pity,
      },
      mathRng,
    );
    if (m.def.mvp) this.ev.announce(`MVP！你擊敗了 ${m.def.name}！`, '#ff9f1a');
    for (const drop of drops) {
      const item = createItem(ITEM_DB, this.state.uids, drop.itemId, drop.qty, { kind: 'drop', sourceId: m.def.id, at: Date.now() });
      const def = getDef(ITEM_DB, drop.itemId);
      if (drop.rarity >= Rarity.Epic) {
        this.ev.announce(`【全服公告】${ch.name} 從 ${m.def.name} 身上獲得了 ${def.name}！`, RARITY_INFO[def.rarity].color);
      }
      if (drop.category === 'mvp' && ch.inventory.add(item)) this.ev.log(`MVP 獎勵：${def.name} x${drop.qty}`, RARITY_INFO[def.rarity].color);
      else this.dropOnGround(item, m.pos);
    }
    this.ev.changed();
  }

  /** 怪物死亡的煙霧粒子 */
  private poof(at: THREE.Vector3): void {
    const parts: THREE.Mesh[] = [];
    const mat = new THREE.MeshBasicMaterial({ color: 0xeeeeee, transparent: true, opacity: 0.9 });
    for (let i = 0; i < 10; i++) {
      const p = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.15, 0.15), mat);
      p.position.copy(at).add(new THREE.Vector3(randRange(mathRng, -0.5, 0.5), randRange(mathRng, 0.2, 1.2), randRange(mathRng, -0.5, 0.5)));
      p.userData.v = new THREE.Vector3(randRange(mathRng, -0.6, 0.6), randRange(mathRng, 0.5, 1.5), randRange(mathRng, -0.6, 0.6));
      this.zoneRoot.add(p);
      parts.push(p);
    }
    const start = performance.now();
    const tick = () => {
      const t = (performance.now() - start) / 700;
      for (const p of parts) p.position.addScaledVector(p.userData.v as THREE.Vector3, 0.016);
      mat.opacity = 0.9 * (1 - t);
      if (t < 1) requestAnimationFrame(tick);
      else parts.forEach((p) => this.zoneRoot.remove(p));
    };
    tick();
  }

  private dropOnGround(item: ItemInstance, at: THREE.Vector3): void {
    const def = getDef(ITEM_DB, item.defId);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: groundItemTexture(def), alphaTest: 0.1, transparent: true }));
    sprite.center.set(0.5, 0.2);
    sprite.scale.set(0.7, 0.7, 1);
    let x = at.x + randRange(mathRng, -1, 1);
    let z = at.z + randRange(mathRng, -1, 1);
    if (!this.terrain.walkable(x, z)) {
      x = at.x;
      z = at.z;
    }
    const pos = new THREE.Vector3(x, this.groundY(x, z), z);
    sprite.position.copy(pos);
    const gi: GroundItemRt = { item, sprite, pos, expireAt: this.time + 120 };
    sprite.userData.pick = { type: 'item', ref: gi } satisfies Pick;
    this.zoneRoot.add(sprite);
    this.items.push(gi);
  }

  private pickup(gi: GroundItemRt): void {
    const ch = this.state.player;
    const def = getDef(ITEM_DB, gi.item.defId);
    if (ch.inventory.totalWeight() + def.weight * gi.item.qty > ch.derived().maxWeight) {
      this.ev.log('負重已滿，無法撿取。', '#f66');
      return;
    }
    if (!ch.inventory.add(gi.item)) {
      this.ev.log('背包已滿。', '#f66');
      return;
    }
    this.zoneRoot.remove(gi.sprite);
    this.items.splice(this.items.indexOf(gi), 1);
    this.ev.log(`獲得 ${def.name} x${gi.item.qty}`, RARITY_INFO[def.rarity].color);
    this.ev.changed();
  }

  private doGather(node: NodeRt): boolean {
    const res = gather(this.state.player, node.state, node.def, ITEM_DB, this.state.uids, mathRng, Date.now());
    if (!res.ok) {
      this.ev.log(res.reason!, '#f99');
      return false;
    }
    const head = node.pos.clone().setY(node.pos.y + (node.def.kind === 'tree' ? 3 : 1.8));
    res.items.forEach((it, i) => {
      const def = getDef(ITEM_DB, it.defId);
      setTimeout(() => this.ev.floatText(head, `+${it.qty} ${def.name}`, RARITY_INFO[def.rarity].color), i * 180);
      if (def.rarity >= Rarity.Rare) this.ev.log(`採集到稀有物品：${def.name}！`, RARITY_INFO[def.rarity].color);
      if (def.rarity >= Rarity.Epic) this.ev.announce(`【全服公告】${this.state.player.name} 在家園採集到了 ${def.name}！`, RARITY_INFO[def.rarity].color);
    });
    if (res.levelUps) {
      const skill = node.def.kind === 'ore' ? '採礦' : '伐木';
      this.ev.announce(`${skill}等級提升！Lv ${this.state.player.data.lifeSkills[node.def.kind === 'ore' ? 'mining' : 'woodcutting'].level}`, '#9fffb0');
    }
    this.chips(node);
    this.updateNodeVisual(node);
    this.ev.changed();
    return !res.depleted;
  }

  /** 敲擊時噴出的方塊碎屑 */
  private chips(node: NodeRt): void {
    const color = node.def.kind === 'tree' ? 0x7a5a36 : new THREE.Color(node.def.color).getHex();
    const mat = new THREE.MeshLambertMaterial({ color });
    const parts: THREE.Mesh[] = [];
    for (let i = 0; i < 6; i++) {
      const p = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), mat);
      p.position.copy(node.pos).add(new THREE.Vector3(0, node.def.kind === 'tree' ? 1.2 : 0.7, 0));
      p.userData.v = new THREE.Vector3(randRange(mathRng, -2, 2), randRange(mathRng, 2, 4), randRange(mathRng, -2, 2));
      this.zoneRoot.add(p);
      parts.push(p);
    }
    const start = performance.now();
    const tick = () => {
      const t = (performance.now() - start) / 600;
      for (const p of parts) {
        const v = p.userData.v as THREE.Vector3;
        v.y -= 0.25;
        p.position.addScaledVector(v, 0.016);
      }
      if (t < 1) requestAnimationFrame(tick);
      else parts.forEach((p) => this.zoneRoot.remove(p));
    };
    tick();
  }

  private updateMonsters(dt: number): void {
    const ch = this.state.player;
    const pd = ch.derived();
    for (const m of this.monsters) {
      if (m.dead) {
        if (this.time >= m.respawnAt) {
          m.dead = false;
          m.hp = m.def.hp;
          m.chasing = false;
          this.placeRandom(m);
          m.rig.root.visible = true;
          if (m.def.mvp) this.ev.announce(`${m.def.name} 出現在晨曦平原的東南方！`, '#ff6b6b');
        }
        continue;
      }
      const dist = m.pos.distanceTo(this.player.pos);
      if (!m.chasing && m.def.aggressive && dist < 5) m.chasing = true;
      // 追太遠就放棄並回血（防止拉怪）
      if (m.chasing && (dist > 16 || m.pos.distanceTo(m.spawnCenter) > m.spawnRadius + 14)) {
        m.chasing = false;
        m.hp = m.def.hp;
        m.wander = m.spawnCenter.clone();
      }
      if (m.chasing) {
        if (this.moveToward(m, this.player.pos, m.def.speed * 1.3, dt, 1.2)) {
          this.faceToward(m, this.player.pos);
          if (this.time >= m.nextAttack) {
            m.nextAttack = this.time + 1 / m.def.attacksPerSec;
            m.attackT = 0.001;
            const res = resolveAttack({ ...m.def, critPct: 1 }, pd, mathRng);
            this.lastCombatAt = this.time;
            const head = this.player.pos.clone().setY(this.player.pos.y + 2.2);
            if (res.kind === 'miss') this.ev.floatText(head, 'Miss', '#9fd');
            else {
              ch.data.hp -= res.damage;
              this.flash(this.player);
              this.ev.floatText(head, String(res.damage), '#ff5a5a');
              if (!this.intent) this.intent = { kind: 'attack', m }; // 被打會自動反擊
              if (ch.data.hp <= 0) this.playerDied(m);
            }
            this.ev.changed();
          }
        }
      } else {
        if (this.time >= m.nextWander) {
          m.nextWander = this.time + randRange(mathRng, 2, 6);
          const a = Math.random() * Math.PI * 2;
          const r = Math.random() * m.spawnRadius;
          m.wander = new THREE.Vector3(m.spawnCenter.x + Math.cos(a) * r, 0, m.spawnCenter.z + Math.sin(a) * r);
        }
        if (m.wander && this.moveToward(m, m.wander, m.def.speed * 0.5, dt, 0.1)) m.wander = undefined;
      }
    }
  }

  private playerDied(killer: MonsterRt): void {
    const ch = this.state.player;
    const lost = applyDeathPenalty(ch.progression);
    this.ev.announce(`你被 ${killer.def.name} 擊倒了…（失去 ${lost} 經驗值）`, '#ff6b6b');
    ch.data.hp = ch.derived().maxHp;
    for (const m of this.monsters) m.chasing = false;
    this.intent = undefined;
    this.loadZone('field');
  }

  private updateItems(): void {
    for (const gi of [...this.items]) {
      gi.sprite.position.y = gi.pos.y + 0.1 + Math.sin(this.time * 3 + gi.pos.x) * 0.08;
      if (this.time > gi.expireAt) {
        this.zoneRoot.remove(gi.sprite);
        this.items.splice(this.items.indexOf(gi), 1);
      }
    }
  }

  private syncActor(a: Actor, dt: number): void {
    const gy = this.groundY(a.pos.x, a.pos.z);
    a.pos.y += (gy - a.pos.y) * Math.min(1, dt * 14);
    a.rig.root.position.copy(a.pos);
    // 平滑轉向
    let dy = a.targetYaw - a.rig.yaw.rotation.y;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    a.rig.yaw.rotation.y += dy * Math.min(1, dt * 12);
    if (a.moving) a.animT += dt;
    else a.animT += dt * 0.3;
    if (a.attackT > 0) {
      a.attackT += dt * 3.5;
      if (a.attackT >= 1) a.attackT = 0;
    }
    animateRig(a.rig, a.moving ? a.animT : this.time, a.moving, a.attackT);
  }

  private syncActors(dt: number): void {
    this.syncActor(this.player, dt);
    for (const m of this.monsters) if (!m.dead) this.syncActor(m, dt);
    for (const n of this.npcs) this.syncActor(n, dt);
  }

  private updateCamera(dt: number): void {
    this.camTarget.lerp(this.player.pos, Math.min(1, dt * 8));
    const pitch = THREE.MathUtils.degToRad(48);
    const off = new THREE.Vector3(
      Math.sin(this.camYaw) * Math.cos(pitch) * this.camDist,
      Math.sin(pitch) * this.camDist,
      Math.cos(this.camYaw) * Math.cos(pitch) * this.camDist,
    );
    this.camera.position.copy(this.camTarget).add(off);
    this.camera.lookAt(this.camTarget.x, this.camTarget.y + 0.9, this.camTarget.z);
    // 陰影相機跟著玩家
    this.sun.position.copy(this.camTarget).add(new THREE.Vector3(-18, 34, 12));
    this.sun.target.position.copy(this.camTarget);
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  // ------------------------------------------------------------ 給 HUD 用的查詢

  toScreen(p: THREE.Vector3): { x: number; y: number; visible: boolean } {
    const v = p.clone().project(this.camera);
    const r = this.renderer.domElement.getBoundingClientRect();
    return { x: ((v.x + 1) / 2) * r.width, y: ((1 - v.y) / 2) * r.height, visible: v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1 };
  }

  labelsToDraw(): { pos: THREE.Vector3; text: string; color: string; hp?: number; kind: 'monster' | 'item' | 'npc' | 'player' | 'node' | 'station' }[] {
    const out: ReturnType<World['labelsToDraw']> = [];
    const above = (a: Actor, extra = 0.35) => a.pos.clone().setY(a.pos.y + a.rig.height + extra);
    out.push({ pos: above(this.player), text: this.state.player.name, color: '#fff', kind: 'player' });
    for (const m of this.monsters) {
      if (m.dead) continue;
      const hovered = this.hovered?.type === 'monster' && this.hovered.ref === m;
      const targeted = this.intent?.kind === 'attack' && this.intent.m === m;
      if (hovered || targeted || m.def.mvp || this.time - m.lastHitAt < 5) {
        out.push({
          pos: above(m, m.def.mvp ? 0.8 : 0.35),
          text: `${m.def.mvp ? '【MVP】' : ''}${m.def.name} Lv${m.def.level}`,
          color: m.def.mvp ? '#ff9f1a' : m.def.aggressive ? '#ff9a9a' : '#fff',
          hp: m.hp / m.def.hp,
          kind: 'monster',
        });
      }
    }
    for (const gi of this.items) {
      const def = getDef(ITEM_DB, gi.item.defId);
      out.push({ pos: gi.pos.clone().setY(gi.pos.y + 0.8), text: `${def.name}${gi.item.qty > 1 ? ` x${gi.item.qty}` : ''}`, color: RARITY_INFO[def.rarity].color, kind: 'item' });
    }
    for (const n of this.npcs) out.push({ pos: above(n), text: n.name, color: '#9fe0ff', kind: 'npc' });
    for (const s of this.stations) out.push({ pos: s.pos.clone().setY(s.pos.y + 1.7), text: `${STATION_NAMES[s.id]} Lv${this.state.homestead.buildingLevel(s.id)}`, color: '#ffe0a0', kind: 'station' });
    if (this.hovered?.type === 'node') {
      const n = this.hovered.ref;
      const depleted = n.state.depletedAt !== undefined;
      out.push({
        pos: n.pos.clone().setY(n.pos.y + (n.def.kind === 'tree' && !depleted ? 6.8 : 1.8)),
        text: `${n.def.name}${depleted ? '（枯竭中）' : ` ${n.state.hitsLeft}/${n.def.hits}`}`,
        color: depleted ? '#999' : '#b0ffb0',
        kind: 'node',
      });
    }
    for (const p of this.portals) out.push({ pos: p.pos.clone().setY(p.pos.y + 5.6), text: p.to === 'homestead' ? '▶ 我的家園' : '▶ 晨曦平原', color: '#d9b0ff', kind: 'npc' });
    return out;
  }

  /** 小地圖用：地形每格的代表色（換地圖時才重算） */
  minimapBase(): { size: number; colors: string[]; zone: ZoneId } {
    const TILE_COLOR: Partial<Record<TileName, string>> = {
      grass_top: '#5f9a3a', path: '#a88a58', cobble: '#8a8a8a', sand: '#d8cb96', gravel: '#857f7a', stone: '#7d7d7d',
      darkstone: '#3a2f4a', stone_brick: '#4a4a4a', dirt: '#7a5234', hay: '#c8a440', leaves: '#2f6a20',
    };
    return {
      size: this.terrain.size,
      zone: this.zone,
      colors: this.terrain.cols.map((c) => (c.water ? '#3a6fd8' : c.blocked && c.top === 'grass_top' ? '#2f6a20' : TILE_COLOR[c.top] ?? '#5f9a3a')),
    };
  }

  /** 小地圖用：動態標記（世界座標） */
  minimapMarkers(): { x: number; z: number; kind: 'player' | 'monster' | 'mvp' | 'npc' | 'portal' | 'station' | 'node' }[] {
    const out: ReturnType<World['minimapMarkers']> = [];
    for (const m of this.monsters) if (!m.dead) out.push({ x: m.pos.x, z: m.pos.z, kind: m.def.mvp ? 'mvp' : 'monster' });
    for (const n of this.npcs) out.push({ x: n.pos.x, z: n.pos.z, kind: 'npc' });
    for (const p of this.portals) out.push({ x: p.pos.x, z: p.pos.z, kind: 'portal' });
    for (const s of this.stations) out.push({ x: s.pos.x, z: s.pos.z, kind: 'station' });
    for (const n of this.nodes) if (n.state.depletedAt === undefined) out.push({ x: n.pos.x, z: n.pos.z, kind: 'node' });
    out.push({ x: this.player.pos.x, z: this.player.pos.z, kind: 'player' });
    return out;
  }

  get playerYaw(): number {
    return this.player.rig.yaw.rotation.y;
  }

  get cameraYaw(): number {
    return this.camYaw;
  }

  playerScreenPos(): { x: number; y: number } {
    return this.toScreen(this.player.pos.clone().setY(this.player.pos.y + 2));
  }
}
