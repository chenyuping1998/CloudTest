/**
 * 交易所（寄賣）
 * - 上架：物品進入託管 (escrow)，收取上架費 1%（最低 10G，不退還）→ 抑制洗盤與亂掛。
 * - 成交：買家付全額，賣家收到「售價 - 交易稅 5%」（商人職業有減免）→ 主要金幣回收 (gold sink)。
 * - 下架/過期：物品退回，上架費不退。
 * 單機原型中賣家角色存在於本地；上線版 escrow 由伺服器資料庫保存。
 */
import type { Character } from './character';
import { getDef, isTradeable, maxStack, type ItemDb } from './items';
import type { ItemInstance } from './types';

export const MARKET_RULES = {
  listingFeePct: 1,
  minListingFee: 10,
  saleTaxPct: 5,
  listingDurationMs: 72 * 3600 * 1000,
  maxListingsPerSeller: 20,
  maxPrice: 2_000_000_000,
};

export interface Listing {
  id: string;
  seller: string;
  item: ItemInstance;
  price: number;
  taxPct: number;
  listedAt: number;
  expiresAt: number;
}

export interface MarketStats {
  goldSunkFees: number;
  goldSunkTax: number;
  volume: number;
  trades: number;
}

export interface Sale {
  listingId: string;
  seller: string;
  buyer: string;
  defId: string;
  qty: number;
  price: number;
  sellerReceived: number;
  at: number;
}

export function listingFee(price: number): number {
  return Math.max(MARKET_RULES.minListingFee, Math.floor((price * MARKET_RULES.listingFeePct) / 100));
}

export class Market {
  listings: Listing[] = [];
  /** 賣家不在線時的待領收入 */
  pendingPayouts = new Map<string, number>();
  history: Sale[] = [];
  stats: MarketStats = { goldSunkFees: 0, goldSunkTax: 0, volume: 0, trades: 0 };
  private seq = 0;

  constructor(private readonly db: ItemDb) {}

  list(seller: Character, uid: string, qty: number, price: number, now = Date.now()): { ok: boolean; reason?: string; listing?: Listing } {
    if (!Number.isInteger(price) || price <= 0 || price > MARKET_RULES.maxPrice) return { ok: false, reason: '價格不正確' };
    if (this.listings.filter((l) => l.seller === seller.name).length >= MARKET_RULES.maxListingsPerSeller) {
      return { ok: false, reason: '上架數量已達上限' };
    }
    const it = seller.inventory.get(uid);
    if (!it || qty <= 0 || qty > it.qty) return { ok: false, reason: '物品或數量不正確' };
    if (!isTradeable(getDef(this.db, it.defId), it)) return { ok: false, reason: '綁定物品無法上架' };
    const fee = listingFee(price);
    if (seller.data.gold < fee) return { ok: false, reason: `上架費不足（需要 ${fee}G）` };
    const item = seller.inventory.take(uid, qty)!;
    seller.data.gold -= fee;
    this.stats.goldSunkFees += fee;
    const listing: Listing = {
      id: `L${now.toString(36)}-${++this.seq}`,
      seller: seller.name,
      item,
      price,
      taxPct: Math.max(0, MARKET_RULES.saleTaxPct - (seller.classDef.perks.marketTaxReductionPct ?? 0)),
      listedAt: now,
      expiresAt: now + MARKET_RULES.listingDurationMs,
    };
    this.listings.push(listing);
    return { ok: true, listing };
  }

  buy(buyer: Character, listingId: string, sellerIfOnline?: Character, now = Date.now()): { ok: boolean; reason?: string; sale?: Sale } {
    const idx = this.listings.findIndex((l) => l.id === listingId);
    if (idx < 0) return { ok: false, reason: '商品已售出或下架' };
    const l = this.listings[idx];
    if (l.expiresAt <= now) return { ok: false, reason: '商品已過期' };
    if (l.seller === buyer.name) return { ok: false, reason: '不能購買自己的商品' };
    if (buyer.data.gold < l.price) return { ok: false, reason: '金幣不足' };
    const slots = Math.ceil(l.item.qty / maxStack(getDef(this.db, l.item.defId)));
    if (buyer.inventory.usedSlots + slots > buyer.inventory.capacity) return { ok: false, reason: '背包空間不足' };

    this.listings.splice(idx, 1);
    buyer.data.gold -= l.price;
    buyer.inventory.add(l.item);
    const tax = Math.floor((l.price * l.taxPct) / 100);
    const net = l.price - tax;
    if (sellerIfOnline && sellerIfOnline.name === l.seller) sellerIfOnline.data.gold += net;
    else this.pendingPayouts.set(l.seller, (this.pendingPayouts.get(l.seller) ?? 0) + net);
    this.stats.goldSunkTax += tax;
    this.stats.volume += l.price;
    this.stats.trades++;
    const sale: Sale = { listingId: l.id, seller: l.seller, buyer: buyer.name, defId: l.item.defId, qty: l.item.qty, price: l.price, sellerReceived: net, at: now };
    this.history.push(sale);
    return { ok: true, sale };
  }

  cancel(seller: Character, listingId: string): { ok: boolean; reason?: string } {
    const idx = this.listings.findIndex((l) => l.id === listingId && l.seller === seller.name);
    if (idx < 0) return { ok: false, reason: '找不到商品' };
    const l = this.listings[idx];
    const slots = Math.ceil(l.item.qty / maxStack(getDef(this.db, l.item.defId)));
    if (seller.inventory.usedSlots + slots > seller.inventory.capacity) return { ok: false, reason: '背包空間不足' };
    this.listings.splice(idx, 1);
    seller.inventory.add(l.item);
    return { ok: true };
  }

  collectPayout(seller: Character): number {
    const amt = this.pendingPayouts.get(seller.name) ?? 0;
    this.pendingPayouts.delete(seller.name);
    seller.data.gold += amt;
    return amt;
  }

  /** 過期商品退回給賣家（上線時由伺服器排程處理） */
  expire(seller: Character, now = Date.now()): number {
    let n = 0;
    for (const l of [...this.listings]) {
      if (l.seller === seller.name && l.expiresAt <= now && this.cancel(seller, l.id).ok) n++;
    }
    return n;
  }

  /** 近期成交均價，給 UI 顯示行情 */
  averagePrice(defId: string, lastN = 20): number | undefined {
    const recent = this.history.filter((s) => s.defId === defId).slice(-lastN);
    if (recent.length === 0) return undefined;
    return Math.round(recent.reduce((s, x) => s + x.price / x.qty, 0) / recent.length);
  }
}
