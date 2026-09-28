/**
 * 用戶端狀態：伺服器傳來的資料的「唯讀鏡像」。
 * UI 只讀取這裡；任何操作都透過 net.send() 請伺服器處理。
 */
import { Character, type CharacterData } from '../core/character';
import { Homestead, type HomesteadData } from '../core/homestead';
import { UidGen } from '../core/items';
import type { Connection } from '../net/connection';
import type { ClientMsg, MarketView, PartyView, TradeView } from '../net/protocol';
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
  party: PartyView | null = null;
  tradeInvites: string[] = [];
  onlinePlayers: string[] = [];
  /** 技能冷卻結束時間（本機 performance.now） */
  cooldowns = new Map<string, { until: number; total: number }>();
  /** 技能快捷列（第 5~8 格），存在本機設定 */
  skillBar: (string | null)[] = ClientState.loadSkillBar();

  private static loadSkillBar(): (string | null)[] {
    try {
      const raw = JSON.parse(localStorage.getItem('roe:skillbar') ?? '[]');
      if (Array.isArray(raw)) return [0, 1, 2, 3].map((i) => (typeof raw[i] === 'string' ? raw[i] : null));
    } catch {
      /* ignore */
    }
    return [null, null, null, null];
  }

  setSkillSlot(slot: number, skill: string | null): void {
    this.skillBar = this.skillBar.map((s, i) => (i === slot ? skill : s === skill ? null : s));
    try {
      localStorage.setItem('roe:skillbar', JSON.stringify(this.skillBar));
    } catch {
      /* ignore */
    }
  }
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

  isPartyMember(name: string): boolean {
    return !!this.party?.members.some((m) => m.name === name);
  }

  /** 目前在自己的家園 */
  get inOwnHome(): boolean {
    return this.zone === 'homestead' && this.zoneOwner === this.name;
  }
}
