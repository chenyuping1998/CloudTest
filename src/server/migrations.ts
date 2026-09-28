/**
 * 存檔版本與遷移。
 *
 * 上線後資料結構一定會變（新欄位、改名、刪除物品）。所有存檔都帶 version，
 * 讀取時依序套用 MIGRATIONS，把舊檔升到 SAVE_VERSION 再交給遊戲；
 * 最後一定跑 sanitize：任何不認得的東西（已刪除的物品、職業、技能）都會被安全地移除或換成替代品，
 * 絕對不讓一個舊存檔害伺服器在 getDef() 拋錯、讓玩家無法登入。
 *
 * 新增遷移的方法：在 MIGRATIONS 最後加一筆 { to: N, run }，並把 SAVE_VERSION 改成 N。
 * 已上線的遷移不可修改（舊存檔可能還沒跑過）。
 */
import { STORAGE_CAPACITY, type CharacterData } from '../core/character';
import type { HomesteadData, StationId } from '../core/homestead';
import type { ItemInstance, StatKey } from '../core/types';
import { STAT_KEYS } from '../core/types';
import { CLASSES, ITEM_DB, NODE_DB, STATION_MAX_LEVEL, STATION_NAMES } from '../data';
import { SKILL_DB } from '../data/skills';
import type { AccountRecord, WorldRecord } from './GameServer';

export const SAVE_VERSION = 2;

/** 物品改名對照：舊 id → 新 id（刪除改名後的舊物品時在這裡登記，玩家的東西就不會消失） */
export const ITEM_RENAMES: Record<string, string> = {};

type Migration = { to: number; note: string; run(rec: AccountRecord): void };

export const MIGRATIONS: Migration[] = [
  {
    to: 1,
    note: '補齊早期版本沒有的欄位（休息經驗、成就、技能、增益）',
    run(rec) {
      const c = rec.character;
      c.restedExp ??= 0;
      c.achievements ??= [];
      c.skills ??= {};
      c.buffs ??= [];
      rec.pity ??= [];
    },
  },
  {
    to: 2,
    note: '新增倉庫',
    run(rec) {
      rec.character.storage ??= { capacity: STORAGE_CAPACITY, items: [] };
    },
  },
];

export interface MigrationReport {
  from: number;
  to: number;
  /** 被移除或替換的東西（寫進稽核日誌，客服可以補償） */
  fixes: string[];
}

export function migrateAccount(input: AccountRecord): { rec: AccountRecord; report: MigrationReport } {
  const rec = structuredClone(input);
  const from = rec.version ?? 0;
  const fixes: string[] = [];
  if (from > SAVE_VERSION) fixes.push(`存檔版本 ${from} 比伺服器新（${SAVE_VERSION}），只做安全檢查`);
  for (const m of MIGRATIONS) if (m.to > from) m.run(rec);
  rec.version = Math.max(from, SAVE_VERSION);
  sanitizeCharacter(rec.character, fixes);
  sanitizeHomestead(rec.homestead, fixes);
  return { rec, report: { from, to: rec.version, fixes } };
}

/** 修正單一物品；回傳 undefined 表示已無法保留 */
function fixItem(it: ItemInstance, where: string, fixes: string[]): ItemInstance | undefined {
  const renamed = ITEM_RENAMES[it.defId];
  if (renamed) {
    fixes.push(`${where}：${it.defId} → ${renamed}`);
    it.defId = renamed;
  }
  if (!ITEM_DB.has(it.defId)) {
    fixes.push(`${where}：移除已不存在的物品 ${it.defId} x${it.qty}`);
    return undefined;
  }
  if (!Number.isSafeInteger(it.qty) || it.qty <= 0) {
    fixes.push(`${where}：${it.defId} 數量異常（${it.qty}）已移除`);
    return undefined;
  }
  it.cards = (it.cards ?? []).filter((c) => {
    if (ITEM_DB.has(c)) return true;
    fixes.push(`${where}：${it.defId} 上的卡片 ${c} 已不存在`);
    return false;
  });
  it.enchant = Number.isSafeInteger(it.enchant) && it.enchant >= 0 ? it.enchant : 0;
  it.bound = !!it.bound;
  return it;
}

function sanitizeCharacter(c: CharacterData, fixes: string[]): void {
  if (!Object.hasOwn(CLASSES, c.classId)) {
    fixes.push(`職業 ${c.classId} 不存在，改為初心者`);
    c.classId = 'novice';
  }
  for (const k of STAT_KEYS as readonly StatKey[]) {
    const v = c.stats?.[k];
    if (!Number.isSafeInteger(v) || v < 1) {
      fixes.push(`素質 ${k} 異常（${v}）`);
      c.stats[k] = 1;
    }
  }
  if (!Number.isSafeInteger(c.gold) || c.gold < 0) {
    fixes.push(`金幣異常（${c.gold}）`);
    c.gold = Number.isFinite(c.gold) ? Math.max(0, Math.floor(c.gold)) : 0;
  }
  for (const box of [c.inventory, c.storage!]) {
    const where = box === c.inventory ? '背包' : '倉庫';
    box.items = box.items.map((it) => fixItem(it, where, fixes)).filter((x): x is ItemInstance => !!x);
  }
  for (const [slot, it] of Object.entries(c.equipment)) {
    const ok = it && fixItem(it, `裝備（${slot}）`, fixes);
    if (!ok || ITEM_DB.get(ok.defId)!.slot !== slot) {
      if (ok) fixes.push(`裝備（${slot}）：${ok.defId} 已不屬於這個部位，放回背包`);
      delete c.equipment[slot as keyof typeof c.equipment];
      // 放回背包；背包滿就放倉庫（不計負重，格數大）
      if (ok) (c.inventory.items.length < c.inventory.capacity ? c.inventory : c.storage!).items.push(ok);
    }
  }
  for (const id of Object.keys(c.skills ?? {})) {
    if (!SKILL_DB.has(id)) {
      // 刪除的技能把點數還給玩家
      c.progression.skillPoints += c.skills![id];
      fixes.push(`技能 ${id} 已移除，退還 ${c.skills![id]} 點`);
      delete c.skills![id];
    }
  }
  c.buffs = (c.buffs ?? []).filter((b) => SKILL_DB.has(b.id));
}

function sanitizeHomestead(h: HomesteadData, fixes: string[]): void {
  for (const id of Object.keys(STATION_NAMES) as StationId[]) {
    const lv = h.buildings[id];
    if (!Number.isSafeInteger(lv) || lv < 1) h.buildings[id] = 1;
    else if (lv > STATION_MAX_LEVEL) h.buildings[id] = STATION_MAX_LEVEL;
  }
  const before = h.nodes.length;
  h.nodes = h.nodes.filter((n) => NODE_DB.has(n.defId));
  if (h.nodes.length !== before) fixes.push(`家園：移除 ${before - h.nodes.length} 個已不存在的資源點`);
}

/** 世界存檔（交易所）：移除含有已刪除物品的掛單，並把物品退回賣家的待領款項無法處理的情況寫進報告 */
export function migrateWorld(input: WorldRecord): { rec: WorldRecord; fixes: string[] } {
  const rec = structuredClone(input);
  const fixes: string[] = [];
  rec.market.listings = rec.market.listings.filter((l) => {
    const renamed = ITEM_RENAMES[l.item.defId];
    if (renamed) l.item.defId = renamed;
    if (ITEM_DB.has(l.item.defId)) return true;
    fixes.push(`交易所：移除 ${l.seller} 的掛單 ${l.item.defId} x${l.item.qty}`);
    return false;
  });
  return { rec, fixes };
}
