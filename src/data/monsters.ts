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
];

export const MONSTERS: MonsterDef[] = [
  {
    id: 'jelly_slime', name: '果凍史萊姆', level: 1, hp: 50, atk: 7, def: 0, hit: 5, flee: 2, baseExp: 6, jobExp: 4,
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
    id: 'hop_shroom', name: '跳跳菇', level: 5, hp: 130, atk: 14, def: 3, hit: 12, flee: 6, baseExp: 22, jobExp: 15,
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
    id: 'grey_wolf', name: '灰狼', level: 10, hp: 320, atk: 30, def: 6, hit: 28, flee: 18, baseExp: 70, jobExp: 45,
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
    id: 'goblin', name: '哥布林戰士', level: 15, hp: 540, atk: 48, def: 10, hit: 40, flee: 22, baseExp: 160, jobExp: 100,
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
    id: 'skeleton', name: '骷髏士兵', level: 22, hp: 950, atk: 75, def: 18, hit: 60, flee: 30, baseExp: 380, jobExp: 240,
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
    id: 'rock_golem', name: '岩石魔像', level: 30, hp: 2100, atk: 110, def: 40, hit: 75, flee: 20, baseExp: 900, jobExp: 560,
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
    id: 'bone_lich', name: '骸骨巫妖王', level: 45, hp: 40_000, atk: 260, def: 50, hit: 120, flee: 40, baseExp: 45_000, jobExp: 30_000,
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
];

export const MONSTER_DB = new Map(MONSTERS.map((m) => [m.id, m]));
export const POOL_DB = new Map(TREASURE_POOLS.map((p) => [p.id, p]));
