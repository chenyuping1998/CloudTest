import type { HomesteadData, HomesteadUpgrade, Recipe, ResourceNodeDef, StationId } from '../core/homestead';
import { PPM } from '../core/rng';

export const RESOURCE_NODES: ResourceNodeDef[] = [
  {
    id: 'oak_tree', name: '橡樹', kind: 'tree', toolTier: 1, skillReq: 1, hits: 5, respawnSec: 60, exp: 8, homesteadLevelReq: 1, color: '#3f8f3f',
    yields: [
      { itemId: 'oak_log', ratePpm: PPM, min: 1, max: 2 },
      { itemId: 'apple', ratePpm: 50_000 },
      { itemId: 'ancient_branch', ratePpm: 50 },
    ],
  },
  {
    id: 'maple_tree', name: '楓樹', kind: 'tree', toolTier: 2, skillReq: 10, hits: 6, respawnSec: 120, exp: 20, homesteadLevelReq: 2, color: '#c8562c',
    yields: [
      { itemId: 'maple_log', ratePpm: PPM, min: 1, max: 2 },
      { itemId: 'ancient_branch', ratePpm: 200 },
    ],
  },
  {
    id: 'copper_vein', name: '銅礦脈', kind: 'ore', toolTier: 1, skillReq: 1, hits: 6, respawnSec: 60, exp: 8, homesteadLevelReq: 1, color: '#c77b43',
    yields: [
      { itemId: 'copper_ore', ratePpm: PPM, min: 1, max: 2 },
      { itemId: 'coal', ratePpm: 300_000 },
      { itemId: 'rough_ruby', ratePpm: 1_000 },
    ],
  },
  {
    id: 'iron_vein', name: '鐵礦脈', kind: 'ore', toolTier: 2, skillReq: 10, hits: 8, respawnSec: 120, exp: 20, homesteadLevelReq: 2, color: '#7d7f86',
    yields: [
      { itemId: 'iron_ore', ratePpm: PPM, min: 1, max: 2 },
      { itemId: 'coal', ratePpm: 400_000 },
      { itemId: 'rough_ruby', ratePpm: 3_000 },
      { itemId: 'rough_sapphire', ratePpm: 3_000 },
    ],
  },
  {
    id: 'mithril_vein', name: '秘銀礦脈', kind: 'ore', toolTier: 3, skillReq: 25, hits: 10, respawnSec: 300, exp: 50, homesteadLevelReq: 3, color: '#8fd3ff',
    yields: [
      { itemId: 'mithril_ore', ratePpm: PPM },
      { itemId: 'rough_sapphire', ratePpm: 8_000 },
      { itemId: 'star_crystal', ratePpm: 20 },
    ],
  },
];

export const NODE_DB = new Map(RESOURCE_NODES.map((n) => [n.id, n]));

export const STATION_NAMES: Record<StationId, string> = {
  smelter: '熔爐',
  workbench: '木工台',
  anvil: '鐵砧',
  alchemy: '鍊金台',
};

export const STATION_MAX_LEVEL = 3;

export function stationUpgradeCost(id: StationId, current: number): { gold: number; materials: { itemId: string; qty: number }[] } {
  const gold = 1500 * Math.pow(4, current);
  const mat: Record<StationId, string> = { smelter: 'copper_ingot', workbench: 'oak_plank', anvil: 'iron_ingot', alchemy: 'jelly' };
  return { gold, materials: [{ itemId: mat[id], qty: 10 * (current + 1) }] };
}

export const HOMESTEAD_UPGRADES: HomesteadUpgrade[] = [
  {
    toLevel: 2, gold: 5_000,
    materials: [{ itemId: 'oak_plank', qty: 20 }, { itemId: 'copper_ingot', qty: 20 }],
    unlockNodes: ['maple_tree', 'maple_tree', 'iron_vein', 'iron_vein'],
  },
  {
    toLevel: 3, gold: 50_000,
    materials: [{ itemId: 'maple_plank', qty: 40 }, { itemId: 'iron_ingot', qty: 40 }, { itemId: 'golem_core', qty: 10 }],
    unlockNodes: ['mithril_vein', 'mithril_vein', 'oak_tree'],
  },
];

export function initialHomestead(): HomesteadData {
  return {
    level: 1,
    buildings: { smelter: 1, workbench: 1, anvil: 1, alchemy: 1 },
    nodes: ['oak_tree', 'oak_tree', 'oak_tree', 'copper_vein', 'copper_vein'].map((defId) => ({
      defId,
      hitsLeft: NODE_DB.get(defId)!.hits,
    })),
  };
}

const r = (
  id: string, station: StationId, skill: Recipe['skill'], skillReq: number,
  inputs: [string, number][], output: [string, number], baseSuccess: number, exp: number,
  opts: { gold?: number; stationLevel?: number } = {},
): Recipe => ({
  id, station, skill, skillReq, baseSuccess, exp,
  inputs: inputs.map(([itemId, qty]) => ({ itemId, qty })),
  output: { itemId: output[0], qty: output[1] },
  goldCost: opts.gold ?? 0,
  stationLevelReq: opts.stationLevel ?? 1,
});

export const RECIPES: Recipe[] = [
  // 熔爐
  r('smelt_copper', 'smelter', 'smithing', 1, [['copper_ore', 3], ['coal', 1]], ['copper_ingot', 1], 0.95, 5),
  r('smelt_iron', 'smelter', 'smithing', 8, [['iron_ore', 3], ['coal', 2]], ['iron_ingot', 1], 0.9, 12),
  r('smelt_mithril', 'smelter', 'smithing', 20, [['mithril_ore', 4], ['coal', 3]], ['mithril_ingot', 1], 0.8, 35, { stationLevel: 2 }),
  // 木工台
  r('plank_oak', 'workbench', 'carpentry', 1, [['oak_log', 2]], ['oak_plank', 1], 0.98, 4),
  r('plank_maple', 'workbench', 'carpentry', 8, [['maple_log', 2]], ['maple_plank', 1], 0.92, 10),
  r('craft_oak_staff', 'workbench', 'carpentry', 12, [['maple_plank', 5], ['rough_sapphire', 1]], ['oak_staff', 1], 0.75, 45),
  // 鐵砧
  r('craft_iron_pickaxe', 'anvil', 'smithing', 5, [['iron_ingot', 5], ['oak_plank', 2]], ['iron_pickaxe', 1], 0.9, 30),
  r('craft_iron_axe', 'anvil', 'smithing', 5, [['iron_ingot', 5], ['oak_plank', 2]], ['iron_axe', 1], 0.9, 30),
  r('craft_iron_sword', 'anvil', 'smithing', 10, [['iron_ingot', 8], ['oak_plank', 2]], ['iron_sword', 1], 0.75, 40, { gold: 200 }),
  r('craft_iron_helm', 'anvil', 'smithing', 8, [['iron_ingot', 6]], ['iron_helm', 1], 0.8, 30, { gold: 150 }),
  r('craft_chainmail', 'anvil', 'smithing', 15, [['iron_ingot', 15], ['wolf_pelt', 10]], ['chainmail', 1], 0.7, 80, { gold: 800, stationLevel: 2 }),
  r('craft_mithril_pickaxe', 'anvil', 'smithing', 22, [['mithril_ingot', 5], ['maple_plank', 3]], ['mithril_pickaxe', 1], 0.8, 90, { stationLevel: 2 }),
  r('craft_mithril_axe', 'anvil', 'smithing', 22, [['mithril_ingot', 5], ['maple_plank', 3]], ['mithril_axe', 1], 0.8, 90, { stationLevel: 2 }),
  r('craft_mithril_sword', 'anvil', 'smithing', 25, [['mithril_ingot', 10], ['maple_plank', 3], ['rune_fragment', 2]], ['mithril_sword', 1], 0.55, 200, { gold: 3000, stationLevel: 2 }),
  r('craft_mithril_armor', 'anvil', 'smithing', 30, [['mithril_ingot', 15], ['golem_core', 3]], ['mithril_armor', 1], 0.45, 300, { gold: 8000, stationLevel: 3 }),
  // 鍊金台
  r('brew_orange', 'alchemy', 'alchemy', 1, [['red_potion', 2], ['spore', 3]], ['orange_potion', 1], 0.9, 6),
  r('brew_white', 'alchemy', 'alchemy', 10, [['orange_potion', 2], ['jelly', 5], ['wolf_fang', 1]], ['white_potion', 1], 0.8, 18),
  r('scribe_armor_scroll', 'alchemy', 'alchemy', 15, [['rune_fragment', 3], ['rough_sapphire', 1]], ['scroll_armor', 1], 0.6, 60, { gold: 500, stationLevel: 2 }),
  r('scribe_weapon_scroll', 'alchemy', 'alchemy', 15, [['rune_fragment', 3], ['rough_ruby', 1]], ['scroll_weapon', 1], 0.6, 60, { gold: 500, stationLevel: 2 }),
  r('scribe_protect_scroll', 'alchemy', 'alchemy', 25, [['lich_ash', 3], ['rough_sapphire', 2], ['ancient_branch', 1]], ['scroll_protect', 1], 0.5, 150, { gold: 5000, stationLevel: 3 }),
];

export const RECIPE_DB = new Map(RECIPES.map((x) => [x.id, x]));
