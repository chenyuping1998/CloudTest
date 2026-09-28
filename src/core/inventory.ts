import { getDef, maxStack, type ItemDb, type UidGen } from './items';
import type { ItemInstance } from './types';

export interface InventoryData {
  capacity: number;
  items: ItemInstance[];
}

/**
 * 背包：格數上限 + 負重上限（RO：負重 = 2000 + STR×30）。
 * 可堆疊物品只有在「綁定狀態、強化、卡片、製作者都相同」時才會合併。
 */
export class Inventory {
  constructor(
    private readonly db: ItemDb,
    private readonly uids: UidGen,
    public capacity = 100,
    public items: ItemInstance[] = [],
  ) {}

  static from(db: ItemDb, uids: UidGen, data: InventoryData): Inventory {
    return new Inventory(db, uids, data.capacity, data.items.map((i) => ({ ...i, cards: [...i.cards] })));
  }

  toJSON(): InventoryData {
    return { capacity: this.capacity, items: this.items };
  }

  get usedSlots(): number {
    return this.items.length;
  }

  totalWeight(): number {
    return this.items.reduce((s, i) => s + getDef(this.db, i.defId).weight * i.qty, 0);
  }

  get(uid: string): ItemInstance | undefined {
    return this.items.find((i) => i.uid === uid);
  }

  count(defId: string): number {
    return this.items.filter((i) => i.defId === defId).reduce((s, i) => s + i.qty, 0);
  }

  private canMerge(a: ItemInstance, b: ItemInstance): boolean {
    return (
      a.defId === b.defId &&
      a.bound === b.bound &&
      a.enchant === b.enchant &&
      a.cards.length === 0 &&
      b.cards.length === 0 &&
      a.crafter === b.crafter
    );
  }

  /** 模擬加入：回傳需要的新格數（不修改背包） */
  slotsNeeded(incoming: readonly ItemInstance[]): number {
    const room = new Map<ItemInstance, number>();
    let newSlots = 0;
    const pending: ItemInstance[] = [];
    for (const inc of incoming) {
      const def = getDef(this.db, inc.defId);
      let left = inc.qty;
      if (def.stackable) {
        for (const ex of [...this.items, ...pending]) {
          if (!this.canMerge(ex, inc)) continue;
          const used = room.get(ex) ?? ex.qty;
          const free = maxStack(def) - used;
          if (free <= 0) continue;
          const take = Math.min(free, left);
          room.set(ex, used + take);
          left -= take;
          if (left === 0) break;
        }
      }
      while (left > 0) {
        const take = Math.min(maxStack(def), left);
        const ghost = { ...inc, qty: take };
        pending.push(ghost);
        room.set(ghost, take);
        left -= take;
        newSlots++;
      }
    }
    return newSlots;
  }

  canAdd(incoming: readonly ItemInstance[]): boolean {
    return this.usedSlots + this.slotsNeeded(incoming) <= this.capacity;
  }

  /** 加入物品；空間不足回傳 false 且不做任何修改 */
  add(item: ItemInstance): boolean {
    if (!this.canAdd([item])) return false;
    const def = getDef(this.db, item.defId);
    let left = item.qty;
    if (def.stackable) {
      for (const ex of this.items) {
        if (!this.canMerge(ex, item)) continue;
        const take = Math.min(maxStack(def) - ex.qty, left);
        if (take <= 0) continue;
        ex.qty += take;
        left -= take;
        if (left === 0) return true;
      }
    }
    // 第一段沿用原 uid（保留來源紀錄），溢出的堆疊才另外拆出
    let first = true;
    while (left > 0) {
      const take = Math.min(maxStack(def), left);
      this.items.push({ ...item, cards: [...item.cards], qty: take, uid: first ? item.uid : this.uids.next() });
      first = false;
      left -= take;
    }
    return true;
  }

  /**
   * 取出指定 uid 的 qty 個。全部取出時回傳原實例；部分取出時拆出新 uid。
   */
  take(uid: string, qty: number): ItemInstance | undefined {
    const idx = this.items.findIndex((i) => i.uid === uid);
    if (idx < 0) return undefined;
    const it = this.items[idx];
    if (qty <= 0 || qty > it.qty) return undefined;
    if (qty === it.qty) {
      this.items.splice(idx, 1);
      return it;
    }
    it.qty -= qty;
    return { ...it, cards: [...it.cards], qty, uid: this.uids.next(), origin: { kind: 'split', sourceId: it.uid, at: Date.now() } };
  }

  /** 依 defId 消耗數量（製作、升級家園用），不足時不做修改 */
  consume(defId: string, qty: number): boolean {
    if (this.count(defId) < qty) return false;
    let left = qty;
    for (let i = this.items.length - 1; i >= 0 && left > 0; i--) {
      const it = this.items[i];
      if (it.defId !== defId) continue;
      const take = Math.min(it.qty, left);
      it.qty -= take;
      left -= take;
      if (it.qty === 0) this.items.splice(i, 1);
    }
    return true;
  }
}
