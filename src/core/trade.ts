/**
 * 玩家對玩家交易視窗（天堂/RO 式）
 * 流程：雙方放入物品/金幣 → 雙方「鎖定」→ 雙方「確認」→ 原子性交換。
 * 防詐騙：任何一方在鎖定後修改內容，雙方鎖定與確認全部重置。
 * 防複製：執行時重新驗證每一個 uid 仍在持有者背包、數量正確、未綁定；
 *        任何一項失敗，整筆交易取消且不做任何修改。
 * 上線版這段邏輯只在伺服器執行，客戶端只送「意圖」。
 */
import type { Character } from './character';
import { getDef, isTradeable, maxStack, type ItemDb } from './items';
import type { ItemInstance } from './types';

export type Side = 'a' | 'b';

interface Offer {
  items: Map<string, number>; // uid -> qty
  gold: number;
  locked: boolean;
  confirmed: boolean;
  /** 鎖定當下每件物品的樣子（強化值、卡片…）；執行前比對，防止鎖定後偷偷降級 */
  snapshot?: Map<string, string>;
}

/** 交易關心的物品特徵：任何一項改變都代表對方看到的已經不是同一件東西 */
function fingerprint(it: ItemInstance): string {
  return JSON.stringify([it.defId, it.enchant, it.cards, it.bound]);
}

export interface TradeLog {
  at: number;
  a: string;
  b: string;
  aGave: { uid: string; defId: string; qty: number }[];
  bGave: { uid: string; defId: string; qty: number }[];
  aGold: number;
  bGold: number;
}

export const MAX_TRADE_ITEMS = 10;

export class TradeSession {
  private offers: Record<Side, Offer> = {
    a: { items: new Map(), gold: 0, locked: false, confirmed: false },
    b: { items: new Map(), gold: 0, locked: false, confirmed: false },
  };
  state: 'open' | 'completed' | 'cancelled' = 'open';

  constructor(
    private readonly db: ItemDb,
    readonly a: Character,
    readonly b: Character,
  ) {
    if (a === b) throw new Error('cannot trade with self');
  }

  private who(side: Side): Character {
    return side === 'a' ? this.a : this.b;
  }

  private resetLocks(): void {
    for (const o of Object.values(this.offers)) {
      o.locked = false;
      o.confirmed = false;
    }
  }

  offer(side: Side): Readonly<Offer> {
    return this.offers[side];
  }

  setItem(side: Side, uid: string, qty: number): { ok: boolean; reason?: string } {
    if (this.state !== 'open') return { ok: false, reason: '交易已結束' };
    const o = this.offers[side];
    if (o.locked) return { ok: false, reason: '已鎖定，請先取消鎖定' };
    if (qty <= 0) {
      o.items.delete(uid);
      this.resetLocks();
      return { ok: true };
    }
    const item = this.who(side).inventory.get(uid);
    if (!item) return { ok: false, reason: '物品不存在' };
    if (!isTradeable(getDef(this.db, item.defId), item)) return { ok: false, reason: '此物品已綁定，無法交易' };
    if (qty > item.qty) return { ok: false, reason: '數量不足' };
    if (!o.items.has(uid) && o.items.size >= MAX_TRADE_ITEMS) return { ok: false, reason: `一次最多 ${MAX_TRADE_ITEMS} 樣` };
    o.items.set(uid, qty);
    this.resetLocks();
    return { ok: true };
  }

  setGold(side: Side, gold: number): { ok: boolean; reason?: string } {
    if (this.state !== 'open') return { ok: false, reason: '交易已結束' };
    const o = this.offers[side];
    if (o.locked) return { ok: false, reason: '已鎖定，請先取消鎖定' };
    if (!Number.isInteger(gold) || gold < 0) return { ok: false, reason: '金額不正確' };
    if (gold > this.who(side).data.gold) return { ok: false, reason: '金幣不足' };
    o.gold = gold;
    this.resetLocks();
    return { ok: true };
  }

  lock(side: Side): void {
    if (this.state !== 'open') return;
    const o = this.offers[side];
    o.locked = true;
    const inv = this.who(side).inventory;
    o.snapshot = new Map([...o.items.keys()].flatMap((uid) => {
      const it = inv.get(uid);
      return it ? [[uid, fingerprint(it)] as [string, string]] : [];
    }));
  }

  unlock(side: Side): void {
    if (this.state !== 'open') return;
    this.offers[side].locked = false;
    this.resetLocks();
  }

  cancel(): void {
    if (this.state === 'open') this.state = 'cancelled';
  }

  /** 雙方都確認後自動執行；回傳交易紀錄或失敗原因 */
  confirm(side: Side): { ok: boolean; done: boolean; reason?: string; log?: TradeLog } {
    if (this.state !== 'open') return { ok: false, done: false, reason: '交易已結束' };
    if (!this.offers.a.locked || !this.offers.b.locked) return { ok: false, done: false, reason: '雙方都必須先鎖定' };
    this.offers[side].confirmed = true;
    if (!this.offers.a.confirmed || !this.offers.b.confirmed) return { ok: true, done: false };
    return this.execute();
  }

  private validate(side: Side): string | undefined {
    const c = this.who(side);
    const o = this.offers[side];
    if (o.gold > c.data.gold) return `${c.name} 金幣不足`;
    for (const [uid, qty] of o.items) {
      const it = c.inventory.get(uid);
      if (!it || it.qty < qty) return `${c.name} 的物品已變動`;
      if (o.snapshot?.get(uid) !== fingerprint(it)) return `${c.name} 的物品在鎖定後被改動（強化值或卡片不同），交易取消`;
      if (!isTradeable(getDef(this.db, it.defId), it)) return '含有綁定物品';
    }
    return undefined;
  }

  private worstCaseSlots(items: ItemInstance[]): number {
    return items.reduce((s, it) => s + Math.ceil(it.qty / maxStack(getDef(this.db, it.defId))), 0);
  }

  private execute(): { ok: boolean; done: boolean; reason?: string; log?: TradeLog } {
    const err = this.validate('a') ?? this.validate('b');
    if (err) {
      this.state = 'cancelled';
      return { ok: false, done: true, reason: err };
    }
    // 空間檢查：用「最壞情況（完全不堆疊）」估算，保證接下來的 add 一定成功，交換不會有物品遺失
    const preview = (side: Side): ItemInstance[] =>
      [...this.offers[side].items].map(([uid, qty]) => ({ ...this.who(side).inventory.get(uid)!, qty }));
    const aItems = preview('a');
    const bItems = preview('b');
    const freedA = aItems.filter((p) => this.a.inventory.get(p.uid)!.qty === p.qty).length;
    const freedB = bItems.filter((p) => this.b.inventory.get(p.uid)!.qty === p.qty).length;
    if (this.a.inventory.usedSlots - freedA + this.worstCaseSlots(bItems) > this.a.inventory.capacity) {
      this.state = 'cancelled';
      return { ok: false, done: true, reason: `${this.a.name} 背包空間不足` };
    }
    if (this.b.inventory.usedSlots - freedB + this.worstCaseSlots(aItems) > this.b.inventory.capacity) {
      this.state = 'cancelled';
      return { ok: false, done: true, reason: `${this.b.name} 背包空間不足` };
    }

    const takeAll = (side: Side) =>
      [...this.offers[side].items].map(([uid, qty]) => this.who(side).inventory.take(uid, qty)!);
    const fromA = takeAll('a');
    const fromB = takeAll('b');
    for (const it of fromA) this.b.inventory.add(it);
    for (const it of fromB) this.a.inventory.add(it);
    this.a.data.gold += this.offers.b.gold - this.offers.a.gold;
    this.b.data.gold += this.offers.a.gold - this.offers.b.gold;
    this.state = 'completed';
    const brief = (xs: ItemInstance[]) => xs.map((x) => ({ uid: x.uid, defId: x.defId, qty: x.qty }));
    return {
      ok: true,
      done: true,
      log: {
        at: Date.now(),
        a: this.a.name,
        b: this.b.name,
        aGave: brief(fromA),
        bGave: brief(fromB),
        aGold: this.offers.a.gold,
        bGold: this.offers.b.gold,
      },
    };
  }
}
