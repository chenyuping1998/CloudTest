/**
 * 掉寶引擎
 * ==========
 * 設計原則（詳見 docs/drop-economy.md）：
 * 1. 每個掉落欄位「獨立擲骰」（RO 式）：一隻怪可能同時掉多樣，也可能什麼都沒有。
 * 2. 另外有「寶箱池」(treasure pool)：觸發後以權重抽一樣，用來放區域共用的裝備。
 * 3. 卡片固定極低機率，只受等級差與官方活動倍率影響，不吃個人掉寶加成。
 * 4. 個人加成 (裝備/LUK/藥水) 有上限，且越稀有的東西加成效率越低，避免稀有品通膨。
 * 5. 等級差懲罰：高等打低等怪掉率大減，避免高等角色洗新手區材料。
 * 6. 可選的保底 (pity)：只用在 MVP 專屬掉落，連續 N 次沒掉之後機率線性上升。
 */
import { PPM, rollPpm, randInt, weightedPick, type Rng } from './rng';
import { Rarity } from './types';
import { getDef, type ItemDb } from './items';

export type DropCategory = 'normal' | 'card' | 'mvp';

export interface DropEntry {
  itemId: string;
  /** 基礎掉率 (ppm) */
  ratePpm: number;
  min?: number;
  max?: number;
  category?: DropCategory;
  /** 保底：連續 startAfter 次沒掉之後，每次再 +stepPpm */
  pity?: { startAfter: number; stepPpm: number };
}

export interface TreasurePoolEntry {
  itemId: string;
  weight: number;
  min?: number;
  max?: number;
}

export interface TreasurePool {
  id: string;
  /** 每次擊殺觸發此寶箱池的機率 (ppm) */
  triggerPpm: number;
  entries: TreasurePoolEntry[];
}

export interface DropProfile {
  sourceId: string;
  drops: DropEntry[];
  pools?: string[];
  /** 只有 MVP 得主 (傷害最高者) 會擲的欄位，直接進背包 */
  mvpDrops?: DropEntry[];
}

export interface DropContext {
  playerLevel: number;
  sourceLevel: number;
  luk: number;
  /** 裝備/藥水等個人掉寶加成 (%) */
  personalBonusPct: number;
  /** 官方活動倍率，例如 2 倍掉寶週末 = 2 */
  eventMultiplier: number;
  isMvpWinner?: boolean;
  /** key = `${sourceId}:${itemId}` 的連續未掉落次數，會被就地更新 */
  pityCounters?: Map<string, number>;
}

export interface DropResult {
  itemId: string;
  qty: number;
  category: DropCategory | 'pool';
  rarity: Rarity;
  baseRatePpm: number;
  finalRatePpm: number;
}

export const DROP_RULES = {
  /** 個人加成總上限 (%)：再多裝備也只能 +100% */
  personalBonusCapPct: 100,
  /** 每 N 點 LUK 給 +1% 掉寶 */
  lukPerPct: 10,
  /** 各稀有度吃個人加成的效率 */
  bonusEfficiency: {
    [Rarity.Common]: 1,
    [Rarity.Uncommon]: 1,
    [Rarity.Rare]: 0.75,
    [Rarity.Epic]: 0.5,
    [Rarity.Legendary]: 0.25,
    [Rarity.Mythic]: 0,
  } as Record<Rarity, number>,
  /** 非必掉物品的最終機率上限 */
  maxRatePpm: 900_000,
  /** 卡片標準掉率 0.01% */
  cardRatePpm: 100,
};

/**
 * 各稀有度的「合法基礎掉率區間」(ppm)。資料表必須通過 validateDropProfile，
 * 企劃填錯數字（例如把傳說武器填成 5%）在測試階段就會被擋下來。
 */
export const RARITY_RATE_BANDS: Record<Rarity, [number, number]> = {
  [Rarity.Common]: [10_000, PPM],
  [Rarity.Uncommon]: [5_000, 300_000],
  [Rarity.Rare]: [500, 50_000],
  [Rarity.Epic]: [50, 5_000],
  [Rarity.Legendary]: [5, 500],
  [Rarity.Mythic]: [1, 100],
};

/** 等級差 → 掉率倍率（正值 = 怪物比玩家高） */
export function dropLevelModifier(playerLevel: number, sourceLevel: number): number {
  const diff = sourceLevel - playerLevel;
  if (diff >= -5) return 1;
  if (diff >= -10) return 0.9;
  if (diff >= -15) return 0.75;
  if (diff >= -20) return 0.5;
  if (diff >= -30) return 0.3;
  return 0.1;
}

export function personalBonusPct(ctx: Pick<DropContext, 'luk' | 'personalBonusPct'>): number {
  const raw = ctx.personalBonusPct + Math.floor(ctx.luk / DROP_RULES.lukPerPct);
  return Math.min(Math.max(raw, 0), DROP_RULES.personalBonusCapPct);
}

export function finalRatePpm(entry: DropEntry, rarity: Rarity, ctx: DropContext): number {
  if (entry.ratePpm >= PPM) return PPM;
  const category = entry.category ?? 'normal';
  let rate = entry.ratePpm;

  if (category !== 'card') {
    const eff = DROP_RULES.bonusEfficiency[rarity];
    rate *= 1 + (personalBonusPct(ctx) / 100) * eff;
  }
  rate *= dropLevelModifier(ctx.playerLevel, ctx.sourceLevel);
  rate *= ctx.eventMultiplier;
  return Math.min(rate, DROP_RULES.maxRatePpm);
}

function pityKey(sourceId: string, itemId: string): string {
  return `${sourceId}:${itemId}`;
}

function rateWithPity(profile: DropProfile, entry: DropEntry, rarity: Rarity, ctx: DropContext): number {
  let rate = finalRatePpm(entry, rarity, ctx);
  if (entry.pity && ctx.pityCounters) {
    const misses = ctx.pityCounters.get(pityKey(profile.sourceId, entry.itemId)) ?? 0;
    const over = misses - entry.pity.startAfter;
    if (over > 0) rate = Math.min(rate + over * entry.pity.stepPpm, DROP_RULES.maxRatePpm);
  }
  return rate;
}

function rollEntry(
  profile: DropProfile,
  entry: DropEntry,
  db: ItemDb,
  ctx: DropContext,
  rng: Rng,
  out: DropResult[],
): void {
  const rarity = getDef(db, entry.itemId).rarity;
  const rate = rateWithPity(profile, entry, rarity, ctx);
  const hit = rollPpm(rng, rate);
  if (entry.pity && ctx.pityCounters) {
    const key = pityKey(profile.sourceId, entry.itemId);
    ctx.pityCounters.set(key, hit ? 0 : (ctx.pityCounters.get(key) ?? 0) + 1);
  }
  if (!hit) return;
  out.push({
    itemId: entry.itemId,
    qty: randInt(rng, entry.min ?? 1, entry.max ?? entry.min ?? 1),
    category: entry.category ?? 'normal',
    rarity,
    baseRatePpm: entry.ratePpm,
    finalRatePpm: rate,
  });
}

export function rollDrops(
  profile: DropProfile,
  db: ItemDb,
  pools: ReadonlyMap<string, TreasurePool>,
  ctx: DropContext,
  rng: Rng,
): DropResult[] {
  const out: DropResult[] = [];
  for (const entry of profile.drops) rollEntry(profile, entry, db, ctx, rng, out);

  for (const poolId of profile.pools ?? []) {
    const pool = pools.get(poolId);
    if (!pool) throw new Error(`unknown treasure pool: ${poolId}`);
    // 寶箱池的觸發率視為「普通」稀有度吃加成；池內稀有度由權重控制
    const trigger = finalRatePpm({ itemId: poolId, ratePpm: pool.triggerPpm }, Rarity.Common, ctx);
    if (!rollPpm(rng, trigger)) continue;
    const pick = weightedPick(rng, pool.entries);
    out.push({
      itemId: pick.itemId,
      qty: randInt(rng, pick.min ?? 1, pick.max ?? pick.min ?? 1),
      category: 'pool',
      rarity: getDef(db, pick.itemId).rarity,
      baseRatePpm: poolEntryRatePpm(pool, pick.itemId),
      finalRatePpm: trigger * (pick.weight / totalWeight(pool)),
    });
  }

  if (ctx.isMvpWinner) {
    for (const entry of profile.mvpDrops ?? []) rollEntry(profile, { ...entry, category: 'mvp' }, db, ctx, rng, out);
  }
  return out;
}

function totalWeight(pool: TreasurePool): number {
  return pool.entries.reduce((s, e) => s + e.weight, 0);
}

/** 寶箱池中某物品的「等效基礎掉率」= 觸發率 × 權重占比 */
export function poolEntryRatePpm(pool: TreasurePool, itemId: string): number {
  const w = pool.entries.filter((e) => e.itemId === itemId).reduce((s, e) => s + e.weight, 0);
  return pool.triggerPpm * (w / totalWeight(pool));
}

/** 期望擊殺數 = 1 / p；取得機率 50%/90% 所需擊殺數用幾何分布算 */
export function killsForConfidence(ratePpm: number, confidence: number): number {
  const p = ratePpm / PPM;
  if (p >= 1) return 1;
  if (p <= 0) return Infinity;
  return Math.ceil(Math.log(1 - confidence) / Math.log(1 - p));
}

export interface DropValidationIssue {
  sourceId: string;
  itemId: string;
  message: string;
}

export function validateDropProfile(
  profile: DropProfile,
  db: ItemDb,
  pools: ReadonlyMap<string, TreasurePool>,
): DropValidationIssue[] {
  const issues: DropValidationIssue[] = [];
  const check = (entry: DropEntry) => {
    const def = db.get(entry.itemId);
    if (!def) {
      issues.push({ sourceId: profile.sourceId, itemId: entry.itemId, message: '物品不存在' });
      return;
    }
    const category = entry.category ?? 'normal';
    if (category === 'card' || def.type === 'card') {
      if (entry.ratePpm !== DROP_RULES.cardRatePpm) {
        issues.push({ sourceId: profile.sourceId, itemId: entry.itemId, message: `卡片掉率必須是 ${DROP_RULES.cardRatePpm} ppm` });
      }
      if (category !== 'card' && category !== 'mvp') {
        issues.push({ sourceId: profile.sourceId, itemId: entry.itemId, message: '卡片欄位必須標記 category: card' });
      }
      return;
    }
    if (entry.ratePpm >= PPM) return; // 必掉（任務物品、MVP 保證獎勵）
    const [lo, hi] = RARITY_RATE_BANDS[def.rarity];
    if (entry.ratePpm < lo || entry.ratePpm > hi) {
      issues.push({
        sourceId: profile.sourceId,
        itemId: entry.itemId,
        message: `稀有度 ${Rarity[def.rarity]} 的掉率應介於 ${lo}~${hi} ppm，目前 ${entry.ratePpm}`,
      });
    }
    if (entry.pity && category !== 'mvp') {
      issues.push({ sourceId: profile.sourceId, itemId: entry.itemId, message: '保底機制只允許用在 MVP 欄位' });
    }
  };
  profile.drops.forEach(check);
  (profile.mvpDrops ?? []).forEach((e) => check({ ...e, category: e.category ?? 'mvp' }));
  for (const poolId of profile.pools ?? []) {
    const pool = pools.get(poolId);
    if (!pool) {
      issues.push({ sourceId: profile.sourceId, itemId: poolId, message: '寶箱池不存在' });
      continue;
    }
    // 寶箱池只檢查上限：池子是「額外」的機會，不能讓稀有品變得比單獨欄位更容易拿
    for (const e of pool.entries) {
      const def = db.get(e.itemId);
      if (!def) {
        issues.push({ sourceId: poolId, itemId: e.itemId, message: '物品不存在' });
        continue;
      }
      const eq = poolEntryRatePpm(pool, e.itemId);
      const hi = RARITY_RATE_BANDS[def.rarity][1];
      if (eq > hi) issues.push({ sourceId: poolId, itemId: e.itemId, message: `寶箱池等效掉率 ${Math.round(eq)} ppm 超過 ${Rarity[def.rarity]} 上限 ${hi}` });
    }
  }
  return issues;
}

/**
 * 考慮保底後的取得分布：回傳「期望擊殺數」與達到指定信心水準所需的擊殺數。
 * 以數值方式逐次累加 CDF（保底會讓機率逐次上升，不再是幾何分布）。
 */
export function pityKillStats(entry: DropEntry, confidence: number[] = [0.5, 0.9]): { expected: number; atConfidence: number[] } {
  const results = confidence.map(() => Infinity);
  let notYet = 1;
  let expected = 0;
  for (let k = 1; k <= 10_000_000 && notYet > 1e-9; k++) {
    const misses = k - 1;
    const over = entry.pity ? misses - entry.pity.startAfter : 0;
    const ppm = Math.min(entry.ratePpm + (over > 0 ? over * entry.pity!.stepPpm : 0), entry.ratePpm >= PPM ? PPM : DROP_RULES.maxRatePpm);
    const p = ppm / PPM;
    expected += notYet; // E[K] = Σ P(K ≥ k)
    notYet *= 1 - p;
    confidence.forEach((c, i) => {
      if (results[i] === Infinity && 1 - notYet >= c) results[i] = k;
    });
  }
  return { expected, atConfidence: results };
}
