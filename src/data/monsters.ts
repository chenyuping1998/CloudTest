import type { DropProfile, TreasurePool } from '../core/drops';
import { PPM } from '../core/rng';

export interface MonsterDef {
  id: string;
  name: string;
  level: number;
  hp: number;
  atk: number;
  def: number;
  hit: number;
  flee: number;
  baseExp: number;
  jobExp: number;
  /** 每秒移動格數 */
  speed: number;
  attacksPerSec: number;
  aggressive: boolean;
  respawnSec: number;
  mvp?: boolean;
  /** 外觀（原型用程序化繪製） */
  look: { color: string; shape: 'slime' | 'shroom' | 'beast' | 'humanoid' | 'golem' | 'lich'; scale: number };
  drops: DropProfile;
}

const CARD = 100; // 0.01%

export const TREASURE_POOLS: TreasurePool[] = [
  {
    id: 'field_t1',
    triggerPpm: 20_000, // 2% 機率觸發，再從下列權重抽一件
    entries: [
      { itemId: 'knife', weight: 40 },
      { itemId: 'cotton_shirt', weight: 40 },
      { itemId: 'leather_cap', weight: 30 },
      { itemId: 'sandals', weight: 30 },
      { itemId: 'leather_armor', weight: 15 },
      { itemId: 'cutlass', weight: 8 },
      { itemId: 'hunter_bow', weight: 8 },
      { itemId: 'oak_staff', weight: 8 },
      { itemId: 'scroll_armor', weight: 5 },
      { itemId: 'scroll_weapon', weight: 5 },
      { itemId: 'clover_ring', weight: 1 },
    ],
  },
  {
    id: 'field_t2',
    triggerPpm: 25_000,
    entries: [
      { itemId: 'longsword', weight: 30 },
      { itemId: 'iron_helm', weight: 20 },
      { itemId: 'buckler', weight: 20 },
      { itemId: 'chainmail', weight: 15 },
      { itemId: 'scroll_weapon', weight: 10 },
      { itemId: 'scroll_armor', weight: 10 },
      { itemId: 'wind_boots', weight: 6 },
      { itemId: 'golem_amulet', weight: 1 },
      { itemId: 'flame_blade', weight: 0.5 },
    ],
  },
  {
    id: 'frost_t3',
    triggerPpm: 25_000,
    entries: [
      { itemId: 'scroll_weapon', weight: 20 },
      { itemId: 'scroll_armor', weight: 20 },
      { itemId: 'snow_boots', weight: 15 },
      { itemId: 'frost_crown', weight: 12 },
      { itemId: 'frost_greatsword', weight: 10 },
      { itemId: 'crystal_staff', weight: 10 },
      { itemId: 'scroll_weapon_blessed', weight: 3 },
      { itemId: 'giant_ring', weight: 1.5 },
      { itemId: 'queen_tear', weight: 0.2 },
    ],
  },
  {
    id: 'ember_t4',
    triggerPpm: 25_000,
    entries: [
      { itemId: 'scroll_weapon_blessed', weight: 12 },
      { itemId: 'scroll_armor_blessed', weight: 12 },
      { itemId: 'lava_greaves', weight: 15 },
      { itemId: 'ember_helm', weight: 12 },
      { itemId: 'ember_blade', weight: 8 },
      { itemId: 'inferno_staff', weight: 8 },
      { itemId: 'scroll_protect', weight: 2 },
      { itemId: 'hellhound_collar', weight: 1.2 },
      { itemId: 'lord_heart', weight: 0.15 },
    ],
  },
];

export const MONSTERS: MonsterDef[] = [
  {
    id: 'jelly_slime', name: '果凍史萊姆', level: 1, hp: 50, atk: 7, def: 0, hit: 5, flee: 2, baseExp: 32, jobExp: 23,
    speed: 1.2, attacksPerSec: 0.6, aggressive: false, respawnSec: 8,
    look: { color: '#ff8fb8', shape: 'slime', scale: 0.8 },
    drops: {
      sourceId: 'jelly_slime',
      drops: [
        { itemId: 'jelly', ratePpm: 700_000, min: 1, max: 2 },
        { itemId: 'apple', ratePpm: 150_000 },
        { itemId: 'red_potion', ratePpm: 50_000 },
        { itemId: 'cotton_shirt', ratePpm: 15_000 },
        { itemId: 'knife', ratePpm: 10_000 },
        { itemId: 'scroll_armor', ratePpm: 500 },
        { itemId: 'card_slime', ratePpm: CARD, category: 'card' },
      ],
    },
  },
  {
    id: 'hop_shroom', name: '跳跳菇', level: 5, hp: 130, atk: 14, def: 3, hit: 12, flee: 6, baseExp: 54, jobExp: 39,
    speed: 1.4, attacksPerSec: 0.7, aggressive: false, respawnSec: 10,
    look: { color: '#d9534f', shape: 'shroom', scale: 0.9 },
    drops: {
      sourceId: 'hop_shroom',
      drops: [
        { itemId: 'spore', ratePpm: 600_000, min: 1, max: 3 },
        { itemId: 'red_potion', ratePpm: 80_000 },
        { itemId: 'blue_potion', ratePpm: 10_000 },
        { itemId: 'leather_cap', ratePpm: 15_000 },
        { itemId: 'clover_ring', ratePpm: 800 },
        { itemId: 'card_shroom', ratePpm: CARD, category: 'card' },
      ],
    },
  },
  {
    id: 'grey_wolf', name: '灰狼', level: 10, hp: 320, atk: 30, def: 6, hit: 28, flee: 18, baseExp: 57, jobExp: 41,
    speed: 2.6, attacksPerSec: 0.9, aggressive: true, respawnSec: 15,
    look: { color: '#8a8f99', shape: 'beast', scale: 1.1 },
    drops: {
      sourceId: 'grey_wolf',
      pools: ['field_t1'],
      drops: [
        { itemId: 'wolf_pelt', ratePpm: 550_000 },
        { itemId: 'wolf_fang', ratePpm: 120_000 },
        { itemId: 'orange_potion', ratePpm: 30_000 },
        { itemId: 'hunter_bow', ratePpm: 5_000 },
        { itemId: 'wind_boots', ratePpm: 1_500 },
        { itemId: 'card_wolf', ratePpm: CARD, category: 'card' },
      ],
    },
  },
  {
    id: 'goblin', name: '哥布林戰士', level: 15, hp: 540, atk: 48, def: 10, hit: 40, flee: 22, baseExp: 73, jobExp: 53,
    speed: 2, attacksPerSec: 0.9, aggressive: false, respawnSec: 15,
    look: { color: '#5aa45a', shape: 'humanoid', scale: 1 },
    drops: {
      sourceId: 'goblin',
      pools: ['field_t1'],
      drops: [
        { itemId: 'goblin_badge', ratePpm: 500_000 },
        { itemId: 'iron_ore', ratePpm: 100_000 },
        { itemId: 'cutlass', ratePpm: 5_000 },
        { itemId: 'buckler', ratePpm: 6_000 },
        { itemId: 'leather_armor', ratePpm: 8_000 },
        { itemId: 'scroll_weapon', ratePpm: 2_000 },
        { itemId: 'card_goblin', ratePpm: CARD, category: 'card' },
      ],
    },
  },
  {
    id: 'skeleton', name: '骷髏士兵', level: 22, hp: 950, atk: 75, def: 18, hit: 60, flee: 30, baseExp: 86, jobExp: 62,
    speed: 1.8, attacksPerSec: 1, aggressive: true, respawnSec: 20,
    look: { color: '#e8e2cf', shape: 'humanoid', scale: 1.1 },
    drops: {
      sourceId: 'skeleton',
      pools: ['field_t2'],
      drops: [
        { itemId: 'bone', ratePpm: 500_000 },
        { itemId: 'rune_fragment', ratePpm: 20_000 },
        { itemId: 'longsword', ratePpm: 5_000 },
        { itemId: 'chainmail', ratePpm: 1_500 },
        { itemId: 'scroll_weapon', ratePpm: 3_000 },
        { itemId: 'scroll_armor', ratePpm: 3_000 },
        { itemId: 'flame_blade', ratePpm: 150 },
        { itemId: 'card_skeleton', ratePpm: CARD, category: 'card' },
      ],
    },
  },
  {
    id: 'rock_golem', name: '岩石魔像', level: 30, hp: 2100, atk: 110, def: 40, hit: 75, flee: 20, baseExp: 110, jobExp: 79,
    speed: 1.1, attacksPerSec: 0.7, aggressive: false, respawnSec: 30,
    look: { color: '#8c7b6b', shape: 'golem', scale: 1.5 },
    drops: {
      sourceId: 'rock_golem',
      pools: ['field_t2'],
      drops: [
        { itemId: 'golem_core', ratePpm: 300_000 },
        { itemId: 'mithril_ore', ratePpm: 80_000 },
        { itemId: 'rough_ruby', ratePpm: 10_000 },
        { itemId: 'rough_sapphire', ratePpm: 10_000 },
        { itemId: 'golem_amulet', ratePpm: 300 },
        { itemId: 'scroll_weapon_blessed', ratePpm: 200 },
        { itemId: 'card_golem', ratePpm: CARD, category: 'card' },
      ],
    },
  },
  {
    id: 'shadow_knight', name: '暗影騎士', level: 37, hp: 2600, atk: 150, def: 45, hit: 100, flee: 45, baseExp: 114, jobExp: 82,
    speed: 2, attacksPerSec: 1, aggressive: true, respawnSec: 25,
    look: { color: '#3a3448', shape: 'humanoid', scale: 1.15 },
    drops: {
      sourceId: 'shadow_knight',
      pools: ['field_t2'],
      drops: [
        { itemId: 'dark_steel', ratePpm: 280_000 },
        { itemId: 'rune_fragment', ratePpm: 30_000 },
        { itemId: 'chainmail', ratePpm: 3_000 },
        { itemId: 'scroll_weapon', ratePpm: 4_000 },
        { itemId: 'scroll_armor_blessed', ratePpm: 150 },
        { itemId: 'card_knight', ratePpm: CARD, category: 'card' },
      ],
    },
  },
  {
    id: 'magma_golem', name: '熔岩巨像', level: 44, hp: 4200, atk: 190, def: 60, hit: 110, flee: 25, baseExp: 92, jobExp: 66,
    speed: 1.2, attacksPerSec: 0.8, aggressive: false, respawnSec: 35,
    look: { color: '#5a3a30', shape: 'golem', scale: 1.6 },
    drops: {
      sourceId: 'magma_golem',
      pools: ['field_t2'],
      drops: [
        { itemId: 'magma_core', ratePpm: 250_000 },
        { itemId: 'mithril_ore', ratePpm: 120_000, min: 1, max: 2 },
        { itemId: 'rough_ruby', ratePpm: 20_000 },
        { itemId: 'scroll_weapon_blessed', ratePpm: 400 },
        { itemId: 'star_crystal', ratePpm: 30 },
        { itemId: 'card_magma', ratePpm: CARD, category: 'card' },
      ],
    },
  },
  {
    id: 'bone_lich', name: '骸骨巫妖王', level: 45, hp: 40_000, atk: 260, def: 50, hit: 120, flee: 40, baseExp: 26000, jobExp: 16000,
    speed: 1.6, attacksPerSec: 0.8, aggressive: true, respawnSec: 3600, mvp: true,
    look: { color: '#7b4fd6', shape: 'lich', scale: 2.2 },
    drops: {
      sourceId: 'bone_lich',
      drops: [
        { itemId: 'lich_ash', ratePpm: PPM, min: 3, max: 6 },
        { itemId: 'white_potion', ratePpm: 50_000, min: 1, max: 5 },
        { itemId: 'scroll_weapon_blessed', ratePpm: 5_000 },
        { itemId: 'scroll_armor_blessed', ratePpm: 5_000 },
        { itemId: 'star_crystal', ratePpm: 500 },
        { itemId: 'frost_whisper', ratePpm: 400 },
        { itemId: 'card_lich', ratePpm: CARD, category: 'card' },
      ],
      // MVP 得主（總傷害最高）額外獎勵，直接放入背包
      mvpDrops: [
        { itemId: 'scroll_protect', ratePpm: PPM },
        { itemId: 'rune_fragment', ratePpm: 50_000, min: 2, max: 4 },
        { itemId: 'lich_scepter', ratePpm: 50, pity: { startAfter: 40, stepPpm: 25 } },
      ],
    },
  },
  // ======================= 霜語山脈（Lv 50~70） =======================
  {
    id: 'snow_wolf', name: '雪原狼', level: 50, hp: 3800, atk: 220, def: 45, hit: 140, flee: 70, baseExp: 75, jobExp: 54,
    speed: 2.8, attacksPerSec: 1.1, aggressive: true, respawnSec: 20,
    look: { color: '#e8eef4', shape: 'beast', scale: 1.2 },
    drops: {
      sourceId: 'snow_wolf', pools: ['frost_t3'],
      drops: [
        { itemId: 'snow_pelt', ratePpm: 550_000 },
        { itemId: 'ice_crystal', ratePpm: 60_000 },
        { itemId: 'white_potion', ratePpm: 20_000 },
        { itemId: 'snow_boots', ratePpm: 1_500 },
        { itemId: 'card_snow_wolf', ratePpm: CARD, category: 'card' },
      ],
    },
  },
  {
    id: 'ice_slime', name: '冰晶史萊姆', level: 52, hp: 5200, atk: 200, def: 70, hit: 120, flee: 30, baseExp: 94, jobExp: 68,
    speed: 1.4, attacksPerSec: 0.8, aggressive: false, respawnSec: 20,
    look: { color: '#9cd8ff', shape: 'slime', scale: 1.2 },
    drops: {
      sourceId: 'ice_slime', pools: ['frost_t3'],
      drops: [
        { itemId: 'ice_crystal', ratePpm: 250_000 },
        { itemId: 'jelly', ratePpm: 600_000, min: 2, max: 4 },
        { itemId: 'blue_potion', ratePpm: 30_000 },
        { itemId: 'frost_essence', ratePpm: 3_000 },
        { itemId: 'card_ice_slime', ratePpm: CARD, category: 'card' },
      ],
    },
  },
  {
    id: 'yeti', name: '雪人', level: 56, hp: 7500, atk: 260, def: 65, hit: 150, flee: 50, baseExp: 122, jobExp: 88,
    speed: 1.8, attacksPerSec: 0.9, aggressive: false, respawnSec: 30,
    look: { color: '#f0f4f8', shape: 'golem', scale: 1.4 },
    drops: {
      sourceId: 'yeti', pools: ['frost_t3'],
      drops: [
        { itemId: 'yeti_fur', ratePpm: 600_000, min: 1, max: 2 },
        { itemId: 'ice_crystal', ratePpm: 80_000 },
        { itemId: 'frost_essence', ratePpm: 6_000 },
        { itemId: 'frost_greatsword', ratePpm: 800 },
        { itemId: 'card_yeti', ratePpm: CARD, category: 'card' },
      ],
    },
  },
  {
    id: 'frost_skeleton', name: '霜寒骷髏法師', level: 61, hp: 7000, atk: 300, def: 55, hit: 170, flee: 80, baseExp: 101, jobExp: 73,
    speed: 1.6, attacksPerSec: 1, aggressive: true, respawnSec: 25,
    look: { color: '#cfe4f4', shape: 'humanoid', scale: 1.15 },
    drops: {
      sourceId: 'frost_skeleton', pools: ['frost_t3'],
      drops: [
        { itemId: 'bone', ratePpm: 500_000, min: 1, max: 3 },
        { itemId: 'frost_essence', ratePpm: 12_000 },
        { itemId: 'rune_fragment', ratePpm: 40_000 },
        { itemId: 'crystal_staff', ratePpm: 1_000 },
        { itemId: 'frost_crown', ratePpm: 1_500 },
        { itemId: 'scroll_armor_blessed', ratePpm: 300 },
        { itemId: 'card_frost_skeleton', ratePpm: CARD, category: 'card' },
      ],
    },
  },
  {
    id: 'frost_giant', name: '冰霜巨人', level: 66, hp: 13000, atk: 360, def: 90, hit: 170, flee: 40, baseExp: 179, jobExp: 129,
    speed: 1.2, attacksPerSec: 0.7, aggressive: false, respawnSec: 40,
    look: { color: '#8ab8e0', shape: 'golem', scale: 1.9 },
    drops: {
      sourceId: 'frost_giant', pools: ['frost_t3'],
      drops: [
        { itemId: 'giant_heart', ratePpm: 200_000 },
        { itemId: 'mithril_ore', ratePpm: 200_000, min: 1, max: 3 },
        { itemId: 'frost_essence', ratePpm: 15_000 },
        { itemId: 'giant_ring', ratePpm: 400 },
        { itemId: 'star_crystal', ratePpm: 60 },
        { itemId: 'card_frost_giant', ratePpm: CARD, category: 'card' },
      ],
    },
  },
  {
    id: 'frost_queen', name: '冰霜女王', level: 72, hp: 150_000, atk: 520, def: 100, hit: 220, flee: 90, baseExp: 29000, jobExp: 18000,
    speed: 1.8, attacksPerSec: 0.9, aggressive: true, respawnSec: 7200, mvp: true,
    look: { color: '#6ab0f0', shape: 'lich', scale: 2.3 },
    drops: {
      sourceId: 'frost_queen',
      drops: [
        { itemId: 'queen_shard', ratePpm: PPM, min: 2, max: 4 },
        { itemId: 'frost_essence', ratePpm: 50_000, min: 2, max: 5 },
        { itemId: 'scroll_weapon_blessed', ratePpm: 5_000 },
        { itemId: 'scroll_armor_blessed', ratePpm: 5_000 },
        { itemId: 'queen_tear', ratePpm: 300 },
        { itemId: 'card_frost_queen', ratePpm: CARD, category: 'card' },
      ],
      mvpDrops: [
        { itemId: 'scroll_protect', ratePpm: PPM, min: 2, max: 2 },
        { itemId: 'frost_essence', ratePpm: 50_000, min: 3, max: 6 },
        { itemId: 'permafrost_blade', ratePpm: 50, pity: { startAfter: 40, stepPpm: 25 } },
      ],
    },
  },
  // ======================= 餘燼深淵（Lv 70~90） =======================
  {
    id: 'ember_imp', name: '餘燼小鬼', level: 70, hp: 9500, atk: 400, def: 70, hit: 210, flee: 120, baseExp: 134, jobExp: 96,
    speed: 2.6, attacksPerSec: 1.2, aggressive: true, respawnSec: 20,
    look: { color: '#d8502a', shape: 'humanoid', scale: 0.9 },
    drops: {
      sourceId: 'ember_imp', pools: ['ember_t4'],
      drops: [
        { itemId: 'imp_horn', ratePpm: 500_000 },
        { itemId: 'ember_ash', ratePpm: 400_000, min: 1, max: 3 },
        { itemId: 'white_potion', ratePpm: 30_000 },
        { itemId: 'ember_essence', ratePpm: 3_000 },
        { itemId: 'card_ember_imp', ratePpm: CARD, category: 'card' },
      ],
    },
  },
  {
    id: 'lava_slime', name: '熔岩史萊姆', level: 72, hp: 13000, atk: 360, def: 110, hit: 180, flee: 40, baseExp: 158, jobExp: 114,
    speed: 1.4, attacksPerSec: 0.8, aggressive: false, respawnSec: 20,
    look: { color: '#ff7a1a', shape: 'slime', scale: 1.3 },
    drops: {
      sourceId: 'lava_slime', pools: ['ember_t4'],
      drops: [
        { itemId: 'jelly', ratePpm: 600_000, min: 2, max: 5 },
        { itemId: 'magma_core', ratePpm: 200_000 },
        { itemId: 'blue_potion', ratePpm: 40_000 },
        { itemId: 'ember_essence', ratePpm: 4_000 },
        { itemId: 'card_lava_slime', ratePpm: CARD, category: 'card' },
      ],
    },
  },
  {
    id: 'obsidian_golem', name: '黑曜石魔像', level: 76, hp: 16500, atk: 450, def: 150, hit: 200, flee: 40, baseExp: 211, jobExp: 152,
    speed: 1.1, attacksPerSec: 0.7, aggressive: false, respawnSec: 35,
    look: { color: '#2a2238', shape: 'golem', scale: 1.7 },
    drops: {
      sourceId: 'obsidian_golem', pools: ['ember_t4'],
      drops: [
        { itemId: 'obsidian_shard', ratePpm: 250_000, min: 1, max: 2 },
        { itemId: 'golem_core', ratePpm: 300_000 },
        { itemId: 'ember_essence', ratePpm: 8_000 },
        { itemId: 'lava_greaves', ratePpm: 1_200 },
        { itemId: 'star_crystal', ratePpm: 80 },
        { itemId: 'card_obsidian_golem', ratePpm: CARD, category: 'card' },
      ],
    },
  },
  {
    id: 'hellhound', name: '煉獄犬', level: 79, hp: 13500, atk: 500, def: 90, hit: 250, flee: 140, baseExp: 195, jobExp: 140,
    speed: 3, attacksPerSec: 1.2, aggressive: true, respawnSec: 25,
    look: { color: '#5a1a14', shape: 'beast', scale: 1.35 },
    drops: {
      sourceId: 'hellhound', pools: ['ember_t4'],
      drops: [
        { itemId: 'hellfire_fang', ratePpm: 200_000 },
        { itemId: 'ember_ash', ratePpm: 500_000, min: 1, max: 3 },
        { itemId: 'ember_essence', ratePpm: 10_000 },
        { itemId: 'hellhound_collar', ratePpm: 300 },
        { itemId: 'card_hellhound', ratePpm: CARD, category: 'card' },
      ],
    },
  },
  {
    id: 'ember_knight', name: '餘燼騎士', level: 83, hp: 19000, atk: 560, def: 130, hit: 270, flee: 110, baseExp: 234, jobExp: 168,
    speed: 1.7, attacksPerSec: 1, aggressive: true, respawnSec: 30,
    look: { color: '#3a2a2a', shape: 'humanoid', scale: 1.3 },
    drops: {
      sourceId: 'ember_knight', pools: ['ember_t4'],
      drops: [
        { itemId: 'dark_steel', ratePpm: 280_000, min: 1, max: 2 },
        { itemId: 'rune_fragment', ratePpm: 50_000 },
        { itemId: 'ember_essence', ratePpm: 12_000 },
        { itemId: 'ember_blade', ratePpm: 800 },
        { itemId: 'ember_helm', ratePpm: 1_500 },
        { itemId: 'scroll_weapon_blessed', ratePpm: 400 },
        { itemId: 'card_ember_knight', ratePpm: CARD, category: 'card' },
      ],
    },
  },
  {
    id: 'flame_wraith', name: '炎靈', level: 87, hp: 17500, atk: 620, def: 100, hit: 290, flee: 160, baseExp: 242, jobExp: 174,
    speed: 2, attacksPerSec: 1, aggressive: true, respawnSec: 30,
    look: { color: '#ffb040', shape: 'lich', scale: 1.3 },
    drops: {
      sourceId: 'flame_wraith', pools: ['ember_t4'],
      drops: [
        { itemId: 'ember_ash', ratePpm: 600_000, min: 2, max: 4 },
        { itemId: 'ember_essence', ratePpm: 15_000 },
        { itemId: 'inferno_staff', ratePpm: 1_000 },
        { itemId: 'scroll_armor_blessed', ratePpm: 400 },
        { itemId: 'card_flame_wraith', ratePpm: CARD, category: 'card' },
      ],
    },
  },
  {
    id: 'ember_lord', name: '餘燼魔王', level: 92, hp: 400_000, atk: 780, def: 140, hit: 320, flee: 120, baseExp: 36000, jobExp: 22000,
    speed: 1.8, attacksPerSec: 0.9, aggressive: true, respawnSec: 7200, mvp: true,
    look: { color: '#b0200c', shape: 'lich', scale: 2.6 },
    drops: {
      sourceId: 'ember_lord',
      drops: [
        { itemId: 'lord_cinder', ratePpm: PPM, min: 2, max: 4 },
        { itemId: 'ember_essence', ratePpm: 50_000, min: 2, max: 5 },
        { itemId: 'scroll_weapon_blessed', ratePpm: 5_000 },
        { itemId: 'scroll_armor_blessed', ratePpm: 5_000 },
        { itemId: 'lord_heart', ratePpm: 300 },
        { itemId: 'card_ember_lord', ratePpm: CARD, category: 'card' },
      ],
      mvpDrops: [
        { itemId: 'scroll_protect', ratePpm: PPM, min: 2, max: 3 },
        { itemId: 'ember_essence', ratePpm: 50_000, min: 3, max: 6 },
        { itemId: 'abyss_edge', ratePpm: 50, pity: { startAfter: 40, stepPpm: 25 } },
      ],
    },
  },
];

export const MONSTER_DB = new Map(MONSTERS.map((m) => [m.id, m]));
export const POOL_DB = new Map(TREASURE_POOLS.map((p) => [p.id, p]));
