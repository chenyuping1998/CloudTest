/**
 * 權威遊戲伺服器（純 TypeScript，無 DOM / Node 相依）。
 * - 單機模式：在瀏覽器內執行，存檔到 localStorage。
 * - 連線模式：在 Node.js 內執行（server/main.ts），透過 WebSocket 服務多位玩家。
 * 所有會影響經濟的計算（戰鬥、掉寶、採集、強化、製作、交易、交易所）都只在這裡發生。
 */
import { Character, newCharacter, type CharacterData } from '../core/character';
import { resolveAttack } from '../core/combat';
import { rollDrops } from '../core/drops';
import { enchantSuccessRate, ENCHANT_RULES, tryEnchant, type EnchantKind } from '../core/enchant';
import { craft, gather, Homestead, refreshNode, type HomesteadData, type StationId } from '../core/homestead';
import { createItem, getDef, UidGen } from '../core/items';
import { accrueRested, addExp, applyDeathPenalty, capKillExp, consumeRested, expLevelModifier } from '../core/leveling';
import { Market, type Listing, type MarketStats, type Sale } from '../core/market';
import { mathRng, randRange, type Rng } from '../core/rng';
import { TradeSession, type Side } from '../core/trade';
import { Rarity, RARITY_INFO, STAT_KEYS, type ItemInstance } from '../core/types';
import {
  CLASSES, HOMESTEAD_UPGRADES, ITEM_DB, JOB_CHOICES, MONSTER_DB, NODE_DB, NPC_SHOP, POOL_DB, RECIPE_DB, STATION_MAX_LEVEL,
  STATION_NAMES, initialHomestead, stationUpgradeCost,
} from '../data';
import type { MonsterDef } from '../data/monsters';
import type { ClientMsg, MarketView, ServerMsg, TradeOfferView } from '../net/protocol';
import { PROTOCOL_VERSION } from '../net/protocol';
import { FIELD_SPAWNS, fieldLayout, homesteadLayout, NPC_POSITIONS, type MapLayout, type ZoneId } from '../shared/maps';
import { BOT_NAMES, MarketBots } from './marketBots';

// ------------------------------------------------------------ 介面

export interface Conn {
  send(msg: ServerMsg): void;
  close?(): void;
}

export interface AccountRecord {
  name: string;
  passwordHash?: string;
  character: CharacterData;
  homestead: HomesteadData;
  pity: [string, number][];
  createdAt: number;
  lastLogin: number;
}

export interface WorldRecord {
  uidCounter: number;
  market: { listings: Listing[]; history: Sale[]; stats: MarketStats; pendingPayouts: [string, number][] };
}

export interface ServerStorage {
  loadAccount(name: string): AccountRecord | undefined;
  saveAccount(rec: AccountRecord): void;
  loadWorld(): WorldRecord | undefined;
  saveWorld(rec: WorldRecord): void;
}

export interface ServerOptions {
  /** 連線模式需要密碼；單機模式不需要 */
  online: boolean;
  storage: ServerStorage;
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
  | { kind: 'station'; id: StationId };

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
  lastChat: number;
  createdAt: number;
  passwordHash?: string;
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

export class GameServer {
  private players = new Map<Conn, PlayerEnt>();
  private byName = new Map<string, PlayerEnt>();
  private zones = new Map<string, Zone>();
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
    const world = opts.storage.loadWorld();
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
    const p = this.players.get(conn);
    if (!p) return;
    this.cancelTrade(p, `${p.name} 離線了`);
    this.saveAccount(p);
    this.leaveZone(p);
    this.players.delete(conn);
    this.byName.delete(p.name);
    this.broadcastPlayers();
    if (this.opts.online) this.broadcastChat(`${p.name} 離開了遊戲。`);
  }

  handle(conn: Conn, msg: ClientMsg): void {
    if (!msg || typeof msg !== 'object' || typeof (msg as { t?: unknown }).t !== 'string') return;
    if (msg.t === 'login') {
      this.login(conn, msg);
      return;
    }
    const p = this.players.get(conn);
    if (!p) return;
    try {
      this.dispatch(p, msg);
    } catch (e) {
      // 單一玩家的錯誤請求不能讓整台伺服器掛掉
      console.error('handle error', msg.t, e);
      this.log(p, '操作失敗。', '#f99');
    }
  }

  private login(conn: Conn, msg: Extract<ClientMsg, { t: 'login' }>): void {
    if (this.players.has(conn)) return;
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
    if (this.byName.has(name)) {
      conn.send({ t: 'loginFailed', reason: '此角色已在線上。' });
      return;
    }
    let rec = this.opts.storage.loadAccount(name);
    if (this.opts.online) {
      const pw = String(msg.password ?? '');
      if (pw.length < 4) {
        conn.send({ t: 'loginFailed', reason: '密碼至少 4 個字元。' });
        return;
      }
      if (rec?.passwordHash && !this.opts.verifyPassword?.(pw, rec.passwordHash)) {
        conn.send({ t: 'loginFailed', reason: '密碼錯誤。' });
        return;
      }
      if (rec && !rec.passwordHash) rec.passwordHash = this.opts.hashPassword?.(pw);
      if (!rec) rec = this.newAccount(name, this.opts.hashPassword?.(pw));
    } else if (!rec) {
      rec = this.newAccount(name);
    }

    const ch = new Character(ITEM_DB, this.uids, rec.character);
    const p: PlayerEnt = {
      id: this.nextId++, conn, name, ch, home: new Homestead(rec.homestead), pity: new Map(rec.pity),
      x: 0, z: 0, yaw: 0, moving: false, swing: 0, nextAttack: 0, nextGather: 0, nextRegen: 0, lastCombat: -1e9,
      dirtySelf: true, dirtyHome: true, invitesFrom: new Set(), lastChat: 0, createdAt: rec.createdAt, passwordHash: rec.passwordHash,
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
    this.saveAccount(p);
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
    return { name, passwordHash, character: ch.serialize(), homestead: initialHomestead(), pity: [], createdAt: now, lastLogin: now };
  }

  // ============================================================ 存檔

  private saveAccount(p: PlayerEnt): void {
    this.opts.storage.saveAccount({
      name: p.name,
      passwordHash: p.passwordHash,
      character: p.ch.serialize(),
      homestead: structuredClone(p.home.data),
      pity: [...p.pity],
      createdAt: p.createdAt,
      lastLogin: this.now(),
    });
  }

  saveAll(): void {
    for (const p of this.players.values()) this.saveAccount(p);
    this.opts.storage.saveWorld({
      uidCounter: this.uids.value,
      market: {
        listings: this.market.listings,
        history: this.market.history.slice(-500),
        stats: this.market.stats,
        pendingPayouts: [...this.market.pendingPayouts],
      },
    });
  }

  // ============================================================ 地圖

  private fieldZone(): Zone {
    let z = this.zones.get('field');
    if (!z) {
      z = { key: 'field', kind: 'field', owner: '', layout: fieldLayout(), players: new Set(), monsters: [], items: [], nextSnap: 0 };
      for (const [id, count, [cx, cz], r] of FIELD_SPAWNS) {
        const def = MONSTER_DB.get(id)!;
        for (let i = 0; i < count; i++) {
          const m: MonsterEnt = {
            id: this.nextId++, def, hp: def.hp, cx, cz, radius: r, x: cx, z: cz, yaw: 0, moving: false, swing: 0,
            dead: false, respawnAt: 0, nextAttack: 0, nextWander: 0, damageBy: new Map(),
          };
          this.placeRandom(z, m);
          z.monsters.push(m);
        }
      }
      this.zones.set('field', z);
    }
    return z;
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

  private enterZone(p: PlayerEnt, zone: Zone): void {
    this.leaveZone(p);
    p.zone = zone;
    zone.players.add(p);
    p.x = zone.layout.spawn.x;
    p.z = zone.layout.spawn.z;
    p.intent = undefined;
    p.conn.send({ t: 'zone', zone: zone.kind, owner: zone.owner, homestead: zone.home ? structuredClone(zone.home.data) : undefined });
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
        if (msg.kind === 'station' && msg.id in STATION_NAMES) p.intent = { kind: 'station', id: msg.id };
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
        if (!ch.unequip(msg.slot)) this.log(p, '背包已滿。', '#f99');
        this.markSelf(p);
        return;
      case 'raiseStat':
        if (STAT_KEYS.includes(msg.stat)) ch.raiseStat(msg.stat);
        this.markSelf(p);
        return;
      case 'changeJob':
        if (JOB_CHOICES.includes(msg.job) && ch.changeJob(msg.job)) {
          this.announce(p, `恭喜轉職為 ${CLASSES[msg.job].name}！`, '#ffe680');
          if (this.opts.online) this.broadcastChat(`${p.name} 轉職為 ${CLASSES[msg.job].name}！`);
        }
        this.markSelf(p);
        return;
      case 'enchant':
        this.enchant(p, msg.scrollUid, msg.targetUid);
        return;
      case 'compound': {
        const r = ch.compoundCard(msg.cardUid, msg.equipUid);
        if (r.ok) this.announce(p, '卡片鑲嵌成功！', '#b366ff');
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
        this.markSelf(sp);
        this.sendMarket(sp);
      }
    });
    if (now >= this.nextSave) {
      this.nextSave = now + SAVE_INTERVAL_MS;
      this.saveAll();
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
    const d = ch.derived();
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
          const range = ch.data.classId === 'archer' || ch.data.classId === 'mage' ? RANGED_RANGE : MELEE_RANGE;
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
          this.log(p, portal.to === 'homestead' ? '進入了你的家園。' : '回到了晨曦平原。', '#c99aff');
          this.enterZone(p, portal.to === 'homestead' ? this.homeZone(p) : this.fieldZone());
          return;
        }
      }
    }

    // 自然回復（脫離戰鬥 4 秒後加速）
    if (now >= p.nextRegen) {
      p.nextRegen = now + 2000;
      const out = now - p.lastCombat > 4000;
      if (!ch.isOverweight() && (ch.data.hp < d.maxHp || ch.data.sp < d.maxSp)) {
        ch.data.hp = Math.min(d.maxHp, ch.data.hp + Math.max(1, Math.floor(d.maxHp * (out ? 0.03 : 0.005) + d.totalStats.vit / 5)));
        ch.data.sp = Math.min(d.maxSp, ch.data.sp + Math.max(1, Math.floor(d.maxSp * (out ? 0.03 : 0.01))));
        this.markSelf(p);
      }
    }
  }

  // ============================================================ 戰鬥

  private playerAttack(p: PlayerEnt, z: Zone, m: MonsterEnt, now: number): void {
    const ch = p.ch;
    const d = ch.derived();
    const atk = ch.data.classId === 'mage' ? Math.max(d.atk, d.matk) : d.atk;
    const res = resolveAttack({ atk, def: d.def, hit: d.hit, flee: d.flee, critPct: d.critPct }, m.def, this.rng);
    p.lastCombat = now;
    if (!m.target) m.target = p;
    const y = this.monsterHeight(m);
    if (res.kind === 'miss') {
      this.zoneFx(z, { kind: 'miss', x: m.x, y, z: m.z, text: 'Miss', color: '#cccccc', target: m.id });
      return;
    }
    const dmg = Math.min(res.damage, m.hp);
    m.hp -= res.damage;
    m.damageBy.set(p.name, (m.damageBy.get(p.name) ?? 0) + dmg);
    this.zoneFx(z, { kind: res.kind === 'crit' ? 'crit' : 'dmg', x: m.x, y, z: m.z, text: String(res.damage), color: res.kind === 'crit' ? '#ffd24a' : '#ffffff', target: m.id });
    if (m.hp <= 0) this.killMonster(z, m, now);
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

    const total = [...m.damageBy.values()].reduce((s, v) => s + v, 0) || 1;
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
    // 經驗值依傷害比例分配（RO 式）
    for (const [name, dmg] of m.damageBy) {
      const pl = this.byName.get(name);
      if (!pl || pl.zone !== z) continue;
      const share = dmg / total;
      const mod = expLevelModifier(pl.ch.progression.baseLevel, m.def.level);
      const prog = pl.ch.progression;
      const raw = Math.max(1, Math.floor(m.def.baseExp * mod * share));
      const capped = capKillExp(prog.baseLevel, raw);
      const [rested, left] = consumeRested(pl.ch.data.restedExp ?? 0, capped);
      pl.ch.data.restedExp = left;
      const be = Math.min(capped + rested, capKillExp(prog.baseLevel, Number.MAX_SAFE_INTEGER) * 2);
      const je = Math.max(1, Math.floor(Math.min(m.def.jobExp * mod * share, (m.def.jobExp / Math.max(1, m.def.baseExp)) * capped)));
      const lv = addExp(prog, be, je);
      this.log(pl, `擊敗 ${m.def.name}，獲得 Base EXP ${be}${rested ? `（休息加成 +${rested}）` : ''}${capped < raw ? '（已達單次上限）' : ''}、Job EXP ${je}`, '#bcd');
      if (lv.baseLevelsGained) {
        const d = pl.ch.derived();
        pl.ch.data.hp = d.maxHp;
        pl.ch.data.sp = d.maxSp;
        this.announce(pl, `等級提升！Base Lv ${pl.ch.progression.baseLevel}`, '#ffe680');
        this.zoneFx(z, { kind: 'levelup', x: pl.x, y: 2.4, z: pl.z, text: 'LEVEL UP!', color: '#ffe680', target: pl.id });
      }
      if (lv.jobLevelsGained) this.log(pl, `Job Lv 提升至 ${pl.ch.progression.jobLevel}${pl.ch.canChangeJob() ? '（可以轉職了！按 S 開啟角色視窗）' : ''}`, '#ffe680');
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
      if (drop.rarity >= Rarity.Epic) this.broadcastAnnounce(`【全服公告】${top.name} 從 ${m.def.name} 身上獲得了 ${def.name}！`, RARITY_INFO[def.rarity].color);
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
        z.items.push({ id: this.nextId++, item, x, z: zz, expireAt: now + ITEM_LIFETIME_MS, owner: top.name, ownerUntil: now + LOOT_PRIORITY_MS });
      }
    }
  }

  private pickup(p: PlayerEnt, z: Zone, gi: GroundItem, now: number): void {
    const ch = p.ch;
    const def = getDef(ITEM_DB, gi.item.defId);
    if (gi.owner && gi.owner !== p.name && now < gi.ownerUntil) {
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
          if (m.def.mvp) this.broadcastAnnounce(`${m.def.name} 出現在晨曦平原的東南方！`, '#ff6b6b');
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
    const res = resolveAttack({ ...m.def, critPct: 1 }, ch.derived(), this.rng);
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

  // ============================================================ 家園

  private doGather(p: PlayerEnt, z: Zone, nodeIndex: number, now: number): boolean {
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
    if (!(id in STATION_NAMES)) return;
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
      this.announce(p, `${tdef.name} 發出${gain > 1 ? '耀眼的' : '一陣'}${kind === 'weapon' ? '藍色' : '銀色'}光芒！（+${res.newLevel}）`, '#8cf');
      if (res.newLevel >= safe + 3) this.broadcastAnnounce(`【全服公告】${p.name} 成功將 ${tdef.name} 強化到 +${res.newLevel}！`, '#ff9f1a');
    } else if (res.outcome === 'downgraded') {
      target.enchant = res.newLevel;
      this.announce(p, `強化失敗… 保護卷軸發揮效果，${tdef.name} 變為 +${res.newLevel}。`, '#fc8');
    } else if (res.outcome === 'destroyed') {
      ch.inventory.take(target.uid, 1);
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
    const cost = entry.price * n;
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
        if (seller) {
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
            if (r.ok) this.announce(x, '交易完成！', '#8fe07a');
            else this.log(x, `交易失敗：${r.reason}`, '#f99');
          }
          if (r.ok && r.log) console.log('[trade]', JSON.stringify(r.log));
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

  // ============================================================ 傳送

  private markSelf(p: PlayerEnt): void {
    p.dirtySelf = true;
  }

  private markHome(p: PlayerEnt): void {
    p.dirtyHome = true;
  }

  private flushSelf(p: PlayerEnt): void {
    p.dirtySelf = false;
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
    const items = z.items.map((it) => ({ id: it.id, defId: it.item.defId, qty: it.item.qty, x: r(it.x), z: r(it.z), owner: now < it.ownerUntil ? it.owner : undefined }));
    const nodes = z.home
      ? z.home.data.nodes.map((n, i) => {
          refreshNode(n, NODE_DB.get(n.defId)!, now);
          return { i, hitsLeft: n.hitsLeft, depleted: n.depletedAt !== undefined };
        })
      : [];
    for (const p of z.players) p.conn.send({ t: 'snap', players, monsters, items, nodes });
  }

  // ============================================================ 測試 / 除錯用

  /** 僅供測試：取得玩家的角色與位置 */
  debugPlayer(name: string): { ch: Character; x: number; z: number; zone?: string; setPos(x: number, z: number): void } | undefined {
    const p = this.byName.get(name);
    if (!p) return undefined;
    return { ch: p.ch, x: p.x, z: p.z, zone: p.zone?.key, setPos: (x, z) => { p.x = x; p.z = z; } };
  }

  debugMonsters(): { id: number; def: string; x: number; z: number; hp: number; dead: boolean }[] {
    return this.fieldZone().monsters.map((m) => ({ id: m.id, def: m.def.id, x: m.x, z: m.z, hp: m.hp, dead: m.dead }));
  }
}
