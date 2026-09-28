import * as THREE from 'three';
import { resolveAttack } from '../core/combat';
import { rollDrops } from '../core/drops';
import { gather, refreshNode, type NodeState, type ResourceNodeDef, type StationId } from '../core/homestead';
import { createItem, getDef } from '../core/items';
import { addExp, applyDeathPenalty, expLevelModifier } from '../core/leveling';
import { mathRng, randRange } from '../core/rng';
import { Rarity, RARITY_INFO, type ItemInstance } from '../core/types';
import { ITEM_DB, MONSTER_DB, NODE_DB, POOL_DB, STATION_NAMES } from '../data';
import type { MonsterDef } from '../data/monsters';
import { groundItemTexture, monsterTextures, npcTextures, playerTextures, type FacingTextures } from './sprites';
import type { GameState } from './state';

export type ZoneId = 'field' | 'homestead';
export type NpcId = 'shop' | 'market' | 'guide';

interface Actor {
  sprite: THREE.Sprite;
  shadow: THREE.Mesh;
  tex: FacingTextures;
  pos: THREE.Vector3;
  height: number;
  facing: 'left' | 'right';
  bob: number;
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
  depletedVisual: boolean;
}

interface StationRt {
  id: StationId;
  group: THREE.Group;
  pos: THREE.Vector3;
}

interface NpcRt extends Actor {
  id: NpcId;
  name: string;
}

interface PortalRt {
  to: ZoneId;
  pos: THREE.Vector3;
  mesh: THREE.Mesh;
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
const INTERACT_RANGE = 2.2;

/** 野外怪物分布：怪物 id、數量、中心點、半徑 */
const FIELD_SPAWNS: [string, number, [number, number], number][] = [
  ['jelly_slime', 10, [6, 6], 9],
  ['hop_shroom', 8, [-8, 10], 8],
  ['grey_wolf', 7, [22, -2], 8],
  ['goblin', 7, [0, -22], 9],
  ['skeleton', 6, [-22, -18], 8],
  ['rock_golem', 4, [-22, 22], 7],
  ['bone_lich', 1, [24, 24], 3],
];

const HOMESTEAD_NODE_SLOTS: [number, number][] = [
  [-12, -8], [-15, -2], [-10, 3], [10, -10], [14, -6], [-14, 10], [-8, 13], [12, 8], [16, 12], [6, 14], [-4, -14], [2, -15],
];

export class World {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  zone: ZoneId = 'field';

  private zoneRoot = new THREE.Group();
  private player!: Actor;
  private monsters: MonsterRt[] = [];
  private items: GroundItemRt[] = [];
  private nodes: NodeRt[] = [];
  private stations: StationRt[] = [];
  private npcs: NpcRt[] = [];
  private portals: PortalRt[] = [];
  /** 會擋住視線的裝飾物（樹、房子），站在後面時半透明 */
  private occluders: THREE.Object3D[] = [];
  private intent?: Intent;
  private nextPlayerAttack = 0;
  private nextGather = 0;
  private nextRegen = 0;
  private lastCombatAt = -99;
  private time = 0;
  private camYaw = Math.PI / 4;
  private camDist = 26;
  private camTarget = new THREE.Vector3();
  private raycaster = new THREE.Raycaster();
  private groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private clickMarker: THREE.Mesh;
  hovered?: Pick;

  constructor(
    private readonly container: HTMLElement,
    private readonly state: GameState,
    private readonly ev: WorldEvents,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);
    this.camera = new THREE.PerspectiveCamera(32, 1, 0.5, 300);
    this.scene.add(new THREE.HemisphereLight(0xfff4e0, 0x5a6b3a, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(-20, 40, 10);
    this.scene.add(sun);
    this.scene.add(this.zoneRoot);

    this.clickMarker = new THREE.Mesh(
      new THREE.RingGeometry(0.25, 0.4, 24),
      new THREE.MeshBasicMaterial({ color: 0xffe680, transparent: true, opacity: 0.9, side: THREE.DoubleSide }),
    );
    this.clickMarker.rotation.x = -Math.PI / 2;
    this.clickMarker.visible = false;
    this.scene.add(this.clickMarker);

    this.player = this.makeActor(playerTextures(state.player.data.classId), 1.9);
    this.scene.add(this.player.sprite, this.player.shadow);
    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.loadZone('field');
  }

  // ------------------------------------------------------------ 建構

  private makeActor(tex: FacingTextures, height: number): Actor {
    const mat = new THREE.SpriteMaterial({ map: tex.right, alphaTest: 0.4, transparent: true });
    const sprite = new THREE.Sprite(mat);
    sprite.center.set(0.5, 0);
    sprite.scale.set(height * tex.aspect, height, 1);
    const shadow = new THREE.Mesh(
      new THREE.CircleGeometry(height * tex.aspect * 0.35, 20),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28, depthWrite: false }),
    );
    shadow.rotation.x = -Math.PI / 2;
    return { sprite, shadow, tex, pos: new THREE.Vector3(), height, facing: 'right', bob: Math.random() * 10 };
  }

  refreshPlayerLook(): void {
    this.player.tex = playerTextures(this.state.player.data.classId);
    (this.player.sprite.material as THREE.SpriteMaterial).map = this.player.tex.right;
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
    this.intent = undefined;
  }

  private buildGround(size: number, colors: [number, number, number]): void {
    const seg = size;
    const geo = new THREE.PlaneGeometry(size, size, seg, seg);
    geo.rotateX(-Math.PI / 2);
    const col: number[] = [];
    const c = new THREE.Color();
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const n = Math.sin(x * 0.35) * Math.cos(z * 0.3) + Math.sin((x + z) * 0.13) * 0.8 + (Math.random() - 0.5) * 0.25;
      c.setHex(n > 0.6 ? colors[1] : n < -0.7 ? colors[2] : colors[0]);
      col.push(c.r, c.g, c.b);
    }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    const ground = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }));
    this.zoneRoot.add(ground);
    // 邊界：低矮石牆
    const wallMat = new THREE.MeshLambertMaterial({ color: 0x8a8278 });
    for (const [x, z, w, d] of [
      [0, -size / 2, size, 1], [0, size / 2, size, 1], [-size / 2, 0, 1, size], [size / 2, 0, 1, size],
    ]) {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(w, 1.2, d), wallMat);
      wall.position.set(x, 0.6, z);
      this.zoneRoot.add(wall);
    }
  }

  private decorTree(x: number, z: number, scale = 1, color = 0x3f8f3f): THREE.Group {
    const g = new THREE.Group();
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.28, 1.4, 6), new THREE.MeshLambertMaterial({ color: 0x7a5230 }));
    trunk.position.y = 0.7;
    const crown = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 0), new THREE.MeshLambertMaterial({ color, flatShading: true }));
    crown.position.y = 2;
    crown.scale.set(1.1, 1.3, 1.1);
    g.add(trunk, crown);
    g.position.set(x, 0, z);
    g.scale.setScalar(scale);
    this.zoneRoot.add(g);
    this.occluders.push(g);
    return g;
  }

  private addPortal(to: ZoneId, x: number, z: number): void {
    const mesh = new THREE.Mesh(
      new THREE.CylinderGeometry(1.1, 1.1, 0.12, 32, 1, true),
      new THREE.MeshBasicMaterial({ color: 0x7fd8ff, transparent: true, opacity: 0.8, side: THREE.DoubleSide }),
    );
    mesh.position.set(x, 0.06, z);
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(1, 1, 3, 32, 1, true),
      new THREE.MeshBasicMaterial({ color: 0x7fd8ff, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false }),
    );
    beam.position.y = 1.5;
    mesh.add(beam);
    this.zoneRoot.add(mesh);
    this.portals.push({ to, pos: new THREE.Vector3(x, 0, z), mesh });
  }

  private addNpc(id: NpcId, name: string, x: number, z: number, body: string, hat: string): void {
    const a = this.makeActor(npcTextures(id, body, hat), 1.9);
    const npc: NpcRt = { ...a, id, name };
    npc.pos.set(x, 0, z);
    npc.sprite.userData.pick = { type: 'npc', ref: npc } satisfies Pick;
    this.zoneRoot.add(npc.sprite, npc.shadow);
    this.npcs.push(npc);
  }

  loadZone(zone: ZoneId): void {
    this.clearZone();
    this.zone = zone;
    const half = ZONE_SIZE[zone] / 2;
    if (zone === 'field') {
      this.scene.background = new THREE.Color(0x9fd4f0);
      this.scene.fog = new THREE.Fog(0x9fd4f0, 45, 90);
      this.buildGround(ZONE_SIZE.field, [0x6fae4a, 0x86c25a, 0x5a9a3c]);
      // 城鎮廣場
      const plaza = new THREE.Mesh(new THREE.CircleGeometry(5, 32), new THREE.MeshLambertMaterial({ color: 0xcdbf9f }));
      plaza.rotation.x = -Math.PI / 2;
      plaza.position.y = 0.01;
      this.zoneRoot.add(plaza);
      this.addNpc('shop', '道具商人 瑪莉', -3, -2.5, '#b8733b', '#6b3a1a');
      this.addNpc('market', '交易所管理員 奧斯卡', 3, -2.5, '#3a4f8f', '#1a2a5a');
      this.addNpc('guide', '新手導覽員 露娜', 0, 3.5, '#8f3a6b', '#5a1a3a');
      this.addPortal('homestead', -4, 4);
      for (let i = 0; i < 40; i++) {
        const x = randRange(mathRng, -half + 2, half - 2);
        const z = randRange(mathRng, -half + 2, half - 2);
        if (Math.hypot(x, z) < 8) continue;
        this.decorTree(x, z, randRange(mathRng, 0.8, 1.4));
      }
      for (const [id, count, [cx, cz], r] of FIELD_SPAWNS) {
        for (let i = 0; i < count; i++) this.spawnMonster(MONSTER_DB.get(id)!, new THREE.Vector3(cx, 0, cz), r);
      }
      this.player.pos.set(0, 0, 1);
    } else {
      this.scene.background = new THREE.Color(0xf6d9b0);
      this.scene.fog = new THREE.Fog(0xf6d9b0, 40, 80);
      this.buildGround(ZONE_SIZE.homestead, [0x7fb85a, 0x8fc868, 0x6aa64a]);
      this.buildHouse();
      this.buildStations();
      this.buildNodes();
      this.addPortal('field', 0, 14);
      for (let i = 0; i < 14; i++) {
        const a = (i / 14) * Math.PI * 2;
        this.decorTree(Math.cos(a) * 18, Math.sin(a) * 18, 1.2, 0x4a9a4a);
      }
      this.player.pos.set(0, 0, 11);
    }
    this.camTarget.copy(this.player.pos);
    this.ev.zoneChanged(zone);
    this.ev.changed();
  }

  private buildHouse(): void {
    const g = new THREE.Group();
    const walls = new THREE.Mesh(new THREE.BoxGeometry(6, 3, 5), new THREE.MeshLambertMaterial({ color: 0xe8d8b8 }));
    walls.position.y = 1.5;
    const roof = new THREE.Mesh(new THREE.ConeGeometry(5, 2.4, 4), new THREE.MeshLambertMaterial({ color: 0xb04a3a, flatShading: true }));
    roof.position.y = 4.2;
    roof.rotation.y = Math.PI / 4;
    const door = new THREE.Mesh(new THREE.BoxGeometry(1.2, 2, 0.1), new THREE.MeshLambertMaterial({ color: 0x6b4226 }));
    door.position.set(0, 1, 2.55);
    g.add(walls, roof, door);
    g.position.set(0, 0, -4);
    this.zoneRoot.add(g);
    this.occluders.push(g);
    // 籬笆
    const fenceMat = new THREE.MeshLambertMaterial({ color: 0xa87a4a });
    for (let x = -18; x <= 18; x += 1.5) {
      for (const z of [-18.5, 18.5]) {
        if (z > 0 && Math.abs(x) < 2) continue;
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.2, 1, 0.2), fenceMat);
        post.position.set(x, 0.5, z);
        this.zoneRoot.add(post);
      }
    }
  }

  private buildStations(): void {
    const defs: [StationId, number, number, number][] = [
      ['smelter', -5, 3, 0xb0522a],
      ['workbench', -2, 4, 0xa87a4a],
      ['anvil', 2, 4, 0x5a5f6a],
      ['alchemy', 5, 3, 0x7b4fd6],
    ];
    for (const [id, x, z, color] of defs) {
      const g = new THREE.Group();
      const base = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.9, 1), new THREE.MeshLambertMaterial({ color }));
      base.position.y = 0.45;
      g.add(base);
      if (id === 'smelter') {
        const chimney = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.3, 1.4, 8), new THREE.MeshLambertMaterial({ color: 0x5a3a2a }));
        chimney.position.set(0.3, 1.5, 0);
        const fire = new THREE.Mesh(new THREE.SphereGeometry(0.25, 8, 8), new THREE.MeshBasicMaterial({ color: 0xffa040 }));
        fire.position.set(0, 0.5, 0.52);
        g.add(chimney, fire);
      } else if (id === 'alchemy') {
        const flask = new THREE.Mesh(new THREE.SphereGeometry(0.3, 12, 12), new THREE.MeshBasicMaterial({ color: 0x9fffb0 }));
        flask.position.y = 1.2;
        g.add(flask);
      }
      g.position.set(x, 0, z);
      const st: StationRt = { id, group: g, pos: new THREE.Vector3(x, 0, z) };
      g.traverse((o) => (o.userData.pick = { type: 'station', ref: st } satisfies Pick));
      this.zoneRoot.add(g);
      this.stations.push(st);
    }
  }

  buildNodes(): void {
    for (const n of this.nodes) {
      this.zoneRoot.remove(n.group);
      this.occluders.splice(this.occluders.indexOf(n.group), 1);
    }
    this.nodes = [];
    this.state.homestead.data.nodes.forEach((ns, i) => {
      const def = NODE_DB.get(ns.defId)!;
      const [x, z] = HOMESTEAD_NODE_SLOTS[i % HOMESTEAD_NODE_SLOTS.length];
      const g = new THREE.Group();
      if (def.kind === 'tree') {
        const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.35, 1.6, 7), new THREE.MeshLambertMaterial({ color: 0x7a5230 }));
        trunk.position.y = 0.8;
        const crown = new THREE.Mesh(new THREE.ConeGeometry(1.3, 2.6, 7), new THREE.MeshLambertMaterial({ color: new THREE.Color(def.color), flatShading: true }));
        crown.position.y = 2.6;
        crown.name = 'top';
        g.add(trunk, crown);
      } else {
        const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(0.9, 0), new THREE.MeshLambertMaterial({ color: 0x77736c, flatShading: true }));
        rock.position.y = 0.6;
        rock.scale.set(1.2, 0.9, 1);
        rock.name = 'top';
        g.add(rock);
        for (let k = 0; k < 4; k++) {
          const ore = new THREE.Mesh(new THREE.OctahedronGeometry(0.22, 0), new THREE.MeshLambertMaterial({ color: new THREE.Color(def.color), emissive: new THREE.Color(def.color).multiplyScalar(0.25) }));
          ore.position.set(Math.cos(k * 1.7) * 0.7, 0.7 + (k % 2) * 0.3, Math.sin(k * 1.7) * 0.6);
          ore.name = 'ore';
          g.add(ore);
        }
      }
      g.position.set(x, 0, z);
      this.occluders.push(g);
      const rt: NodeRt = { state: ns, def, group: g, pos: new THREE.Vector3(x, 0, z), depletedVisual: false };
      g.traverse((o) => (o.userData.pick = { type: 'node', ref: rt } satisfies Pick));
      this.zoneRoot.add(g);
      this.nodes.push(rt);
      this.updateNodeVisual(rt);
    });
  }

  private updateNodeVisual(n: NodeRt): void {
    refreshNode(n.state, n.def, Date.now());
    const depleted = n.state.depletedAt !== undefined;
    if (depleted === n.depletedVisual) return;
    n.depletedVisual = depleted;
    n.group.traverse((o) => {
      if (o.name === 'top' || o.name === 'ore') o.visible = !depleted || o.name === 'top' && n.def.kind === 'ore';
    });
    n.group.scale.setScalar(depleted ? 0.6 : 1);
  }

  private spawnMonster(def: MonsterDef, center: THREE.Vector3, radius: number): void {
    const a = this.makeActor(monsterTextures(def), def.look.scale * 1.2);
    const m: MonsterRt = {
      ...a, def, hp: def.hp, spawnCenter: center.clone(), spawnRadius: radius, chasing: false, dead: false,
      respawnAt: 0, nextAttack: 0, nextWander: 0, lastHitAt: -99,
    };
    this.placeRandom(m);
    m.sprite.userData.pick = { type: 'monster', ref: m } satisfies Pick;
    this.zoneRoot.add(m.sprite, m.shadow);
    this.monsters.push(m);
  }

  private placeRandom(m: MonsterRt): void {
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * m.spawnRadius;
    m.pos.set(m.spawnCenter.x + Math.cos(a) * r, 0, m.spawnCenter.z + Math.sin(a) * r);
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
    this.camDist = Math.min(34, Math.max(10, this.camDist + delta));
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
    const hits = this.raycaster.intersectObjects(objs, false);
    for (const h of hits) {
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
    const pt = new THREE.Vector3();
    if (this.raycaster.ray.intersectPlane(this.groundPlane, pt)) {
      const half = ZONE_SIZE[this.zone] / 2 - 1;
      pt.x = Math.max(-half, Math.min(half, pt.x));
      pt.z = Math.max(-half, Math.min(half, pt.z));
      this.intent = { kind: 'move', pos: pt };
      this.clickMarker.position.set(pt.x, 0.03, pt.z);
      this.clickMarker.visible = true;
    }
  }

  /** 撿起身邊最近的物品（快捷鍵） */
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

  private moveToward(a: Actor, target: THREE.Vector3, speed: number, dt: number, stopAt: number): boolean {
    const dx = target.x - a.pos.x;
    const dz = target.z - a.pos.z;
    const d = Math.hypot(dx, dz);
    if (d <= stopAt) return true;
    const step = Math.min(speed * dt, d - stopAt);
    a.pos.x += (dx / d) * step;
    a.pos.z += (dz / d) * step;
    this.face(a, dx, dz);
    a.bob += dt * 12;
    return d - step <= stopAt + 1e-3;
  }

  private face(a: Actor, dx: number, dz: number): void {
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
    const dot = dx * right.x + dz * right.z;
    if (Math.abs(dot) < 1e-3) return;
    const f = dot > 0 ? 'right' : 'left';
    if (f !== a.facing) {
      a.facing = f;
      (a.sprite.material as THREE.SpriteMaterial).map = f === 'right' ? a.tex.right : a.tex.left;
    }
  }

  update(dt: number): void {
    this.time += dt;
    const ch = this.state.player;
    const d = ch.derived();
    const speed = 4.2 + d.totalStats.agi * 0.01;
    const intent = this.intent;

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
            this.face(this.player, m.pos.x - this.player.pos.x, m.pos.z - this.player.pos.z);
            if (this.time >= this.nextPlayerAttack) {
              this.nextPlayerAttack = this.time + 1 / d.attacksPerSec;
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
          if (this.moveToward(this.player, intent.node.pos, speed, dt, 1.8) && this.time >= this.nextGather) {
            this.nextGather = this.time + 1.1;
            if (!this.doGather(intent.node)) this.intent = undefined;
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
            this.ev.openNpc(intent.npc.id);
          }
          break;
      }
    }

    for (const p of this.portals) {
      p.mesh.rotation.y += dt;
      if (p.pos.distanceTo(this.player.pos) < 1 && (!this.intent || this.intent.kind === 'move')) {
        this.ev.log(p.to === 'homestead' ? '進入了你的家園。' : '回到了晨曦平原。', '#7fd8ff');
        this.loadZone(p.to);
        return;
      }
    }

    this.updateMonsters(dt);
    this.updateItems();
    if (this.zone === 'homestead' && Math.floor(this.time) !== Math.floor(this.time - dt)) for (const n of this.nodes) this.updateNodeVisual(n);

    // 自然回復（脫離戰鬥 4 秒後加速，RO 的坐下回復概念）
    if (this.time >= this.nextRegen) {
      this.nextRegen = this.time + 2;
      const outOfCombat = this.time - this.lastCombatAt > 4;
      const hpRegen = Math.max(1, Math.floor(d.maxHp * (outOfCombat ? 0.03 : 0.005) + d.totalStats.vit / 5));
      const spRegen = Math.max(1, Math.floor(d.maxSp * (outOfCombat ? 0.03 : 0.01)));
      if (!ch.isOverweight()) {
        ch.data.hp = Math.min(d.maxHp, ch.data.hp + hpRegen);
        ch.data.sp = Math.min(d.maxSp, ch.data.sp + spRegen);
      }
      this.ev.changed();
    }

    this.syncActors();
    this.updateCamera(dt);
    this.fadeOccluders();
  }

  private fadeOccluders(): void {
    const cam = this.camera.position;
    const head = this.player.pos.clone().setY(1);
    const seg = new THREE.Line3(cam, head);
    const closest = new THREE.Vector3();
    const camToPlayer = cam.distanceTo(head);
    for (const o of this.occluders) {
      const center = o.position.clone().setY(1.6 * o.scale.y);
      seg.closestPointToPoint(center, true, closest);
      const block = closest.distanceTo(center) < 2.6 * o.scale.x && cam.distanceTo(center) < camToPlayer;
      const opacity = block ? 0.3 : 1;
      o.traverse((c) => {
        const mat = (c as THREE.Mesh).material as THREE.MeshLambertMaterial | undefined;
        if (!mat || mat.opacity === opacity) return;
        mat.transparent = opacity < 1;
        mat.opacity = opacity;
        mat.depthWrite = opacity === 1;
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
    const head = m.pos.clone().setY(m.height);
    if (res.kind === 'miss') {
      this.ev.floatText(head, 'Miss', '#cccccc');
      return;
    }
    m.hp -= res.damage;
    this.ev.floatText(head, String(res.damage), res.kind === 'crit' ? '#ffd24a' : '#ffffff', res.kind === 'crit');
    if (m.hp <= 0) this.killMonster(m);
  }

  private killMonster(m: MonsterRt): void {
    const ch = this.state.player;
    m.dead = true;
    m.hp = 0;
    m.sprite.visible = false;
    m.shadow.visible = false;
    m.respawnAt = this.time + m.def.respawnSec;
    if (this.intent?.kind === 'attack' && this.intent.m === m) this.intent = undefined;

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
      this.ev.floatText(this.player.pos.clone().setY(2.4), 'LEVEL UP!', '#ffe680', true);
    }
    if (lv.jobLevelsGained) this.ev.log(`Job Lv 提升至 ${ch.progression.jobLevel}${ch.canChangeJob() ? '（可以轉職了！按 S 開啟能力視窗）' : ''}`, '#ffe680');

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
      if (drop.category === 'mvp') {
        if (ch.inventory.add(item)) this.ev.log(`MVP 獎勵：${def.name} x${drop.qty}`, RARITY_INFO[def.rarity].color);
        else this.dropOnGround(item, m.pos);
      } else {
        this.dropOnGround(item, m.pos);
      }
    }
    this.ev.changed();
  }

  private dropOnGround(item: ItemInstance, at: THREE.Vector3): void {
    const def = getDef(ITEM_DB, item.defId);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: groundItemTexture(def), alphaTest: 0.1, transparent: true }));
    sprite.center.set(0.5, 0.2);
    sprite.scale.set(0.8, 0.8, 1);
    const pos = at.clone().add(new THREE.Vector3(randRange(mathRng, -1, 1), 0, randRange(mathRng, -1, 1)));
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
    const head = node.pos.clone().setY(2.2);
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
    node.group.rotation.z = (Math.random() - 0.5) * 0.15;
    setTimeout(() => (node.group.rotation.z = 0), 120);
    this.updateNodeVisual(node);
    this.ev.changed();
    return !res.depleted;
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
          m.sprite.visible = true;
          m.shadow.visible = true;
          if (m.def.mvp) this.ev.announce(`${m.def.name} 出現在晨曦平原的東南方！`, '#ff6b6b');
        }
        continue;
      }
      const dist = m.pos.distanceTo(this.player.pos);
      if (!m.chasing && m.def.aggressive && dist < 5) m.chasing = true;
      // 脫離太遠就放棄追擊、回血（防止拉怪）
      if (m.chasing && (dist > 16 || m.pos.distanceTo(m.spawnCenter) > m.spawnRadius + 14)) {
        m.chasing = false;
        m.hp = m.def.hp;
        m.wander = m.spawnCenter.clone();
      }
      if (m.chasing) {
        if (this.moveToward(m, this.player.pos, m.def.speed * 1.3, dt, 1.2) && this.time >= m.nextAttack) {
          m.nextAttack = this.time + 1 / m.def.attacksPerSec;
          const res = resolveAttack({ ...m.def, critPct: 1 }, pd, mathRng);
          this.lastCombatAt = this.time;
          const head = this.player.pos.clone().setY(2);
          if (res.kind === 'miss') this.ev.floatText(head, 'Miss', '#9fd');
          else {
            ch.data.hp -= res.damage;
            this.ev.floatText(head, String(res.damage), '#ff5a5a');
            if (!this.intent) this.intent = { kind: 'attack', m }; // 被打會自動反擊
            if (ch.data.hp <= 0) this.playerDied(m);
          }
          this.ev.changed();
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
      gi.sprite.position.y = Math.sin(this.time * 3 + gi.pos.x) * 0.06;
      if (this.time > gi.expireAt) {
        this.zoneRoot.remove(gi.sprite);
        this.items.splice(this.items.indexOf(gi), 1);
      }
    }
  }

  private syncActor(a: Actor, squash = false): void {
    const bob = Math.abs(Math.sin(a.bob)) * 0.08;
    a.sprite.position.set(a.pos.x, squash ? 0 : bob, a.pos.z);
    if (squash) a.sprite.scale.y = a.height * (1 - bob);
    a.shadow.position.set(a.pos.x, 0.02, a.pos.z);
  }

  private syncActors(): void {
    this.syncActor(this.player);
    for (const m of this.monsters) if (!m.dead) this.syncActor(m, m.def.look.shape === 'slime');
    for (const n of this.npcs) {
      n.bob += 0.02;
      this.syncActor(n);
    }
  }

  private updateCamera(dt: number): void {
    this.camTarget.lerp(this.player.pos, Math.min(1, dt * 8));
    const pitch = THREE.MathUtils.degToRad(52);
    const off = new THREE.Vector3(
      Math.sin(this.camYaw) * Math.cos(pitch) * this.camDist,
      Math.sin(pitch) * this.camDist,
      Math.cos(this.camYaw) * Math.cos(pitch) * this.camDist,
    );
    this.camera.position.copy(this.camTarget).add(off);
    this.camera.lookAt(this.camTarget.x, this.camTarget.y + 0.8, this.camTarget.z);
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
    out.push({ pos: this.player.pos.clone().setY(-0.35), text: this.state.player.name, color: '#fff', kind: 'player' });
    for (const m of this.monsters) {
      if (m.dead) continue;
      const hovered = this.hovered?.type === 'monster' && this.hovered.ref === m;
      const targeted = this.intent?.kind === 'attack' && this.intent.m === m;
      if (hovered || targeted || m.def.mvp || this.time - m.lastHitAt < 5) {
        out.push({
          pos: m.pos.clone().setY(-0.35),
          text: `${m.def.mvp ? '【MVP】' : ''}${m.def.name} Lv${m.def.level}`,
          color: m.def.mvp ? '#ff9f1a' : m.def.aggressive ? '#ff9a9a' : '#fff',
          hp: m.hp / m.def.hp,
          kind: 'monster',
        });
      }
    }
    for (const gi of this.items) {
      const def = getDef(ITEM_DB, gi.item.defId);
      out.push({ pos: gi.pos.clone().setY(0.75), text: `${def.name}${gi.item.qty > 1 ? ` x${gi.item.qty}` : ''}`, color: RARITY_INFO[def.rarity].color, kind: 'item' });
    }
    for (const n of this.npcs) out.push({ pos: n.pos.clone().setY(-0.35), text: n.name, color: '#9fe0ff', kind: 'npc' });
    for (const s of this.stations) out.push({ pos: s.pos.clone().setY(1.8), text: `${STATION_NAMES[s.id]} Lv${this.state.homestead.buildingLevel(s.id)}`, color: '#ffe0a0', kind: 'station' });
    if (this.hovered?.type === 'node') {
      const n = this.hovered.ref;
      const depleted = n.state.depletedAt !== undefined;
      out.push({
        pos: n.pos.clone().setY(n.def.kind === 'tree' ? 4.2 : 2),
        text: `${n.def.name}${depleted ? '（枯竭中）' : ` ${n.state.hitsLeft}/${n.def.hits}`}`,
        color: depleted ? '#999' : '#b0ffb0',
        kind: 'node',
      });
    }
    for (const p of this.portals) out.push({ pos: p.pos.clone().setY(3.2), text: p.to === 'homestead' ? '▶ 我的家園' : '▶ 晨曦平原', color: '#7fd8ff', kind: 'npc' });
    return out;
  }

  playerScreenPos(): { x: number; y: number } {
    return this.toScreen(this.player.pos.clone().setY(this.player.height));
  }
}
