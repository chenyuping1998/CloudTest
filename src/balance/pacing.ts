/**
 * 練功節奏模擬器
 * ================
 * 用「遊戲真正的戰鬥公式」估算：一個照正常方式配點、穿著該等級合理裝備的玩家，
 * 在每個等級選擇效率最好的怪物時，每小時能拿多少經驗、升一級要多久。
 *
 * 模型（每隻怪的循環時間）：
 *   擊殺時間 TTK  = 怪物 HP ÷ 玩家期望 DPS（含命中率、爆擊、防禦減傷）
 *   受到傷害      = 怪物期望 DPS × TTK
 *   休息時間      = 受到傷害 ÷ 脫戰回血速度
 *   找怪時間      = 固定秒數（地圖密度）
 *   經驗/小時     = 3600 ÷ (TTK + 休息 + 找怪) × 怪物經驗 × 等級差倍率 × 玩家效率
 * 企劃調整怪物數值或經驗曲線後跑 `npm run sim:leveling`，測試會檢查是否仍落在目標區間。
 */
import { newCharacter, type Character } from '../core/character';
import { defReduction, hitChance } from '../core/combat';
import { enchantAtkBonus } from '../core/enchant';
import { createItem, getDef, UidGen } from '../core/items';
import { baseExpToNext, expLevelModifier, jobExpToNext, JOB_CHANGE_LEVEL, MAX_BASE_LEVEL, MAX_JOB_LEVEL, statRaiseCost } from '../core/leveling';
import type { StatKey } from '../core/types';
import { ITEM_DB, MONSTERS } from '../data';
import { partyBonus } from '../core/party';
import type { MonsterDef } from '../data/monsters';

export interface PacingOptions {
  /** 玩家操作效率（1 = 最佳化練功；一般玩家約 0.6） */
  efficiency: number;
  /** 兩隻怪之間的平均移動 / 找怪秒數 */
  searchSec: number;
  /** 一場戰鬥最多允許損失的 HP 比例，超過就視為打不動 */
  maxHpLossPerKill: number;
}

export const DEFAULT_PACING: PacingOptions = { efficiency: 0.6, searchSec: 4, maxHpLossPerKill: 0.7 };

/**
 * 各等級「合理的」裝備：只用當時容易取得的東西（掉落 / 家園製作 / 交易所常見品），
 * 不計入稀有高強化裝備，代表一般玩家。
 */
const GEAR_BY_LEVEL: { lv: number; weapon: string; enchant: number; armor: string[] }[] = [
  { lv: 1, weapon: 'novice_knife', enchant: 0, armor: ['cotton_shirt'] },
  { lv: 5, weapon: 'knife', enchant: 2, armor: ['cotton_shirt', 'leather_cap', 'sandals'] },
  { lv: 12, weapon: 'cutlass', enchant: 3, armor: ['leather_armor', 'leather_cap', 'sandals', 'buckler'] },
  { lv: 18, weapon: 'longsword', enchant: 4, armor: ['leather_armor', 'iron_helm', 'sandals', 'buckler'] },
  { lv: 22, weapon: 'longsword', enchant: 5, armor: ['chainmail', 'iron_helm', 'wind_boots', 'buckler'] },
  { lv: 30, weapon: 'mithril_sword', enchant: 5, armor: ['mithril_armor', 'iron_helm', 'wind_boots', 'buckler'] },
  { lv: 38, weapon: 'flame_blade', enchant: 6, armor: ['mithril_armor', 'iron_helm', 'wind_boots', 'buckler', 'golem_amulet'] },
  { lv: 44, weapon: 'flame_blade', enchant: 7, armor: ['mithril_armor', 'iron_helm', 'wind_boots', 'buckler', 'golem_amulet'] },
];

/** 近戰劍士的配點比例（依序投點，每點依 RO 公式計價） */
const BUILD: [StatKey, number][] = [['str', 0.38], ['agi', 0.27], ['dex', 0.2], ['vit', 0.15]];

export function simulatedCharacter(level: number, jobLevel: number, classId: 'novice' | 'swordsman'): Character {
  const uids = new UidGen('sim');
  const ch = newCharacter('sim', ITEM_DB, uids);
  ch.data.classId = classId;
  ch.data.progression.baseLevel = level;
  ch.data.progression.jobLevel = jobLevel;
  let points = 48;
  for (let l = 2; l <= level; l++) points += Math.floor(l / 5) + 3;
  // 依目標比例分配：每次把點數給「目前最低於目標比例」的素質
  const spent: Record<StatKey, number> = { str: 0, agi: 0, vit: 0, int: 0, dex: 0, luk: 0 };
  for (;;) {
    const total = Object.values(spent).reduce((s, v) => s + v, 0) || 1;
    const [key] = [...BUILD].sort((a, b) => spent[a[0]] / total - a[1] - (spent[b[0]] / total - b[1]))[0];
    const cost = statRaiseCost(ch.data.stats[key]);
    if (cost > points || ch.data.stats[key] >= 99) break;
    points -= cost;
    spent[key] += cost;
    ch.data.stats[key]++;
  }
  const gear = [...GEAR_BY_LEVEL].reverse().find((g) => g.lv <= level)!;
  ch.data.equipment = {};
  for (const id of [gear.weapon, ...gear.armor]) {
    const def = getDef(ITEM_DB, id);
    const it = createItem(ITEM_DB, uids, id, 1, { kind: 'system', at: 0 });
    if (def.slot === 'weapon') it.enchant = gear.enchant;
    ch.data.equipment[def.slot!] = it;
  }
  const d = ch.derived();
  ch.data.hp = d.maxHp;
  void enchantAtkBonus;
  return ch;
}

export interface FightEstimate {
  monster: MonsterDef;
  ttkSec: number;
  hpLossPerKill: number;
  restSec: number;
  cycleSec: number;
  baseExpPerHour: number;
  jobExpPerHour: number;
  viable: boolean;
}

/** 期望傷害（與 resolveAttack 相同的公式，取期望值） */
function expectedDamage(atk: number, hit: number, critPct: number, targetDef: number, targetFlee: number): number {
  const crit = Math.min(1, critPct / 100);
  const normal = (1 - crit) * hitChance(hit, targetFlee) * atk * defReduction(targetDef);
  return Math.max(0.05, crit * atk * 1.4 + normal);
}

export function estimateFight(ch: Character, m: MonsterDef, opts: PacingOptions): FightEstimate {
  const d = ch.derived();
  const pDps = expectedDamage(d.atk, d.hit, d.critPct, m.def, m.flee) * d.attacksPerSec;
  const ttk = m.hp / pDps;
  const mDps = expectedDamage(m.atk, m.hit, 1, d.def, d.flee) * m.attacksPerSec;
  const hpLoss = mDps * ttk;
  // 脫戰回血：每 2 秒 3% 最大 HP + VIT/5（與伺服器相同）
  const regenPerSec = (d.maxHp * 0.03 + d.totalStats.vit / 5) / 2;
  const restSec = hpLoss / regenPerSec;
  const cycle = ttk + restSec + opts.searchSec;
  const mod = expLevelModifier(ch.progression.baseLevel, m.level);
  const kph = (3600 / cycle) * opts.efficiency;
  return {
    monster: m,
    ttkSec: ttk,
    hpLossPerKill: hpLoss / d.maxHp,
    restSec,
    cycleSec: cycle,
    baseExpPerHour: kph * m.baseExp * mod,
    jobExpPerHour: kph * m.jobExp * mod,
    viable: hpLoss < d.maxHp * opts.maxHpLossPerKill && !m.mvp,
  };
}

export interface LevelRow {
  level: number;
  jobLevel: number;
  classId: string;
  best: FightEstimate;
  hoursThisLevel: number;
  cumulativeHours: number;
}

/** 模擬 1 → maxLevel 的完整練功過程（Base 與 Job 同時累積，Job 10 自動轉職） */
export function simulateLeveling(maxLevel = MAX_BASE_LEVEL, opts: PacingOptions = DEFAULT_PACING): LevelRow[] {
  const rows: LevelRow[] = [];
  let cumulative = 0;
  let jobLevel = 1;
  let jobExp = 0;
  let classId: 'novice' | 'swordsman' = 'novice';
  for (let lv = 1; lv < maxLevel; lv++) {
    const ch = simulatedCharacter(lv, jobLevel, classId);
    const fights = MONSTERS.map((m) => estimateFight(ch, m, opts)).filter((f) => f.viable);
    const best = fights.sort((a, b) => b.baseExpPerHour - a.baseExpPerHour)[0];
    const hours = baseExpToNext(lv) / best.baseExpPerHour;
    cumulative += hours;
    // 同一段時間內獲得的 Job 經驗
    jobExp += best.jobExpPerHour * hours;
    while (jobLevel < MAX_JOB_LEVEL && jobExp >= jobExpToNext(jobLevel)) {
      jobExp -= jobExpToNext(jobLevel);
      jobLevel++;
      if (classId === 'novice' && jobLevel >= JOB_CHANGE_LEVEL) {
        classId = 'swordsman';
        jobLevel = 1;
        jobExp = 0;
      }
    }
    rows.push({ level: lv, jobLevel, classId, best, hoursThisLevel: hours, cumulativeHours: cumulative });
  }
  return rows;
}

/**
 * 驗收區間：模擬結果必須落在目標曲線的 ±30% 之內（每 5 級檢查一次）。
 * 只檢查到「現有內容支援的等級」；之後的等級要等新地圖上線再開放檢查。
 */
export const CONTENT_LEVEL_CAP = 50;
export const PACING_TOLERANCE = 0.3;
export const PACING_CHECKPOINTS = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50];

export const MILESTONE_NOTES: Record<number, string> = {
  10: '第一晚就能轉職（約 1 小時）',
  20: '一個週末：換上第一套中階裝備',
  30: '約兩週（每天 1~2 小時）：挑戰魔像、製作秘銀',
  40: '約一個月：接近 MVP 挑戰等級',
  50: '現有內容上限，之後需要第二張地圖',
};

// ============================================================ 目標曲線與怪物經驗校準

/**
 * 目標：一般玩家（效率 0.6）升到 L+1 需要的小時數 T(L) = a × L^p。
 * 參數由兩個錨點決定：Lv 10 累積約 1 小時、Lv 99 累積約 1200 小時（MMO 長期目標）。
 * 累積時數 ≈ a × L^(p+1) / (p+1) → Lv 20 ≈ 8.5 時、Lv 30 ≈ 30 時、Lv 40 ≈ 72 時、Lv 50 ≈ 145 時。
 */
const CURVE_P = 2.09;
const CURVE_A = 0.00251;

export function targetHoursForLevel(level: number): number {
  return CURVE_A * Math.pow(level, CURVE_P);
}

export function targetCumulativeHours(level: number): number {
  let h = 0;
  for (let l = 1; l < level; l++) h += targetHoursForLevel(l);
  return h;
}

/** 該等級應該有的「每小時 Base 經驗」 */
export function targetExpPerHour(level: number): number {
  return baseExpToNext(level) / targetHoursForLevel(level);
}

/**
 * 校正係數：實際上玩家會在「略低於自己等級」的怪物上多待一陣子（裝備領先時打得更快），
 * 整體速度比單點校準快約 20%，因此統一乘上此係數。由模擬器回歸得出。
 */
export const CALIBRATION_FACTOR = 0.82;

/** Job 經驗與 Base 經驗的比例：讓初心者在 Base Lv 9~10 附近達到 Job 10（轉職） */
export const JOB_EXP_RATIO = 0.72;

/**
 * 依目標曲線反推一隻怪物「公平」的經驗值：
 * 以「比怪物高 2 級、穿著該等級合理裝備」的玩家為基準，量出實際擊殺循環時間，
 * 再乘上該等級應有的每小時經驗。新增怪物時用這個函式定數值，就不會打亂整體節奏。
 */
export function suggestMonsterExp(m: MonsterDef, opts: PacingOptions = DEFAULT_PACING): { baseExp: number; jobExp: number; refLevel: number; cycleSec: number } {
  const refLevel = Math.max(1, m.level + 2);
  const cls = refLevel >= 11 ? 'swordsman' : 'novice';
  const ch = simulatedCharacter(refLevel, cls === 'novice' ? Math.min(9, refLevel) : Math.min(50, refLevel - 10), cls);
  const f = estimateFight(ch, m, opts);
  const killsPerHour = (3600 / f.cycleSec) * opts.efficiency;
  const baseExp = Math.max(1, Math.round((targetExpPerHour(refLevel) / killsPerHour / expLevelModifier(refLevel, m.level)) * CALIBRATION_FACTOR));
  return { baseExp, jobExp: Math.max(1, Math.round(baseExp * JOB_EXP_RATIO)), refLevel, cycleSec: f.cycleSec };
}

// ============================================================ 組隊節奏

/**
 * 同等級 n 人隊伍在最佳練功點時，每位成員的每小時經驗 ÷ 單人的每小時經驗。
 * 模型：輸出 ×n（擊殺時間 ÷n）、休息時間略增（坦克承受較多）、找怪時間 ÷√n（分散找怪、集體拉怪），
 * 經驗平分並有人數加成。找怪時間仍是瓶頸，所以人越多邊際效益越低（符合地圖密度的限制）。
 */
export function partyEfficiency(level: number, size: number, opts: PacingOptions = DEFAULT_PACING): number {
  const cls = level >= 11 ? 'swordsman' : 'novice';
  const ch = simulatedCharacter(level, cls === 'novice' ? Math.min(9, level) : Math.min(50, level - 10), cls);
  let bestSolo = 0;
  let bestParty = 0;
  for (const m of MONSTERS) {
    if (m.mvp) continue;
    const f = estimateFight(ch, m, opts);
    const mod = expLevelModifier(level, m.level);
    if (f.viable) bestSolo = Math.max(bestSolo, f.baseExpPerHour);
    // 隊伍可以挑戰單人打不動的怪（坦補分工），但受到的傷害仍需休息回復
    const ttk = f.ttkSec / size;
    const rest = (f.restSec / size) * 1.2;
    // 隊伍分散找怪、一起拉怪，找怪時間約以 √n 縮短
    const cycle = ttk + rest + opts.searchSec / Math.sqrt(size);
    const perMember = ((3600 / cycle) * opts.efficiency * m.baseExp * mod * partyBonus(size)) / size;
    if (f.hpLossPerKill / size < opts.maxHpLossPerKill) bestParty = Math.max(bestParty, perMember);
  }
  return bestParty / bestSolo;
}
