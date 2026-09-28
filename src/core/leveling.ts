/**
 * 等級系統：RO 式 Base Level / Job Level 雙軌制。
 * - Base Lv 上限 99，每升一級給素質點，點素質越高越貴（RO 公式）。
 * - Job Lv 上限 50，每升一級給 1 技能點；Job Lv 10 可轉職。
 */
export const MAX_BASE_LEVEL = 99;
export const MAX_JOB_LEVEL = 50;
export const JOB_CHANGE_LEVEL = 10;
export const MAX_STAT = 99;

export function baseExpToNext(level: number): number {
  if (level >= MAX_BASE_LEVEL) return Infinity;
  // 前期快、後期陡：Lv1→2 = 30，Lv50→51 ≈ 11.9 萬，Lv98→99 ≈ 57.5 萬，1→99 總計約 1715 萬
  return Math.floor(12 * Math.pow(level, 2.35) + 18 * level);
}

export function jobExpToNext(level: number): number {
  if (level >= MAX_JOB_LEVEL) return Infinity;
  return Math.floor(15 * Math.pow(level, 2.2) + 20 * level);
}

/** 升到 newLevel 時獲得的素質點 */
export function statPointsForLevel(newLevel: number): number {
  return Math.floor(newLevel / 5) + 3;
}

/** 從 current 點到 current+1 需要的素質點 */
export function statRaiseCost(current: number): number {
  return Math.floor((current - 1) / 10) + 2;
}

/**
 * 等級差 → 經驗倍率。
 * 用練功模擬器校準過：懲罰要夠陡，否則裝備成長後「秒殺低等怪」反而比打同等級怪更有效率，
 * 玩家會一直待在新手區（RO 的經典問題）。打高等怪有獎勵，但風險也高。
 */
export function expLevelModifier(playerLevel: number, monsterLevel: number): number {
  const diff = monsterLevel - playerLevel;
  if (diff >= 16) return 1.4;
  if (diff >= 10) return 1.3;
  if (diff >= 3) return 1.15;
  if (diff >= -5) return 1;
  if (diff >= -10) return 0.7;
  if (diff >= -15) return 0.4;
  if (diff >= -20) return 0.2;
  return 0.05;
}

export interface Progression {
  baseLevel: number;
  baseExp: number;
  jobLevel: number;
  jobExp: number;
  statPoints: number;
  skillPoints: number;
}

export interface LevelUpResult {
  baseLevelsGained: number;
  jobLevelsGained: number;
}

export function addExp(p: Progression, baseExp: number, jobExp: number): LevelUpResult {
  const res: LevelUpResult = { baseLevelsGained: 0, jobLevelsGained: 0 };
  if (p.baseLevel < MAX_BASE_LEVEL) p.baseExp += baseExp;
  while (p.baseLevel < MAX_BASE_LEVEL && p.baseExp >= baseExpToNext(p.baseLevel)) {
    p.baseExp -= baseExpToNext(p.baseLevel);
    p.baseLevel++;
    p.statPoints += statPointsForLevel(p.baseLevel);
    res.baseLevelsGained++;
  }
  if (p.baseLevel >= MAX_BASE_LEVEL) p.baseExp = 0;

  if (p.jobLevel < MAX_JOB_LEVEL) p.jobExp += jobExp;
  while (p.jobLevel < MAX_JOB_LEVEL && p.jobExp >= jobExpToNext(p.jobLevel)) {
    p.jobExp -= jobExpToNext(p.jobLevel);
    p.jobLevel++;
    p.skillPoints++;
    res.jobLevelsGained++;
  }
  if (p.jobLevel >= MAX_JOB_LEVEL) p.jobExp = 0;
  return res;
}

/** 死亡懲罰：扣當前等級所需經驗的 1%（不會降級），天堂/RO 的經典設計 */
export function applyDeathPenalty(p: Progression, ratio = 0.01): number {
  const need = baseExpToNext(p.baseLevel);
  if (!Number.isFinite(need)) return 0;
  const loss = Math.min(p.baseExp, Math.floor(need * ratio));
  p.baseExp -= loss;
  return loss;
}

/** 通用的生活技能經驗曲線（採礦、伐木、鍛造、木工） */
export const MAX_LIFE_SKILL_LEVEL = 50;
export function lifeSkillExpToNext(level: number): number {
  if (level >= MAX_LIFE_SKILL_LEVEL) return Infinity;
  return Math.floor(40 * Math.pow(level, 1.8));
}

export interface LifeSkill {
  level: number;
  exp: number;
}

export function addLifeSkillExp(s: LifeSkill, exp: number): number {
  let gained = 0;
  if (s.level >= MAX_LIFE_SKILL_LEVEL) return 0;
  s.exp += exp;
  while (s.level < MAX_LIFE_SKILL_LEVEL && s.exp >= lifeSkillExpToNext(s.level)) {
    s.exp -= lifeSkillExpToNext(s.level);
    s.level++;
    gained++;
  }
  if (s.level >= MAX_LIFE_SKILL_LEVEL) s.exp = 0;
  return gained;
}

// ============================================================ 節奏保護機制

/**
 * 單次擊殺經驗上限：該等級升級所需的 50%。
 * 防止「高等玩家幫忙打高等怪 / MVP」讓低等角色一口氣跳好幾級（帶練破壞節奏與經濟）。
 */
export const KILL_EXP_CAP_RATIO = 0.5;

export function capKillExp(level: number, exp: number): number {
  const need = baseExpToNext(level);
  return Number.isFinite(need) ? Math.min(exp, Math.floor(need * KILL_EXP_CAP_RATIO)) : 0;
}

/**
 * 休息經驗（Rested EXP）：離線時累積，打怪時額外給與同等經驗（雙倍）直到用完。
 * - 每離線 8 小時累積「目前等級所需經驗」的 20%
 * - 上限為目前等級所需經驗的 150%（約離線 2.5 天就滿）
 * 讓每天只能玩一小時的玩家不會被重度玩家拉開太多，但不影響重度玩家的上限。
 */
export const RESTED_PER_8H = 0.2;
export const RESTED_CAP_RATIO = 1.5;

export function accrueRested(level: number, current: number, offlineHours: number): number {
  const need = baseExpToNext(level);
  if (!Number.isFinite(need) || offlineHours <= 0) return current;
  const gain = need * RESTED_PER_8H * (offlineHours / 8);
  return Math.floor(Math.min(current + gain, need * RESTED_CAP_RATIO));
}

/** 回傳 [這次擊殺的額外經驗, 剩餘休息經驗] */
export function consumeRested(rested: number, killExp: number): [number, number] {
  const bonus = Math.min(rested, killExp);
  return [bonus, rested - bonus];
}
