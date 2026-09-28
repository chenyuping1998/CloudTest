/**
 * 地圖配置：地形、樹、NPC、傳送門、怪物分布、家園設施位置。
 * 完全決定性（固定 seed），伺服器與所有用戶端產生的地圖一模一樣。
 */
import type { NodeState, StationId } from '../core/homestead';
import { randRange, SeededRng } from '../core/rng';
import { Grid, valueNoise, type Column } from './grid';
import type { TileName } from './tiles';

export type ZoneId = 'field' | 'homestead' | 'frost' | 'ember';
/** 所有玩家共用的野外地圖（家園是每人一份） */
export type WorldZoneId = 'field' | 'frost' | 'ember';
export type NpcId = 'shop' | 'market' | 'guide';

export interface TreeDef { x: number; z: number; leaves: TileName; trunk: number; spruce?: boolean }

export interface MapLayout {
  zone: ZoneId;
  size: number;
  grid: Grid;
  spawn: { x: number; z: number };
  trees: TreeDef[];
  graves: { x: number; z: number; rot: number }[];
  npcs: { id: NpcId; name: string; x: number; z: number }[];
  portals: { to: ZoneId; x: number; z: number }[];
  stations: { id: StationId; x: number; z: number }[];
  /** 家園資源點位置（與 homestead.nodes 同順序） */
  nodes: { x: number; z: number }[];
  house?: { x: number; z: number };
  fences: [number, number][][];
  sky: { top: string; bottom: string; fog: number };
}

export const ZONE_SIZE: Record<ZoneId, number> = { field: 72, homestead: 40, frost: 72, ember: 72 };

export const ZONE_NAMES: Record<ZoneId, string> = { field: '晨曦平原', homestead: '家園', frost: '霜語山脈', ember: '餘燼深淵' };

/** 地圖的建議等級（顯示在傳送門上） */
export const ZONE_LEVELS: Record<ZoneId, string> = { field: 'Lv 1~50', homestead: '', frost: 'Lv 50~70', ember: 'Lv 70~90' };

/** 野外怪物分布：怪物 id、數量、中心點、半徑 */
export const FIELD_SPAWNS: [string, number, [number, number], number][] = [
  ['jelly_slime', 10, [7, 7], 8],
  ['hop_shroom', 8, [-9, 11], 7],
  ['grey_wolf', 7, [22, -3], 7],
  ['goblin', 7, [0, -22], 8],
  ['skeleton', 6, [-22, -19], 7],
  ['rock_golem', 4, [-22, 22], 6],
  ['shadow_knight', 6, [23, -23], 6],
  ['magma_golem', 4, [0, 26], 5],
  ['bone_lich', 1, [24, 24], 3],
];

export const FROST_SPAWNS: [string, number, [number, number], number][] = [
  ['snow_wolf', 8, [-14, -14], 8],
  ['ice_slime', 7, [-14, 14], 7],
  ['yeti', 6, [8, -20], 7],
  ['frost_skeleton', 6, [20, 4], 7],
  ['frost_giant', 4, [18, 22], 6],
  ['frost_queen', 1, [26, -24], 3],
];

export const EMBER_SPAWNS: [string, number, [number, number], number][] = [
  ['ember_imp', 8, [-16, -12], 7],
  ['lava_slime', 7, [-16, 14], 7],
  ['obsidian_golem', 5, [2, -22], 6],
  ['hellhound', 6, [18, 6], 6],
  ['ember_knight', 6, [16, 24], 6],
  ['flame_wraith', 5, [-2, 22], 5],
  ['ember_lord', 1, [26, -22], 3],
];

export const ZONE_SPAWNS: Record<WorldZoneId, typeof FIELD_SPAWNS> = { field: FIELD_SPAWNS, frost: FROST_SPAWNS, ember: EMBER_SPAWNS };

/** MVP 出現時的公告位置描述 */
export const MVP_LOCATION: Record<string, string> = { bone_lich: '晨曦平原的東南方', frost_queen: '霜語山脈的東北方冰原', ember_lord: '餘燼深淵的東北方祭壇' };

const HOMESTEAD_NODE_SLOTS: [number, number][] = [
  [-12, -9], [-15, -3], [-11, 3], [11, -11], [15, -6], [-14, 10], [-8, 13], [12, 7], [16, 12], [7, 14], [-5, -14], [3, -15],
];

export const NPC_POSITIONS: MapLayout['npcs'] = [
  { id: 'shop', name: '道具商人 瑪莉', x: -3.5, z: -3 },
  { id: 'market', name: '交易所管理員 奧斯卡', x: 3.5, z: -3 },
  { id: 'guide', name: '新手導覽員 露娜', x: 0.5, z: 4 },
];

function fieldColumn(x: number, z: number, noise: (x: number, z: number) => number, rng: SeededRng): Column {
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
  } else if (inRegion(0, 26, 7)) {
    top = rng.next() < 0.6 ? 'darkstone' : 'gravel';
    under = 'stone';
    height = 1;
  } else if (inRegion(23, -23, 7)) {
    top = rng.next() < 0.5 ? 'stone_brick' : 'cobble';
    under = 'stone';
    height = 1;
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

function blockTree(grid: Grid, t: TreeDef): void {
  const c = grid.columnAt(t.x, t.z);
  if (c) c.blocked = true;
}

let fieldCache: MapLayout | undefined;

export function fieldLayout(): MapLayout {
  if (fieldCache) return fieldCache;
  const size = ZONE_SIZE.field;
  const half = size / 2;
  const noise = valueNoise(7);
  const rng = new SeededRng(99);
  const grid = new Grid(size, (x, z) => fieldColumn(x, z, noise, rng));
  const trees: TreeDef[] = [];
  const tr = new SeededRng(5);
  for (let i = 0; i < 70; i++) {
    const x = randRange(tr, -half + 3, half - 3);
    const z = randRange(tr, -half + 3, half - 3);
    const leaves: TileName = tr.next() < 0.15 ? 'maple_leaves' : 'leaves';
    const trunk = 4 + (tr.next() < 0.5 ? 1 : 0);
    const col = grid.columnAt(x, z);
    if (!col || col.top !== 'grass_top' || Math.hypot(x, z) < 9 || Math.abs(x) < 2 || Math.abs(z) < 2 || Math.hypot(x - 31.5, z - 8.5) < 4) continue;
    if (FIELD_SPAWNS.some(([, , [cx, cz], r]) => Math.hypot(x - cx, z - cz) < r * 0.6)) continue;
    const t = { x: Math.floor(x) + 0.5, z: Math.floor(z) + 0.5, leaves, trunk };
    trees.push(t);
    blockTree(grid, t);
  }
  const graves: MapLayout['graves'] = [];
  for (let i = 0; i < 9; i++) {
    const x = -22 + randRange(tr, -6, 6);
    const z = -19 + randRange(tr, -6, 6);
    graves.push({ x: Math.floor(x) + 0.5, z: Math.floor(z) + 0.5, rot: Math.PI / 4 + randRange(tr, -0.3, 0.3) });
  }
  fieldCache = {
    zone: 'field', size, grid, spawn: { x: 0.5, z: 1.5 }, trees, graves, npcs: NPC_POSITIONS,
    portals: [{ to: 'homestead', x: -5, z: 4.5 }, { to: 'frost', x: 31.5, z: 8.5 }], stations: [], nodes: [], fences: [],
    sky: { top: '#5d9cf0', bottom: '#bfe0ff', fog: 0xbfe0ff },
  };
  return fieldCache;
}

/** 家園配置會依資源點數量變化，所以每個家園各自產生 */
export function homesteadLayout(nodes: readonly NodeState[]): MapLayout {
  const size = ZONE_SIZE.homestead;
  const half = size / 2;
  const rng = new SeededRng(3);
  const grid = new Grid(size, (x, z) => {
    const edge = Math.max(Math.abs(x), Math.abs(z)) > half - 1;
    if (edge) return { height: 3, top: 'leaves', under: 'leaves', blocked: true };
    if (Math.abs(x) < 1.1 && z > 2) return { height: 1, top: 'path', under: 'dirt' };
    if (x > 4 && x < 10 && z > -2 && z < 4) return { height: 1, top: rng.next() < 0.5 ? 'dirt' : 'hay', under: 'dirt' };
    const r = rng.next();
    return { height: 1, top: 'grass_top', under: 'dirt', plant: r < 0.08 ? 'tallgrass' : r < 0.1 ? 'flower_red' : r < 0.12 ? 'flower_yellow' : undefined };
  });
  for (let x = -5; x <= 5; x++) for (let z = -9; z <= 6; z++) {
    const c = grid.columnAt(x, z);
    if (c) c.plant = undefined;
  }
  // 房子
  for (let x = -4; x <= 4; x++) for (let z = -8; z <= -1; z++) {
    const c = grid.columnAt(x, z);
    if (c) c.blocked = true;
  }
  const stations: MapLayout['stations'] = [
    { id: 'smelter', x: -6, z: 3 },
    { id: 'workbench', x: -3, z: 4 },
    { id: 'anvil', x: 3, z: 4 },
    { id: 'alchemy', x: 6, z: 3 },
  ];
  const nodePos = nodes.map((_, i) => {
    const [x, z] = HOMESTEAD_NODE_SLOTS[i % HOMESTEAD_NODE_SLOTS.length];
    const c = grid.columnAt(x + 0.5, z + 0.5);
    if (c) c.blocked = true;
    return { x: x + 0.5, z: z + 0.5 };
  });
  const trees: TreeDef[] = [];
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    const t = { x: Math.floor(Math.cos(a) * 17.5) + 0.5, z: Math.floor(Math.sin(a) * 17.5 - 0.5) + 0.5, leaves: (i % 3 === 0 ? 'maple_leaves' : 'leaves') as TileName, trunk: 4 + (i % 2) };
    trees.push(t);
    blockTree(grid, t);
  }
  const fence: [number, number][] = [];
  for (let x = -17; x <= 17; x++) if (Math.abs(x) > 1) fence.push([x + 0.5, 17.5]);
  return {
    zone: 'homestead', size, grid, spawn: { x: 0.5, z: 12.5 }, trees, graves: [], npcs: [],
    portals: [{ to: 'field', x: 0.5, z: 15 }], stations, nodes: nodePos, house: { x: 0.5, z: -4.5 },
    fences: [fence.slice(0, 16), fence.slice(16)],
    sky: { top: '#f0a860', bottom: '#ffe4b8', fog: 0xffe4b8 },
  };
}

// ============================================================ 霜語山脈

function frostColumn(x: number, z: number, noise: (x: number, z: number) => number, rng: SeededRng): Column {
  const half = ZONE_SIZE.frost / 2;
  if (Math.max(Math.abs(x), Math.abs(z)) > half - 1) return { height: 5, top: 'packed_ice', under: 'packed_ice', blocked: true };
  const n = noise(x * 0.08, z * 0.08);
  const inRegion = (cx: number, cz: number, r: number) => Math.hypot(x - cx, z - cz) < r;
  // 入口營地
  if (inRegion(-29, 0, 5)) return { height: 1, top: inRegion(-29, 0, 3) ? 'cobble' : 'frozen_grass', under: 'dirt' };
  // 結冰的湖（可以走）
  if (inRegion(-2, 20, 7)) return { height: 1, top: inRegion(-2, 20, 5.5) ? 'ice' : 'snow_top', under: 'packed_ice' };
  // 通往餘燼深淵的傳送門
  if (inRegion(31.5, 0.5, 3)) return { height: 1, top: 'cobble', under: 'dirt' };
  // 主要道路（西邊營地 → 東邊傳送門）
  if (Math.abs(z) < 1.2) return { height: 1, top: 'gravel', under: 'dirt' };
  let height = 1 + (n > 0.55 ? 1 : 0) + (n > 0.7 ? 1 : 0) + (n > 0.82 ? 1 : 0);
  let top: TileName = 'snow_top';
  let under: TileName = 'dirt';
  if (inRegion(26, -24, 6)) {
    top = rng.next() < 0.6 ? 'packed_ice' : 'ice';
    under = 'packed_ice';
    height = 1;
  } else if (inRegion(18, 22, 8)) {
    top = rng.next() < 0.5 ? 'packed_ice' : 'snow_top';
    under = 'stone';
    height = Math.min(height, 2);
  } else if (inRegion(20, 4, 8) || inRegion(8, -20, 8)) {
    height = Math.min(height, 2);
  } else if (inRegion(-14, 14, 8) || inRegion(-14, -14, 9)) {
    height = 1;
  }
  return { height, top, under };
}

let frostCache: MapLayout | undefined;

export function frostLayout(): MapLayout {
  if (frostCache) return frostCache;
  const size = ZONE_SIZE.frost;
  const half = size / 2;
  const noise = valueNoise(21);
  const rng = new SeededRng(77);
  const grid = new Grid(size, (x, z) => frostColumn(x, z, noise, rng));
  const trees: TreeDef[] = [];
  const tr = new SeededRng(13);
  for (let i = 0; i < 90; i++) {
    const x = randRange(tr, -half + 3, half - 3);
    const z = randRange(tr, -half + 3, half - 3);
    const trunk = 5 + (tr.next() < 0.5 ? 1 : 0);
    const col = grid.columnAt(x, z);
    if (!col || col.top !== 'snow_top' || Math.hypot(x + 29, z) < 7 || Math.hypot(x - 31.5, z) < 5 || Math.abs(z) < 2) continue;
    if (FROST_SPAWNS.some(([, , [cx, cz], r]) => Math.hypot(x - cx, z - cz) < r * 0.7)) continue;
    const t: TreeDef = { x: Math.floor(x) + 0.5, z: Math.floor(z) + 0.5, leaves: 'spruce_leaves', trunk, spruce: true };
    trees.push(t);
    blockTree(grid, t);
  }
  frostCache = {
    zone: 'frost', size, grid, spawn: { x: -28.5, z: 0.5 }, trees, graves: [], npcs: [],
    portals: [{ to: 'field', x: -32, z: 0.5 }, { to: 'ember', x: 32, z: 0.5 }], stations: [], nodes: [], fences: [],
    sky: { top: '#8fb8e8', bottom: '#eef4fa', fog: 0xe4eef8 },
  };
  return frostCache;
}

// ============================================================ 餘燼深淵

/** 岩漿河：由北往南蜿蜒，在主要道路處有黑曜石橋 */
function lavaRiverX(z: number): number {
  return 6 + Math.sin(z * 0.13) * 5;
}

function emberColumn(x: number, z: number, noise: (x: number, z: number) => number, rng: SeededRng): Column {
  const half = ZONE_SIZE.ember / 2;
  if (Math.max(Math.abs(x), Math.abs(z)) > half - 1) return { height: 6, top: 'basalt_top', under: 'basalt_side', blocked: true };
  const inRegion = (cx: number, cz: number, r: number) => Math.hypot(x - cx, z - cz) < r;
  const lava = (): Column => ({ height: 0, top: 'lava', under: 'basalt_side', blocked: true });
  // 入口營地
  if (inRegion(-29, 0, 5)) return { height: 1, top: inRegion(-29, 0, 3) ? 'obsidian' : 'ash', under: 'basalt_side' };
  // 魔王祭壇：黑曜石地板，外圍一圈岩漿，只留西南方入口
  const altar = Math.hypot(x - 26, z + 22);
  if (altar < 5.5) return { height: 1, top: 'obsidian', under: 'obsidian' };
  if (altar < 7 && !(x < 24 && z > -20)) return lava();
  // 岩漿河與橋
  const river = Math.abs(x - lavaRiverX(z));
  if (river < 1.6) {
    if (Math.abs(z) < 1.3 || Math.abs(z - 18) < 1.3 || Math.abs(z + 16) < 1.3) return { height: 1, top: 'obsidian', under: 'obsidian' };
    return lava();
  }
  // 主要道路
  if (Math.abs(z) < 1.2) return { height: 1, top: 'ash', under: 'basalt_side' };
  // 零星的岩漿池
  const n = noise(x * 0.09, z * 0.09);
  const nearSpawn = EMBER_SPAWNS.some(([, , [cx, cz], r]) => inRegion(cx, cz, r + 1));
  if (!nearSpawn && n < 0.16) return lava();
  // 玄武岩柱（擋路的高柱）
  if (!nearSpawn && n > 0.8) return { height: 3 + (n > 0.88 ? 1 : 0), top: 'basalt_top', under: 'basalt_side', blocked: true };
  const height = 1 + (n > 0.62 && !nearSpawn ? 1 : 0);
  const r = rng.next();
  return { height, top: r < 0.35 ? 'ash' : 'basalt_top', under: 'basalt_side' };
}

let emberCache: MapLayout | undefined;

export function emberLayout(): MapLayout {
  if (emberCache) return emberCache;
  const size = ZONE_SIZE.ember;
  const noise = valueNoise(66);
  const rng = new SeededRng(91);
  const grid = new Grid(size, (x, z) => emberColumn(x, z, noise, rng));
  emberCache = {
    zone: 'ember', size, grid, spawn: { x: -28.5, z: 0.5 }, trees: [], graves: [], npcs: [],
    portals: [{ to: 'frost', x: -32, z: 0.5 }], stations: [], nodes: [], fences: [],
    sky: { top: '#2a0e0a', bottom: '#7a2a14', fog: 0x4a1a10 },
  };
  return emberCache;
}

export function worldLayout(zone: WorldZoneId): MapLayout {
  return zone === 'field' ? fieldLayout() : zone === 'frost' ? frostLayout() : emberLayout();
}
