import { newCharacter } from '../src/core/character';
import { createItem, UidGen } from '../src/core/items';
import { ITEM_DB } from '../src/data';

export const uids = new UidGen('t');

export function makeChar(name: string) {
  return newCharacter(name, ITEM_DB, uids);
}

export function give(ch: ReturnType<typeof makeChar>, defId: string, qty = 1) {
  const it = createItem(ITEM_DB, uids, defId, qty, { kind: 'system', at: 0 });
  if (!ch.inventory.add(it)) throw new Error('inventory full');
  return ch.inventory.items.find((i) => i.defId === defId && (i.uid === it.uid || ITEM_DB.get(defId)!.stackable))!;
}
