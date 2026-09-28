export type StatKey = 'str' | 'agi' | 'vit' | 'int' | 'dex' | 'luk';
export type Stats = Record<StatKey, number>;
export const STAT_KEYS: readonly StatKey[] = ['str', 'agi', 'vit', 'int', 'dex', 'luk'];

export const STAT_NAMES: Record<StatKey, string> = {
  str: '力量 STR',
  agi: '敏捷 AGI',
  vit: '體力 VIT',
  int: '智力 INT',
  dex: '靈巧 DEX',
  luk: '幸運 LUK',
};

export enum Rarity {
  Common = 0,
  Uncommon = 1,
  Rare = 2,
  Epic = 3,
  Legendary = 4,
  Mythic = 5,
}

export const RARITY_INFO: Record<Rarity, { name: string; color: string }> = {
  [Rarity.Common]: { name: '普通', color: '#e8e8e8' },
  [Rarity.Uncommon]: { name: '優良', color: '#5fd35f' },
  [Rarity.Rare]: { name: '稀有', color: '#4aa3ff' },
  [Rarity.Epic]: { name: '史詩', color: '#b366ff' },
  [Rarity.Legendary]: { name: '傳說', color: '#ff9f1a' },
  [Rarity.Mythic]: { name: '神話', color: '#ff4d6d' },
};

export type ItemType =
  | 'weapon'
  | 'armor'
  | 'accessory'
  | 'consumable'
  | 'material'
  | 'card'
  | 'scroll'
  | 'tool';

/**
 * 綁定規則（交易經濟的核心）：
 * - tradeable：可自由交易
 * - bindOnEquip：裝備後綁定（取得時可交易，穿上就不能賣）
 * - bound：取得即綁定角色（任務獎勵、新手裝）
 */
export type BindRule = 'tradeable' | 'bindOnEquip' | 'bound';

export type EquipSlot = 'weapon' | 'armor' | 'helm' | 'shield' | 'boots' | 'accessory';

export type ScrollKind = 'weaponEnchant' | 'armorEnchant' | 'blessedWeaponEnchant' | 'blessedArmorEnchant' | 'protection';

export interface ItemDef {
  id: string;
  name: string;
  type: ItemType;
  rarity: Rarity;
  bind: BindRule;
  stackable: boolean;
  maxStack?: number;
  weight: number;
  /** 賣給 NPC 的價格；也是市場參考價的下限 */
  sellPrice: number;
  levelReq?: number;
  slot?: EquipSlot;
  atk?: number;
  matk?: number;
  def?: number;
  bonus?: Partial<Stats>;
  /** 掉寶率加成 (%)，例如幸運飾品 */
  dropBonusPct?: number;
  cardSlots?: number;
  /** 卡片可插入的部位 */
  cardTarget?: EquipSlot;
  heal?: { hp?: number; sp?: number };
  toolKind?: 'pickaxe' | 'axe';
  toolTier?: number;
  scroll?: ScrollKind;
  desc: string;
}

export interface ItemOrigin {
  kind: 'drop' | 'gather' | 'craft' | 'npc' | 'quest' | 'system' | 'split';
  sourceId?: string;
  at: number;
}

/** 物品實例：每一件都有唯一 uid，伺服器可以用來追蹤流向、防止複製 (dupe) */
export interface ItemInstance {
  uid: string;
  defId: string;
  qty: number;
  enchant: number;
  cards: string[];
  bound: boolean;
  origin: ItemOrigin;
  crafter?: string;
}

export function emptyStats(v = 1): Stats {
  return { str: v, agi: v, vit: v, int: v, dex: v, luk: v };
}
