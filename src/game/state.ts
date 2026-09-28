/**
 * 遊戲狀態與存檔。
 * 單機原型存在 localStorage；上架 Steam 後改為：
 *   - 角色/背包/交易所 → 伺服器資料庫（交易必須由伺服器驗證）
 *   - 設定/快捷鍵 → Steam Cloud
 */
import { Character, newCharacter, type CharacterData } from '../core/character';
import { Homestead, type HomesteadData } from '../core/homestead';
import { createItem, UidGen } from '../core/items';
import { Market, type Listing, type MarketStats, type Sale } from '../core/market';
import { ITEM_DB, initialHomestead } from '../data';

const SAVE_KEY = 'realm-of-embers-save-v1';

interface SaveData {
  version: 1;
  uidCounter: number;
  character: CharacterData;
  homestead: HomesteadData;
  market: { listings: Listing[]; history: Sale[]; stats: MarketStats; pendingPayouts: [string, number][] };
  pity: [string, number][];
  savedAt: number;
}

export class GameState {
  uids: UidGen;
  player: Character;
  homestead: Homestead;
  market: Market;
  pity = new Map<string, number>();

  private constructor(uids: UidGen, player: Character, homestead: Homestead, market: Market) {
    this.uids = uids;
    this.player = player;
    this.homestead = homestead;
    this.market = market;
  }

  static newGame(name: string): GameState {
    const uids = new UidGen('p');
    const player = newCharacter(name, ITEM_DB, uids);
    const give = (id: string, qty = 1) => player.inventory.add(createItem(ITEM_DB, uids, id, qty, { kind: 'system', at: Date.now() }));
    give('novice_knife');
    give('cotton_shirt');
    give('red_potion', 10);
    give('stone_pickaxe');
    give('stone_axe');
    player.equip(player.inventory.items.find((i) => i.defId === 'novice_knife')!.uid);
    player.equip(player.inventory.items.find((i) => i.defId === 'cotton_shirt')!.uid);
    return new GameState(uids, player, new Homestead(initialHomestead()), new Market(ITEM_DB));
  }

  static load(): GameState | undefined {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return undefined;
      const s = JSON.parse(raw) as SaveData;
      if (s.version !== 1) return undefined;
      const uids = new UidGen('p', s.uidCounter);
      const market = new Market(ITEM_DB);
      market.listings = s.market.listings;
      market.history = s.market.history;
      market.stats = s.market.stats;
      market.pendingPayouts = new Map(s.market.pendingPayouts);
      const st = new GameState(uids, new Character(ITEM_DB, uids, s.character), new Homestead(s.homestead), market);
      st.pity = new Map(s.pity);
      return st;
    } catch (e) {
      console.warn('讀取存檔失敗', e);
      return undefined;
    }
  }

  save(): void {
    const data: SaveData = {
      version: 1,
      uidCounter: this.uids.value,
      character: this.player.serialize(),
      homestead: this.homestead.data,
      market: {
        listings: this.market.listings,
        history: this.market.history.slice(-200),
        stats: this.market.stats,
        pendingPayouts: [...this.market.pendingPayouts],
      },
      pity: [...this.pity],
      savedAt: Date.now(),
    };
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(data));
    } catch (e) {
      console.warn('存檔失敗', e);
    }
  }

  static wipe(): void {
    try {
      localStorage.removeItem(SAVE_KEY);
    } catch {
      /* ignore */
    }
  }
}
