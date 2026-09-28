import type { ItemDef, ItemInstance, ItemOrigin } from './types';

export type ItemDb = ReadonlyMap<string, ItemDef>;

export function buildItemDb(defs: readonly ItemDef[]): ItemDb {
  const db = new Map<string, ItemDef>();
  for (const d of defs) {
    if (db.has(d.id)) throw new Error(`duplicate item id: ${d.id}`);
    db.set(d.id, d);
  }
  return db;
}

export function getDef(db: ItemDb, id: string): ItemDef {
  const d = db.get(id);
  if (!d) throw new Error(`unknown item: ${id}`);
  return d;
}

/** uid 產生器。上線版由伺服器發號（例如 snowflake），單機版用前綴+流水號。 */
export class UidGen {
  constructor(private prefix: string, private counter = 0) {}
  next(): string {
    this.counter++;
    return `${this.prefix}-${this.counter.toString(36)}`;
  }
  get value(): number {
    return this.counter;
  }
}

export function createItem(db: ItemDb, uids: UidGen, defId: string, qty: number, origin: ItemOrigin): ItemInstance {
  const def = getDef(db, defId);
  if (!def.stackable && qty !== 1) throw new Error(`${defId} is not stackable`);
  return {
    uid: uids.next(),
    defId,
    qty,
    enchant: 0,
    cards: [],
    bound: def.bind === 'bound',
    origin,
  };
}

export function maxStack(def: ItemDef): number {
  return def.stackable ? def.maxStack ?? 9999 : 1;
}

/** 物品是否可以交易（交易視窗、市場都要檢查） */
export function isTradeable(def: ItemDef, item: ItemInstance): boolean {
  return def.bind !== 'bound' && !item.bound;
}

export function itemDisplayName(def: ItemDef, item: ItemInstance): string {
  const plus = item.enchant > 0 ? `+${item.enchant} ` : '';
  const slots = def.cardSlots ? ` [${def.cardSlots}]` : '';
  return `${plus}${def.name}${slots}`;
}
