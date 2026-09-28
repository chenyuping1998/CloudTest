import { Rarity as R, type ItemDef, type EquipSlot, type Stats } from '../core/types';

type Base = Omit<ItemDef, 'type' | 'stackable'>;

const mat = (id: string, name: string, rarity: R, sellPrice: number, weight: number, desc: string): ItemDef => ({
  id, name, type: 'material', rarity, bind: 'tradeable', stackable: true, weight, sellPrice, desc,
});

const potion = (id: string, name: string, rarity: R, sellPrice: number, heal: { hp?: number; sp?: number }, desc: string): ItemDef => ({
  id, name, type: 'consumable', rarity, bind: 'tradeable', stackable: true, weight: 7, sellPrice, heal, desc,
});

const equip = (
  type: 'weapon' | 'armor' | 'accessory',
  slot: EquipSlot,
  b: Omit<Base, 'slot'> & { bonus?: Partial<Stats> },
): ItemDef => ({ ...b, type, slot, stackable: false });

const card = (id: string, name: string, rarity: R, target: EquipSlot, extra: Partial<ItemDef>, desc: string): ItemDef => ({
  id, name, type: 'card', rarity, bind: 'tradeable', stackable: true, weight: 1, sellPrice: 10, cardTarget: target, desc, ...extra,
});

const tool = (id: string, name: string, kind: 'pickaxe' | 'axe', tier: number, rarity: R, sellPrice: number, desc: string): ItemDef => ({
  id, name, type: 'tool', rarity, bind: 'tradeable', stackable: false, weight: 30, sellPrice, toolKind: kind, toolTier: tier, desc,
});

export const ITEMS: ItemDef[] = [
  // ---- 怪物材料 ----
  mat('jelly', '黏稠果凍', R.Common, 3, 1, '果凍史萊姆身上的果凍，是鍊金的基本材料。'),
  mat('spore', '蘑菇孢子', R.Common, 5, 1, '跳跳菇散落的孢子。'),
  mat('wolf_pelt', '灰狼毛皮', R.Common, 12, 2, '粗糙但保暖的毛皮。'),
  mat('wolf_fang', '銳利狼牙', R.Uncommon, 40, 1, '可以用來製作藥劑。'),
  mat('goblin_badge', '哥布林徽章', R.Common, 18, 1, '哥布林部落的身分證明。'),
  mat('bone', '古老骸骨', R.Common, 22, 2, '帶著陰冷氣息的骨頭。'),
  mat('rune_fragment', '符文碎片', R.Rare, 150, 1, '刻有古代文字的碎片，製作強化卷軸的關鍵材料。'),
  mat('golem_core', '魔像核心', R.Uncommon, 90, 5, '仍在微微跳動的石核。'),
  mat('lich_ash', '巫妖之塵', R.Rare, 800, 1, '骸骨巫妖王消散後留下的魔力塵埃。'),
  // ---- 家園原料 ----
  mat('oak_log', '橡木原木', R.Common, 4, 3, '家園砍伐的橡木。'),
  mat('maple_log', '楓木原木', R.Common, 12, 3, '質地細密的楓木。'),
  mat('ancient_branch', '世界樹之枝', R.Epic, 3000, 1, '極少數樹木中蘊藏的神聖樹枝。'),
  mat('copper_ore', '銅礦石', R.Common, 5, 3, '最常見的礦石。'),
  mat('iron_ore', '鐵礦石', R.Common, 14, 3, '鍛造武器的基本礦石。'),
  mat('mithril_ore', '秘銀礦石', R.Uncommon, 60, 3, '輕盈而堅硬的魔法金屬礦。'),
  mat('coal', '煤炭', R.Common, 4, 2, '熔煉用的燃料。'),
  mat('rough_ruby', '紅寶石原石', R.Rare, 400, 1, '未經打磨的紅寶石。'),
  mat('rough_sapphire', '藍寶石原石', R.Rare, 400, 1, '未經打磨的藍寶石。'),
  mat('star_crystal', '星辰結晶', R.Legendary, 20000, 1, '傳說中墜落在礦脈深處的星星碎片。'),
  // ---- 加工品 ----
  mat('copper_ingot', '銅錠', R.Common, 22, 2, '熔煉後的銅。'),
  mat('iron_ingot', '鐵錠', R.Common, 60, 2, '熔煉後的鐵。'),
  mat('mithril_ingot', '秘銀錠', R.Uncommon, 320, 2, '熔煉後的秘銀。'),
  mat('oak_plank', '橡木板', R.Common, 10, 2, '加工過的木板。'),
  mat('maple_plank', '楓木板', R.Common, 30, 2, '加工過的楓木板。'),

  // ---- 消耗品 ----
  potion('apple', '蘋果', R.Common, 3, { hp: 16 }, '恢復少量 HP。'),
  potion('red_potion', '紅色藥水', R.Common, 10, { hp: 45 }, '恢復 45 HP。'),
  potion('orange_potion', '橙色藥水', R.Uncommon, 40, { hp: 120 }, '恢復 120 HP。'),
  potion('white_potion', '白色藥水', R.Rare, 150, { hp: 350 }, '恢復 350 HP。'),
  potion('blue_potion', '藍色藥水', R.Uncommon, 100, { sp: 60 }, '恢復 60 SP。'),

  // ---- 強化卷軸 ----
  { id: 'scroll_weapon', name: '武器強化卷軸', type: 'scroll', rarity: R.Rare, bind: 'tradeable', stackable: true, weight: 1, sellPrice: 300, scroll: 'weaponEnchant', desc: '武器 +1。超過安定值 (+6) 失敗會使武器蒸發。' },
  { id: 'scroll_armor', name: '防具強化卷軸', type: 'scroll', rarity: R.Rare, bind: 'tradeable', stackable: true, weight: 1, sellPrice: 250, scroll: 'armorEnchant', desc: '防具 +1。超過安定值 (+4) 失敗會使防具蒸發。' },
  { id: 'scroll_weapon_blessed', name: '祝福的武器強化卷軸', type: 'scroll', rarity: R.Epic, bind: 'tradeable', stackable: true, weight: 1, sellPrice: 2000, scroll: 'blessedWeaponEnchant', desc: '安定值內有機率一次 +2 ~ +3。' },
  { id: 'scroll_armor_blessed', name: '祝福的防具強化卷軸', type: 'scroll', rarity: R.Epic, bind: 'tradeable', stackable: true, weight: 1, sellPrice: 1800, scroll: 'blessedArmorEnchant', desc: '安定值內有機率一次 +2 ~ +3。' },
  { id: 'scroll_protect', name: '保護卷軸', type: 'scroll', rarity: R.Epic, bind: 'tradeable', stackable: true, weight: 1, sellPrice: 1500, scroll: 'protection', desc: '強化時自動消耗，失敗時改為強化值 -1，裝備不會蒸發。' },

  // ---- 武器 ----
  equip('weapon', 'weapon', { id: 'novice_knife', name: '新手短劍', rarity: R.Common, bind: 'bound', weight: 40, sellPrice: 1, atk: 12, levelReq: 1, desc: '新手的第一把武器。' }),
  equip('weapon', 'weapon', { id: 'knife', name: '短劍', rarity: R.Common, bind: 'tradeable', weight: 40, sellPrice: 25, atk: 17, levelReq: 1, cardSlots: 3, desc: '輕巧的短劍，卡槽很多。' }),
  equip('weapon', 'weapon', { id: 'cutlass', name: '彎刀', rarity: R.Uncommon, bind: 'tradeable', weight: 60, sellPrice: 250, atk: 40, levelReq: 12, cardSlots: 2, desc: '哥布林愛用的彎刀。' }),
  equip('weapon', 'weapon', { id: 'hunter_bow', name: '獵弓', rarity: R.Uncommon, bind: 'tradeable', weight: 50, sellPrice: 200, atk: 38, levelReq: 10, cardSlots: 2, bonus: { dex: 1 }, desc: '獵人常用的短弓。' }),
  equip('weapon', 'weapon', { id: 'oak_staff', name: '橡木法杖', rarity: R.Uncommon, bind: 'tradeable', weight: 40, sellPrice: 220, atk: 15, matk: 45, levelReq: 10, cardSlots: 2, bonus: { int: 2 }, desc: '鑲著藍寶石的法杖。' }),
  equip('weapon', 'weapon', { id: 'longsword', name: '長劍', rarity: R.Uncommon, bind: 'tradeable', weight: 80, sellPrice: 450, atk: 60, levelReq: 18, cardSlots: 2, desc: '騎士團的制式長劍。' }),
  equip('weapon', 'weapon', { id: 'iron_sword', name: '鐵製長劍', rarity: R.Uncommon, bind: 'tradeable', weight: 80, sellPrice: 380, atk: 55, levelReq: 15, cardSlots: 1, desc: '家園鍛造的長劍，會刻上製作者的名字。' }),
  equip('weapon', 'weapon', { id: 'mithril_sword', name: '秘銀長劍', rarity: R.Rare, bind: 'tradeable', weight: 60, sellPrice: 2400, atk: 95, levelReq: 30, cardSlots: 1, desc: '以秘銀鍛造的名劍。' }),
  equip('weapon', 'weapon', { id: 'flame_blade', name: '灼炎魔劍', rarity: R.Epic, bind: 'tradeable', weight: 90, sellPrice: 8000, atk: 130, levelReq: 35, cardSlots: 1, bonus: { str: 3 }, desc: '劍身永遠燃燒著火焰。' }),
  equip('weapon', 'weapon', { id: 'frost_whisper', name: '霜語', rarity: R.Legendary, bind: 'bindOnEquip', weight: 90, sellPrice: 40000, atk: 175, levelReq: 40, cardSlots: 2, bonus: { str: 5, agi: 5 }, desc: '巫妖王生前的佩劍，裝備後綁定。' }),
  equip('weapon', 'weapon', { id: 'lich_scepter', name: '巫妖王權杖', rarity: R.Mythic, bind: 'bindOnEquip', weight: 60, sellPrice: 150000, atk: 40, matk: 220, levelReq: 45, cardSlots: 2, bonus: { int: 10, dex: 5 }, desc: '伺服器中屈指可數的神器，裝備後綁定。' }),

  // ---- 防具 ----
  equip('armor', 'armor', { id: 'cotton_shirt', name: '棉布衣', rarity: R.Common, bind: 'tradeable', weight: 10, sellPrice: 15, def: 5, cardSlots: 1, desc: '普通的衣服。' }),
  equip('armor', 'armor', { id: 'leather_armor', name: '皮甲', rarity: R.Uncommon, bind: 'tradeable', weight: 60, sellPrice: 180, def: 14, levelReq: 8, cardSlots: 1, desc: '輕便的皮甲。' }),
  equip('armor', 'armor', { id: 'chainmail', name: '鎖子甲', rarity: R.Rare, bind: 'tradeable', weight: 150, sellPrice: 900, def: 28, levelReq: 20, cardSlots: 1, desc: '鐵環編織的鎧甲。' }),
  equip('armor', 'armor', { id: 'mithril_armor', name: '秘銀鎧甲', rarity: R.Epic, bind: 'tradeable', weight: 100, sellPrice: 6000, def: 45, levelReq: 30, cardSlots: 1, desc: '只能由高階工匠鍛造的鎧甲。' }),
  equip('armor', 'helm', { id: 'leather_cap', name: '皮帽', rarity: R.Common, bind: 'tradeable', weight: 10, sellPrice: 20, def: 3, desc: '簡單的皮帽。' }),
  equip('armor', 'helm', { id: 'iron_helm', name: '鐵盔', rarity: R.Uncommon, bind: 'tradeable', weight: 40, sellPrice: 300, def: 8, levelReq: 12, cardSlots: 1, desc: '結實的鐵盔。' }),
  equip('armor', 'shield', { id: 'buckler', name: '圓盾', rarity: R.Uncommon, bind: 'tradeable', weight: 60, sellPrice: 200, def: 8, levelReq: 8, cardSlots: 1, desc: '小型圓盾。' }),
  equip('armor', 'boots', { id: 'sandals', name: '涼鞋', rarity: R.Common, bind: 'tradeable', weight: 10, sellPrice: 12, def: 2, cardSlots: 1, desc: '輕便的涼鞋。' }),
  equip('armor', 'boots', { id: 'wind_boots', name: '疾風之靴', rarity: R.Rare, bind: 'tradeable', weight: 20, sellPrice: 1200, def: 6, levelReq: 15, bonus: { agi: 3 }, desc: '穿上後腳步輕盈。' }),
  equip('accessory', 'accessory', { id: 'clover_ring', name: '四葉草戒指', rarity: R.Rare, bind: 'tradeable', weight: 5, sellPrice: 1000, bonus: { luk: 3 }, dropBonusPct: 5, desc: '幸運的戒指，掉寶率 +5%。' }),
  equip('accessory', 'accessory', { id: 'golem_amulet', name: '魔像護符', rarity: R.Epic, bind: 'tradeable', weight: 10, sellPrice: 5000, bonus: { vit: 5 }, def: 3, levelReq: 25, desc: '蘊含大地之力的護符。' }),

  // ---- 卡片（全部 0.01%，可交易；插入後永久鑲嵌）----
  card('card_slime', '果凍史萊姆卡片', R.Epic, 'armor', { bonus: { luk: 2 }, def: 1 }, '鎧甲卡：LUK +2、DEF +1。'),
  card('card_shroom', '跳跳菇卡片', R.Epic, 'helm', { bonus: { int: 2 } }, '頭盔卡：INT +2。'),
  card('card_wolf', '灰狼卡片', R.Epic, 'weapon', { atk: 5, bonus: { str: 1 } }, '武器卡：ATK +5、STR +1。'),
  card('card_goblin', '哥布林卡片', R.Epic, 'shield', { def: 4 }, '盾牌卡：DEF +4。'),
  card('card_skeleton', '骷髏士兵卡片', R.Epic, 'weapon', { atk: 15 }, '武器卡：ATK +15。'),
  card('card_golem', '岩石魔像卡片', R.Epic, 'armor', { def: 5, bonus: { vit: 4 } }, '鎧甲卡：VIT +4、DEF +5。'),
  card('card_lich', '骸骨巫妖王卡片', R.Mythic, 'accessory', { bonus: { int: 5, dex: 5 }, dropBonusPct: 5 }, 'MVP 卡：INT +5、DEX +5、掉寶率 +5%。'),

  // ---- 工具 ----
  tool('stone_pickaxe', '石製礦鎬', 'pickaxe', 1, R.Common, 5, '1 階礦鎬，可以挖銅礦。'),
  tool('iron_pickaxe', '鐵製礦鎬', 'pickaxe', 2, R.Uncommon, 300, '2 階礦鎬，可以挖鐵礦。'),
  tool('mithril_pickaxe', '秘銀礦鎬', 'pickaxe', 3, R.Rare, 2500, '3 階礦鎬，可以挖秘銀礦。'),
  tool('stone_axe', '石斧', 'axe', 1, R.Common, 5, '1 階斧頭，可以砍橡樹。'),
  tool('iron_axe', '鐵斧', 'axe', 2, R.Uncommon, 300, '2 階斧頭，可以砍楓樹。'),
  tool('mithril_axe', '秘銀斧', 'axe', 3, R.Rare, 2500, '3 階斧頭。'),
];

/** NPC 商店（固定價格，是金幣的另一個回收點） */
export const NPC_SHOP: { itemId: string; price: number }[] = [
  { itemId: 'red_potion', price: 50 },
  { itemId: 'blue_potion', price: 600 },
  { itemId: 'stone_pickaxe', price: 100 },
  { itemId: 'stone_axe', price: 100 },
  { itemId: 'knife', price: 250 },
  { itemId: 'cotton_shirt', price: 150 },
];
