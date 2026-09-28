/**
 * 用戶端 ⇄ 伺服器 訊息格式。
 * 原則：用戶端只送「意圖」，所有結果（傷害、掉寶、交易）都由伺服器計算後回傳。
 */
import type { CharacterData } from '../core/character';
import type { HomesteadData, StationId } from '../core/homestead';
import type { Listing, MarketStats, Sale } from '../core/market';
import type { EquipSlot, ItemInstance, StatKey } from '../core/types';
import type { ClassId } from '../data/classes';
import type { NpcId, ZoneId } from '../shared/maps';

export const PROTOCOL_VERSION = 1;

export type ClientMsg =
  | { t: 'login'; name: string; password?: string; version: number }
  | { t: 'move'; x: number; z: number }
  | { t: 'attack'; id: number }
  | { t: 'pickup'; id: number }
  | { t: 'gather'; node: number }
  | { t: 'interact'; kind: 'npc'; id: NpcId }
  | { t: 'interact'; kind: 'station'; id: StationId }
  | { t: 'stop' }
  | { t: 'useItem'; uid: string }
  | { t: 'equip'; uid: string }
  | { t: 'unequip'; slot: EquipSlot }
  | { t: 'raiseStat'; stat: StatKey }
  | { t: 'changeJob'; job: ClassId }
  | { t: 'enchant'; scrollUid: string; targetUid: string }
  | { t: 'compound'; cardUid: string; equipUid: string }
  | { t: 'discard'; uid: string; qty: number }
  | { t: 'craft'; recipe: string; times: number }
  | { t: 'upgradeHome' }
  | { t: 'upgradeStation'; station: StationId }
  | { t: 'npcBuy'; itemId: string; qty: number }
  | { t: 'npcSell'; uid: string; qty: number }
  | { t: 'marketList'; uid: string; qty: number; price: number }
  | { t: 'marketBuy'; id: string }
  | { t: 'marketCancel'; id: string }
  | { t: 'chat'; text: string }
  | { t: 'tradeRequest'; target: string }
  | { t: 'tradeRespond'; from: string; accept: boolean }
  | { t: 'tradeItem'; uid: string; qty: number }
  | { t: 'tradeGold'; gold: number }
  | { t: 'tradeLock' }
  | { t: 'tradeUnlock' }
  | { t: 'tradeConfirm' }
  | { t: 'tradeCancel' }
  | { t: 'partyInvite'; target: string }
  | { t: 'partyRespond'; from: string; accept: boolean }
  | { t: 'partyLeave' }
  | { t: 'partyKick'; name: string }
  | { t: 'partyShare'; mode: PartyShareMode };

export type PartyShareMode = 'even' | 'each';

export interface PartyMemberView {
  name: string;
  level: number;
  cls: ClassId;
  hp: number;
  maxHp: number;
  zone: string;
  /** 是否在均分經驗的範圍內（同地圖、距離內、等級差內） */
  inRange: boolean;
}

export interface PartyView {
  leader: string;
  share: PartyShareMode;
  members: PartyMemberView[];
}

export interface PlayerSnap {
  id: number;
  name: string;
  cls: ClassId;
  x: number;
  z: number;
  yaw: number;
  moving: boolean;
  /** 攻擊動作序號：改變時播放揮擊動畫 */
  swing: number;
  hp: number;
  maxHp: number;
}

export interface MonsterSnap {
  id: number;
  def: string;
  x: number;
  z: number;
  yaw: number;
  moving: boolean;
  swing: number;
  hp: number;
  dead: boolean;
}

export interface ItemSnap {
  id: number;
  defId: string;
  qty: number;
  x: number;
  z: number;
  /** 撿取優先權擁有者（RO 式：擊殺者先撿） */
  owner?: string;
  /** 擁有者所在隊伍的成員也可以撿 */
  party?: string[];
}

export interface NodeSnap {
  i: number;
  hitsLeft: number;
  depleted: boolean;
}

export interface TradeOfferView {
  items: ItemInstance[];
  gold: number;
  locked: boolean;
  confirmed: boolean;
}

export interface TradeView {
  partner: string;
  mine: TradeOfferView;
  theirs: TradeOfferView;
}

export interface MarketView {
  listings: Listing[];
  stats: MarketStats;
  mySales: Sale[];
  averages: Record<string, number>;
}

export type FxKind = 'dmg' | 'crit' | 'miss' | 'hurt' | 'heal' | 'levelup' | 'text' | 'poof' | 'chips';

export type ServerMsg =
  | { t: 'welcome'; id: number; name: string; online: boolean }
  | { t: 'loginFailed'; reason: string }
  | { t: 'zone'; zone: ZoneId; owner: string; homestead?: HomesteadData }
  | { t: 'snap'; players: PlayerSnap[]; monsters: MonsterSnap[]; items: ItemSnap[]; nodes: NodeSnap[] }
  | { t: 'self'; data: CharacterData }
  | { t: 'home'; data: HomesteadData }
  | { t: 'fx'; kind: FxKind; x: number; y: number; z: number; text?: string; color?: string; target?: number }
  | { t: 'log'; msg: string; color?: string }
  | { t: 'announce'; msg: string; color: string }
  | { t: 'open'; kind: 'npc'; id: NpcId }
  | { t: 'open'; kind: 'station'; id: StationId }
  | { t: 'market'; view: MarketView }
  | { t: 'trade'; view: TradeView | null }
  | { t: 'tradeInvite'; from: string }
  | { t: 'chat'; from: string; text: string; system?: boolean; channel?: 'party' }
  | { t: 'partyInvite'; from: string }
  | { t: 'party'; view: PartyView | null }
  | { t: 'players'; names: string[] };
