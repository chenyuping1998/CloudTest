/**
 * 用戶端狀態：伺服器傳來的資料的「唯讀鏡像」。
 * UI 只讀取這裡；任何操作都透過 net.send() 請伺服器處理。
 */
import { Character, type CharacterData } from '../core/character';
import { Homestead, type HomesteadData } from '../core/homestead';
import { UidGen } from '../core/items';
import type { Connection } from '../net/connection';
import type { ClientMsg, MarketView, TradeView } from '../net/protocol';
import { ITEM_DB } from '../data';
import type { ZoneId } from '../shared/maps';

export class ClientState {
  myId = 0;
  name = '';
  online = false;
  player?: Character;
  homestead = new Homestead({ level: 1, buildings: { smelter: 1, workbench: 1, anvil: 1, alchemy: 1 }, nodes: [] });
  zone: ZoneId = 'field';
  zoneOwner = '';
  market?: MarketView;
  trade: TradeView | null = null;
  tradeInvites: string[] = [];
  onlinePlayers: string[] = [];
  private uids = new UidGen('client');

  constructor(readonly net: Connection) {}

  send(msg: ClientMsg): void {
    this.net.send(msg);
  }

  setSelf(data: CharacterData): void {
    this.player = new Character(ITEM_DB, this.uids, data);
  }

  setHome(data: HomesteadData): void {
    this.homestead = new Homestead(data);
  }

  /** 目前在自己的家園 */
  get inOwnHome(): boolean {
    return this.zone === 'homestead' && this.zoneOwner === this.name;
  }
}
