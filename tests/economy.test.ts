import { describe, expect, it } from 'vitest';
import { Market, MARKET_RULES, listingFee } from '../src/core/market';
import { TradeSession } from '../src/core/trade';
import { ITEM_DB } from '../src/data';
import { give, makeChar } from './helpers';

describe('player trade', () => {
  it('swaps items and gold atomically after both lock and confirm', () => {
    const a = makeChar('Alice');
    const b = makeChar('Bob');
    const ore = give(a, 'iron_ore', 50);
    a.data.gold = 0;
    b.data.gold = 1000;
    const t = new TradeSession(ITEM_DB, a, b);
    expect(t.setItem('a', ore.uid, 30).ok).toBe(true);
    expect(t.setGold('b', 600).ok).toBe(true);
    expect(t.confirm('a').ok).toBe(false); // 尚未鎖定
    t.lock('a');
    t.lock('b');
    expect(t.confirm('a').done).toBe(false);
    const res = t.confirm('b');
    expect(res.ok && res.done).toBe(true);
    expect(a.inventory.count('iron_ore')).toBe(20);
    expect(b.inventory.count('iron_ore')).toBe(30);
    expect(a.data.gold).toBe(600);
    expect(b.data.gold).toBe(400);
    expect(res.log!.aGave[0].qty).toBe(30);
  });

  it('changing the offer after lock resets both locks (anti-scam)', () => {
    const a = makeChar('A2');
    const b = makeChar('B2');
    b.data.gold = 100;
    const ore = give(a, 'iron_ore', 5);
    const t = new TradeSession(ITEM_DB, a, b);
    t.setItem('a', ore.uid, 5);
    t.lock('a');
    t.setGold('b', 100);
    t.lock('b');
    t.unlock('a');
    expect(t.offer('b').locked).toBe(false);
  });

  it('bound items cannot be traded', () => {
    const a = makeChar('A3');
    const b = makeChar('B3');
    const knife = give(a, 'novice_knife');
    const t = new TradeSession(ITEM_DB, a, b);
    expect(t.setItem('a', knife.uid, 1).ok).toBe(false);
  });

  it('trade fails without changes if an item disappeared (anti-dupe)', () => {
    const a = makeChar('A4');
    const b = makeChar('B4');
    const ore = give(a, 'iron_ore', 5);
    const t = new TradeSession(ITEM_DB, a, b);
    t.setItem('a', ore.uid, 5);
    t.lock('a');
    t.lock('b');
    t.confirm('a');
    a.inventory.take(ore.uid, 5); // 例如同時丟到地上
    const res = t.confirm('b');
    expect(res.ok).toBe(false);
    expect(b.inventory.count('iron_ore')).toBe(0);
  });

  it('trade fails without changes if receiver inventory is full', () => {
    const a = makeChar('A5');
    const b = makeChar('B5');
    b.inventory.capacity = 0;
    const ore = give(a, 'iron_ore', 5);
    const t = new TradeSession(ITEM_DB, a, b);
    t.setItem('a', ore.uid, 5);
    t.lock('a');
    t.lock('b');
    t.confirm('a');
    expect(t.confirm('b').ok).toBe(false);
    expect(a.inventory.count('iron_ore')).toBe(5);
  });
});

describe('market', () => {
  it('charges listing fee and sale tax (gold sinks), pays seller', () => {
    const m = new Market(ITEM_DB);
    const s = makeChar('Seller');
    const buyer = makeChar('Buyer');
    s.data.gold = 1000;
    buyer.data.gold = 20_000;
    const scroll = give(s, 'scroll_weapon', 3);
    const l = m.list(s, scroll.uid, 2, 10_000);
    expect(l.ok).toBe(true);
    expect(s.data.gold).toBe(1000 - listingFee(10_000));
    expect(s.inventory.count('scroll_weapon')).toBe(1);
    const res = m.buy(buyer, l.listing!.id, s);
    expect(res.ok).toBe(true);
    expect(buyer.inventory.count('scroll_weapon')).toBe(2);
    expect(buyer.data.gold).toBe(10_000);
    const tax = (10_000 * MARKET_RULES.saleTaxPct) / 100;
    expect(s.data.gold).toBe(1000 - 100 + 10_000 - tax);
    expect(m.stats.goldSunkTax).toBe(tax);
    expect(m.averagePrice('scroll_weapon')).toBe(5000);
  });

  it('merchant pays less tax; offline seller gets payout later', () => {
    const m = new Market(ITEM_DB);
    const s = makeChar('Merch');
    s.progression.jobLevel = 10;
    s.changeJob('merchant');
    const buyer = makeChar('Buyer2');
    buyer.data.gold = 1000;
    const it = give(s, 'wolf_pelt', 10);
    const l = m.list(s, it.uid, 10, 1000)!;
    const goldAfterList = s.data.gold;
    m.buy(buyer, l.listing!.id);
    expect(m.collectPayout(s)).toBe(1000 - 30);
    expect(s.data.gold).toBe(goldAfterList + 970);
  });

  it('cannot list bound items or buy own listing', () => {
    const m = new Market(ITEM_DB);
    const s = makeChar('S3');
    const k = give(s, 'novice_knife');
    expect(m.list(s, k.uid, 1, 100).ok).toBe(false);
    const p = give(s, 'jelly', 5);
    const l = m.list(s, p.uid, 5, 100);
    expect(m.buy(s, l.listing!.id).ok).toBe(false);
  });
});
