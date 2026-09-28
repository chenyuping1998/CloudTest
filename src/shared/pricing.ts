import { getDef } from '../core/items';
import { ITEM_DB } from '../data';

/** 市場參考價：NPC 收購價 × 稀有度倍數，再以近期成交均價修正（伺服器與 UI 共用） */
export function referencePrice(defId: string, recentAverage?: number): number {
  const def = getDef(ITEM_DB, defId);
  const mult = [2.5, 3, 4, 6, 8, 10][def.rarity];
  const base = Math.max(5, Math.round(def.sellPrice * mult));
  return recentAverage ? Math.round(base * 0.5 + recentAverage * 0.5) : base;
}
