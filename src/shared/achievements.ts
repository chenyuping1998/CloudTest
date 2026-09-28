/**
 * 成就：由伺服器判定並記錄在角色資料中，用戶端收到後顯示通知並同步到 Steam。
 * Steam 後台的成就 API 名稱請與這裡的 id 完全相同。
 */
export interface AchievementDef {
  id: string;
  name: string;
  desc: string;
}

export const ACHIEVEMENTS: AchievementDef[] = [
  { id: 'FIRST_BLOOD', name: '初次討伐', desc: '擊敗第一隻怪物。' },
  { id: 'JOB_CHANGE', name: '踏上旅途', desc: '完成轉職。' },
  { id: 'SECOND_JOB', name: '更上一層樓', desc: '完成二轉。' },
  { id: 'LEVEL_30', name: '獨當一面', desc: 'Base 等級達到 30。' },
  { id: 'LEVEL_50', name: '身經百戰', desc: 'Base 等級達到 50。' },
  { id: 'LEVEL_70', name: '傳奇冒險者', desc: 'Base 等級達到 70。' },
  { id: 'LEVEL_90', name: '深淵的征服者', desc: 'Base 等級達到 90。' },
  { id: 'MVP_LICH', name: '巫妖王的終焉', desc: '參與擊敗骸骨巫妖王。' },
  { id: 'MVP_QUEEN', name: '融化的王冠', desc: '參與擊敗冰霜女王。' },
  { id: 'MVP_EMBER_LORD', name: '熄滅的業火', desc: '參與擊敗餘燼魔王。' },
  { id: 'FIRST_TRADE', name: '第一筆生意', desc: '完成一次玩家交易或交易所買賣。' },
  { id: 'ENCHANT_7', name: '衝裝達人', desc: '將裝備強化到 +7 以上。' },
  { id: 'CARD_COMPOUND', name: '卡片收藏家', desc: '第一次把卡片鑲嵌到裝備上。' },
  { id: 'HOME_LV2', name: '安居樂業', desc: '家園升級到 Lv 2。' },
  { id: 'HOME_LV3', name: '莊園主人', desc: '家園升級到 Lv 3。' },
  { id: 'FROST_ARRIVAL', name: '北方的寒風', desc: '抵達霜語山脈。' },
  { id: 'EMBER_ARRIVAL', name: '墜入深淵', desc: '抵達餘燼深淵。' },
  { id: 'PARTY_UP', name: '同伴', desc: '加入隊伍。' },
  { id: 'MASTER_CRAFTER', name: '工匠', desc: '任一生活技能達到 Lv 20。' },
];

export const ACHIEVEMENT_DB = new Map(ACHIEVEMENTS.map((a) => [a.id, a]));
