/**
 * 單機原型用的「模擬玩家市場」：讓交易所在沒有其他真人時也能運作與測試。
 * 模擬商人走的是與真人完全相同的 Market API（上架費、稅、託管都一樣）。
 * 上線版移除此模組即可。
 */
import { Character, newCharacter } from '../core/character';
import { createItem, getDef, isTradeable } from '../core/items';
import { mathRng, randInt, randRange } from '../core/rng';
import { ITEM_DB } from '../data';
import type { GameState } from './state';

const BOT_NAMES = ['旅行商人艾莉', '鐵匠布朗', '冒險者小霖', '收藏家維克多'];

/** 模擬商人會拿出來賣的東西與權重 */
const BOT_STOCK: [string, number, number][] = [
  // itemId, 權重, 最大數量
  ['red_potion', 20, 30], ['orange_potion', 10, 10], ['blue_potion', 6, 5], ['iron_ore', 12, 40], ['coal', 10, 50],
  ['iron_ingot', 8, 20], ['oak_plank', 8, 30], ['maple_log', 6, 30], ['wolf_pelt', 8, 20], ['golem_core', 4, 5],
  ['rune_fragment', 4, 5], ['rough_ruby', 3, 2], ['rough_sapphire', 3, 2], ['scroll_weapon', 3, 3], ['scroll_armor', 3, 3],
  ['iron_pickaxe', 3, 1], ['iron_axe', 3, 1], ['cutlass', 3, 1], ['leather_armor', 3, 1], ['longsword', 2, 1],
  ['chainmail', 1, 1], ['wind_boots', 1, 1], ['clover_ring', 1, 1], ['card_wolf', 0.4, 1], ['card_slime', 0.4, 1],
  ['scroll_weapon_blessed', 0.3, 1], ['flame_blade', 0.15, 1],
];

/** 市場參考價：NPC 收購價的倍數（稀有品溢價較高），再以近期成交價修正 */
export function referencePrice(state: GameState, defId: string): number {
  const def = getDef(ITEM_DB, defId);
  const mult = [2.5, 3, 4, 6, 8, 10][def.rarity];
  const base = Math.max(5, Math.round(def.sellPrice * mult));
  const avg = state.market.averagePrice(defId);
  return avg ? Math.round(base * 0.5 + avg * 0.5) : base;
}

export class MarketSim {
  private bots: Character[];
  private nextTick = 0;

  constructor(private readonly state: GameState) {
    this.bots = BOT_NAMES.map((n) => {
      const c = newCharacter(n, ITEM_DB, state.uids);
      c.data.gold = 10_000_000;
      c.inventory.capacity = 1000;
      return c;
    });
  }

  private weightedStock(): [string, number] {
    const total = BOT_STOCK.reduce((s, x) => s + x[1], 0);
    let r = mathRng.next() * total;
    for (const [id, w, max] of BOT_STOCK) {
      r -= w;
      if (r < 0) return [id, max];
    }
    return [BOT_STOCK[0][0], BOT_STOCK[0][2]];
  }

  /** 每 10 秒：模擬商人上架、並評估是否買下玩家的商品 */
  tick(now: number, onSold: (msg: string) => void): void {
    if (now < this.nextTick) return;
    this.nextTick = now + 10_000;
    const m = this.state.market;
    const player = this.state.player;

    // 1) 上架
    const botListings = m.listings.filter((l) => BOT_NAMES.includes(l.seller));
    if (botListings.length < 24) {
      for (let i = 0; i < 3; i++) {
        const bot = this.bots[randInt(mathRng, 0, this.bots.length - 1)];
        const [id, max] = this.weightedStock();
        const def = getDef(ITEM_DB, id);
        const qty = def.stackable ? randInt(mathRng, 1, max) : 1;
        const it = createItem(ITEM_DB, this.state.uids, id, qty, { kind: 'system', sourceId: 'market-sim', at: now });
        bot.inventory.add(it);
        const unit = referencePrice(this.state, id) * randRange(mathRng, 0.9, 1.6);
        bot.data.gold = 10_000_000;
        m.list(bot, it.uid, qty, Math.max(1, Math.round(unit * qty)), now);
      }
    }
    // 過期的模擬商品直接移除
    m.listings = m.listings.filter((l) => !(BOT_NAMES.includes(l.seller) && l.expiresAt <= now));

    // 2) 收購玩家商品：價格越接近參考價越容易賣出
    for (const l of [...m.listings]) {
      if (l.seller !== player.name) continue;
      const def = getDef(ITEM_DB, l.item.defId);
      if (!isTradeable(def, l.item)) continue;
      const fair = referencePrice(this.state, l.item.defId) * l.item.qty * (1 + l.item.enchant * 0.5 + l.item.cards.length);
      const ratio = l.price / fair;
      const chance = ratio <= 0.8 ? 0.9 : ratio <= 1.2 ? 0.45 : ratio <= 2 ? 0.12 : ratio <= 3 ? 0.02 : 0;
      if (mathRng.next() >= chance) continue;
      const buyer = this.bots[randInt(mathRng, 0, this.bots.length - 1)];
      buyer.data.gold = 10_000_000;
      const res = m.buy(buyer, l.id, player, now);
      if (res.ok) {
        buyer.inventory.items = []; // 模擬買家買走即消失
        onSold(`【交易所】${buyer.name} 買下了你的 ${def.name} x${l.item.qty}，入帳 ${res.sale!.sellerReceived.toLocaleString()}G（稅 ${l.price - res.sale!.sellerReceived}G）`);
      }
    }
  }
}
