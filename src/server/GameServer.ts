/**
 * 權威遊戲伺服器（純 TypeScript，無 DOM / Node 相依）。
 * - 單機模式：在瀏覽器內執行，存檔到 localStorage。
 * - 連線模式：在 Node.js 內執行（server/main.ts），透過 WebSocket 服務多位玩家。
 * 所有會影響經濟的計算（戰鬥、掉寶、採集、強化、製作、交易、交易所）都只在這裡發生。
 */
import { Character, newCharacter, type CharacterData } from '../core/character';
import { migrateAccount, migrateWorld, SAVE_VERSION } from './migrations';
import { defReduction, hitChance, resolveAttack } from '../core/combat';
import { rollDrops } from '../core/drops';
import { enchantSuccessRate, ENCHANT_RULES, tryEnchant, type EnchantKind } from '../core/enchant';
import { craft, gather, Homestead, refreshNode, type HomesteadData, type StationId } from '../core/homestead';
import { createItem, getDef, UidGen } from '../core/items';
import { accrueRested, addExp, applyDeathPenalty, capKillExp, consumeRested, expLevelModifier } from '../core/leveling';
import { Market, type Listing, type MarketStats, type Sale } from '../core/market';
import { distributeExp, PARTY_MAX, PARTY_SHARE_DISTANCE, type ShareGroup } from '../core/party';
import { mathRng, randRange, type Rng } from '../core/rng';
import { TradeSession, type Side } from '../core/trade';
import { Rarity, RARITY_INFO, STAT_KEYS, type EquipSlot, type ItemInstance } from '../core/types';
import {
  CLASSES, HOMESTEAD_UPGRADES, ITEM_DB, MONSTER_DB, NODE_DB, NPC_SHOP, POOL_DB, RECIPE_DB, STATION_MAX_LEVEL,
  STATION_NAMES, initialHomestead, stationUpgradeCost,
} from '../data';
import type { MonsterDef } from '../data/monsters';
import type { ClientMsg, MarketView, PartyShareMode, PartyView, ServerMsg, TradeOfferView } from '../net/protocol';
import { PROTOCOL_VERSION } from '../net/protocol';
import { homesteadLayout, MVP_LOCATION, NPC_POSITIONS, worldLayout, ZONE_NAMES, ZONE_SPAWNS, type MapLayout, type WorldZoneId, type ZoneId } from '../shared/maps';
import { BOT_NAMES, MarketBots } from './marketBots';
import { ACHIEVEMENT_DB } from '../shared/achievements';
import { SKILL_DB, type SkillDef } from '../data/skills';
import { QUEST_DB } from '../data/quests';
import { abandonQuest, acceptQuest, questDay, questEvent, questStatus, turnInQuest, type QuestEvent } from '../core/quests';

// ------------------------------------------------------------ 介面

export interface Conn {
  send(msg: ServerMsg): void;
  close?(): void;
}

export interface AccountRecord {
  /** 存檔版本（見 migrations.ts）；舊檔沒有這個欄位 = 0 */
  version?: number;
  name: string;
  passwordHash?: string;
  /** 以 Steam 登入的帳號 */
  steamId?: string;
  character: CharacterData;
  homestead: HomesteadData;
  pity: [string, number][];
  createdAt: number;
  lastLogin: number;
  /** 實際遊玩秒數（5 分鐘沒有操作就不計），用來比對練功節奏 */
  playSeconds?: number;
}

export interface WorldRecord {
  uidCounter: number;
  market: { listings: Listing[]; history: Sale[]; stats: MarketStats; pendingPayouts: [string, number][] };
}

/** 存檔介面（非同步：正式環境是資料庫）。單機 / 測試用的實作直接回傳已完成的 Promise */
export interface ServerStorage {
  loadAccount(name: string): Promise<AccountRecord | undefined>;
  loadAccountBySteamId?(steamId: string): Promise<AccountRecord | undefined>;
  saveAccount(rec: AccountRecord): Promise<void>;
  loadWorld(): Promise<WorldRecord | undefined>;
  saveWorld(rec: WorldRecord): Promise<void>;
  /** 稽核紀錄（交易、強化蒸發、MVP 等），用來追查複製 bug 與 RMT */
  audit?(kind: string, actor: string, data: unknown): Promise<void>;
}

export type SteamVerifier = (ticketHex: string) => Promise<{ steamId: string } | { error: string }>;

export interface ServerOptions {
  /** 連線模式需要密碼（或 Steam 票證）；單機模式不需要 */
  online: boolean;
  storage: ServerStorage;
  /** 啟動前先由呼叫端讀好的世界資料（交易所等） */
  world?: WorldRecord;
  /** 驗證 Steam 登入票證（連線模式、Steam 版） */
  verifySteamTicket?: SteamVerifier;
  hashPassword?: (password: string) => string;
  verifyPassword?: (password: string, hash: string) => boolean;
  rng?: Rng;
  marketBots?: boolean;
  now?: () => number;
  uidPrefix?: string;
}

// ------------------------------------------------------------ 實體

type Intent =
  | { kind: 'move'; x: number; z: number }
  | { kind: 'attack'; id: number }
  | { kind: 'pickup'; id: number }
  | { kind: 'gather'; node: number }
  | { kind: 'npc'; id: (typeof NPC_POSITIONS)[number]['id'] }
  | { kind: 'station'; id: StationId }
  | { kind: 'skill'; skill: string; target: number };

interface Mover {
  id: number;
  x: number;
  z: number;
  yaw: number;
  moving: boolean;
  swing: number;
}

interface PlayerEnt extends Mover {
  conn: Conn;
  name: string;
  ch: Character;
  home: Homestead;
  pity: Map<string, number>;
  zone?: Zone;
  intent?: Intent;
  nextAttack: number;
  nextGather: number;
  nextRegen: number;
  lastCombat: number;
  dirtySelf: boolean;
  dirtyHome: boolean;
  trade?: { session: TradeSession; side: Side; partner: PlayerEnt };
  invitesFrom: Set<string>;
  party?: Party;
  partyInvitesFrom: Set<string>;
  cooldowns: Map<string, number>;
  nextBuffCheck: number;
  lastChat: number;
  createdAt: number;
  passwordHash?: string;
  steamId?: string;
  playMs: number;
  lastInput: number;
  lastFeedback: number;
}

interface Party {
  id: number;
  leader: string;
  members: string[];
  share: PartyShareMode;
}

interface MonsterEnt extends Mover {
  def: MonsterDef;
  hp: number;
  cx: number;
  cz: number;
  radius: number;
  target?: PlayerEnt;
  dead: boolean;
  respawnAt: number;
  nextAttack: number;
  nextWander: number;
  wander?: { x: number; z: number };
  damageBy: Map<string, number>;
}

interface GroundItem {
  id: number;
  item: ItemInstance;
  x: number;
  z: number;
  expireAt: number;
  owner?: string;
  ownerParty?: number;
  ownerUntil: number;
}

interface Zone {
  key: string;
  kind: ZoneId;
  owner: string;
  layout: MapLayout;
  players: Set<PlayerEnt>;
  monsters: MonsterEnt[];
  items: GroundItem[];
  home?: Homestead;
  nextSnap: number;
}

const MELEE_RANGE = 1.6;
const RANGED_RANGE = 7;
const INTERACT_RANGE = 2.4;
const NPC_ACTION_RANGE = 6;
const LOOT_PRIORITY_MS = 5_000;
const ITEM_LIFETIME_MS = 120_000;
const SNAP_INTERVAL_MS = 100;
const SAVE_INTERVAL_MS = 30_000;

const valid = (s: unknown): s is string => typeof s === 'string' && s.length > 0 && s.length < 64;
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/** 只接受物件「自己的」鍵：'toString'、'__proto__' 等原型鏈上的名稱一律不算 */
function own<T extends object>(obj: T, key: unknown): key is keyof T {
  return typeof key === 'string' && Object.hasOwn(obj, key);
}

const EQUIP_SLOTS: readonly string[] = ['weapon', 'armor', 'helm', 'shield', 'boots', 'accessory'] satisfies EquipSlot[];

/** 超過這段時間沒有任何操作就視為掛機，不計入遊玩時間 */
const AFK_AFTER_MS = 5 * 60_000;

const TRADE_BLOCKED = new Set<ClientMsg['t']>([
  'useItem', 'equip', 'unequip', 'enchant', 'compound', 'discard', 'craft', 'upgradeHome', 'upgradeStation',
  'npcBuy', 'npcSell', 'marketList', 'marketBuy', 'marketCancel', 'storageDeposit', 'storageWithdraw', 'questTurnIn',
]);

export class GameServer {
  private players = new Map<Conn, PlayerEnt>();
  /** 登入處理中（等待資料庫）的連線與名稱，避免重複登入的競態 */
  private pendingLogins = new Set<Conn>();
  private pendingNames = new Set<string>();
  /** 每個帳號的存檔串列，保證同一帳號的寫入依序完成 */
  private saveChains = new Map<string, Promise<void>>();
  private byName = new Map<string, PlayerEnt>();
  private zones = new Map<string, Zone>();
  private parties = new Map<number, Party>();
  private nextPartyPush = 0;
  private nextId = 1;
  readonly uids: UidGen;
  readonly market: Market;
  private bots?: MarketBots;
  private rng: Rng;
  private now: () => number;
  private nextSave: number;

  constructor(private readonly opts: ServerOptions) {
    this.rng = opts.rng ?? mathRng;
    this.now = opts.now ?? (() => Date.now());
    const migrated = opts.world ? migrateWorld(opts.world) : undefined;
    if (migrated?.fixes.length) console.warn('[migrate] world', migrated.fixes);
    const world = migrated?.rec;
    this.uids = new UidGen(opts.uidPrefix ?? 'i', world?.uidCounter ?? 0);
    this.market = new Market(ITEM_DB);
    if (world) {
      this.market.listings = world.market.listings;
      this.market.history = world.market.history;
      this.market.stats = world.market.stats;
      this.market.pendingPayouts = new Map(world.market.pendingPayouts);
    }
    if (opts.marketBots ?? true) this.bots = new MarketBots(this.market, this.uids, this.rng);
    this.nextSave = this.now() + SAVE_INTERVAL_MS;
  }

  get onlineCount(): number {
    return this.players.size;
  }

  // ============================================================ 連線

  connect(conn: Conn): void {
    // 在 login 之前不建立玩家
    void conn;
  }

  disconnect(conn: Conn): void {
    this.pendingLogins.delete(conn);
    const p = this.players.get(conn);
    if (!p) return;
    this.cancelTrade(p, `${p.name} 離線了`);
    this.leaveParty(p, `${p.name} 離線，退出了隊伍`);
    void this.saveAccount(p);
    this.leaveZone(p);
    this.players.delete(conn);
    this.byName.delete(p.name);
    this.broadcastPlayers();
    if (this.opts.online) this.broadcastChat(`${p.name} 離開了遊戲。`);
  }

  handle(conn: Conn, msg: ClientMsg): void {
    if (!msg || typeof msg !== 'object' || typeof (msg as { t?: unknown }).t !== 'string') return;
    if (msg.t === 'login') {
      void this.login(conn, msg).catch((e) => {
        console.error('login error', e);
        conn.send({ t: 'loginFailed', reason: '伺服器錯誤，請稍後再試。' });
      });
      return;
    }
    const p = this.players.get(conn);
    if (!p) return;
    p.lastInput = this.now();
    try {
      this.dispatch(p, msg);
    } catch (e) {
      // 單一玩家的錯誤請求不能讓整台伺服器掛掉
      console.error('handle error', msg.t, e);
      this.log(p, '操作失敗。', '#f99');
    }
  }

  private async login(conn: Conn, msg: Extract<ClientMsg, { t: 'login' }>): Promise<void> {
    if (this.players.has(conn) || this.pendingLogins.has(conn)) return;
    if (msg.version !== PROTOCOL_VERSION) {
      conn.send({ t: 'loginFailed', reason: '版本不符，請更新遊戲。' });
      return;
    }
    const name = String(msg.name ?? '').trim();
    if (!/^[\p{L}\p{N}_]{2,12}$/u.test(name)) {
      conn.send({ t: 'loginFailed', reason: '名稱需為 2~12 個字（中英文、數字、底線）。' });
      return;
    }
    if (BOT_NAMES.includes(name)) {
      conn.send({ t: 'loginFailed', reason: '此名稱無法使用。' });
      return;
    }
    this.pendingLogins.add(conn);
    try {
      const rec = await this.authenticate(conn, msg, name);
      if (!rec || !this.pendingLogins.has(conn)) return; // 驗證失敗或等待中已斷線
      if (this.byName.has(rec.name) || this.pendingNames.has(rec.name)) {
        conn.send({ t: 'loginFailed', reason: '此角色已在線上。' });
        return;
      }
      this.enterWorld(conn, rec);
    } finally {
      this.pendingLogins.delete(conn);
    }
  }

  /** 驗證身分並取得（或建立）帳號；失敗時回傳 undefined 並已通知用戶端 */
  private async authenticate(conn: Conn, msg: Extract<ClientMsg, { t: 'login' }>, name: string): Promise<AccountRecord | undefined> {
    const fail = (reason: string) => {
      conn.send({ t: 'loginFailed', reason });
      return undefined;
    };
    const st = this.opts.storage;
    // 剛離線的角色可能還在存檔中：先等存檔完成再讀，避免讀到舊資料（回檔）
    await this.saveChains.get(name);
    if (!this.opts.online) return (await st.loadAccount(name)) ?? this.newAccount(name);

    // Steam 登入：驗證票證取得 SteamID，以 SteamID 找帳號（不需要密碼）
    if (msg.steamTicket) {
      if (!this.opts.verifySteamTicket || !st.loadAccountBySteamId) return fail('此伺服器未開放 Steam 登入。');
      const v = await this.opts.verifySteamTicket(String(msg.steamTicket));
      if ('error' in v) return fail(`Steam 驗證失敗：${v.error}`);
      const existing = await st.loadAccountBySteamId(v.steamId);
      if (existing) return existing;
      const taken = await st.loadAccount(name);
      if (taken) return fail('這個角色名稱已被使用，請換一個。');
      const rec = this.newAccount(name);
      rec.steamId = v.steamId;
      await st.saveAccount(rec);
      void st.audit?.('account_created', name, { via: 'steam', steamId: v.steamId });
      return rec;
    }

    const pw = String(msg.password ?? '');
    if (pw.length < 4) return fail('密碼至少 4 個字元。');
    const rec = await st.loadAccount(name);
    if (rec?.steamId && !rec.passwordHash) return fail('這是 Steam 帳號，請從 Steam 版登入。');
    if (rec?.passwordHash && !this.opts.verifyPassword?.(pw, rec.passwordHash)) return fail('密碼錯誤。');
    if (rec) {
      if (!rec.passwordHash) rec.passwordHash = this.opts.hashPassword?.(pw);
      return rec;
    }
    const created = this.newAccount(name, this.opts.hashPassword?.(pw));
    await st.saveAccount(created);
    void st.audit?.('account_created', name, { via: 'password' });
    return created;
  }

  private enterWorld(conn: Conn, loaded: AccountRecord): void {
    const { rec, report } = migrateAccount(loaded);
    if (report.fixes.length || report.from !== report.to) this.audit('save_migrated', rec.name, report);
    const name = rec.name;
    const ch = new Character(ITEM_DB, this.uids, rec.character);
    const p: PlayerEnt = {
      id: this.nextId++, conn, name, ch, home: new Homestead(rec.homestead), pity: new Map(rec.pity),
      x: 0, z: 0, yaw: 0, moving: false, swing: 0, nextAttack: 0, nextGather: 0, nextRegen: 0, lastCombat: -1e9,
      dirtySelf: true, dirtyHome: true, invitesFrom: new Set(), partyInvitesFrom: new Set(), cooldowns: new Map(), nextBuffCheck: 0, lastChat: 0, createdAt: rec.createdAt, passwordHash: rec.passwordHash, steamId: rec.steamId,
      playMs: (rec.playSeconds ?? 0) * 1000, lastInput: this.now(), lastFeedback: -1e12,
    };
    if (p.ch.data.hp <= 0) p.ch.data.hp = p.ch.derived().maxHp;
    const offlineHours = Math.max(0, (this.now() - rec.lastLogin) / 3_600_000);
    const beforeRested = p.ch.data.restedExp ?? 0;
    p.ch.data.restedExp = accrueRested(p.ch.progression.baseLevel, beforeRested, offlineHours);
    this.players.set(conn, p);
    this.byName.set(name, p);
    conn.send({ t: 'welcome', id: p.id, name, online: this.opts.online });
    const payout = this.market.collectPayout(p.ch);
    this.enterZone(p, this.fieldZone());
    this.flushSelf(p);
    if (payout) this.log(p, `你離線期間交易所賣出了商品，入帳 ${payout.toLocaleString()}G`, '#ffd24a');
    if ((p.ch.data.restedExp ?? 0) > beforeRested) this.log(p, `休息了一段時間，獲得休息經驗 ${(p.ch.data.restedExp! - beforeRested).toLocaleString()}（打怪經驗加倍直到用完）`, '#8fd0ff');
    void this.saveAccount(p);
    this.audit('login', name, { steam: !!rec.steamId });
    this.broadcastPlayers();
    if (this.opts.online) this.broadcastChat(`${name} 進入了遊戲。`);
  }

  private newAccount(name: string, passwordHash?: string): AccountRecord {
    const ch = newCharacter(name, ITEM_DB, this.uids);
    const give = (id: string, qty = 1) => ch.inventory.add(createItem(ITEM_DB, this.uids, id, qty, { kind: 'system', sourceId: 'starter', at: this.now() }));
    give('novice_knife');
    give('cotton_shirt');
    give('red_potion', 10);
    give('stone_pickaxe');
    give('stone_axe');
    ch.equip(ch.inventory.items.find((i) => i.defId === 'novice_knife')!.uid);
    ch.equip(ch.inventory.items.find((i) => i.defId === 'cotton_shirt')!.uid);
    const now = this.now();
    return { version: SAVE_VERSION, name, passwordHash, character: ch.serialize(), homestead: initialHomestead(), pity: [], createdAt: now, lastLogin: now };
  }

  // ============================================================ 存檔

  private saveAccount(p: PlayerEnt): Promise<void> {
    const rec: AccountRecord = {
      version: SAVE_VERSION,
      name: p.name,
      passwordHash: p.passwordHash,
      steamId: p.steamId,
      character: p.ch.serialize(),
      homestead: structuredClone(p.home.data),
      pity: [...p.pity],
      createdAt: p.createdAt,
      lastLogin: this.now(),
      playSeconds: Math.floor(p.playMs / 1000),
    };
    // 同一帳號的寫入依序排隊，避免舊資料覆蓋新資料
    const prev = this.saveChains.get(p.name) ?? Promise.resolve();
    const next = prev.then(() => this.opts.storage.saveAccount(rec)).catch((e) => console.error('saveAccount failed', p.name, e));
    this.saveChains.set(p.name, next);
    void next.then(() => {
      if (this.saveChains.get(p.name) === next) this.saveChains.delete(p.name);
    });
    return next;
  }

  async saveAll(): Promise<void> {
    const jobs: Promise<void>[] = [...this.players.values()].map((p) => this.saveAccount(p));
    jobs.push(this.opts.storage.saveWorld({
      uidCounter: this.uids.value,
      market: {
        listings: this.market.listings,
        history: this.market.history.slice(-500),
        stats: this.market.stats,
        pendingPayouts: [...this.market.pendingPayouts],
      },
    }).catch((e) => console.error('saveWorld failed', e)));
    // 等待所有排隊中的帳號存檔（包含已離線玩家的最後一次存檔）
    jobs.push(...this.saveChains.values());
    await Promise.all(jobs);
  }

  private audit(kind: string, actor: string, data: unknown): void {
    void this.opts.storage.audit?.(kind, actor, data)?.catch((e) => console.error('audit failed', e));
  }

  // ============================================================ 地圖

  private fieldZone(): Zone {
    return this.worldZone('field');
  }

  /** 野外地圖（所有玩家共用，一直存在） */
  private worldZone(id: WorldZoneId): Zone {
    let z = this.zones.get(id);
    if (!z) {
      z = { key: id, kind: id, owner: '', layout: worldLayout(id), players: new Set(), monsters: [], items: [], nextSnap: 0 };
      for (const [mid, count, [cx, cz], r] of ZONE_SPAWNS[id]) {
        const def = MONSTER_DB.get(mid)!;
        for (let i = 0; i < count; i++) {
          const m: MonsterEnt = {
            id: this.nextId++, def, hp: def.hp, cx, cz, radius: r, x: cx, z: cz, yaw: 0, moving: false, swing: 0,
            dead: false, respawnAt: 0, nextAttack: 0, nextWander: 0, damageBy: new Map(),
          };
          this.placeRandom(z, m);
          z.monsters.push(m);
        }
      }
      this.zones.set(id, z);
    }
    return z;
  }

  private zoneLabel(z: Zone | undefined): string {
    if (!z) return '';
    return z.kind === 'homestead' ? `${z.owner} 的家園` : ZONE_NAMES[z.kind];
  }

  private homeZone(owner: PlayerEnt): Zone {
    const key = `home:${owner.name}`;
    let z = this.zones.get(key);
    if (!z) {
      z = { key, kind: 'homestead', owner: owner.name, layout: homesteadLayout(owner.home.data.nodes), players: new Set(), monsters: [], items: [], home: owner.home, nextSnap: 0 };
      this.zones.set(key, z);
    }
    return z;
  }

  private enterZone(p: PlayerEnt, zone: Zone, from?: ZoneId): void {
    this.leaveZone(p);
    p.zone = zone;
    zone.players.add(p);
    // 從傳送門過來時，出現在通往原地圖的傳送門旁邊
    const back = from ? zone.layout.portals.find((pt) => pt.to === from) : undefined;
    if (back) {
      const dx = zone.layout.spawn.x - back.x;
      const dz = zone.layout.spawn.z - back.z;
      const d = Math.hypot(dx, dz) || 1;
      p.x = back.x + (dx / d) * 2.5;
      p.z = back.z + (dz / d) * 2.5;
    } else {
      p.x = zone.layout.spawn.x;
      p.z = zone.layout.spawn.z;
    }
    p.intent = undefined;
    p.conn.send({ t: 'zone', zone: zone.kind, owner: zone.owner, homestead: zone.home ? structuredClone(zone.home.data) : undefined });
    if (zone.kind === 'frost') this.achieve(p, 'FROST_ARRIVAL');
    if (zone.kind === 'ember') this.achieve(p, 'EMBER_ARRIVAL');
    this.questNotify(p, { kind: 'visit', zone: zone.kind });
    zone.nextSnap = 0;
  }

  private leaveZone(p: PlayerEnt): void {
    const z = p.zone;
    if (!z) return;
    z.players.delete(p);
    for (const m of z.monsters) if (m.target === p) m.target = undefined;
    p.zone = undefined;
    if (z.kind === 'homestead' && z.players.size === 0) this.zones.delete(z.key);
  }

  private placeRandom(z: Zone, m: MonsterEnt): void {
    for (let tries = 0; tries < 20; tries++) {
      const a = this.rng.next() * Math.PI * 2;
      const r = Math.sqrt(this.rng.next()) * m.radius;
      const x = m.cx + Math.cos(a) * r;
      const zz = m.cz + Math.sin(a) * r;
      if (!z.layout.grid.walkable(x, zz)) continue;
      m.x = x;
      m.z = zz;
      m.yaw = this.rng.next() * Math.PI * 2;
      return;
    }
    m.x = m.cx;
    m.z = m.cz;
  }

  // ============================================================ 訊息處理

  private dispatch(p: PlayerEnt, msg: ClientMsg): void {
    const ch = p.ch;
    // 交易視窗開著時不能動背包 / 裝備 / 金幣（防止鎖定後調包；交易核心執行前也會再比對一次）
    if (p.trade && TRADE_BLOCKED.has(msg.t)) {
      this.log(p, '交易中無法進行此操作。', '#f99');
      return;
    }
    switch (msg.t) {
      case 'move':
        if (finite(msg.x) && finite(msg.z)) p.intent = { kind: 'move', x: msg.x, z: msg.z };
        return;
      case 'attack':
        if (finite(msg.id)) p.intent = { kind: 'attack', id: msg.id };
        return;
      case 'pickup':
        if (finite(msg.id)) p.intent = { kind: 'pickup', id: msg.id };
        return;
      case 'gather':
        if (finite(msg.node)) p.intent = { kind: 'gather', node: msg.node };
        return;
      case 'interact':
        if (msg.kind === 'npc' && NPC_POSITIONS.some((n) => n.id === msg.id)) p.intent = { kind: 'npc', id: msg.id };
        if (msg.kind === 'station' && own(STATION_NAMES, msg.id)) p.intent = { kind: 'station', id: msg.id };
        return;
      case 'stop':
        p.intent = undefined;
        return;
      case 'useItem': {
        const it = ch.inventory.get(msg.uid);
        if (!it) return;
        const def = getDef(ITEM_DB, it.defId);
        if (!def.heal) return;
        const d = ch.derived();
        ch.inventory.consume(def.id, 1);
        if (def.heal.hp) ch.data.hp = Math.min(d.maxHp, ch.data.hp + def.heal.hp);
        if (def.heal.sp) ch.data.sp = Math.min(d.maxSp, ch.data.sp + def.heal.sp);
        this.fxAt(p, 'heal', `+${def.heal.hp ?? def.heal.sp}`, def.heal.hp ? '#6f6' : '#6af');
        this.markSelf(p);
        return;
      }
      case 'equip': {
        const r = ch.equip(msg.uid);
        if (!r.ok) this.log(p, r.reason!, '#f99');
        this.markSelf(p);
        return;
      }
      case 'unequip':
        if (!EQUIP_SLOTS.includes(msg.slot)) return;
        if (!ch.unequip(msg.slot)) this.log(p, '背包已滿。', '#f99');
        this.markSelf(p);
        return;
      case 'raiseStat':
        if (STAT_KEYS.includes(msg.stat)) ch.raiseStat(msg.stat);
        this.markSelf(p);
        return;
      case 'changeJob':
        if (own(CLASSES, msg.job) && ch.changeJob(msg.job)) {
          const tier = CLASSES[msg.job].tier;
          this.announce(p, `恭喜${tier === 2 ? '二轉' : '轉職'}為 ${CLASSES[msg.job].name}！`, '#ffe680');
          if (tier === 2) this.achieve(p, 'SECOND_JOB');
          if (this.opts.online) this.broadcastChat(`${p.name} 轉職為 ${CLASSES[msg.job].name}！`);
        }
        this.markSelf(p);
        return;
      case 'storageDeposit':
      case 'storageWithdraw': {
        if (!this.nearNpc(p, 'storage') || typeof msg.uid !== 'string' || !finite(msg.qty)) return;
        const r = msg.t === 'storageDeposit' ? ch.deposit(msg.uid, Math.floor(msg.qty)) : ch.withdraw(msg.uid, Math.floor(msg.qty));
        if (!r.ok) this.log(p, r.reason!, '#f99');
        this.markSelf(p);
        return;
      }
      case 'feedback':
        this.feedback(p, msg);
        return;
      case 'questAccept':
      case 'questTurnIn':
      case 'questAbandon':
        this.questAction(p, msg);
        return;
      case 'learnSkill': {
        const r = ch.learnSkill(String(msg.skill));
        if (r.ok) this.log(p, `學會了 ${SKILL_DB.get(msg.skill)!.name} Lv ${ch.skillLevel(msg.skill)}`, '#9fe0ff');
        else this.log(p, r.reason!, '#f99');
        this.markSelf(p);
        return;
      }
      case 'skill':
        this.requestSkill(p, String(msg.skill), msg.target);
        return;
      case 'enchant':
        this.enchant(p, msg.scrollUid, msg.targetUid);
        return;
      case 'compound': {
        const r = ch.compoundCard(msg.cardUid, msg.equipUid);
        if (r.ok) {
          this.announce(p, '卡片鑲嵌成功！', '#b366ff');
          this.achieve(p, 'CARD_COMPOUND');
        }
        else this.log(p, r.reason!, '#f99');
        this.markSelf(p);
        return;
      }
      case 'discard': {
        const it = ch.inventory.get(msg.uid);
        if (!it || !finite(msg.qty) || msg.qty <= 0) return;
        ch.inventory.take(msg.uid, Math.min(Math.floor(msg.qty), it.qty));
        this.markSelf(p);
        return;
      }
      case 'craft':
        this.craft(p, msg.recipe, msg.times);
        return;
      case 'upgradeHome':
        this.upgradeHome(p);
        return;
      case 'upgradeStation':
        this.upgradeStation(p, msg.station);
        return;
      case 'npcBuy':
        this.npcBuy(p, msg.itemId, msg.qty);
        return;
      case 'npcSell':
        this.npcSell(p, msg.uid, msg.qty);
        return;
      case 'marketList':
      case 'marketBuy':
      case 'marketCancel':
        this.marketAction(p, msg);
        return;
      case 'chat':
        this.chat(p, msg.text);
        return;
      case 'tradeRequest':
        this.tradeRequest(p, msg.target);
        return;
      case 'tradeRespond':
        this.tradeRespond(p, msg.from, msg.accept);
        return;
      case 'partyInvite':
        this.partyInvite(p, msg.target);
        return;
      case 'partyRespond':
        this.partyRespond(p, msg.from, msg.accept);
        return;
      case 'partyLeave':
        this.leaveParty(p, `${p.name} 退出了隊伍`);
        return;
      case 'partyKick':
        this.partyKick(p, msg.name);
        return;
      case 'partyShare':
        if (p.party && p.party.leader === p.name && (msg.mode === 'even' || msg.mode === 'each')) {
          p.party.share = msg.mode;
          this.partyMsg(p.party, `經驗分配改為「${msg.mode === 'even' ? '均分' : '各自取得'}」`);
          this.pushParty(p.party);
        }
        return;
      case 'tradeItem':
      case 'tradeGold':
      case 'tradeLock':
      case 'tradeUnlock':
      case 'tradeConfirm':
      case 'tradeCancel':
        this.tradeAction(p, msg);
        return;
    }
  }

  // ============================================================ 主迴圈

  tick(dt: number): void {
    const now = this.now();
    for (const z of [...this.zones.values()]) this.tickZone(z, dt, now);
    for (const p of this.players.values()) {
      if (now - p.lastInput < AFK_AFTER_MS) p.playMs += dt * 1000;
      if (p.dirtySelf) this.flushSelf(p);
      if (p.dirtyHome) {
        p.dirtyHome = false;
        p.conn.send({ t: 'home', data: structuredClone(p.home.data) });
      }
    }
    this.bots?.tick(now, (name) => this.byName.get(name)?.ch, (seller, msg) => {
      const sp = this.byName.get(seller);
      if (sp) {
        this.announce(sp, msg, '#ffd24a');
        this.achieve(sp, 'FIRST_TRADE');
        this.markSelf(sp);
        this.sendMarket(sp);
      }
    });
    if (now >= this.nextPartyPush) {
      this.nextPartyPush = now + 1000;
      for (const party of this.parties.values()) this.pushParty(party);
    }
    if (now >= this.nextSave) {
      this.nextSave = now + SAVE_INTERVAL_MS;
      void this.saveAll();
    }
  }

  private tickZone(z: Zone, dt: number, now: number): void {
    for (const p of [...z.players]) {
      if (p.zone !== z) continue;
      this.tickPlayer(p, z, dt, now);
    }
    this.tickMonsters(z, dt, now);
    z.items = z.items.filter((it) => it.expireAt > now);
    if (now >= z.nextSnap) {
      z.nextSnap = now + SNAP_INTERVAL_MS;
      this.sendSnap(z, now);
    }
  }

  private speedOf(p: PlayerEnt): number {
    return 4.3 + p.ch.derived().totalStats.agi * 0.01;
  }

  /** 朝目標移動；回傳是否抵達。碰到障礙物會沿牆滑動或停下 */
  private moveToward(z: Zone, e: Mover, tx: number, tz: number, speed: number, dt: number, stopAt: number): boolean {
    const dx = tx - e.x;
    const dz = tz - e.z;
    const d = Math.hypot(dx, dz);
    if (d <= stopAt) return true;
    const step = Math.min(speed * dt, d - stopAt);
    let nx = e.x + (dx / d) * step;
    let nz = e.z + (dz / d) * step;
    const g = z.layout.grid;
    if (!g.walkable(nx, nz)) {
      if (g.walkable(nx, e.z)) nz = e.z;
      else if (g.walkable(e.x, nz)) nx = e.x;
      else return true;
    }
    if (g.heightAt(nx, nz) - g.heightAt(e.x, e.z) > 1.2) return true;
    e.x = nx;
    e.z = nz;
    e.yaw = Math.atan2(dx, dz);
    e.moving = true;
    return d - step <= stopAt + 1e-3;
  }

  private face(e: Mover, x: number, z: number): void {
    e.yaw = Math.atan2(x - e.x, z - e.z);
  }

  private tickPlayer(p: PlayerEnt, z: Zone, dt: number, now: number): void {
    const ch = p.ch;
    const d = ch.derived(now);
    const speed = this.speedOf(p);
    p.moving = false;
    const it = p.intent;
    if (it) {
      switch (it.kind) {
        case 'move':
          if (this.moveToward(z, p, it.x, it.z, speed, dt, 0.05)) p.intent = undefined;
          break;
        case 'attack': {
          const m = z.monsters.find((x) => x.id === it.id);
          if (!m || m.dead) {
            p.intent = undefined;
            break;
          }
          const range = this.attackRange(p);
          if (this.moveToward(z, p, m.x, m.z, speed, dt, range)) {
            this.face(p, m.x, m.z);
            if (now >= p.nextAttack) {
              p.nextAttack = now + 1000 / d.attacksPerSec;
              p.swing++;
              this.playerAttack(p, z, m, now);
            }
          }
          break;
        }
        case 'skill': {
          const m = z.monsters.find((x) => x.id === it.target);
          const def = SKILL_DB.get(it.skill);
          if (!m || m.dead || !def) {
            p.intent = undefined;
            break;
          }
          if (this.moveToward(z, p, m.x, m.z, speed, dt, def.range ?? this.attackRange(p))) {
            this.face(p, m.x, m.z);
            this.castSkill(p, z, def, m, now);
            // 施放後繼續普攻同一個目標
            p.intent = m.dead ? undefined : { kind: 'attack', id: m.id };
          }
          break;
        }
        case 'pickup': {
          const gi = z.items.find((x) => x.id === it.id);
          if (!gi) {
            p.intent = undefined;
            break;
          }
          if (this.moveToward(z, p, gi.x, gi.z, speed, dt, 0.8)) {
            this.pickup(p, z, gi, now);
            p.intent = undefined;
          }
          break;
        }
        case 'gather': {
          const pos = z.layout.nodes[it.node];
          if (!pos || !z.home || z.owner !== p.name) {
            p.intent = undefined;
            break;
          }
          if (this.moveToward(z, p, pos.x, pos.z, speed, dt, 1.8)) {
            this.face(p, pos.x, pos.z);
            if (now >= p.nextGather) {
              p.nextGather = now + 1100;
              p.swing++;
              if (!this.doGather(p, z, it.node, now)) p.intent = undefined;
            }
          }
          break;
        }
        case 'npc': {
          const npc = z.layout.npcs.find((n) => n.id === it.id);
          if (!npc) {
            p.intent = undefined;
            break;
          }
          if (this.moveToward(z, p, npc.x, npc.z, speed, dt, INTERACT_RANGE)) {
            p.intent = undefined;
            if (npc.id === 'market') {
              const got = this.market.collectPayout(ch);
              if (got) {
                this.log(p, `領取交易所收入 ${got.toLocaleString()}G`, '#ffd24a');
                this.markSelf(p);
              }
              this.sendMarket(p);
            }
            p.conn.send({ t: 'open', kind: 'npc', id: npc.id });
            this.questNotify(p, { kind: 'talk', npc: npc.id });
          }
          break;
        }
        case 'station': {
          const st = z.layout.stations.find((s) => s.id === it.id);
          if (!st || z.owner !== p.name) {
            p.intent = undefined;
            break;
          }
          if (this.moveToward(z, p, st.x + 0.5, st.z, speed, dt, INTERACT_RANGE)) {
            p.intent = undefined;
            p.conn.send({ t: 'open', kind: 'station', id: st.id });
          }
          break;
        }
      }
    }

    // 傳送門（只有閒置或走路時才會觸發）
    if (!p.intent || p.intent.kind === 'move') {
      for (const portal of z.layout.portals) {
        if (Math.hypot(portal.x - p.x, portal.z - p.z) < 1.1) {
          this.cancelTrade(p, '離開了地圖，交易取消');
          const dest = portal.to === 'homestead' ? this.homeZone(p) : this.worldZone(portal.to);
          this.log(p, `進入了${this.zoneLabel(dest) === `${p.name} 的家園` ? '你的家園' : this.zoneLabel(dest)}。`, '#c99aff');
          this.enterZone(p, dest, z.kind);
          return;
        }
      }
    }

    if (now >= p.nextBuffCheck) {
      p.nextBuffCheck = now + 1000;
      if (ch.pruneBuffs(now)) this.markSelf(p);
    }

    // 自然回復（脫離戰鬥 4 秒後加速）
    if (now >= p.nextRegen) {
      p.nextRegen = now + 2000;
      const out = now - p.lastCombat > 4000;
      // 負重 50% 以上停止自然回復（RO 規則）
      if (ch.weightTier() === 'ok' && (ch.data.hp < d.maxHp || ch.data.sp < d.maxSp)) {
        ch.data.hp = Math.min(d.maxHp, ch.data.hp + Math.max(1, Math.floor(d.maxHp * (out ? 0.03 : 0.005) + d.totalStats.vit / 5)));
        ch.data.sp = Math.min(d.maxSp, ch.data.sp + Math.max(1, Math.floor(d.maxSp * (out ? 0.03 : 0.01))));
        this.markSelf(p);
      }
    }
  }

  // ============================================================ 戰鬥

  private attackRange(p: PlayerEnt): number {
    return p.ch.classDef.ranged ? RANGED_RANGE : MELEE_RANGE;
  }

  /** 負重 90% 以上不能戰鬥與採集（RO 規則），提示後取消目前的行動 */
  private overloaded(p: PlayerEnt): boolean {
    if (p.ch.weightTier() !== 'overloaded') return false;
    this.log(p, '負重超過 90%，無法攻擊、施法或採集。請先把物品存進倉庫或賣掉。', '#f99');
    p.intent = undefined;
    return true;
  }

  private playerAttack(p: PlayerEnt, z: Zone, m: MonsterEnt, now: number): void {
    if (this.overloaded(p)) return;
    const ch = p.ch;
    const d = ch.derived(now);
    const atk = ch.classDef.magic ? Math.max(d.atk, d.matk) : d.atk;
    const res = resolveAttack({ atk, def: d.def, hit: d.hit, flee: d.flee, critPct: d.critPct }, m.def, this.rng);
    p.lastCombat = now;
    if (res.kind === 'miss') {
      if (!m.target) m.target = p;
      this.zoneFx(z, { kind: 'miss', x: m.x, y: this.monsterHeight(m), z: m.z, text: 'Miss', color: '#cccccc', target: m.id });
      return;
    }
    this.damageMonster(p, z, m, res.damage, res.kind === 'crit', now);
  }

  /** 對怪物造成傷害（普攻與技能共用）：記錄傷害來源、顯示數字、判定死亡 */
  private damageMonster(p: PlayerEnt, z: Zone, m: MonsterEnt, damage: number, crit: boolean, now: number, color?: string): void {
    if (m.dead) return;
    if (!m.target) m.target = p;
    const dealt = Math.min(damage, m.hp);
    m.hp -= damage;
    m.damageBy.set(p.name, (m.damageBy.get(p.name) ?? 0) + dealt);
    this.zoneFx(z, { kind: crit ? 'crit' : 'dmg', x: m.x, y: this.monsterHeight(m), z: m.z, text: String(damage), color: color ?? (crit ? '#ffd24a' : '#ffffff'), target: m.id });
    if (m.hp <= 0) this.killMonster(z, m, now);
  }

  // ============================================================ 技能

  private requestSkill(p: PlayerEnt, id: string, target?: number): void {
    const def = SKILL_DB.get(id);
    const z = p.zone;
    if (!def || def.kind !== 'active' || !z) return;
    if (p.ch.skillLevel(id) <= 0) return this.log(p, '尚未學會這個技能。', '#f99');
    if (this.overloaded(p)) return;
    if (def.target === 'enemy') {
      const m = finite(target) ? z.monsters.find((x) => x.id === target && !x.dead) : undefined;
      if (!m) return this.log(p, '請先選擇目標。', '#f99');
      p.intent = { kind: 'skill', skill: id, target: m.id };
      return;
    }
    this.castSkill(p, z, def, undefined, this.now());
  }

  private static readonly ELEMENT_COLOR: Record<string, string> = {
    physical: '#ffffff', fire: '#ff8a3a', ice: '#9adfff', lightning: '#ffe860', holy: '#fff4b0', gold: '#ffd24a',
  };

  /** 施放技能。所有檢查（冷卻、SP、金幣、距離）都在這裡，用戶端無法略過 */
  private castSkill(p: PlayerEnt, z: Zone, def: SkillDef, target: MonsterEnt | undefined, now: number): void {
    const ch = p.ch;
    const lv = ch.skillLevel(def.id);
    if (lv <= 0) return;
    const readyAt = p.cooldowns.get(def.id) ?? 0;
    if (now < readyAt) return this.log(p, `${def.name} 冷卻中（${Math.ceil((readyAt - now) / 1000)} 秒）。`, '#f99');
    const sp = def.sp?.(lv) ?? 0;
    if (ch.data.sp < sp) return this.log(p, 'SP 不足。', '#f99');
    const gold = def.damage?.goldCost?.(lv) ?? 0;
    if (ch.data.gold < gold) return this.log(p, '金幣不足。', '#f99');
    if (def.target === 'enemy' && (!target || target.dead)) return;

    ch.data.sp -= sp;
    ch.data.gold -= gold;
    const cd = def.cooldownMs?.(lv) ?? 0;
    p.cooldowns.set(def.id, now + cd);
    p.conn.send({ t: 'skillUsed', skill: def.id, cooldownMs: cd });
    p.swing++;
    p.lastCombat = now;
    const d = ch.derived(now);
    p.nextAttack = now + 1000 / d.attacksPerSec; // 技能取代一次普攻
    const color = GameServer.ELEMENT_COLOR[def.element ?? 'physical'];
    const cx = target ? target.x : p.x;
    const cz = target ? target.z : p.z;
    this.zoneFx(z, { kind: 'skill', x: cx, y: 0.5, z: cz, text: def.name, color, radius: def.damage?.aoe ?? 0, element: def.element, caster: p.id });

    if (def.heal) {
      const amount = Math.floor(def.heal(lv) * (1 + d.totalStats.int / 100) + d.maxHp * 0.02);
      ch.data.hp = Math.min(d.maxHp, ch.data.hp + amount);
      this.zoneFx(z, { kind: 'heal', x: p.x, y: 2.2, z: p.z, text: `+${amount}`, color: '#6f6', target: p.id });
    }
    if (def.buff) {
      ch.addBuff(def.id, lv, now + def.buff.durationMs(lv));
      this.log(p, `${def.name} 生效（${Math.round(def.buff.durationMs(lv) / 1000)} 秒）`, '#9fe0ff');
    }
    const dmg = def.damage;
    if (dmg) {
      const victims = dmg.aoe
        ? z.monsters.filter((m) => !m.dead && Math.hypot(m.x - cx, m.z - cz) <= dmg.aoe!)
        : target ? [target] : [];
      const mul = dmg.mul(lv);
      for (const m of victims) {
        for (let h = 0; h < (dmg.hits ?? 1) && !m.dead; h++) {
          const variance = 0.9 + this.rng.next() * 0.2;
          if (dmg.type === 'magic') {
            // 魔法必中，敵人防禦效果減半
            const v = Math.max(1, Math.round(d.matk * mul * variance * defReduction(m.def.def / 2)));
            this.damageMonster(p, z, m, v, false, now, color);
          } else {
            if (this.rng.next() >= hitChance(d.hit + (dmg.hitBonus ?? 0), m.def.flee)) {
              this.zoneFx(z, { kind: 'miss', x: m.x, y: this.monsterHeight(m), z: m.z, text: 'Miss', color: '#cccccc', target: m.id });
              if (!m.target) m.target = p;
              continue;
            }
            const v = Math.max(1, Math.round(d.atk * mul * variance * (dmg.ignoreDef ? 1 : defReduction(m.def.def))));
            this.damageMonster(p, z, m, v, false, now, color);
          }
        }
      }
    }
    this.markSelf(p);
  }

  private monsterHeight(m: MonsterEnt): number {
    return 1 + m.def.look.scale * 1.2;
  }

  private killMonster(z: Zone, m: MonsterEnt, now: number): void {
    m.dead = true;
    m.hp = 0;
    m.respawnAt = now + m.def.respawnSec * 1000;
    m.target = undefined;
    this.zoneFx(z, { kind: 'poof', x: m.x, y: 0.5, z: m.z });

    // MVP / 撿取優先權：總傷害最高的在線玩家
    let top: PlayerEnt | undefined;
    let topDmg = -1;
    for (const [name, dmg] of m.damageBy) {
      const pl = this.byName.get(name);
      if (pl && pl.zone === z && dmg > topDmg) {
        top = pl;
        topDmg = dmg;
      }
    }
    // 經驗分配：單人依傷害比例；隊伍均分時全隊（同地圖、距離內）平分並有人數加成
    const groupOf = (name: string): ShareGroup | undefined => {
      const pl = this.byName.get(name);
      const party = pl?.party;
      if (!party) return undefined;
      const eligible = party.members
        .map((n) => this.byName.get(n))
        .filter((x): x is PlayerEnt => !!x && x.zone === z && Math.hypot(x.x - m.x, x.z - m.z) <= PARTY_SHARE_DISTANCE)
        .map((x) => ({ name: x.name, level: x.ch.progression.baseLevel }));
      return { partyId: party.id, mode: party.share, eligible };
    };
    const shares = distributeExp(m.damageBy, groupOf);
    for (const [name, share] of shares) {
      const pl = this.byName.get(name);
      if (!pl || pl.zone !== z) continue;
      const mod = expLevelModifier(pl.ch.progression.baseLevel, m.def.level);
      const prog = pl.ch.progression;
      const raw = Math.max(1, Math.floor(m.def.baseExp * mod * share));
      const capped = capKillExp(prog.baseLevel, raw, m.def.level);
      const [rested, left] = consumeRested(pl.ch.data.restedExp ?? 0, capped);
      pl.ch.data.restedExp = left;
      const be = capped + rested;
      const je = Math.max(1, Math.floor(Math.min(m.def.jobExp * mod * share, (m.def.jobExp / Math.max(1, m.def.baseExp)) * capped)));
      this.achieve(pl, 'FIRST_BLOOD');
      if (m.def.id === 'bone_lich') this.achieve(pl, 'MVP_LICH');
      if (m.def.id === 'frost_queen') this.achieve(pl, 'MVP_QUEEN');
      if (m.def.id === 'ember_lord') this.achieve(pl, 'MVP_EMBER_LORD');
      this.log(pl, `擊敗 ${m.def.name}，獲得 Base EXP ${be}${rested ? `（休息加成 +${rested}）` : ''}${capped < raw ? '（已達單次上限）' : ''}、Job EXP ${je}`, '#bcd');
      this.giveExp(pl, be, je);
      // 分到經驗的人（含隊友）都算擊殺
      this.questNotify(pl, { kind: 'kill', monster: m.def.id });
      this.markSelf(pl);
    }
    m.damageBy.clear();
    if (!top) return;

    const d = top.ch.derived();
    const drops = rollDrops(m.def.drops, ITEM_DB, POOL_DB, {
      playerLevel: top.ch.progression.baseLevel,
      sourceLevel: m.def.level,
      luk: d.totalStats.luk,
      personalBonusPct: d.dropBonusPct,
      eventMultiplier: 1,
      isMvpWinner: m.def.mvp,
      pityCounters: top.pity,
    }, this.rng);
    if (m.def.mvp) {
      this.announce(top, `MVP！你擊敗了 ${m.def.name}！`, '#ff9f1a');
      this.broadcastChat(`【MVP】${top.name} 擊敗了 ${m.def.name}！`);
    }
    for (const drop of drops) {
      const item = createItem(ITEM_DB, this.uids, drop.itemId, drop.qty, { kind: 'drop', sourceId: m.def.id, at: now });
      const def = getDef(ITEM_DB, drop.itemId);
      if (drop.rarity >= Rarity.Epic) {
        this.broadcastAnnounce(`【全服公告】${top.name} 從 ${m.def.name} 身上獲得了 ${def.name}！`, RARITY_INFO[def.rarity].color);
        this.audit('rare_drop', top.name, { uid: item.uid, defId: item.defId, qty: item.qty, source: m.def.id });
      }
      if (drop.category === 'mvp' && top.ch.inventory.add(item)) {
        this.log(top, `MVP 獎勵：${def.name} x${drop.qty}`, RARITY_INFO[def.rarity].color);
        this.markSelf(top);
      } else {
        let x = m.x + randRange(this.rng, -1, 1);
        let zz = m.z + randRange(this.rng, -1, 1);
        if (!z.layout.grid.walkable(x, zz)) {
          x = m.x;
          zz = m.z;
        }
        z.items.push({ id: this.nextId++, item, x, z: zz, expireAt: now + ITEM_LIFETIME_MS, owner: top.name, ownerParty: top.party?.id, ownerUntil: now + LOOT_PRIORITY_MS });
      }
    }
  }

  private pickup(p: PlayerEnt, z: Zone, gi: GroundItem, now: number): void {
    const ch = p.ch;
    const def = getDef(ITEM_DB, gi.item.defId);
    const partyOk = gi.ownerParty !== undefined && p.party?.id === gi.ownerParty;
    if (gi.owner && gi.owner !== p.name && !partyOk && now < gi.ownerUntil) {
      this.log(p, `這是 ${gi.owner} 的戰利品，${Math.ceil((gi.ownerUntil - now) / 1000)} 秒後才能撿取。`, '#f99');
      return;
    }
    if (ch.inventory.totalWeight() + def.weight * gi.item.qty > ch.derived().maxWeight) {
      this.log(p, '負重已滿，無法撿取。', '#f66');
      return;
    }
    if (!ch.inventory.add(gi.item)) {
      this.log(p, '背包已滿。', '#f66');
      return;
    }
    z.items.splice(z.items.indexOf(gi), 1);
    this.log(p, `獲得 ${def.name} x${gi.item.qty}`, RARITY_INFO[def.rarity].color);
    p.conn.send({ t: 'sfx', name: def.rarity >= Rarity.Epic ? 'rare' : 'pickup' });
    this.markSelf(p);
  }

  private tickMonsters(z: Zone, dt: number, now: number): void {
    for (const m of z.monsters) {
      m.moving = false;
      if (m.dead) {
        if (now >= m.respawnAt) {
          m.dead = false;
          m.hp = m.def.hp;
          m.target = undefined;
          this.placeRandom(z, m);
          if (m.def.mvp) this.broadcastAnnounce(`${m.def.name} 出現在${MVP_LOCATION[m.def.id] ?? ZONE_NAMES[z.kind]}！`, '#ff6b6b');
        }
        continue;
      }
      // 主動怪：找最近的玩家
      if (!m.target && m.def.aggressive) {
        let best: PlayerEnt | undefined;
        let bd = 5;
        for (const p of z.players) {
          const d = Math.hypot(p.x - m.x, p.z - m.z);
          if (d < bd) {
            bd = d;
            best = p;
          }
        }
        m.target = best;
      }
      const t = m.target;
      if (t && (t.zone !== z || Math.hypot(t.x - m.x, t.z - m.z) > 16 || Math.hypot(m.x - m.cx, m.z - m.cz) > m.radius + 14)) {
        // 放棄追擊並回血（防止拉怪）
        m.target = undefined;
        m.hp = m.def.hp;
        m.damageBy.clear();
        m.wander = { x: m.cx, z: m.cz };
      }
      if (m.target) {
        const p = m.target;
        if (this.moveToward(z, m, p.x, p.z, m.def.speed * 1.3, dt, 1.2)) {
          this.face(m, p.x, p.z);
          if (now >= m.nextAttack) {
            m.nextAttack = now + 1000 / m.def.attacksPerSec;
            m.swing++;
            this.monsterAttack(z, m, p, now);
          }
        }
      } else {
        if (now >= m.nextWander) {
          m.nextWander = now + randRange(this.rng, 2000, 6000);
          const a = this.rng.next() * Math.PI * 2;
          const r = this.rng.next() * m.radius;
          m.wander = { x: m.cx + Math.cos(a) * r, z: m.cz + Math.sin(a) * r };
        }
        if (m.wander && this.moveToward(z, m, m.wander.x, m.wander.z, m.def.speed * 0.5, dt, 0.1)) m.wander = undefined;
      }
    }
  }

  private monsterAttack(z: Zone, m: MonsterEnt, p: PlayerEnt, now: number): void {
    const ch = p.ch;
    const res = resolveAttack({ ...m.def, critPct: 1 }, ch.derived(now), this.rng);
    p.lastCombat = now;
    if (res.kind === 'miss') {
      this.zoneFx(z, { kind: 'miss', x: p.x, y: 2.2, z: p.z, text: 'Miss', color: '#9fd', target: p.id });
      return;
    }
    ch.data.hp -= res.damage;
    this.zoneFx(z, { kind: 'hurt', x: p.x, y: 2.2, z: p.z, text: String(res.damage), color: '#ff5a5a', target: p.id });
    if (!p.intent) p.intent = { kind: 'attack', id: m.id }; // 被打會自動反擊
    this.markSelf(p);
    if (ch.data.hp <= 0) {
      const lost = applyDeathPenalty(ch.progression);
      this.announce(p, `你被 ${m.def.name} 擊倒了…（失去 ${lost} 經驗值）`, '#ff6b6b');
      ch.data.hp = ch.derived().maxHp;
      for (const mm of z.monsters) if (mm.target === p) mm.target = undefined;
      this.cancelTrade(p, '交易取消');
      this.enterZone(p, this.fieldZone());
    }
  }

  /** 給經驗並處理升級（打怪與任務獎勵共用） */
  private giveExp(pl: PlayerEnt, be: number, je: number): void {
    const lv = addExp(pl.ch.progression, be, je);
    if (lv.baseLevelsGained) {
      // 封測分析用：每次升級記下實際遊玩時數（npm run report:playtest）
      this.audit('level_up', pl.name, { level: pl.ch.progression.baseLevel, jobLevel: pl.ch.progression.jobLevel, classId: pl.ch.data.classId, playSeconds: Math.floor(pl.playMs / 1000), zone: pl.zone?.kind });
      const d = pl.ch.derived();
      pl.ch.data.hp = d.maxHp;
      pl.ch.data.sp = d.maxSp;
      this.announce(pl, `等級提升！Base Lv ${pl.ch.progression.baseLevel}`, '#ffe680');
      if (pl.zone) this.zoneFx(pl.zone, { kind: 'levelup', x: pl.x, y: 2.4, z: pl.z, text: 'LEVEL UP!', color: '#ffe680', target: pl.id });
    }
    if (lv.jobLevelsGained) this.log(pl, `Job Lv 提升至 ${pl.ch.progression.jobLevel}，獲得技能點（按 K 開啟技能視窗）${pl.ch.canChangeJob() ? '。可以轉職了！按 S 開啟角色視窗' : ''}`, '#ffe680');
    this.markSelf(pl);
  }

  // ============================================================ 封測回報

  private feedback(p: PlayerEnt, msg: Extract<ClientMsg, { t: 'feedback' }>): void {
    const text = typeof msg.text === 'string' ? msg.text.replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim().slice(0, 1000) : '';
    if (!text) return;
    const now = this.now();
    if (now - p.lastFeedback < 20_000) return this.log(p, '回報太頻繁了，請稍等一下。', '#f99');
    p.lastFeedback = now;
    const category = msg.category === 'bug' || msg.category === 'balance' || msg.category === 'idea' ? msg.category : 'other';
    const client = msg.client && typeof msg.client === 'object' ? JSON.stringify(msg.client).slice(0, 400) : undefined;
    this.audit('feedback', p.name, {
      category, text, client,
      zone: p.zone?.kind, x: Math.round(p.x), z: Math.round(p.z),
      level: p.ch.progression.baseLevel, jobLevel: p.ch.progression.jobLevel, classId: p.ch.data.classId,
      playSeconds: Math.floor(p.playMs / 1000),
    });
    this.log(p, '感謝回報！已經送出，開發者會看到。', '#9fffb0');
  }

  // ============================================================ 任務

  private questNotify(p: PlayerEnt, ev: QuestEvent): void {
    const changes = questEvent(p.ch, ev);
    for (const c of changes) {
      const done = c.have >= c.need;
      const ready = questStatus(p.ch, c.def, questDay(this.now())) === 'ready';
      this.log(p, `任務「${c.def.name}」${c.need > 1 ? `：${c.have} / ${c.need}` : '目標達成'}${ready ? '　✔ 可以回報了！' : ''}`, done ? '#9fffb0' : '#9fe0ff');
      if (ready) p.conn.send({ t: 'sfx', name: 'quest' });
    }
    if (changes.length) this.markSelf(p);
  }

  private questAction(p: PlayerEnt, msg: Extract<ClientMsg, { t: 'questAccept' | 'questTurnIn' | 'questAbandon' }>): void {
    const def = typeof msg.id === 'string' ? QUEST_DB.get(msg.id) : undefined;
    if (!def) return;
    const day = questDay(this.now());
    if (msg.t === 'questAbandon') {
      if (abandonQuest(p.ch, def.id)) this.log(p, `放棄了任務「${def.name}」。`, '#fc8');
      this.markSelf(p);
      return;
    }
    // 接任務與回報都要站在委託人旁邊（放棄不用）
    if (!this.nearNpc(p, def.giver)) return;
    if (msg.t === 'questAccept') {
      const r = acceptQuest(p.ch, def.id, day);
      if (!r.ok) return this.log(p, r.reason!, '#f99');
      this.log(p, `接受任務「${def.name}」：${def.hint}`, '#9fe0ff');
      // 狀態型目標（收集、職業）可能一接就完成；對話目標如果委託人就是對象也立即完成
      this.questNotify(p, { kind: 'talk', npc: def.giver });
      this.markSelf(p);
      return;
    }
    const r = turnInQuest(p.ch, def.id, day, ITEM_DB, this.uids, this.now());
    if (!r.ok) return this.log(p, r.reason!, '#f99');
    const rw = r.reward!;
    const parts = [rw.gold ? `${rw.gold.toLocaleString()}G` : '', ...(rw.items ?? []).map(([id, n]) => `${getDef(ITEM_DB, id).name} x${n}`)].filter(Boolean);
    this.announce(p, `完成任務「${def.name}」！${parts.length ? `獲得 ${parts.join('、')}` : ''}`, '#ffd24a');
    p.conn.send({ t: 'sfx', name: 'quest' });
    if (rw.baseExp || rw.jobExp) {
      this.log(p, `任務經驗：Base EXP ${rw.baseExp ?? 0}、Job EXP ${rw.jobExp ?? 0}`, '#bcd');
      this.giveExp(p, rw.baseExp ?? 0, rw.jobExp ?? 0);
    }
    this.audit('quest_done', p.name, { id: def.id, reward: rw });
    this.markSelf(p);
  }

  // ============================================================ 家園

  private doGather(p: PlayerEnt, z: Zone, nodeIndex: number, now: number): boolean {
    if (this.overloaded(p)) return false;
    const home = z.home!;
    const state = home.data.nodes[nodeIndex];
    const def = state && NODE_DB.get(state.defId);
    if (!state || !def) return false;
    const res = gather(p.ch, state, def, ITEM_DB, this.uids, this.rng, now);
    if (!res.ok) {
      this.log(p, res.reason!, '#f99');
      return false;
    }
    const pos = z.layout.nodes[nodeIndex];
    this.zoneFx(z, { kind: 'chips', x: pos.x, y: def.kind === 'tree' ? 1.2 : 0.7, z: pos.z, color: def.kind === 'tree' ? '#7a5a36' : def.color });
    res.items.forEach((it) => {
      const idef = getDef(ITEM_DB, it.defId);
      this.fx(p, { kind: 'text', x: pos.x, y: def.kind === 'tree' ? 3 : 1.8, z: pos.z, text: `+${it.qty} ${idef.name}`, color: RARITY_INFO[idef.rarity].color });
      if (idef.rarity >= Rarity.Rare) this.log(p, `採集到稀有物品：${idef.name}！`, RARITY_INFO[idef.rarity].color);
      if (idef.rarity >= Rarity.Epic) this.broadcastAnnounce(`【全服公告】${p.name} 在家園採集到了 ${idef.name}！`, RARITY_INFO[idef.rarity].color);
    });
    if (res.levelUps) {
      const skill = def.kind === 'ore' ? 'mining' : 'woodcutting';
      this.announce(p, `${def.kind === 'ore' ? '採礦' : '伐木'}等級提升！Lv ${p.ch.data.lifeSkills[skill].level}`, '#9fffb0');
    }
    this.markSelf(p);
    this.markHome(p);
    return !res.depleted;
  }

  private inOwnHomeNear(p: PlayerEnt, station: StationId): boolean {
    const z = p.zone;
    if (!z || z.kind !== 'homestead' || z.owner !== p.name) {
      this.log(p, '只能在自己的家園使用設施。', '#f99');
      return false;
    }
    const st = z.layout.stations.find((s) => s.id === station);
    if (!st || Math.hypot(st.x + 0.5 - p.x, st.z - p.z) > INTERACT_RANGE + 2) {
      this.log(p, '距離設施太遠。', '#f99');
      return false;
    }
    return true;
  }

  private craft(p: PlayerEnt, recipeId: string, times: number): void {
    const r = RECIPE_DB.get(recipeId);
    if (!r || !finite(times)) return;
    if (!this.inOwnHomeNear(p, r.station)) return;
    const out = getDef(ITEM_DB, r.output.itemId);
    let ok = 0;
    let fail = 0;
    for (let i = 0; i < Math.min(Math.max(1, Math.floor(times)), 50); i++) {
      const res = craft(p.ch, r, p.home, ITEM_DB, this.uids, this.rng, this.now());
      if (!res.ok) {
        if (i === 0) this.log(p, res.reason!, '#f99');
        break;
      }
      if (res.success) ok++;
      else fail++;
      if (res.levelUps) this.announce(p, '生活技能等級提升！', '#9fffb0');
    }
    if (ok) this.questNotify(p, { kind: 'craft', recipe: r.id, count: ok });
    if (ok + fail > 0) this.log(p, `製作 ${out.name}：成功 ${ok} 次${fail ? `、失敗 ${fail} 次（材料已消耗）` : ''}`, fail && !ok ? '#f99' : RARITY_INFO[out.rarity].color);
    this.markSelf(p);
  }

  private upgradeHome(p: PlayerEnt): void {
    const next = HOMESTEAD_UPGRADES.find((u) => u.toLevel === p.home.data.level + 1);
    if (!next) return;
    const r = p.home.upgrade(p.ch, next, NODE_DB);
    if (!r.ok) {
      this.log(p, r.reason!, '#f99');
      return;
    }
    this.announce(p, `家園升級到 Lv ${p.home.data.level}！`, '#9fffb0');
    this.markSelf(p);
    this.markHome(p);
    // 資源點數量改變 → 重建家園地圖
    const z = this.zones.get(`home:${p.name}`);
    if (z) {
      z.layout = homesteadLayout(p.home.data.nodes);
      for (const pl of z.players) pl.conn.send({ t: 'zone', zone: 'homestead', owner: z.owner, homestead: structuredClone(p.home.data) });
    }
  }

  private upgradeStation(p: PlayerEnt, id: StationId): void {
    if (!own(STATION_NAMES, id)) return;
    const cost = stationUpgradeCost(id, p.home.buildingLevel(id));
    const r = p.home.upgradeBuilding(p.ch, id, cost, STATION_MAX_LEVEL);
    if (r.ok) this.announce(p, `${STATION_NAMES[id]} 升級到 Lv ${p.home.buildingLevel(id)}！`, '#9fffb0');
    else this.log(p, r.reason!, '#f99');
    this.markSelf(p);
    this.markHome(p);
  }

  // ============================================================ 強化

  private enchant(p: PlayerEnt, scrollUid: string, targetUid: string): void {
    const ch = p.ch;
    const scroll = ch.inventory.get(scrollUid);
    const target = ch.inventory.get(targetUid);
    if (!scroll || !target) return;
    const sdef = getDef(ITEM_DB, scroll.defId);
    const tdef = getDef(ITEM_DB, target.defId);
    if (!sdef.scroll || sdef.scroll === 'protection') return;
    const kind: EnchantKind | undefined = tdef.type === 'weapon' ? 'weapon' : tdef.type === 'armor' ? 'armor' : undefined;
    const scrollKind: EnchantKind = sdef.scroll === 'weaponEnchant' || sdef.scroll === 'blessedWeaponEnchant' ? 'weapon' : 'armor';
    if (!kind) return this.log(p, '這個物品不能強化。', '#f99');
    if (kind !== scrollKind) return this.log(p, `${sdef.name} 只能用在${scrollKind === 'weapon' ? '武器' : '防具'}上。`, '#f99');
    if (enchantSuccessRate(kind, target.enchant) === 0) return this.log(p, '已達強化上限。', '#f99');
    const safe = ENCHANT_RULES[kind].safe;
    ch.inventory.consume(sdef.id, 1);
    const useProtect = target.enchant >= safe && ch.inventory.count('scroll_protect') > 0;
    if (useProtect) ch.inventory.consume('scroll_protect', 1);
    const blessed = sdef.scroll === 'blessedWeaponEnchant' || sdef.scroll === 'blessedArmorEnchant';
    const res = tryEnchant(kind, target.enchant, { blessed, protectedByScroll: useProtect }, this.rng);
    if (res.outcome === 'success') {
      const gain = res.newLevel - target.enchant;
      target.enchant = res.newLevel;
      if (res.newLevel >= 7) this.achieve(p, 'ENCHANT_7');
      p.conn.send({ t: 'sfx', name: 'enchantOk' });
      this.announce(p, `${tdef.name} 發出${gain > 1 ? '耀眼的' : '一陣'}${kind === 'weapon' ? '藍色' : '銀色'}光芒！（+${res.newLevel}）`, '#8cf');
      if (res.newLevel >= safe + 3) this.broadcastAnnounce(`【全服公告】${p.name} 成功將 ${tdef.name} 強化到 +${res.newLevel}！`, '#ff9f1a');
    } else if (res.outcome === 'downgraded') {
      target.enchant = res.newLevel;
      p.conn.send({ t: 'sfx', name: 'enchantFail' });
      this.announce(p, `強化失敗… 保護卷軸發揮效果，${tdef.name} 變為 +${res.newLevel}。`, '#fc8');
    } else if (res.outcome === 'destroyed') {
      ch.inventory.take(target.uid, 1);
      p.conn.send({ t: 'sfx', name: 'enchantFail' });
      this.audit('enchant_destroyed', p.name, { uid: target.uid, defId: target.defId, from: target.enchant });
      this.announce(p, `${tdef.name} 發出強烈的黑色光芒後蒸發了…`, '#f66');
    }
    this.markSelf(p);
  }

  // ============================================================ NPC 與交易所

  private nearNpc(p: PlayerEnt, id: string): boolean {
    const z = p.zone;
    const npc = z?.layout.npcs.find((n) => n.id === id);
    if (!npc || Math.hypot(npc.x - p.x, npc.z - p.z) > NPC_ACTION_RANGE) {
      this.log(p, '請先走到 NPC 旁邊。', '#f99');
      return false;
    }
    return true;
  }

  private npcBuy(p: PlayerEnt, itemId: string, qty: number): void {
    if (!this.nearNpc(p, 'shop') || !finite(qty)) return;
    const entry = NPC_SHOP.find((s) => s.itemId === itemId);
    if (!entry) return;
    const def = getDef(ITEM_DB, itemId);
    const n = def.stackable ? Math.min(Math.max(1, Math.floor(qty)), 100) : 1;
    const discount = Math.min(40, p.ch.passiveBonus().npcBuyDiscountPct ?? 0);
    const cost = Math.max(1, Math.floor(entry.price * (1 - discount / 100))) * n;
    if (p.ch.data.gold < cost) return this.log(p, '金幣不足。', '#f99');
    const it = createItem(ITEM_DB, this.uids, itemId, n, { kind: 'npc', at: this.now() });
    if (!p.ch.inventory.add(it)) return this.log(p, '背包已滿。', '#f99');
    p.ch.data.gold -= cost;
    this.markSelf(p);
  }

  private npcSell(p: PlayerEnt, uid: string, qty: number): void {
    if (!this.nearNpc(p, 'shop') || !finite(qty)) return;
    const it = p.ch.inventory.get(uid);
    if (!it) return;
    const def = getDef(ITEM_DB, it.defId);
    const n = Math.min(Math.max(1, Math.floor(qty)), it.qty);
    const gold = p.ch.sellToNpc(uid, n);
    p.conn.send({ t: 'sfx', name: 'coin' });
    this.log(p, `賣出 ${def.name} x${n}，獲得 ${gold.toLocaleString()}G`, '#ffd24a');
    this.markSelf(p);
  }

  private marketAction(p: PlayerEnt, msg: Extract<ClientMsg, { t: 'marketList' | 'marketBuy' | 'marketCancel' }>): void {
    if (!this.nearNpc(p, 'market')) return;
    const ch = p.ch;
    if (msg.t === 'marketList') {
      if (!finite(msg.qty) || !finite(msg.price)) return;
      const r = this.market.list(ch, msg.uid, Math.floor(msg.qty), Math.floor(msg.price), this.now());
      if (r.ok) this.log(p, `已上架 ${getDef(ITEM_DB, r.listing!.item.defId).name}，支付上架費。`, '#ffd24a');
      else this.log(p, r.reason!, '#f99');
    } else if (msg.t === 'marketBuy') {
      const l = this.market.listings.find((x) => x.id === msg.id);
      const seller = l ? this.byName.get(l.seller) : undefined;
      const r = this.market.buy(ch, msg.id, seller?.ch, this.now());
      if (r.ok) {
        const def = getDef(ITEM_DB, r.sale!.defId);
        this.log(p, `購買 ${def.name} x${r.sale!.qty}，花費 ${r.sale!.price.toLocaleString()}G`, '#ffd24a');
        this.achieve(p, 'FIRST_TRADE');
        if (seller) this.achieve(seller, 'FIRST_TRADE');
        this.audit('market_sale', p.name, r.sale);
        if (seller) {
          seller.conn.send({ t: 'sfx', name: 'coin' });
          this.announce(seller, `【交易所】${p.name} 買下了你的 ${def.name} x${r.sale!.qty}，入帳 ${r.sale!.sellerReceived.toLocaleString()}G`, '#ffd24a');
          this.markSelf(seller);
          this.sendMarket(seller);
        }
      } else this.log(p, r.reason!, '#f99');
    } else {
      const r = this.market.cancel(ch, msg.id);
      if (!r.ok) this.log(p, r.reason!, '#f99');
    }
    this.markSelf(p);
    this.sendMarket(p);
  }

  private sendMarket(p: PlayerEnt): void {
    const averages: Record<string, number> = {};
    for (const s of this.market.history.slice(-300)) averages[s.defId] ??= this.market.averagePrice(s.defId) ?? 0;
    const view: MarketView = {
      listings: this.market.listings.filter((l) => l.expiresAt > this.now()),
      stats: this.market.stats,
      mySales: this.market.history.filter((s) => s.seller === p.name).slice(-10),
      averages,
    };
    p.conn.send({ t: 'market', view });
  }

  // ============================================================ 聊天

  private chat(p: PlayerEnt, text: unknown): void {
    if (typeof text !== 'string') return;
    const clean = text.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 120);
    if (!clean) return;
    const now = this.now();
    if (now - p.lastChat < 500) return this.log(p, '說話太快了。', '#f99');
    p.lastChat = now;
    if (clean.startsWith('%')) {
      const text = clean.slice(1).trim();
      if (!p.party) return this.log(p, '你沒有隊伍。（% 開頭的訊息是隊伍頻道）', '#f99');
      if (!text) return;
      for (const n of p.party.members) this.byName.get(n)?.conn.send({ t: 'chat', from: p.name, text, channel: 'party' });
      return;
    }
    for (const o of this.players.values()) o.conn.send({ t: 'chat', from: p.name, text: clean });
  }

  private broadcastChat(text: string): void {
    for (const o of this.players.values()) o.conn.send({ t: 'chat', from: '系統', text, system: true });
  }

  private broadcastPlayers(): void {
    const names = [...this.byName.keys()];
    for (const o of this.players.values()) o.conn.send({ t: 'players', names });
  }

  // ============================================================ 玩家交易

  private tradeRequest(p: PlayerEnt, target: string): void {
    if (!valid(target) || target === p.name) return;
    const o = this.byName.get(target);
    if (!o) return this.log(p, `${target} 不在線上。`, '#f99');
    if (p.trade || o.trade) return this.log(p, '對方或你正在交易中。', '#f99');
    if (o.zone !== p.zone || Math.hypot(o.x - p.x, o.z - p.z) > 8) return this.log(p, '距離太遠，請靠近對方再交易。', '#f99');
    o.invitesFrom.add(p.name);
    o.conn.send({ t: 'tradeInvite', from: p.name });
    this.log(p, `已向 ${target} 提出交易邀請。`, '#9fe0ff');
  }

  private tradeRespond(p: PlayerEnt, from: string, accept: boolean): void {
    if (!valid(from) || !p.invitesFrom.delete(from)) return;
    const o = this.byName.get(from);
    if (!o) return;
    if (!accept) {
      this.log(o, `${p.name} 拒絕了交易。`, '#f99');
      return;
    }
    if (p.trade || o.trade) return this.log(p, '對方正在交易中。', '#f99');
    if (o.zone !== p.zone || Math.hypot(o.x - p.x, o.z - p.z) > 8) return this.log(p, '距離太遠。', '#f99');
    const session = new TradeSession(ITEM_DB, o.ch, p.ch);
    o.trade = { session, side: 'a', partner: p };
    p.trade = { session, side: 'b', partner: o };
    o.intent = undefined;
    p.intent = undefined;
    this.sendTrade(o);
    this.sendTrade(p);
  }

  private tradeAction(p: PlayerEnt, msg: Extract<ClientMsg, { t: `trade${'Item' | 'Gold' | 'Lock' | 'Unlock' | 'Confirm' | 'Cancel'}` }>): void {
    const t = p.trade;
    if (!t) return;
    const s = t.session;
    let res: { ok: boolean; reason?: string } = { ok: true };
    switch (msg.t) {
      case 'tradeItem':
        if (finite(msg.qty)) res = s.setItem(t.side, msg.uid, Math.floor(msg.qty));
        break;
      case 'tradeGold':
        if (finite(msg.gold)) res = s.setGold(t.side, Math.floor(msg.gold));
        break;
      case 'tradeLock':
        s.lock(t.side);
        break;
      case 'tradeUnlock':
        s.unlock(t.side);
        break;
      case 'tradeCancel':
        this.cancelTrade(p, `${p.name} 取消了交易`);
        return;
      case 'tradeConfirm': {
        const r = s.confirm(t.side);
        if (r.done) {
          const a = t.side === 'a' ? p : t.partner;
          const b = t.side === 'a' ? t.partner : p;
          a.trade = undefined;
          b.trade = undefined;
          for (const x of [a, b]) {
            x.conn.send({ t: 'trade', view: null });
            this.markSelf(x);
            if (r.ok) {
              this.announce(x, '交易完成！', '#8fe07a');
              this.achieve(x, 'FIRST_TRADE');
            }
            else this.log(x, `交易失敗：${r.reason}`, '#f99');
          }
          if (r.ok && r.log) this.audit('trade', r.log.a, r.log);
          return;
        }
        res = r;
        break;
      }
    }
    if (!res.ok && res.reason) this.log(p, res.reason, '#f99');
    this.sendTrade(p);
    this.sendTrade(t.partner);
  }

  private offerView(p: PlayerEnt, side: Side, s: TradeSession): TradeOfferView {
    const o = s.offer(side);
    return {
      items: [...o.items].map(([uid, qty]) => {
        const it = p.ch.inventory.get(uid);
        return it ? { ...it, qty } : undefined;
      }).filter((x): x is ItemInstance => !!x),
      gold: o.gold,
      locked: o.locked,
      confirmed: o.confirmed,
    };
  }

  private sendTrade(p: PlayerEnt): void {
    const t = p.trade;
    if (!t) return;
    const other: Side = t.side === 'a' ? 'b' : 'a';
    p.conn.send({
      t: 'trade',
      view: { partner: t.partner.name, mine: this.offerView(p, t.side, t.session), theirs: this.offerView(t.partner, other, t.session) },
    });
  }

  private cancelTrade(p: PlayerEnt, reason: string): void {
    const t = p.trade;
    if (!t) return;
    t.session.cancel();
    for (const x of [p, t.partner]) {
      x.trade = undefined;
      x.conn.send({ t: 'trade', view: null });
      this.log(x, reason, '#f99');
    }
  }

  // ============================================================ 組隊

  private partyMsg(party: Party, text: string): void {
    for (const n of party.members) this.byName.get(n)?.conn.send({ t: 'chat', from: '隊伍', text, system: true, channel: 'party' });
  }

  private partyView(party: Party, viewer: PlayerEnt): PartyView {
    return {
      leader: party.leader,
      share: party.share,
      members: party.members.map((n) => {
        const pl = this.byName.get(n)!;
        const d = pl.ch.derived();
        const inRange = pl === viewer || (pl.zone === viewer.zone && Math.hypot(pl.x - viewer.x, pl.z - viewer.z) <= PARTY_SHARE_DISTANCE);
        return { name: n, level: pl.ch.progression.baseLevel, cls: pl.ch.data.classId, hp: pl.ch.data.hp, maxHp: d.maxHp, zone: this.zoneLabel(pl.zone), inRange };
      }),
    };
  }

  private pushParty(party: Party): void {
    for (const n of party.members) {
      const pl = this.byName.get(n);
      if (pl) pl.conn.send({ t: 'party', view: this.partyView(party, pl) });
    }
  }

  private partyInvite(p: PlayerEnt, target: string): void {
    if (!valid(target) || target === p.name) return;
    const o = this.byName.get(target);
    if (!o) return this.log(p, `${target} 不在線上。`, '#f99');
    if (o.party) return this.log(p, `${target} 已經有隊伍了。`, '#f99');
    if (p.party && p.party.leader !== p.name) return this.log(p, '只有隊長可以邀請成員。', '#f99');
    if (p.party && p.party.members.length >= PARTY_MAX) return this.log(p, `隊伍最多 ${PARTY_MAX} 人。`, '#f99');
    o.partyInvitesFrom.add(p.name);
    o.conn.send({ t: 'partyInvite', from: p.name });
    this.log(p, `已邀請 ${target} 加入隊伍。`, '#9fe0ff');
  }

  private partyRespond(p: PlayerEnt, from: string, accept: boolean): void {
    if (!valid(from) || !p.partyInvitesFrom.delete(from)) return;
    const inviter = this.byName.get(from);
    if (!inviter) return;
    if (!accept) return this.log(inviter, `${p.name} 拒絕了組隊邀請。`, '#f99');
    if (p.party) return this.log(p, '你已經有隊伍了。', '#f99');
    let party = inviter.party;
    if (!party) {
      party = { id: this.nextId++, leader: inviter.name, members: [inviter.name], share: 'even' };
      this.parties.set(party.id, party);
      inviter.party = party;
    }
    if (party.members.length >= PARTY_MAX) return this.log(p, '隊伍已滿。', '#f99');
    party.members.push(p.name);
    p.party = party;
    this.achieve(p, 'PARTY_UP');
    this.achieve(inviter, 'PARTY_UP');
    this.partyMsg(party, `${p.name} 加入了隊伍！`);
    this.pushParty(party);
  }

  private partyKick(p: PlayerEnt, name: string): void {
    const party = p.party;
    if (!party || party.leader !== p.name || name === p.name) return;
    const o = this.byName.get(name);
    if (o && o.party === party) this.leaveParty(o, `${name} 被移出了隊伍`);
  }

  private leaveParty(p: PlayerEnt, reason: string): void {
    const party = p.party;
    if (!party) return;
    this.partyMsg(party, reason);
    party.members = party.members.filter((n) => n !== p.name);
    p.party = undefined;
    p.conn.send({ t: 'party', view: null });
    if (party.members.length <= 1) {
      // 只剩一人就解散
      for (const n of party.members) {
        const o = this.byName.get(n);
        if (o) {
          o.party = undefined;
          o.conn.send({ t: 'party', view: null });
          this.log(o, '隊伍已解散。', '#9fe0ff');
        }
      }
      this.parties.delete(party.id);
      return;
    }
    if (party.leader === p.name) {
      party.leader = party.members[0];
      this.partyMsg(party, `${party.leader} 成為新的隊長。`);
    }
    this.pushParty(party);
  }

  // ============================================================ 成就

  private achieve(p: PlayerEnt, id: string): void {
    const list = (p.ch.data.achievements ??= []);
    if (list.includes(id)) return;
    const def = ACHIEVEMENT_DB.get(id);
    if (!def) return;
    list.push(id);
    p.conn.send({ t: 'achievement', id, name: def.name, desc: def.desc });
    this.markSelf(p);
  }

  /** 檢查與角色狀態相關的成就（升級、生活技能等） */
  private checkProgressAchievements(p: PlayerEnt): void {
    const lv = p.ch.progression.baseLevel;
    if (lv >= 30) this.achieve(p, 'LEVEL_30');
    if (lv >= 50) this.achieve(p, 'LEVEL_50');
    if (lv >= 70) this.achieve(p, 'LEVEL_70');
    if (lv >= 90) this.achieve(p, 'LEVEL_90');
    if (p.ch.data.classId !== 'novice') this.achieve(p, 'JOB_CHANGE');
    if (Object.values(p.ch.data.lifeSkills).some((s) => s.level >= 20)) this.achieve(p, 'MASTER_CRAFTER');
    if (p.home.data.level >= 2) this.achieve(p, 'HOME_LV2');
    if (p.home.data.level >= 3) this.achieve(p, 'HOME_LV3');
  }

  // ============================================================ 傳送

  private markSelf(p: PlayerEnt): void {
    p.dirtySelf = true;
  }

  /**
   * 最後一道防線：金幣與物品數量必須是非負整數。若有 bug 讓數值壞掉（NaN、負數），
   * 立刻修正並寫入稽核日誌，避免「金幣不足」等比較失效而被無限利用。
   */
  private checkInvariants(p: PlayerEnt): void {
    const d = p.ch.data;
    if (!Number.isSafeInteger(d.gold) || d.gold < 0) {
      this.audit('invariant_violation', p.name, { field: 'gold', value: String(d.gold) });
      d.gold = Number.isFinite(d.gold) ? Math.max(0, Math.min(Math.floor(d.gold), Number.MAX_SAFE_INTEGER)) : 0;
    }
    const inv = p.ch.inventory;
    const bad = inv.items.filter((it) => !Number.isSafeInteger(it.qty) || it.qty <= 0);
    if (bad.length) {
      this.audit('invariant_violation', p.name, { field: 'qty', items: bad.map((it) => ({ uid: it.uid, defId: it.defId, qty: String(it.qty) })) });
      inv.items = inv.items.filter((it) => !bad.includes(it));
    }
  }

  private markHome(p: PlayerEnt): void {
    p.dirtyHome = true;
  }

  private flushSelf(p: PlayerEnt): void {
    this.checkProgressAchievements(p);
    p.dirtySelf = false;
    this.checkInvariants(p);
    p.conn.send({ t: 'self', data: p.ch.serialize() });
  }

  private log(p: PlayerEnt, msg: string, color?: string): void {
    p.conn.send({ t: 'log', msg, color });
  }

  private announce(p: PlayerEnt, msg: string, color: string): void {
    p.conn.send({ t: 'announce', msg, color });
  }

  private broadcastAnnounce(msg: string, color: string): void {
    for (const o of this.players.values()) o.conn.send({ t: 'announce', msg, color });
  }

  private fx(p: PlayerEnt, f: Omit<Extract<ServerMsg, { t: 'fx' }>, 't'>): void {
    p.conn.send({ t: 'fx', ...f });
  }

  private fxAt(p: PlayerEnt, kind: 'heal', text: string, color: string): void {
    this.fx(p, { kind, x: p.x, y: 2.2, z: p.z, text, color, target: p.id });
  }

  private zoneFx(z: Zone, f: Omit<Extract<ServerMsg, { t: 'fx' }>, 't'>): void {
    for (const p of z.players) p.conn.send({ t: 'fx', ...f });
  }

  private sendSnap(z: Zone, now: number): void {
    const r = (n: number) => Math.round(n * 100) / 100;
    const players = [...z.players].map((p) => ({
      id: p.id, name: p.name, cls: p.ch.data.classId, x: r(p.x), z: r(p.z), yaw: r(p.yaw), moving: p.moving, swing: p.swing,
      hp: p.ch.data.hp, maxHp: p.ch.derived().maxHp,
    }));
    const monsters = z.monsters.map((m) => ({ id: m.id, def: m.def.id, x: r(m.x), z: r(m.z), yaw: r(m.yaw), moving: m.moving, swing: m.swing, hp: m.hp, dead: m.dead }));
    const items = z.items.map((it) => {
      const locked = now < it.ownerUntil;
      const party = locked && it.ownerParty !== undefined ? this.parties.get(it.ownerParty)?.members : undefined;
      return { id: it.id, defId: it.item.defId, qty: it.item.qty, x: r(it.x), z: r(it.z), owner: locked ? it.owner : undefined, party };
    });
    const nodes = z.home
      ? z.home.data.nodes.map((n, i) => {
          refreshNode(n, NODE_DB.get(n.defId)!, now);
          return { i, hitsLeft: n.hitsLeft, depleted: n.depletedAt !== undefined };
        })
      : [];
    for (const p of z.players) p.conn.send({ t: 'snap', players, monsters, items, nodes });
  }

  /** 監控用統計 */
  stats(): { online: number; zones: number; listings: number; goldSunkFees: number; goldSunkTax: number; tradeVolume: number } {
    return {
      online: this.players.size,
      zones: this.zones.size,
      listings: this.market.listings.length,
      goldSunkFees: this.market.stats.goldSunkFees,
      goldSunkTax: this.market.stats.goldSunkTax,
      tradeVolume: this.market.stats.volume,
    };
  }

  // ============================================================ 測試 / 除錯用

  /** 僅供測試：取得玩家的角色與位置 */
  debugPlayer(name: string): { ch: Character; x: number; z: number; zone?: string; setPos(x: number, z: number): void; give(defId: string, qty?: number): boolean; sync(): void } | undefined {
    const p = this.byName.get(name);
    if (!p) return undefined;
    return { ch: p.ch, x: p.x, z: p.z, zone: p.zone?.key, setPos: (x, z) => { p.x = x; p.z = z; }, give: (defId, qty = 1) => p.ch.inventory.add(createItem(ITEM_DB, this.uids, defId, qty, { kind: 'system', at: this.now() })), sync: () => this.markSelf(p) };
  }

  debugMonsters(zone: WorldZoneId = 'field'): { id: number; def: string; x: number; z: number; hp: number; dead: boolean }[] {
    return this.worldZone(zone).monsters.map((m) => ({ id: m.id, def: m.def.id, x: m.x, z: m.z, hp: m.hp, dead: m.dead }));
  }
}
