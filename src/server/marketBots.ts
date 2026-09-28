/**
 * 市場機器人：伺服器人少時（或單機模式）讓交易所保持有貨、有買家。
 * 走的是與真人完全相同的 Market API（上架費、稅、託管都一樣）。人口夠多時可以關掉。
 */
import { Character, newCharacter } from '../core/character';
import { createItem, getDef, isTradeable, type UidGen } from '../core/items';
import type { Market } from '../core/market';
import { randInt, randRange, type Rng } from '../core/rng';
import { ITEM_DB } from '../data';
import { referencePrice } from '../shared/pricing';

export const BOT_NAMES = ['旅行商人艾莉', '鐵匠布朗', '冒險者小霖', '收藏家維克多'];

/** itemId, 權重, 最大數量 */
const BOT_STOCK: [string, number, number][] = [
  ['red_potion', 20, 30], ['orange_potion', 10, 10], ['blue_potion', 6, 5], ['iron_ore', 12, 40], ['coal', 10, 50],
  ['iron_ingot', 8, 20], ['oak_plank', 8, 30], ['maple_log', 6, 30], ['wolf_pelt', 8, 20], ['golem_core', 4, 5],
  ['rune_fragment', 4, 5], ['rough_ruby', 3, 2], ['rough_sapphire', 3, 2], ['scroll_weapon', 3, 3], ['scroll_armor', 3, 3],
  ['iron_pickaxe', 3, 1], ['iron_axe', 3, 1], ['cutlass', 3, 1], ['leather_armor', 3, 1], ['longsword', 2, 1],
  ['chainmail', 1, 1], ['wind_boots', 1, 1], ['clover_ring', 1, 1], ['card_wolf', 0.4, 1], ['card_slime', 0.4, 1],
  ['scroll_weapon_blessed', 0.3, 1], ['flame_blade', 0.15, 1],
];

export class MarketBots {
  private bots: Character[];
  private nextTick = 0;

  constructor(
    private readonly market: Market,
    private readonly uids: UidGen,
    private readonly rng: Rng,
  ) {
    this.bots = BOT_NAMES.map((n) => {
      const c = newCharacter(n, ITEM_DB, uids);
      c.inventory.capacity = 1000;
      return c;
    });
  }

  private pickStock(): [string, number] {
    const total = BOT_STOCK.reduce((s, x) => s + x[1], 0);
    let r = this.rng.next() * total;
    for (const [id, w, max] of BOT_STOCK) {
      r -= w;
      if (r < 0) return [id, max];
    }
    return [BOT_STOCK[0][0], BOT_STOCK[0][2]];
  }

  /**
   * 每 10 秒：機器人上架商品，並評估是否買下真人玩家的商品。
   * onlineSeller 用來把收入直接交給在線的賣家。
   */
  tick(now: number, onlineSeller: (name: string) => Character | undefined, onSold: (seller: string, msg: string) => void): void {
    if (now < this.nextTick) return;
    this.nextTick = now + 10_000;
    const m = this.market;
    const avg = (id: string) => m.averagePrice(id);

    if (m.listings.filter((l) => BOT_NAMES.includes(l.seller)).length < 24) {
      for (let i = 0; i < 3; i++) {
        const bot = this.bots[randInt(this.rng, 0, this.bots.length - 1)];
        const [id, max] = this.pickStock();
        const def = getDef(ITEM_DB, id);
        const qty = def.stackable ? randInt(this.rng, 1, max) : 1;
        const it = createItem(ITEM_DB, this.uids, id, qty, { kind: 'system', sourceId: 'market-bot', at: now });
        bot.inventory.add(it);
        bot.data.gold = 10_000_000;
        const unit = referencePrice(id, avg(id)) * randRange(this.rng, 0.9, 1.6);
        m.list(bot, it.uid, qty, Math.max(1, Math.round(unit * qty)), now);
      }
    }
    m.listings = m.listings.filter((l) => !(BOT_NAMES.includes(l.seller) && l.expiresAt <= now));
    for (const name of BOT_NAMES) m.pendingPayouts.delete(name);

    for (const l of [...m.listings]) {
      if (BOT_NAMES.includes(l.seller)) continue;
      const def = getDef(ITEM_DB, l.item.defId);
      if (!isTradeable(def, l.item)) continue;
      const fair = referencePrice(l.item.defId, avg(l.item.defId)) * l.item.qty * (1 + l.item.enchant * 0.5 + l.item.cards.length);
      const ratio = l.price / fair;
      const chance = ratio <= 0.8 ? 0.9 : ratio <= 1.2 ? 0.45 : ratio <= 2 ? 0.12 : ratio <= 3 ? 0.02 : 0;
      if (this.rng.next() >= chance) continue;
      const buyer = this.bots[randInt(this.rng, 0, this.bots.length - 1)];
      buyer.data.gold = 10_000_000;
      const res = m.buy(buyer, l.id, onlineSeller(l.seller), now);
      if (res.ok) {
        buyer.inventory.items = [];
        onSold(l.seller, `【交易所】${buyer.name} 買下了你的 ${def.name} x${l.item.qty}，入帳 ${res.sale!.sellerReceived.toLocaleString()}G（稅 ${l.price - res.sale!.sellerReceived}G）`);
      }
    }
  }
}
