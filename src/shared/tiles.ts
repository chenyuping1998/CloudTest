/** 方塊材質名稱（伺服器與用戶端共用，用戶端的 atlas 依此繪製） */
export type TileName =
  | 'grass_top' | 'grass_side' | 'dirt' | 'stone' | 'cobble' | 'sand' | 'gravel' | 'path'
  | 'log_side' | 'log_top' | 'leaves' | 'maple_leaves' | 'planks' | 'dark_planks'
  | 'copper_ore' | 'iron_ore' | 'mithril_ore' | 'coal_ore' | 'water'
  | 'roof' | 'stone_brick' | 'glass' | 'furnace_front' | 'furnace_side' | 'table_top' | 'table_side'
  | 'iron_block' | 'darkstone' | 'portal' | 'tallgrass' | 'flower_red' | 'flower_yellow'
  | 'mushroom_cap' | 'mushroom_stem' | 'moss_stone' | 'bookshelf' | 'hay' | 'wool_white'
  | 'snow_top' | 'snow_side' | 'ice' | 'packed_ice' | 'spruce_log' | 'spruce_leaves' | 'frozen_grass';
