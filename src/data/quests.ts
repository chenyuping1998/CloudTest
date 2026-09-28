/**
 * 任務資料：新手教學主線（帶玩家認識每個系統）與每日討伐委託。
 *
 * 經驗獎勵刻意壓低：主線總共約等於 Lv 1~10 所需經驗的 10%，
 * 每日委託約等於「多打 15 隻目標怪」，不會打亂 docs/leveling.md 的練功節奏。
 * 獎勵以金幣、藥水、卷軸為主。
 */
import type { NpcId, ZoneId } from '../shared/maps';
import { MONSTER_DB } from './monsters';

export type QuestObjective =
  | { kind: 'kill'; monster: string; count: number }
  /** 交任務時背包裡要有；consume = 交出去 */
  | { kind: 'collect'; item: string; count: number; consume: boolean }
  | { kind: 'craft'; recipe: string; count: number }
  | { kind: 'visit'; zone: ZoneId }
  | { kind: 'talk'; npc: NpcId }
  /** 職業階級（1 = 一轉、2 = 二轉） */
  | { kind: 'tier'; tier: number };

export interface QuestReward {
  baseExp?: number;
  jobExp?: number;
  gold?: number;
  items?: [string, number][];
}

export interface QuestDef {
  id: string;
  name: string;
  giver: NpcId;
  /** 接任務時 NPC 說的話 */
  story: string;
  /** 一句話提示下一步要做什麼（追蹤列顯示） */
  hint: string;
  objectives: QuestObjective[];
  reward: QuestReward;
  requires?: { quest?: string; level?: number; maxLevel?: number; tier?: number };
  /** 每日委託：每天（台灣時間 0 點重置）可以完成一次 */
  daily?: boolean;
}

export const MAX_ACTIVE_QUESTS = 10;

const main: QuestDef[] = [
  {
    id: 'q_welcome', name: '初來乍到', giver: 'guide',
    story: '歡迎來到餘燼王國！先去廣場上找道具商人瑪莉打個招呼吧，她會照顧新來的冒險者。',
    hint: '和道具商人 瑪莉 說話，再回來找露娜',
    objectives: [{ kind: 'talk', npc: 'shop' }],
    reward: { gold: 100, items: [['red_potion', 10]] },
  },
  {
    id: 'q_first_hunt', name: '第一次狩獵', giver: 'guide', requires: { quest: 'q_welcome' },
    story: '城外的果凍史萊姆最近多了起來。點一下怪物就會自動攻擊，按空白鍵會打最近的怪物。去打倒 5 隻吧！',
    hint: '在城外打倒果凍史萊姆',
    objectives: [{ kind: 'kill', monster: 'jelly_slime', count: 5 }],
    reward: { baseExp: 120, jobExp: 90, gold: 200 },
  },
  {
    id: 'q_jelly', name: '果凍收集', giver: 'guide', requires: { quest: 'q_first_hunt' },
    story: '史萊姆掉下來的果凍是鍊金的材料。掉在地上的東西點一下或按 Z 就能撿。幫我收集 8 個好嗎？',
    hint: '收集黏稠果凍（按 Z 撿取）',
    objectives: [{ kind: 'collect', item: 'jelly', count: 8, consume: true }],
    reward: { baseExp: 150, jobExp: 110, items: [['orange_potion', 5]] },
  },
  {
    id: 'q_home', name: '我的家園', giver: 'guide', requires: { quest: 'q_jelly' },
    story: '每位冒險者在王國都有一塊自己的土地。從廣場旁的紫色傳送門回去看看吧（按 H 可以查看家園資訊）。',
    hint: '走進通往家園的傳送門',
    objectives: [{ kind: 'visit', zone: 'homestead' }],
    reward: { gold: 300 },
  },
  {
    id: 'q_wood', name: '伐木入門', giver: 'guide', requires: { quest: 'q_home' },
    story: '家園裡的樹可以用斧頭砍（點一下樹）。先砍 6 根橡木原木回來。',
    hint: '在家園砍橡木（背包要有斧頭）',
    objectives: [{ kind: 'collect', item: 'oak_log', count: 6, consume: false }],
    reward: { baseExp: 200, jobExp: 150, gold: 200 },
  },
  {
    id: 'q_plank', name: '木工入門', giver: 'guide', requires: { quest: 'q_wood' },
    story: '把原木拿到家園的木工台（點一下設施）做成橡木板。之後的家具、法杖都要用到。',
    hint: '在家園的木工台製作橡木板',
    objectives: [{ kind: 'craft', recipe: 'plank_oak', count: 3 }],
    reward: { baseExp: 250, jobExp: 200, gold: 300, items: [['orange_potion', 5]] },
  },
  {
    id: 'q_job', name: '踏上旅途', giver: 'guide', requires: { quest: 'q_plank' },
    story: 'Job 等級到 10 就能轉職了。按 S 打開角色視窗，選擇你想走的路：劍士、弓箭手、法師或商人。',
    hint: 'Job Lv 10 後在角色視窗（S）轉職',
    objectives: [{ kind: 'tier', tier: 1 }],
    reward: { gold: 1000, items: [['scroll_weapon', 2], ['scroll_armor', 2]] },
  },
  {
    id: 'q_market', name: '交易所', giver: 'guide', requires: { quest: 'q_job' },
    story: '戴著王冠的奧斯卡管理交易所，全服玩家都在那裡買賣寶物。去認識他一下。',
    hint: '和交易所管理員 奧斯卡 說話',
    objectives: [{ kind: 'talk', npc: 'market' }],
    reward: { gold: 500 },
  },
  {
    id: 'q_storage', name: '倉庫', giver: 'guide', requires: { quest: 'q_market' },
    story: '背包負重超過一半就不會自然回復，超過九成甚至無法戰鬥。找倉庫管理員葛倫把用不到的東西存起來吧。',
    hint: '和倉庫管理員 葛倫 說話',
    objectives: [{ kind: 'talk', npc: 'storage' }],
    reward: { gold: 500, items: [['white_potion', 3]] },
  },
  {
    id: 'q_second_job', name: '更上一層樓', giver: 'guide', requires: { quest: 'q_storage', tier: 1 },
    story: 'Job 等級 40 就能二轉，實力會大幅提升。別忘了在技能視窗（K）先看看二轉技能怎麼點。',
    hint: 'Job Lv 40 後在角色視窗（S）二轉',
    objectives: [{ kind: 'tier', tier: 2 }],
    reward: { gold: 5000, items: [['scroll_weapon_blessed', 1], ['scroll_protect', 1]] },
  },
  {
    id: 'q_frost', name: '北方的寒風', giver: 'guide', requires: { quest: 'q_storage', level: 50 },
    story: '晨曦平原邊緣有一道傳送門通往霜語山脈（小地圖上的紫點），那裡的怪物比平原強得多。準備好了就出發吧。',
    hint: '從晨曦平原的傳送門前往霜語山脈（小地圖紫點）',
    objectives: [{ kind: 'visit', zone: 'frost' }],
    reward: { gold: 3000, items: [['white_potion', 10], ['scroll_protect', 1]] },
  },
  {
    id: 'q_ember', name: '墜入深淵', giver: 'guide', requires: { quest: 'q_frost', level: 70 },
    story: '霜語山脈的盡頭有一道冒著熱氣的傳送門……餘燼深淵，傳說餘燼魔王就在那裡。',
    hint: '從霜語山脈的傳送門前往餘燼深淵（小地圖紫點）',
    objectives: [{ kind: 'visit', zone: 'ember' }],
    reward: { gold: 8000, items: [['scroll_protect', 2]] },
  },
];

/** 每日討伐：依等級區間選目標怪，打 30 隻 */
const BOUNTIES: [string, number, number][] = [
  ['jelly_slime', 1, 9], ['grey_wolf', 8, 18], ['goblin', 13, 25], ['skeleton', 20, 32], ['rock_golem', 28, 40],
  ['shadow_knight', 35, 50], ['snow_wolf', 48, 58], ['frost_skeleton', 58, 70], ['ember_imp', 68, 80], ['ember_knight', 78, 99],
];

const bounties: QuestDef[] = BOUNTIES.map(([monster, lo, hi]) => {
  const m = MONSTER_DB.get(monster)!;
  const potion = m.level < 20 ? 'orange_potion' : 'white_potion';
  return {
    id: `d_${monster}`, name: `討伐：${m.name}`, giver: 'guide', daily: true,
    requires: { quest: 'q_first_hunt', level: lo, maxLevel: hi },
    story: `王國發布了討伐令：${m.name}（Lv ${m.level}）數量太多了，請幫忙清除 30 隻。每天可以接一次。`,
    hint: `打倒 ${m.name}`,
    objectives: [{ kind: 'kill', monster, count: 30 }],
    reward: {
      baseExp: m.baseExp * 15,
      jobExp: m.jobExp * 15,
      gold: Math.round(80 * Math.pow(m.level, 1.25)),
      items: [[potion, 5], ...(m.level >= 30 ? [['scroll_weapon', 1] as [string, number]] : [])],
    },
  };
});

export const QUESTS: QuestDef[] = [...main, ...bounties];
export const QUEST_DB = new Map(QUESTS.map((q) => [q.id, q]));
