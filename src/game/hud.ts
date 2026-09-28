import { ENCHANT_RULES, enchantSuccessRate, type EnchantKind } from '../core/enchant';
import { craftSuccessRate, type StationId } from '../core/homestead';
import { getDef, isTradeable, itemDisplayName } from '../core/items';
import { baseExpToNext, jobExpToNext, lifeSkillExpToNext, statRaiseCost } from '../core/leveling';
import { listingFee, MARKET_RULES } from '../core/market';
import { formatPpm } from '../core/rng';
import { RARITY_INFO, STAT_KEYS, STAT_NAMES, type EquipSlot, type ItemDef, type ItemInstance } from '../core/types';
import {
  CLASSES, HOMESTEAD_UPGRADES, ITEM_DB, MONSTERS, NODE_DB, NPC_SHOP, POOL_DB, RECIPES, STATION_MAX_LEVEL,
  STATION_NAMES, stationUpgradeCost,
} from '../data';
import { referencePrice } from '../shared/pricing';
import type { ClientState } from '../client/ClientState';
import { itemIcon } from './sprites';
import { SKILL_DB, type SkillDef } from '../data/skills';
import { pixelIcon } from './pixelIcons';
import { facePortrait } from './voxel/models';
import { compareEquip, skillEffectLines, statPreview } from './describe';
import { audio } from './audio';
import { settings } from './settings';
import { WEIGHT_NO_ACTION, WEIGHT_NO_REGEN } from '../core/character';
import { SECOND_JOB_OF } from '../data/classes';
import { ask, bar, fmt, h, Panel } from './ui';
import type { NpcId, World } from './world';
import { ZONE_NAMES } from '../shared/maps';

type InvFilter = 'all' | 'equip' | 'use' | 'mat' | 'etc';

const SLOT_NAMES: Record<EquipSlot, string> = { weapon: '武器', armor: '鎧甲', helm: '頭盔', shield: '盾牌', boots: '鞋子', accessory: '飾品' };
const TYPE_ORDER: Record<string, number> = { weapon: 0, armor: 1, accessory: 2, tool: 3, consumable: 4, scroll: 5, card: 6, material: 7 };
const SORT_LABEL = { none: '取得順序', type: '依類型', rarity: '依稀有度', name: '依名稱' } as const;
const DERIVED_NAMES: Record<string, string> = { mining: '採礦', woodcutting: '伐木', smithing: '鍛造', carpentry: '木工', alchemy: '鍊金' };

export class Hud {
  private status: HTMLDivElement;
  private logEl: HTMLDivElement;
  private announceEl: HTMLDivElement;
  private labelLayer: HTMLDivElement;
  private floatLayer: HTMLDivElement;
  private hotbar: HTMLDivElement;
  private tooltip: HTMLDivElement;
  private labelPool: HTMLDivElement[] = [];
  private minimap: HTMLCanvasElement;
  private minimapZone: HTMLDivElement;
  private minimapBase?: { key: string; canvas: HTMLCanvasElement; size: number };
  private nextMinimap = 0;

  private inv: Panel;
  private stats: Panel;
  private home: Panel;
  private station: Panel;
  private shop: Panel;
  private market: Panel;
  private help: Panel;
  private drops: Panel;
  private tradePanel: Panel;
  private skillsPanel: Panel;
  private storagePanel: Panel;
  private settingsPanel: Panel;
  private invSearch = '';
  private storageSel?: string;
  private chatInput: HTMLInputElement;
  private onlineEl: HTMLSpanElement;
  private partyEl: HTMLDivElement;
  private tradeAddUid?: string;
  private tradeGoldDraft = '';

  private invFilter: InvFilter = 'all';
  private selectedUid?: string;
  /** 強化或插卡時等待選擇目標裝備 */
  private pending?: { kind: 'enchant' | 'card'; uid: string };
  private stationId: StationId = 'smelter';
  private marketTab: 'buy' | 'sell' | 'mine' = 'buy';
  private sellSel?: string;
  private sellForm = { uid: '', qty: 1, price: 0 };
  private dirty = true;
  /** 滑鼠按住時不重繪，避免按鈕在 mousedown / mouseup 之間被換掉而點不到 */
  private pointerDown = false;

  constructor(
    private readonly root: HTMLElement,
    private readonly cs: ClientState,
    private readonly world: () => World,
  ) {
    this.labelLayer = h('div', { class: 'label-layer' });
    this.floatLayer = h('div', { class: 'float-layer' });
    this.status = h('div', { class: 'hud-status frame' });
    this.partyEl = h('div', { class: 'hud-party frame', style: 'display:none' });
    this.logEl = h('div', { class: 'hud-log' });
    this.announceEl = h('div', { class: 'hud-announce' });
    this.hotbar = h('div', { class: 'hud-hotbar' });
    this.tooltip = h('div', { class: 'tooltip', style: 'display:none' });
    const menuBtn = (icon: string, label: string, key: string, panel: () => Panel) =>
      h('button', { class: 'icon-btn', title: `${label} (${key})`, onclick: () => this.toggle(panel()) },
        h('img', { src: pixelIcon(icon, 3) }), h('span', { class: 'icon-btn-label' }, label), h('span', { class: 'icon-btn-key' }, key));
    const menu = h(
      'div',
      { class: 'hud-menu' },
      menuBtn('bag', '背包', 'I', () => this.inv),
      menuBtn('char', '角色', 'S', () => this.stats),
      menuBtn('sk_physical', '技能', 'K', () => this.skillsPanel),
      menuBtn('home', '家園', 'H', () => this.home),
      menuBtn('book', '掉寶表', 'D', () => this.drops),
      menuBtn('help', '說明', 'F1', () => this.help),
      menuBtn('gear', '設定', 'O', () => this.settingsPanel),
    );
    this.minimap = h('canvas', { class: 'minimap-canvas', width: 180, height: 180 });
    this.minimapZone = h('div', { class: 'minimap-zone' });
    const minimapBox = h('div', { class: 'hud-minimap frame' }, this.minimapZone, this.minimap);
    this.chatInput = h('input', { class: 'chat-input', maxlength: 120, placeholder: 'Enter 輸入聊天訊息…' });
    this.chatInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        const text = this.chatInput.value.trim();
        if (text) this.cs.send({ t: 'chat', text });
        this.chatInput.value = '';
        this.chatInput.blur();
      } else if (e.key === 'Escape') this.chatInput.blur();
    });
    this.onlineEl = h('span', { class: 'online-count' });
    const logBox = h('div', { class: 'hud-logbox frame' }, h('div', { class: 'logbox-title' }, '訊息', this.onlineEl), this.logEl, this.chatInput);
    root.addEventListener('mousedown', () => (this.pointerDown = true));
    settings.subscribe(() => this.markDirty());
    // 介面按鈕的點擊聲
    root.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('button:not([disabled]), .tab, .item-cell:not(.empty)')) audio.play('ui');
    });
    window.addEventListener('mouseup', () => (this.pointerDown = false));
    root.append(this.labelLayer, this.floatLayer, this.status, this.partyEl, menu, minimapBox, logBox, this.announceEl, this.hotbar, this.tooltip);

    this.inv = new Panel(root, '背包', { x: window.innerWidth - 450, y: 70, w: 430 }, () => (this.pending = undefined));
    this.stats = new Panel(root, '角色資訊', { x: 20, y: 60, w: 620 });
    this.home = new Panel(root, '我的家園', { x: 400, y: 80, w: 400 });
    this.station = new Panel(root, '設施', { x: 400, y: 80, w: 460 });
    this.shop = new Panel(root, '道具商人', { x: 400, y: 80, w: 420 });
    this.market = new Panel(root, '交易所', { x: 360, y: 60, w: 560 });
    this.help = new Panel(root, '遊戲說明', { x: 380, y: 60, w: 520 });
    this.drops = new Panel(root, '怪物掉寶表', { x: 380, y: 60, w: 520 });
    this.skillsPanel = new Panel(root, '技能', { x: 360, y: 60, w: 600 });
    this.settingsPanel = new Panel(root, '設定', { x: window.innerWidth / 2 - 190, y: 100, w: 380 });
    this.storagePanel = new Panel(root, '倉庫', { x: window.innerWidth - 880, y: 70, w: 420 });
    this.tradePanel = new Panel(root, '交易', { x: 360, y: 90, w: 560 }, () => {
      if (this.cs.trade) this.cs.send({ t: 'tradeCancel' });
    });
    for (const p of [this.inv, this.stats, this.home, this.station, this.shop, this.market, this.help, this.drops, this.tradePanel, this.skillsPanel, this.storagePanel, this.settingsPanel]) {
      p.body.addEventListener('click', () => this.markDirty());
    }
  }

  // ------------------------------------------------------------ 通用

  private get player() {
    return this.cs.player!;
  }

  markDirty(): void {
    this.dirty = true;
  }

  private toggle(p: Panel): void {
    p.toggle();
    this.markDirty();
  }

  anyPanelOpen(): boolean {
    return [this.inv, this.stats, this.home, this.station, this.shop, this.market, this.help, this.drops, this.skillsPanel, this.storagePanel, this.settingsPanel].some((p) => p.visible);
  }

  closeTopPanel(): boolean {
    const open = [this.inv, this.stats, this.home, this.station, this.shop, this.market, this.help, this.drops, this.skillsPanel, this.storagePanel, this.settingsPanel]
      .filter((p) => p.visible)
      .sort((a, b) => Number(b.el.style.zIndex) - Number(a.el.style.zIndex));
    if (!open.length) return false;
    open[0].hide();
    return true;
  }

  /** 換地圖時關閉需要站在旁邊才能用的視窗（設施、商店、交易所） */
  closeZonePanels(): void {
    this.station.hide();
    this.shop.hide();
    this.market.hide();
    this.storagePanel.hide();
  }

  key(k: string): void {
    const map: Record<string, Panel> = { i: this.inv, s: this.stats, h: this.home, d: this.drops, f1: this.help, k: this.skillsPanel, o: this.settingsPanel };
    const p = map[k];
    if (p) this.toggle(p);
    const idx = ['1', '2', '3', '4'].indexOf(k);
    if (idx >= 0) this.useHotbar(idx);
    const sidx = ['5', '6', '7', '8'].indexOf(k);
    if (sidx >= 0) this.useSkillSlot(sidx);
  }

  log(msg: string, color = '#ddd'): void {
    const line = h('div', { class: 'log-line', style: `color:${color}` }, msg);
    this.logEl.appendChild(line);
    while (this.logEl.childElementCount > 80) this.logEl.firstElementChild!.remove();
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  /** 成就解鎖通知（右下角滑入的卡片） */
  achievement(name: string, desc: string): void {
    const el = h('div', { class: 'achievement frame' },
      h('div', { class: 'achievement-icon' }, '🏆'),
      h('div', {}, h('div', { class: 'achievement-title' }, `成就解鎖：${name}`), h('div', { class: 'muted small' }, desc)));
    this.root.appendChild(el);
    this.log(`🏆 成就解鎖：${name} — ${desc}`, '#ffd24a');
    setTimeout(() => el.remove(), 5000);
  }

  announce(msg: string, color: string): void {
    const el = h('div', { class: 'announce-line', style: `color:${color}` }, msg);
    this.announceEl.appendChild(el);
    this.log(msg, color);
    setTimeout(() => el.remove(), 4500);
  }

  floatText(x: number, y: number, text: string, color: string, big = false): void {
    const el = h('div', { class: `float-text${big ? ' big' : ''}`, style: `left:${x}px;top:${y}px;color:${color}` }, text);
    this.floatLayer.appendChild(el);
    setTimeout(() => el.remove(), 1100);
  }

  showTooltip(x: number, y: number, html: string | undefined): void {
    if (!html) {
      this.tooltip.style.display = 'none';
      return;
    }
    this.tooltip.innerHTML = html;
    this.tooltip.style.display = 'block';
    this.tooltip.style.left = `${Math.min(x + 16, window.innerWidth - 300)}px`;
    this.tooltip.style.top = `${Math.min(y + 16, window.innerHeight - this.tooltip.offsetHeight - 10)}px`;
  }

  // ------------------------------------------------------------ 每幀

  frame(): void {
    const w = this.world();
    const labels = w.labelsToDraw();
    while (this.labelPool.length < labels.length) {
      const el = h('div', { class: 'world-label' });
      this.labelLayer.appendChild(el);
      this.labelPool.push(el);
    }
    this.labelPool.forEach((el, i) => {
      const l = labels[i];
      if (!l) {
        el.style.display = 'none';
        return;
      }
      const s = w.toScreen(l.pos);
      if (!s.visible) {
        el.style.display = 'none';
        return;
      }
      el.style.display = 'block';
      el.style.transform = `translate(${s.x}px, ${s.y}px) translate(-50%, 0)`;
      el.className = `world-label ${l.kind}`;
      const hp = l.hp !== undefined ? `<div class="mini-hp"><div style="width:${Math.max(0, l.hp) * 100}%"></div></div>` : '';
      const html = `<span style="color:${l.color}">${escapeHtml(l.text)}</span>${hp}`;
      if (el.innerHTML !== html) el.innerHTML = html;
    });
    const now = performance.now();
    this.updateCooldowns();
    if (now >= this.nextMinimap) {
      this.nextMinimap = now + 150;
      this.drawMinimap();
    }
    if (this.dirty && !this.pointerDown) {
      this.dirty = false;
      this.render();
    }
  }

  private render(): void {
    if (!this.cs.player) return;
    this.onlineEl.textContent = this.cs.online ? `　線上 ${this.cs.onlinePlayers.length} 人` : '　單機模式';
    if (this.cs.trade) {
      if (!this.tradePanel.visible) this.tradePanel.show();
      this.renderTrade();
    } else if (this.tradePanel.visible) {
      this.tradePanel.el.style.display = 'none';
    }
    this.renderStatus();
    this.renderParty();
    this.renderHotbar();
    // 正在輸入的視窗不重繪，避免輸入內容與焦點被清掉
    const typing = document.activeElement instanceof HTMLInputElement ? document.activeElement.closest('.panel') : null;
    if (typing) this.dirty = true;
    const draw = (panel: Panel, fn: () => void) => {
      if (panel.visible && typing !== panel.el) fn();
    };
    draw(this.inv, () => this.renderInventory());
    draw(this.stats, () => this.renderStats());
    draw(this.home, () => this.renderHome());
    draw(this.station, () => this.renderStation());
    draw(this.shop, () => this.renderShop());
    draw(this.market, () => this.renderMarket());
    draw(this.help, () => this.renderHelp());
    draw(this.drops, () => this.renderDrops());
    draw(this.skillsPanel, () => this.renderSkills());
    draw(this.storagePanel, () => this.renderStorage());
    draw(this.settingsPanel, () => this.renderSettings());
  }

  // ------------------------------------------------------------ 多人：聊天、交易

  focusChat(): void {
    this.chatInput.focus();
  }

  chat(from: string, text: string, system = false, channel?: 'party'): void {
    const line = h('div', { class: `log-line chat${system ? ' system' : ''}${channel === 'party' ? ' party' : ''}` },
      channel === 'party' ? '[隊伍] ' : '',
      system ? '' : h('span', { class: 'chat-name' }, `${from}：`), text);
    this.logEl.appendChild(line);
    while (this.logEl.childElementCount > 80) this.logEl.firstElementChild!.remove();
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  tradeInvite(from: string): void {
    void ask(this.root, `<b>${escapeHtml(from)}</b> 想與你交易，要接受嗎？`, '接受').then((ok) => this.cs.send({ t: 'tradeRespond', from, accept: ok }));
  }

  partyInvite(from: string): void {
    void ask(this.root, `<b>${escapeHtml(from)}</b> 邀請你加入隊伍，要接受嗎？`, '加入').then((ok) => this.cs.send({ t: 'partyRespond', from, accept: ok }));
  }

  private renderParty(): void {
    const party = this.cs.party;
    if (!party) {
      this.partyEl.style.display = 'none';
      return;
    }
    this.partyEl.style.display = 'block';
    const leader = party.leader === this.cs.name;
    this.partyEl.replaceChildren(
      h('div', { class: 'party-title' }, `隊伍（${party.members.length}/6）`,
        h('button', {
          class: `party-share${party.share === 'even' ? ' even' : ''}`,
          title: leader ? '點擊切換經驗分配方式' : '只有隊長可以切換',
          disabled: !leader,
          onclick: () => this.cs.send({ t: 'partyShare', mode: party.share === 'even' ? 'each' : 'even' }),
        }, party.share === 'even' ? '經驗均分' : '各自取得')),
      ...party.members.map((m) => h('div', { class: `party-member${m.inRange ? '' : ' far'}` },
        h('div', { class: 'party-name' },
          m.name === party.leader ? h('span', { class: 'crown' }, '♛') : '',
          m.name, h('span', { class: 'muted' }, ` Lv${m.level} ${CLASSES[m.cls].name}`),
          leader && m.name !== this.cs.name ? h('button', { class: 'party-kick', title: '移出隊伍', onclick: () => this.cs.send({ t: 'partyKick', name: m.name }) }, '×') : ''),
        bar(m.hp / m.maxHp, 'hp small', ''),
        m.inRange ? '' : h('div', { class: 'muted small' }, `${m.zone}（不在分配範圍）`))),
      h('button', { class: 'btn btn-small party-leave', onclick: () => this.cs.send({ t: 'partyLeave' }) }, '離開隊伍'),
    );
  }

  playerMenu(name: string, x: number, y: number): void {
    this.root.querySelector('.player-menu')?.remove();
    const menu = h('div', { class: 'player-menu frame', style: `left:${x}px;top:${y}px` },
      h('div', { class: 'player-menu-name' }, name),
      h('button', { class: 'btn btn-small', onclick: () => { this.cs.send({ t: 'tradeRequest', target: name }); menu.remove(); } }, '交易'),
      this.cs.isPartyMember(name) ? '' : h('button', { class: 'btn btn-small', onclick: () => { this.cs.send({ t: 'partyInvite', target: name }); menu.remove(); } }, '組隊邀請'),
      h('button', { class: 'btn btn-small', onclick: () => { this.chatInput.value = `@${name} `; this.chatInput.focus(); menu.remove(); } }, '聊天'),
      h('button', { class: 'btn btn-small', onclick: () => menu.remove() }, '取消'),
    );
    this.root.appendChild(menu);
    setTimeout(() => window.addEventListener('mousedown', (e) => { if (!menu.contains(e.target as Node)) menu.remove(); }, { once: true }), 0);
  }

  private tradeSide(title: string, offer: import('../net/protocol').TradeOfferView, mine: boolean): HTMLElement {
    const cells = offer.items.map((it) => {
      const def = getDef(ITEM_DB, it.defId);
      return this.iconCell(def, it, mine && !offer.locked ? () => this.cs.send({ t: 'tradeItem', uid: it.uid, qty: 0 }) : undefined);
    });
    while (cells.length < 10) cells.push(h('div', { class: 'item-cell empty' }));
    const status = offer.confirmed ? '✔ 已確認' : offer.locked ? '🔒 已鎖定' : '編輯中';
    return h('div', { class: `trade-side${offer.locked ? ' locked' : ''}` },
      h('div', { class: 'trade-side-title' }, title, h('span', { class: `trade-status${offer.confirmed ? ' ok' : ''}` }, status)),
      h('div', { class: 'trade-grid' }, ...cells),
      h('div', { class: 'trade-gold' }, h('img', { src: pixelIcon('coin', 2) }), fmt(offer.gold), ' G'),
    );
  }

  private renderTrade(): void {
    const t = this.cs.trade!;
    const ch = this.player;
    this.tradePanel.setTitle(`與 ${t.partner} 交易`);
    const offered = new Set(t.mine.items.map((i) => i.uid));
    const tradeables = ch.inventory.items.filter((i) => isTradeable(getDef(ITEM_DB, i.defId), i) && !offered.has(i.uid));
    let picker: HTMLElement | undefined;
    if (!t.mine.locked) {
      const sel = this.tradeAddUid ? ch.inventory.get(this.tradeAddUid) : undefined;
      const qtyIn = h('input', { type: 'number', class: 'input', min: 1, max: sel?.qty ?? 1, value: sel?.qty ?? 1 });
      const goldIn = h('input', { type: 'number', class: 'input', min: 0, value: this.tradeGoldDraft || String(t.mine.gold) });
      goldIn.addEventListener('input', () => (this.tradeGoldDraft = goldIn.value));
      picker = h('div', { class: 'trade-picker' },
        h('div', { class: 'muted' }, '點選背包物品放入交易欄（再點交易欄中的物品可取回）'),
        h('div', { class: 'item-grid' }, ...tradeables.map((it) => this.iconCell(getDef(ITEM_DB, it.defId), it, () => (this.tradeAddUid = it.uid), it.uid === this.tradeAddUid))),
        sel ? h('div', { class: 'trade-row' }, h('span', { style: `color:${RARITY_INFO[getDef(ITEM_DB, sel.defId).rarity].color}` }, itemDisplayName(getDef(ITEM_DB, sel.defId), sel)),
          sel.qty > 1 ? h('label', {}, ' 數量 ', qtyIn) : undefined,
          h('button', { class: 'btn btn-small', onclick: () => { this.cs.send({ t: 'tradeItem', uid: sel.uid, qty: Math.floor(Number(qtyIn.value) || 1) }); this.tradeAddUid = undefined; } }, '放入')) : undefined,
        h('div', { class: 'trade-row' }, h('label', {}, '金幣 ', goldIn),
          h('button', { class: 'btn btn-small', onclick: () => { this.cs.send({ t: 'tradeGold', gold: Math.floor(Number(goldIn.value) || 0) }); this.tradeGoldDraft = ''; } }, '設定')),
      );
    }
    const bothLocked = t.mine.locked && t.theirs.locked;
    this.tradePanel.set(
      h('div', { class: 'trade-cols' }, this.tradeSide('你的交易品', t.mine, true), this.tradeSide(`${t.partner} 的交易品`, t.theirs, false)),
      picker,
      h('div', { class: 'trade-actions' },
        h('div', { class: 'muted small' }, '雙方都鎖定後才能確認；任何一方修改內容，鎖定會全部重置（防詐騙）。'),
        t.mine.locked
          ? h('button', { class: 'btn', disabled: t.mine.confirmed, onclick: () => this.cs.send({ t: 'tradeUnlock' }) }, '解除鎖定')
          : h('button', { class: 'btn', onclick: () => this.cs.send({ t: 'tradeLock' }) }, '鎖定'),
        h('button', { class: 'btn btn-primary', disabled: !bothLocked || t.mine.confirmed, onclick: () => this.cs.send({ t: 'tradeConfirm' }) }, t.mine.confirmed ? '等待對方確認…' : '確認交易'),
        h('button', { class: 'btn btn-danger', onclick: () => this.cs.send({ t: 'tradeCancel' }) }, '取消'),
      ),
    );
  }

  // ------------------------------------------------------------ 狀態列

  private renderStatus(): void {
    const ch = this.player;
    const p = ch.progression;
    const d = ch.derived();
    const wt = ch.inventory.totalWeight();
    const bNeed = baseExpToNext(p.baseLevel);
    const jNeed = jobExpToNext(p.jobLevel);
    const hint = p.statPoints > 0 || ch.canChangeJob()
      ? h('div', { class: 'status-hint', onclick: () => this.toggle(this.stats) }, ch.canChangeJob() ? '★ 可以轉職！' : `★ 剩餘素質點 ${p.statPoints}`)
      : '';
    this.status.replaceChildren(
      h('div', { class: 'status-head' },
        h('div', { class: 'portrait' }, h('img', { src: facePortrait(ch.data.classId, 64) })),
        h('div', { class: 'status-id' },
          h('div', { class: 'status-name' }, ch.name),
          h('div', { class: 'status-class' }, ch.classDef.name),
          h('div', { class: 'status-levels' }, h('span', { class: 'lv-badge' }, `Lv ${p.baseLevel}`), h('span', { class: 'lv-badge job' }, `Job ${p.jobLevel}`)),
        ),
      ),
      bar(ch.data.hp / d.maxHp, 'hp', `HP ${fmt(ch.data.hp)} / ${fmt(d.maxHp)}`),
      bar(ch.data.sp / d.maxSp, 'sp', `SP ${fmt(ch.data.sp)} / ${fmt(d.maxSp)}`),
      this.expBar(p.baseExp, bNeed, ch.data.restedExp ?? 0),
      bar(Number.isFinite(jNeed) ? p.jobExp / jNeed : 1, 'jexp thin', `Job EXP ${Number.isFinite(jNeed) ? ((p.jobExp / jNeed) * 100).toFixed(1) : 'MAX'}%`),
      h('div', { class: 'status-row' },
        h('span', { class: 'stat-chip gold' }, h('img', { src: pixelIcon('coin', 2) }), `${fmt(ch.data.gold)}`),
        h('span', { class: `stat-chip${wt > d.maxWeight ? ' warn' : ''}` }, h('img', { src: pixelIcon('weight', 2) }), `${fmt(wt)} / ${fmt(d.maxWeight)}`)),
      this.buffRow(),
      hint,
    );
  }

  private buffRow(): HTMLElement | string {
    const now = Date.now();
    const buffs = (this.player.data.buffs ?? []).filter((b) => b.until > now);
    if (!buffs.length) return '';
    return h('div', { class: 'buff-row' }, ...buffs.map((b) => {
      const def = SKILL_DB.get(b.id);
      return h('div', { class: 'buff', title: def ? `${def.name} Lv${b.level}` : b.id },
        def ? h('img', { src: skillIcon(def) }) : '', h('span', {}, String(Math.ceil((b.until - now) / 1000))));
    }));
  }

  /** Base EXP 條：淺藍色區段表示休息經驗（打怪時加倍） */
  private expBar(exp: number, need: number, rested: number): HTMLElement {
    if (!Number.isFinite(need)) return bar(1, 'exp thin', 'Base EXP MAX');
    const pct = exp / need;
    const restPct = Math.min(rested / need, 1 - pct);
    const el = bar(pct, 'exp thin', `Base EXP ${(pct * 100).toFixed(1)}%${rested > 0 ? `　休息 +${Math.round((rested / need) * 100)}%` : ''}`);
    if (restPct > 0) el.insertBefore(h('div', { class: 'bar-rested', style: `left:${pct * 100}%;width:${restPct * 100}%` }), el.lastChild);
    el.title = rested > 0 ? `休息經驗 ${fmt(rested)}：打怪獲得的 Base 經驗加倍，直到用完。離線時會慢慢累積。` : '離線休息時會累積休息經驗。';
    return el;
  }

  private drawMinimap(): void {
    const w = this.world();
    const base = w.minimapBase();
    const key = `${base.zone}:${this.cs.zoneOwner}:${base.size}:${base.colors.length}:${this.cs.homestead.data.nodes.length}`;
    if (this.minimapBase?.key !== key) {
      const c = document.createElement('canvas');
      c.width = c.height = base.size;
      const g = c.getContext('2d')!;
      base.colors.forEach((col, i) => {
        g.fillStyle = col;
        g.fillRect(i % base.size, Math.floor(i / base.size), 1, 1);
      });
      this.minimapBase = { key, canvas: c, size: base.size };
      this.minimapZone.textContent = base.zone === 'homestead' ? `${this.cs.zoneOwner} 的家園` : ZONE_NAMES[base.zone];
    }
    const g = this.minimap.getContext('2d')!;
    const W = this.minimap.width;
    const scale = W / 44; // 顯示玩家周圍約 44 格
    const markers = w.minimapMarkers();
    const me = markers[markers.length - 1];
    const half = this.minimapBase.size / 2;
    g.save();
    g.fillStyle = '#0b0d18';
    g.fillRect(0, 0, W, W);
    g.translate(W / 2, W / 2);
    // 讓相機的前方朝上
    g.rotate(w.cameraYaw);
    g.scale(scale, scale);
    g.translate(-me.x, -me.z);
    g.imageSmoothingEnabled = false;
    g.drawImage(this.minimapBase.canvas, -half, -half);
    const dot = (x: number, z: number, r: number, fill: string, stroke = '#000') => {
      g.beginPath();
      g.arc(x, z, r / scale, 0, Math.PI * 2);
      g.fillStyle = fill;
      g.fill();
      g.lineWidth = 1 / scale;
      g.strokeStyle = stroke;
      g.stroke();
    };
    for (const m of markers) {
      if (m.kind === 'monster') dot(m.x, m.z, 2.5, '#ff5a5a');
      else if (m.kind === 'mvp') dot(m.x, m.z, 5, '#ff9f1a', '#fff');
      else if (m.kind === 'other') dot(m.x, m.z, 3.5, '#ffffff', '#3a6fd8');
      else if (m.kind === 'npc') dot(m.x, m.z, 3.5, '#6ad0ff');
      else if (m.kind === 'portal') dot(m.x, m.z, 4.5, '#b070ff', '#fff');
      else if (m.kind === 'station') dot(m.x, m.z, 3, '#ffd24a');
      else if (m.kind === 'node') dot(m.x, m.z, 2.5, '#9fffb0');
    }
    // 玩家箭頭
    g.translate(me.x, me.z);
    g.rotate(-w.playerYaw);
    g.scale(1 / scale, 1 / scale);
    g.beginPath();
    g.moveTo(0, 7);
    g.lineTo(5, -5);
    g.lineTo(0, -2);
    g.lineTo(-5, -5);
    g.closePath();
    g.fillStyle = '#ffffff';
    g.fill();
    g.strokeStyle = '#000';
    g.lineWidth = 1.5;
    g.stroke();
    g.restore();
  }

  private renderHotbar(): void {
    const ch = this.player;
    this.hotbar.replaceChildren(
      ...this.cs.itemBar.map((id, i) => {
        const def = id ? ITEM_DB.get(id) : undefined;
        const n = def ? ch.inventory.count(def.id) : 0;
        return h('div', {
          class: `hot-slot${n ? '' : ' empty'}`,
          title: def ? `${def.name}（右鍵清除）` : '在背包選擇消耗品後按「快捷 1~4」指定',
          onclick: () => this.useHotbar(i),
          oncontextmenu: (e: Event) => { e.preventDefault(); this.cs.setItemSlot(i, null); this.markDirty(); },
        },
          def ? h('img', { src: itemIcon(def) }) : '', h('span', { class: 'hot-key' }, String(i + 1)), def ? h('span', { class: 'hot-qty' }, String(n)) : '');
      }),
      h('div', { class: 'hot-sep' }),
      ...this.cs.skillBar.map((sid, i) => {
        const def = sid ? SKILL_DB.get(sid) : undefined;
        const lv = def ? ch.skillLevel(def.id) : 0;
        const sp = def && lv ? def.sp?.(lv) ?? 0 : 0;
        return h('div', {
          class: `hot-slot skill${def && lv ? '' : ' empty'}${sp > ch.data.sp ? ' nosp' : ''}`,
          title: def ? `${def.name} Lv${lv}（SP ${sp}）` : '在技能視窗（K）指定快捷技能',
          'data-skill': sid ?? '',
          onclick: () => this.useSkillSlot(i),
        },
          def ? h('img', { src: skillIcon(def) }) : '',
          h('div', { class: 'cd-overlay' }),
          h('span', { class: 'hot-key' }, String(i + 5)),
          def && lv ? h('span', { class: 'hot-qty' }, String(sp)) : '');
      }),
    );
  }

  /** 每幀更新冷卻遮罩（不重建 DOM） */
  private updateCooldowns(): void {
    const now = performance.now();
    this.hotbar.querySelectorAll<HTMLElement>('.hot-slot.skill').forEach((el) => {
      const cd = this.cs.cooldowns.get(el.dataset.skill ?? '');
      const overlay = el.querySelector<HTMLElement>('.cd-overlay');
      if (!overlay) return;
      const left = cd ? cd.until - now : 0;
      if (left > 0) {
        overlay.style.display = 'block';
        overlay.style.background = `conic-gradient(rgba(0,0,0,0.65) ${(left / cd!.total) * 360}deg, transparent 0)`;
        overlay.textContent = left > 1000 ? String(Math.ceil(left / 1000)) : '';
      } else overlay.style.display = 'none';
    });
  }

  private useSkillSlot(i: number): void {
    const sid = this.cs.skillBar[i];
    if (sid) this.castSkill(sid);
  }

  castSkill(id: string): void {
    const def = SKILL_DB.get(id);
    if (!def || this.player.skillLevel(id) <= 0) return;
    const cd = this.cs.cooldowns.get(id);
    if (cd && cd.until > performance.now()) return;
    const target = def.target === 'enemy' ? this.world().currentTarget() : undefined;
    if (def.target === 'enemy' && target === undefined) {
      this.log('請先點選或靠近目標。', '#f99');
      return;
    }
    this.cs.send({ t: 'skill', skill: id, target });
  }

  // ------------------------------------------------------------ 技能視窗

  private renderSkills(): void {
    const ch = this.player;
    const lineage = new Set(ch.availableSkills().map((s) => s.classId));
    const preview = ch.classDef.tier === 1 ? SECOND_JOB_OF[ch.data.classId] : undefined;
    const classes = [...lineage, ...(preview ? [preview] : [])];
    const points = ch.progression.skillPoints;
    const sections = classes.map((cls) => {
      const locked = cls === preview;
      const list = [...SKILL_DB.values()].filter((s) => s.classId === cls);
      return h('div', { class: 'skill-section' },
        h('h4', {}, CLASSES[cls].name, locked ? h('span', { class: 'muted small' }, `　二轉（Job Lv ${40}）後可學，先看看要怎麼點`) : ''),
        ...list.map((s) => this.skillRow(s, locked)));
    });
    this.skillsPanel.setTitle(`技能　剩餘點數 ${points}`);
    this.skillsPanel.set(
      h('div', { class: 'skill-help muted small' }, '每升 1 級 Job 得 1 點。Shift + 點「升級」可一次點滿。主動技能按右邊的 5~8 指定快捷鍵。'),
      ...sections,
    );
  }

  private skillRow(s: SkillDef, locked: boolean): HTMLElement {
    const ch = this.player;
    const lv = ch.skillLevel(s.id);
    const can = ch.canLearn(s.id);
    const now = skillEffectLines(s, lv);
    const next = lv < s.maxLevel ? skillEffectLines(s, lv + 1) : [];
    const kindTag = s.kind === 'passive' ? '被動' : s.buff ? '增益' : s.heal ? '治療' : s.damage?.aoe ? '範圍' : '主動';
    const reqOk = (s.requires ?? []).every((r) => ch.skillLevel(r.skill) >= r.level);
    const slotBtns = s.kind === 'active' && lv > 0 && !locked
      ? h('div', { class: 'slot-btns', title: '指定到快捷鍵（再按一次取消）' }, ...[0, 1, 2, 3].map((i) => {
          const on = this.cs.skillBar[i] === s.id;
          return h('button', { class: `slot-btn${on ? ' on' : ''}`, onclick: () => { this.cs.setSkillSlot(i, on ? null : s.id); this.markDirty(); } }, String(i + 5));
        }))
      : '';
    const learn = locked ? h('span', { class: 'muted small' }, '尚未開放') : h('button', {
      class: 'btn btn-small btn-primary', disabled: !can.ok, title: can.ok ? 'Shift + 點擊：連續升到最高等級' : can.reason ?? '',
      onclick: (e: Event) => {
        const times = (e as MouseEvent).shiftKey ? Math.min(s.maxLevel - lv, ch.progression.skillPoints) : 1;
        for (let i = 0; i < times; i++) this.cs.send({ t: 'learnSkill', skill: s.id });
      },
    }, lv ? '升級' : '學習');
    return h('div', { class: `skill-row${lv ? '' : ' unlearned'}${locked ? ' locked' : ''}` },
      h('img', { class: 'skill-icon', src: skillIcon(s) }),
      h('div', { class: 'skill-info' },
        h('div', { class: 'skill-head' },
          h('span', { class: 'skill-name' }, s.name),
          h('span', { class: `skill-tag ${s.kind}` }, kindTag),
          h('span', { class: 'skill-lv' }, `Lv ${lv} / ${s.maxLevel}`),
          h('span', { class: 'skill-pips' }, ...Array.from({ length: s.maxLevel }, (_, i) => h('i', { class: i < lv ? 'on' : '' })))),
        h('div', { class: 'muted small' }, s.desc),
        h('div', { class: 'skill-effects' },
          h('div', { class: 'eff now' }, h('b', {}, lv ? `目前 Lv ${lv}` : '未學習'), ...now.map((l) => h('div', {}, l))),
          h('div', { class: 'eff next' }, h('b', {}, lv < s.maxLevel ? `下一級 Lv ${lv + 1}` : '已達最高等級'), ...next.map((l) => h('div', {}, l)))),
        s.requires?.length ? h('div', { class: `small ${reqOk ? 'req-ok' : 'req-lack'}` },
          `前置：${s.requires.map((r) => `${SKILL_DB.get(r.skill)?.name} Lv${r.level}（目前 ${ch.skillLevel(r.skill)}）`).join('、')}`) : ''),
      h('div', { class: 'skill-actions' }, learn, slotBtns));
  }

  private useHotbar(i: number): void {
    const id = this.cs.itemBar[i];
    const it = id ? this.player.inventory.items.find((x) => x.defId === id) : undefined;
    if (it) this.useItem(it);
  }

  // ------------------------------------------------------------ 物品

  itemTooltip(def: ItemDef, it?: ItemInstance): string {
    const r = RARITY_INFO[def.rarity];
    const lines: string[] = [`<div class="tt-name" style="color:${r.color}">${escapeHtml(it ? itemDisplayName(def, it) : def.name)}</div>`, `<div class="tt-sub">${r.name} · ${typeName(def)}</div>`];
    if (def.atk) lines.push(`攻擊力 ${def.atk}`);
    if (def.matk) lines.push(`魔法攻擊 ${def.matk}`);
    if (def.def) lines.push(`防禦力 ${def.def}`);
    if (def.bonus) lines.push(Object.entries(def.bonus).map(([k, v]) => `${k.toUpperCase()} +${v}`).join('、'));
    if (def.dropBonusPct) lines.push(`掉寶率 +${def.dropBonusPct}%`);
    if (def.heal) lines.push(`恢復 ${def.heal.hp ? `HP ${def.heal.hp}` : ''}${def.heal.sp ? `SP ${def.heal.sp}` : ''}`);
    if (def.toolTier) lines.push(`工具階級 ${def.toolTier}`);
    if (def.levelReq) lines.push(`需要等級 ${def.levelReq}`);
    if (it?.cards.length) lines.push(`鑲嵌：${it.cards.map((c) => getDef(ITEM_DB, c).name).join('、')}`);
    if (it?.crafter) lines.push(`<span style="color:#ffd27f">製作者：${escapeHtml(it.crafter)}</span>`);
    const worn = def.slot && this.cs.player ? this.cs.player.data.equipment[def.slot] : undefined;
    if (def.slot && worn?.uid !== it?.uid) {
      const diff = compareEquip(def, it, worn);
      const wdef = worn ? getDef(ITEM_DB, worn.defId) : undefined;
      lines.push(`<div class="tt-compare">與身上的${wdef ? `「${escapeHtml(itemDisplayName(wdef, worn!))}」` : '（空）'}比較：${diff.length
        ? diff.map((d) => `<span class="${d.delta > 0 ? 'up' : 'down'}">${d.label} ${d.delta > 0 ? '▲' : '▼'}${Math.abs(d.delta)}</span>`).join('　')
        : '<span class="muted">數值相同</span>'}</div>`);
    }
    lines.push(`<div class="tt-desc">${escapeHtml(def.desc)}</div>`);
    const bindTxt = it?.bound || def.bind === 'bound' ? '<span style="color:#f88">已綁定（無法交易）</span>' : def.bind === 'bindOnEquip' ? '<span style="color:#fc8">裝備後綁定</span>' : '<span style="color:#8f8">可交易</span>';
    lines.push(`${bindTxt} · 重量 ${def.weight} · NPC 收購 ${fmt(def.sellPrice)}G`);
    return lines.map((l) => (l.startsWith('<div') ? l : `<div>${l}</div>`)).join('');
  }

  private iconCell(def: ItemDef, it: ItemInstance | undefined, onclick?: () => void, selected = false, primary?: () => void): HTMLDivElement {
    const cell = h('div', { class: `item-cell r${def.rarity}${selected ? ' selected' : ''}`, onclick },
      h('img', { src: itemIcon(def), draggable: 'false' }),
      it && it.qty > 1 ? h('span', { class: 'qty' }, String(it.qty)) : undefined,
      it && it.enchant > 0 ? h('span', { class: 'plus' }, `+${it.enchant}`) : undefined,
      it && it.cards.length ? h('span', { class: 'card-dot', title: '已鑲嵌卡片' }) : undefined,
      it && (it.bound || def.bind === 'bound') ? h('span', { class: 'bound-dot', title: '已綁定' }) : undefined,
    );
    cell.addEventListener('mousemove', (e) => this.showTooltip(e.clientX, e.clientY, this.itemTooltip(def, it)));
    cell.addEventListener('mouseleave', () => this.showTooltip(0, 0, undefined));
    if (primary) {
      cell.addEventListener('dblclick', () => { primary(); this.showTooltip(0, 0, undefined); this.markDirty(); });
      cell.addEventListener('contextmenu', (e) => { e.preventDefault(); primary(); this.showTooltip(0, 0, undefined); this.markDirty(); });
    }
    return cell;
  }

  private sortedItems(items: ItemInstance[]): ItemInstance[] {
    const mode = this.cs.invSort;
    if (mode === 'none') return items;
    const key = (it: ItemInstance) => getDef(ITEM_DB, it.defId);
    return [...items].sort((a, b) => {
      const da = key(a);
      const db = key(b);
      if (mode === 'type') return (TYPE_ORDER[da.type] ?? 9) - (TYPE_ORDER[db.type] ?? 9) || db.rarity - da.rarity || da.name.localeCompare(db.name, 'zh-Hant');
      if (mode === 'rarity') return db.rarity - da.rarity || (TYPE_ORDER[da.type] ?? 9) - (TYPE_ORDER[db.type] ?? 9) || da.name.localeCompare(db.name, 'zh-Hant');
      return da.name.localeCompare(db.name, 'zh-Hant') || b.enchant - a.enchant;
    });
  }

  private matchesSearch(def: ItemDef): boolean {
    const q = this.invSearch.trim().toLowerCase();
    return !q || def.name.toLowerCase().includes(q) || def.desc.toLowerCase().includes(q);
  }

  /** 雙擊 / 右鍵：倉庫開著 → 存入；消耗品 → 使用；裝備 → 穿上；卷軸 / 卡片 → 進入選擇目標 */
  private primaryAction(it: ItemInstance): void {
    const def = getDef(ITEM_DB, it.defId);
    if (this.storagePanel.visible) return this.cs.send({ t: 'storageDeposit', uid: it.uid, qty: it.qty });
    if (def.type === 'consumable') return this.useItem(it);
    if (def.slot) return this.equip(it);
    if (def.scroll && def.scroll !== 'protection') {
      this.pending = { kind: 'enchant', uid: it.uid };
      return;
    }
    if (def.type === 'card') this.pending = { kind: 'card', uid: it.uid };
  }

  private weightBar(): HTMLElement {
    const ch = this.player;
    const w = ch.inventory.totalWeight();
    const cap = ch.derived().maxWeight;
    const r = w / cap;
    const tier = ch.weightTier();
    const note = tier === 'overloaded' ? '無法戰鬥' : tier === 'heavy' ? '不會自然回復' : '';
    return h('div', { class: `weight-bar ${tier}`, title: `負重 50% 以上停止自然回復；90% 以上無法戰鬥與採集` },
      h('div', { class: 'wb-fill', style: `width:${Math.min(100, r * 100)}%` }),
      h('i', { class: 'wb-mark', style: `left:${WEIGHT_NO_REGEN * 100}%` }),
      h('i', { class: 'wb-mark', style: `left:${WEIGHT_NO_ACTION * 100}%` }),
      h('span', { class: 'wb-text' }, `負重 ${fmt(w)} / ${fmt(cap)}　${Math.floor(r * 100)}%${note ? `　${note}` : ''}`));
  }

  private matchesFilter(def: ItemDef): boolean {
    switch (this.invFilter) {
      case 'all': return true;
      case 'equip': return ['weapon', 'armor', 'accessory', 'tool'].includes(def.type);
      case 'use': return def.type === 'consumable' || def.type === 'scroll';
      case 'mat': return def.type === 'material';
      case 'etc': return def.type === 'card';
    }
  }

  private renderInventory(): void {
    const ch = this.player;
    const inv = ch.inventory;
    const tabs = h('div', { class: 'tabs' },
      ...(['all', 'equip', 'use', 'mat', 'etc'] as InvFilter[]).map((f) =>
        h('button', { class: `tab${this.invFilter === f ? ' active' : ''}`, onclick: () => (this.invFilter = f) },
          { all: '全部', equip: '裝備', use: '消耗', mat: '材料', etc: '卡片' }[f])),
    );
    const search = h('input', { class: 'input inv-search', placeholder: '搜尋物品…', value: this.invSearch });
    search.addEventListener('input', () => (this.invSearch = search.value));
    search.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' || e.key === 'Escape') {
        search.blur();
        this.markDirty();
      }
    });
    search.addEventListener('blur', () => this.markDirty());
    const sort = h('button', { class: 'btn btn-small', title: '切換排序方式（只影響顯示）', onclick: () => {
      const order = ['none', 'type', 'rarity', 'name'] as const;
      this.cs.setInvSort(order[(order.indexOf(this.cs.invSort) + 1) % order.length]);
    } }, `排序：${SORT_LABEL[this.cs.invSort]}`);
    const grid = h('div', { class: 'item-grid' });
    let shown = 0;
    for (const it of this.sortedItems(inv.items)) {
      const def = getDef(ITEM_DB, it.defId);
      if (!this.matchesFilter(def) || !this.matchesSearch(def)) continue;
      shown++;
      grid.appendChild(this.iconCell(def, it, () => this.onInventoryClick(it), it.uid === this.selectedUid, () => this.primaryAction(it)));
    }
    // 「全部」分頁顯示空格，一眼看出還剩多少位置
    if (this.invFilter === 'all' && !this.invSearch.trim()) for (let i = inv.usedSlots; i < inv.capacity; i++) grid.appendChild(h('div', { class: 'item-cell empty' }));
    else if (!shown) grid.appendChild(h('div', { class: 'muted small grid-empty' }, '沒有符合的物品'));
    const sel = this.selectedUid ? inv.get(this.selectedUid) : undefined;
    let detail: HTMLElement | undefined;
    if (this.pending) {
      detail = h('div', { class: 'pending' }, this.pending.kind === 'enchant' ? '請點選要強化的裝備（未裝備中的）' : '請點選要鑲嵌的裝備（需先卸下）',
        h('button', { class: 'btn', onclick: () => (this.pending = undefined) }, '取消'));
    } else if (sel) {
      const def = getDef(ITEM_DB, sel.defId);
      const actions: (HTMLElement | string)[] = [];
      if (this.storagePanel.visible) {
        actions.push(h('button', { class: 'btn btn-primary', onclick: () => this.cs.send({ t: 'storageDeposit', uid: sel.uid, qty: sel.qty }) }, sel.qty > 1 ? `全部存入倉庫（${sel.qty}）` : '存入倉庫'));
        if (sel.qty > 1) actions.push(h('button', { class: 'btn', onclick: () => this.cs.send({ t: 'storageDeposit', uid: sel.uid, qty: 1 }) }, '存入 1 個'));
      }
      if (def.type === 'consumable') actions.push(h('button', { class: 'btn btn-primary', onclick: () => this.useItem(sel) }, '使用'));
      if (def.slot) actions.push(h('button', { class: 'btn btn-primary', onclick: () => this.equip(sel) }, '裝備'));
      if (def.scroll && def.scroll !== 'protection') actions.push(h('button', { class: 'btn btn-primary', onclick: () => (this.pending = { kind: 'enchant', uid: sel.uid }) }, '強化裝備'));
      if (def.type === 'card') actions.push(h('button', { class: 'btn btn-primary', onclick: () => (this.pending = { kind: 'card', uid: sel.uid }) }, '鑲嵌卡片'));
      if (def.type === 'consumable') {
        actions.push(h('span', { class: 'slot-btns', title: '放到快捷鍵 1~4（再按一次取消）' }, h('span', { class: 'muted small' }, '快捷'), ...[0, 1, 2, 3].map((i) => {
          const on = this.cs.itemBar[i] === def.id;
          return h('button', { class: `slot-btn${on ? ' on' : ''}`, onclick: () => { this.cs.setItemSlot(i, on ? null : def.id); } }, String(i + 1));
        })));
      }
      if (sel.qty > 1) actions.push(h('button', { class: 'btn btn-danger', onclick: () => void this.discard(sel, 1) }, '丟棄 1 個'));
      actions.push(h('button', { class: 'btn btn-danger', onclick: () => void this.discard(sel, sel.qty) }, sel.qty > 1 ? '全部丟棄' : '丟棄'));
      detail = h('div', { class: 'item-detail' }, h('div', { html: this.itemTooltip(def, sel) }), h('div', { class: 'actions' }, ...actions));
    }
    this.inv.setTitle(`背包 ${inv.usedSlots} / ${inv.capacity}`);
    this.inv.set(
      h('div', { class: 'inv-head' }, h('span', { class: 'gold-chip' }, h('img', { src: pixelIcon('coin', 2) }), fmt(ch.data.gold)), search, sort),
      this.weightBar(),
      tabs, grid, detail,
      h('div', { class: 'muted small' }, '點一下看詳情 · 雙擊或右鍵：使用 / 裝備（倉庫開著時為存入）· Z 撿取'),
    );
  }

  private renderSettings(): void {
    const st = settings.get();
    const slider = (label: string, key: 'master' | 'music' | 'sfx') => {
      const input = h('input', { type: 'range', min: 0, max: 100, value: Math.round(st[key] * 100), class: 'range' });
      const val = h('span', { class: 'range-val' }, `${Math.round(st[key] * 100)}%`);
      input.addEventListener('input', () => {
        val.textContent = `${input.value}%`;
        settings.set({ [key]: Number(input.value) / 100 });
      });
      input.addEventListener('change', () => {
        input.blur();
        audio.play(key === 'music' ? 'ui' : 'coin');
      });
      return h('div', { class: 'setting-row' }, h('span', {}, label), input, val);
    };
    const toggle = (label: string, key: 'muted' | 'shadows' | 'weather', desc: string) =>
      h('div', { class: 'setting-row' }, h('span', { title: desc }, label),
        h('button', { class: `btn btn-small toggle${st[key] ? ' on' : ''}`, onclick: () => settings.set({ [key]: !st[key] }) }, st[key] ? '開' : '關'),
        h('span', { class: 'muted small' }, desc));
    const scales = [0.5, 0.75, 1, 1.5];
    this.settingsPanel.set(
      h('h4', {}, '聲音'),
      slider('主音量', 'master'), slider('音樂', 'music'), slider('音效', 'sfx'),
      toggle('靜音', 'muted', '暫時關閉所有聲音'),
      h('h4', {}, '畫面'),
      toggle('即時陰影', 'shadows', '關閉可大幅提升低階電腦的流暢度'),
      toggle('天氣粒子', 'weather', '霜語山脈的雪、餘燼深淵的火星'),
      h('div', { class: 'setting-row' }, h('span', {}, '繪圖解析度'),
        h('div', { class: 'seg' }, ...scales.map((v) => h('button', { class: `btn btn-small${st.renderScale === v ? ' on' : ''}`, onclick: () => settings.set({ renderScale: v }) }, `${v * 100}%`)))),
      h('div', { class: 'setting-row' }, h('span', {}, '全螢幕'),
        h('button', { class: 'btn btn-small', onclick: () => void (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()) }, '切換（F11）')),
      h('div', { class: 'muted small', style: 'margin-top:8px' }, '設定會記在這台電腦上。音樂與音效都是即時合成的暫代版本，之後會換成正式配樂。'),
    );
  }

  private renderStorage(): void {
    const ch = this.player;
    const st = ch.storage;
    const grid = h('div', { class: 'item-grid storage-grid' });
    for (const it of this.sortedItems(st.items)) {
      const def = getDef(ITEM_DB, it.defId);
      if (!this.matchesSearch(def)) continue;
      grid.appendChild(this.iconCell(def, it, () => (this.storageSel = it.uid), it.uid === this.storageSel,
        () => this.cs.send({ t: 'storageWithdraw', uid: it.uid, qty: it.qty })));
    }
    if (!st.items.length) grid.appendChild(h('div', { class: 'muted small grid-empty' }, '倉庫是空的。在背包裡雙擊或右鍵物品即可存入。'));
    const sel = this.storageSel ? st.get(this.storageSel) : undefined;
    const detail = sel
      ? h('div', { class: 'item-detail' }, h('div', { html: this.itemTooltip(getDef(ITEM_DB, sel.defId), sel) }),
          h('div', { class: 'actions' },
            h('button', { class: 'btn btn-primary', onclick: () => this.cs.send({ t: 'storageWithdraw', uid: sel.uid, qty: sel.qty }) }, sel.qty > 1 ? `全部取出（${sel.qty}）` : '取出'),
            sel.qty > 1 ? h('button', { class: 'btn', onclick: () => this.cs.send({ t: 'storageWithdraw', uid: sel.uid, qty: 1 }) }, '取出 1 個') : ''))
      : undefined;
    const mats = ch.inventory.items.filter((it) => getDef(ITEM_DB, it.defId).type === 'material');
    this.storagePanel.setTitle(`倉庫 ${st.usedSlots} / ${st.capacity}`);
    this.storagePanel.set(
      h('div', { class: 'inv-head' },
        h('button', { class: 'btn btn-small', disabled: !mats.length, title: '把背包裡的所有材料存進倉庫', onclick: () => {
          for (const it of mats.slice(0, 30)) this.cs.send({ t: 'storageDeposit', uid: it.uid, qty: it.qty });
        } }, `材料全部存入（${mats.length}）`),
        h('span', { class: 'muted small' }, '不計負重 · 背包的搜尋也會套用在這裡')),
      grid, detail,
      h('div', { class: 'muted small' }, '雙擊或右鍵：取出整疊'),
    );
  }

  private onInventoryClick(it: ItemInstance): void {
    if (this.pending) {
      const p = this.pending;
      this.pending = undefined;
      if (p.kind === 'enchant') void this.enchant(p.uid, it.uid);
      else this.compound(p.uid, it.uid);
      return;
    }
    this.selectedUid = it.uid;
  }

  private useItem(it: ItemInstance): void {
    this.cs.send({ t: 'useItem', uid: it.uid });
  }

  private equip(it: ItemInstance): void {
    const def = getDef(ITEM_DB, it.defId);
    if (def.bind === 'bindOnEquip' && !it.bound) {
      void ask(this.root, `<b style="color:${RARITY_INFO[def.rarity].color}">${def.name}</b> 裝備後將會<b>綁定角色</b>，之後無法交易或上架。<br>確定要裝備嗎？`, '裝備').then((ok) => {
        if (ok) this.doEquip(it);
      });
      return;
    }
    this.doEquip(it);
  }

  private doEquip(it: ItemInstance): void {
    this.cs.send({ t: 'equip', uid: it.uid });
    this.selectedUid = undefined;
  }

  private async discard(it: ItemInstance, qty: number): Promise<void> {
    const def = getDef(ITEM_DB, it.defId);
    if (!(await ask(this.root, `確定要丟棄 <b>${def.name}</b> x${qty} 嗎？（無法復原）`, '丟棄'))) return;
    this.cs.send({ t: 'discard', uid: it.uid, qty });
    if (qty >= it.qty) this.selectedUid = undefined;
    this.markDirty();
  }

  private async enchant(scrollUid: string, targetUid: string): Promise<void> {
    const ch = this.player;
    const scroll = ch.inventory.get(scrollUid);
    const target = ch.inventory.get(targetUid);
    if (!scroll || !target) return;
    const sdef = getDef(ITEM_DB, scroll.defId);
    const tdef = getDef(ITEM_DB, target.defId);
    const kind: EnchantKind | undefined = tdef.type === 'weapon' ? 'weapon' : tdef.type === 'armor' ? 'armor' : undefined;
    const scrollKind: EnchantKind = sdef.scroll === 'weaponEnchant' || sdef.scroll === 'blessedWeaponEnchant' ? 'weapon' : 'armor';
    if (!kind) return this.log('這個物品不能強化。', '#f99');
    if (kind !== scrollKind) return this.log(`${sdef.name} 只能用在${scrollKind === 'weapon' ? '武器' : '防具'}上。`, '#f99');
    const rate = enchantSuccessRate(kind, target.enchant);
    if (rate === 0) return this.log('已達強化上限。', '#f99');
    const hasProtect = ch.inventory.count('scroll_protect') > 0;
    const safe = ENCHANT_RULES[kind].safe;
    const risk = target.enchant >= safe
      ? hasProtect ? '<span style="color:#8cf">失敗時會消耗保護卷軸，強化值 -1</span>' : '<b style="color:#f66">失敗時裝備會蒸發消失！</b>'
      : '<span style="color:#8f8">安定值內，必定成功</span>';
    const ok = await ask(this.root,
      `使用 <b>${sdef.name}</b> 強化 <b>${itemDisplayName(tdef, target)}</b><br>成功率：<b>${Math.round(rate * 100)}%</b>（安定值 +${safe}）<br>${risk}`, '強化');
    if (!ok) return;
    this.cs.send({ t: 'enchant', scrollUid, targetUid });
  }

  private compound(cardUid: string, equipUid: string): void {
    this.cs.send({ t: 'compound', cardUid, equipUid });
    this.selectedUid = undefined;
  }

  // ------------------------------------------------------------ 角色

  private renderStats(): void {
    const ch = this.player;
    const p = ch.progression;
    const d = ch.derived();
    const jb = ch.jobBonus();
    const statRows = STAT_KEYS.map((k) => {
      const cost = statRaiseCost(ch.data.stats[k]);
      const extra = d.totalStats[k] - ch.data.stats[k] - jb[k];
      const btn = h('button', {
        class: 'btn btn-small stat-plus', disabled: p.statPoints < cost,
        onclick: (e: Event) => {
          // Shift：一次加到 5 點（伺服器每次都會重新檢查點數）
          let left = p.statPoints;
          let v = ch.data.stats[k];
          const n = (e as MouseEvent).shiftKey ? 5 : 1;
          for (let i = 0; i < n && left >= statRaiseCost(v); i++) {
            left -= statRaiseCost(v);
            v++;
            this.cs.send({ t: 'raiseStat', stat: k });
          }
        },
      }, `+ ${cost}`);
      btn.addEventListener('mousemove', (e) => {
        const lines = statPreview(ch, k);
        this.showTooltip(e.clientX, e.clientY, `<div class="tt-name">${STAT_NAMES[k]} +1（花 ${cost} 點）</div>${lines.map((l) => `${l.label}　${l.from} → <span class="up">${l.to}</span>`).join('<br>') || '<span class="muted">沒有立即變化</span>'}<div class="tt-desc">Shift + 點擊一次加 5 點</div>`);
      });
      btn.addEventListener('mouseleave', () => this.showTooltip(0, 0, undefined));
      return h('tr', {},
        h('td', {}, STAT_NAMES[k]),
        h('td', { class: 'num' }, String(ch.data.stats[k]), jb[k] ? h('span', { class: 'bonus', title: 'Job 加成' }, ` +${jb[k]}`) : undefined, extra ? h('span', { class: 'bonus2', title: '裝備 / 技能加成' }, ` +${extra}`) : undefined),
        h('td', {}, btn));
    });
    const derived: [string, string, string][] = [
      ['最大 HP', fmt(d.maxHp), ''], ['最大 SP', fmt(d.maxSp), ''],
      ['ATK', String(d.atk), '物理攻擊（STR、武器、強化）'], ['MATK', String(d.matk), '魔法攻擊（INT）'],
      ['DEF', String(d.def), '減傷（防具、強化、VIT）'], ['命中', String(d.hit), 'DEX、等級'], ['迴避', String(d.flee), 'AGI、等級'],
      ['爆擊', `${d.critPct.toFixed(1)}%`, 'LUK'], ['攻速', `${d.attacksPerSec.toFixed(2)}/秒`, 'AGI、DEX'],
      ['負重上限', fmt(d.maxWeight), '2000 + STR × 30'], ['掉寶加成', `${d.dropBonusPct}%`, '特定飾品、卡片'],
    ];
    const slotOrder: EquipSlot[] = ['helm', 'weapon', 'armor', 'shield', 'boots', 'accessory'];
    const equipGrid = h('div', { class: 'equip-grid' }, ...slotOrder.map((slot) => {
      const it = ch.data.equipment[slot];
      const def = it ? getDef(ITEM_DB, it.defId) : undefined;
      const cell = def && it
        ? this.iconCell(def, it, undefined, false, () => this.cs.send({ t: 'unequip', slot }))
        : h('div', { class: 'item-cell empty' });
      return h('div', { class: `equip-slot${it ? '' : ' vacant'}` },
        h('span', { class: 'slot-name' }, SLOT_NAMES[slot]), cell,
        h('span', { class: 'equip-name', style: def ? `color:${RARITY_INFO[def.rarity].color}` : '' }, def && it ? itemDisplayName(def, it) : '未裝備'));
    }));
    const job = ch.canChangeJob()
      ? h('div', { class: 'job-change' }, h('b', {}, ch.classDef.tier === 1 ? '可以二轉了：' : '可以轉職了：'), ...ch.jobChoices().map((id) =>
          h('button', { class: 'btn btn-primary', title: CLASSES[id].desc, onclick: () => void this.changeJob(id) }, CLASSES[id].name)))
      : undefined;
    const ls = ch.data.lifeSkills;
    this.stats.set(
      job,
      h('div', { class: 'char-cols' },
        h('div', { class: 'char-left' },
          h('div', { class: 'char-id' },
            h('img', { class: 'char-face', src: facePortrait(ch.data.classId, 48) }),
            h('div', {}, h('div', { class: 'char-name' }, ch.name), h('div', { class: 'muted small' }, `${ch.classDef.name} · Base Lv ${p.baseLevel} · Job Lv ${p.jobLevel}`),
              h('div', { class: 'muted small' }, ch.classDef.desc))),
          h('table', { class: 'stat-table' }, ...statRows),
          h('div', { class: `stat-points${p.statPoints ? ' has' : ''}` }, `剩餘素質點：${p.statPoints}`, h('span', { class: 'muted small' }, '　滑鼠移到 + 可預覽')),
          h('h4', {}, '裝備', h('span', { class: 'muted small' }, '　雙擊或右鍵卸下')),
          equipGrid),
        h('div', { class: 'char-right' },
          h('table', { class: 'stat-table derived' }, ...derived.map(([k, v, tip]) => h('tr', { title: tip }, h('td', {}, k), h('td', { class: 'num' }, v)))),
          h('h4', {}, '生活技能'),
          h('div', { class: 'life-skills' }, ...(Object.entries(ls) as [string, { level: number; exp: number }][]).map(([k, s]) =>
            h('div', { class: 'life-row' }, h('span', {}, `${DERIVED_NAMES[k]} Lv ${s.level}`), bar(s.exp / lifeSkillExpToNext(s.level), 'exp small', '')))))),
    );
  }

  private async changeJob(id: keyof typeof CLASSES): Promise<void> {
    if (!(await ask(this.root, `確定要轉職為 <b>${CLASSES[id].name}</b> 嗎？<br>${CLASSES[id].desc}<br><span class="muted">轉職後 Job Lv 重設為 1，已學的技能會保留。</span>`, '轉職'))) return;
    this.cs.send({ t: 'changeJob', job: id });
  }

  // ------------------------------------------------------------ 家園

  private need(itemId: string, qty: number): HTMLElement {
    const have = this.player.inventory.count(itemId);
    const def = getDef(ITEM_DB, itemId);
    return h('span', { class: `need ${have >= qty ? 'ok' : 'lack'}` }, h('img', { src: itemIcon(def) }), `${def.name} ${have}/${qty}`);
  }

  private renderHome(): void {
    const hs = this.cs.homestead;
    const ch = this.player;
    const next = HOMESTEAD_UPGRADES.find((u) => u.toLevel === hs.data.level + 1);
    const counts = new Map<string, number>();
    for (const n of hs.data.nodes) counts.set(n.defId, (counts.get(n.defId) ?? 0) + 1);
    this.home.set(
      h('div', { class: 'home-level' }, `家園等級 ${hs.data.level}`),
      h('div', { class: 'muted' }, '在家園採礦、伐木，再到熔爐 / 木工台 / 鐵砧 / 鍊金台加工成更有價值的物品，自用或到交易所販售。'),
      h('h4', {}, '資源點'),
      h('div', {}, ...[...counts].map(([id, n]) => {
        const def = NODE_DB.get(id)!;
        return h('div', { class: 'node-row' }, `${def.name} x${n}`, h('span', { class: 'muted' }, ` 需要 ${def.toolTier} 階工具、${def.kind === 'ore' ? '採礦' : '伐木'} Lv ${def.skillReq}，重生 ${def.respawnSec} 秒`));
      })),
      h('h4', {}, next ? `升級到 Lv ${next.toLevel}` : '已達最高等級'),
      next ? h('div', {},
        h('div', { class: 'needs' }, h('span', { class: `need ${ch.data.gold >= next.gold ? 'ok' : 'lack'}` }, `💰 ${fmt(next.gold)} G`), ...next.materials.map((m) => this.need(m.itemId, m.qty))),
        h('div', { class: 'muted' }, `解鎖：${[...new Set(next.unlockNodes)].map((id) => NODE_DB.get(id)!.name).join('、')}`),
        h('button', { class: 'btn btn-primary', onclick: () => this.cs.send({ t: 'upgradeHome' }) }, '升級家園'),
      ) : undefined,
    );
  }

  openStation(id: StationId): void {
    this.stationId = id;
    this.station.show();
    this.markDirty();
  }

  private renderStation(): void {
    const id = this.stationId;
    const hs = this.cs.homestead;
    const ch = this.player;
    const lv = hs.buildingLevel(id);
    this.station.setTitle(`${STATION_NAMES[id]}（Lv ${lv}）`);
    const recipes = RECIPES.filter((r) => r.station === id);
    const rows = recipes.map((r) => {
      const out = getDef(ITEM_DB, r.output.itemId);
      const skill = ch.data.lifeSkills[r.skill];
      const locked = skill.level < r.skillReq || lv < r.stationLevelReq;
      const canMake = this.cs.inOwnHome && !locked && r.inputs.every((i) => ch.inventory.count(i.itemId) >= i.qty) && ch.data.gold >= r.goldCost;
      const doCraft = (times: number) => this.cs.send({ t: 'craft', recipe: r.id, times });
      return h('div', { class: `recipe${locked ? ' locked' : ''}` },
        this.iconCell(out, undefined),
        h('div', { class: 'recipe-info' },
          h('div', { style: `color:${RARITY_INFO[out.rarity].color}` }, `${out.name} x${r.output.qty}`),
          h('div', { class: 'needs' }, ...r.inputs.map((i) => this.need(i.itemId, i.qty)), r.goldCost ? h('span', { class: `need ${ch.data.gold >= r.goldCost ? 'ok' : 'lack'}` }, `💰 ${fmt(r.goldCost)}`) : undefined),
          h('div', { class: 'muted' }, locked
            ? `需要 ${skillName(r.skill)} Lv ${r.skillReq}${r.stationLevelReq > 1 ? `、設施 Lv ${r.stationLevelReq}` : ''}`
            : `成功率 ${Math.round(craftSuccessRate(r, ch) * 100)}%　·　${skillName(r.skill)} Lv ${skill.level}`),
        ),
        h('div', { class: 'recipe-actions' },
          h('button', { class: 'btn btn-primary', disabled: !canMake, onclick: () => doCraft(1) }, '製作'),
          h('button', { class: 'btn', disabled: !canMake, onclick: () => doCraft(10) }, 'x10'),
        ),
      );
    });
    let upgrade: HTMLElement | undefined;
    if (lv < STATION_MAX_LEVEL) {
      const cost = stationUpgradeCost(id, lv);
      upgrade = h('div', { class: 'station-upgrade' },
        h('b', {}, `升級設施到 Lv ${lv + 1}：`),
        h('span', { class: `need ${ch.data.gold >= cost.gold ? 'ok' : 'lack'}` }, `💰 ${fmt(cost.gold)}`),
        ...cost.materials.map((m) => this.need(m.itemId, m.qty)),
        h('button', { class: 'btn', onclick: () => {
          this.cs.send({ t: 'upgradeStation', station: id });
        } }, '升級'));
    }
    this.station.set(h('div', { class: 'recipes' }, ...rows), upgrade);
  }

  // ------------------------------------------------------------ NPC

  openNpc(id: NpcId): void {
    if (id === 'shop') this.shop.show();
    if (id === 'market') this.market.show();
    if (id === 'guide') this.help.show();
    if (id === 'storage') {
      this.storagePanel.show();
      this.inv.show();
    }
    this.markDirty();
  }

  private renderShop(): void {
    const ch = this.player;
    const discount = Math.min(40, ch.passiveBonus().npcBuyDiscountPct ?? 0);
    const buy = NPC_SHOP.map(({ itemId, price: listPrice }) => {
      const price = Math.max(1, Math.floor(listPrice * (1 - discount / 100)));
      const def = getDef(ITEM_DB, itemId);
      const buyN = (n: number) => {
        if (ch.data.gold < price * n) return this.log('金幣不足。', '#f99');
        this.cs.send({ t: 'npcBuy', itemId, qty: n });
      };
      return h('div', { class: 'shop-row' }, this.iconCell(def, undefined), h('span', { class: 'grow' }, def.name), h('span', { class: 'price' }, `${fmt(price)}G`),
        h('button', { class: 'btn btn-small', onclick: () => buyN(1) }, '買 1'), def.stackable ? h('button', { class: 'btn btn-small', onclick: () => buyN(10) }, '買 10') : undefined);
    });
    const bonus = 1 + ((ch.classDef.perks.npcSellBonusPct ?? 0) + (ch.passiveBonus().npcSellPct ?? 0)) / 100;
    const sell = ch.inventory.items.filter((i) => !i.bound && getDef(ITEM_DB, i.defId).bind !== 'bound').map((it) => {
      const def = getDef(ITEM_DB, it.defId);
      return h('div', { class: 'shop-row' }, this.iconCell(def, it), h('span', { class: 'grow', style: `color:${RARITY_INFO[def.rarity].color}` }, `${itemDisplayName(def, it)} x${it.qty}`),
        h('span', { class: 'price' }, `${fmt(Math.floor(def.sellPrice * bonus))}G/個`),
        h('button', { class: 'btn btn-small', onclick: () => this.cs.send({ t: 'npcSell', uid: it.uid, qty: it.qty }) }, '全部賣出'));
    });
    this.shop.set(h('h4', {}, `購買${discount ? `（折價 -${discount}%）` : ''}`), ...buy, h('h4', {}, `賣出${bonus > 1 ? `（商人加成 +${Math.round((bonus - 1) * 100)}%）` : ''}`), h('div', { class: 'scroll-list' }, ...sell));
  }

  private renderMarket(): void {
    const ch = this.player;
    const m = this.cs.market;
    if (!m) {
      this.market.set(h('div', { class: 'muted' }, '讀取中…'));
      return;
    }
    const avgOf = (id: string) => m.averages[id] || undefined;
    const tabs = h('div', { class: 'tabs' },
      ...(['buy', 'sell', 'mine'] as const).map((t) => h('button', { class: `tab${this.marketTab === t ? ' active' : ''}`, onclick: () => { this.marketTab = t; } }, { buy: '購買', sell: '上架物品', mine: '我的商品' }[t])));
    let content: HTMLElement;
    if (this.marketTab === 'buy') {
      const rows = m.listings.filter((l) => l.seller !== ch.name).sort((a, b) => a.item.defId.localeCompare(b.item.defId) || a.price / a.item.qty - b.price / b.item.qty).map((l) => {
        const def = getDef(ITEM_DB, l.item.defId);
        return h('div', { class: 'shop-row' }, this.iconCell(def, l.item),
          h('span', { class: 'grow', style: `color:${RARITY_INFO[def.rarity].color}` }, `${itemDisplayName(def, l.item)} x${l.item.qty}`),
          h('span', { class: 'muted small' }, l.seller),
          h('span', { class: 'price' }, `${fmt(l.price)}G`, l.item.qty > 1 ? h('span', { class: 'muted small' }, ` (${fmt(l.price / l.item.qty)}/個)`) : undefined),
          h('button', { class: 'btn btn-small', disabled: ch.data.gold < l.price, onclick: () => this.cs.send({ t: 'marketBuy', id: l.id }) }, '購買'));
      });
      content = h('div', { class: 'scroll-list tall' }, ...(rows.length ? rows : [h('div', { class: 'muted' }, '目前沒有商品。')]));
    } else if (this.marketTab === 'sell') {
      const tradeables = ch.inventory.items.filter((i) => isTradeable(getDef(ITEM_DB, i.defId), i));
      const sel = this.sellSel ? ch.inventory.get(this.sellSel) : undefined;
      const grid = h('div', { class: 'item-grid' }, ...tradeables.map((it) => this.iconCell(getDef(ITEM_DB, it.defId), it, () => (this.sellSel = it.uid), it.uid === this.sellSel)));
      let form: HTMLElement | undefined;
      if (sel) {
        const def = getDef(ITEM_DB, sel.defId);
        const avg = avgOf(def.id);
        const ref = referencePrice(def.id, avg);
        if (this.sellForm.uid !== sel.uid) this.sellForm = { uid: sel.uid, qty: sel.qty, price: ref * sel.qty };
        const f = this.sellForm;
        const qtyIn = h('input', { type: 'number', min: 1, max: sel.qty, value: f.qty, class: 'input' });
        const priceIn = h('input', { type: 'number', min: 1, value: f.price, class: 'input' });
        const preview = h('div', { class: 'muted' });
        const taxPct = Math.max(0, MARKET_RULES.saleTaxPct - (ch.classDef.perks.marketTaxReductionPct ?? 0));
        const upd = () => {
          f.qty = Math.max(1, Math.min(sel.qty, Math.floor(Number(qtyIn.value) || 1)));
          f.price = Math.max(1, Math.floor(Number(priceIn.value) || 0));
          const price = Math.max(1, Math.floor(Number(priceIn.value) || 0));
          preview.textContent = `上架費 ${fmt(listingFee(price))}G（不退還）· 成交稅 ${taxPct}% · 實收 ${fmt(price - Math.floor((price * taxPct) / 100))}G`;
        };
        qtyIn.addEventListener('input', () => { priceIn.value = String(ref * Math.max(1, Number(qtyIn.value) || 1)); upd(); });
        priceIn.addEventListener('input', upd);
        upd();
        form = h('div', { class: 'sell-form' },
          h('div', { style: `color:${RARITY_INFO[def.rarity].color}` }, itemDisplayName(def, sel)),
          h('div', { class: 'muted' }, `參考單價 ${fmt(ref)}G${avg ? ` · 近期成交均價 ${fmt(avg)}G` : ''} · NPC 收購 ${fmt(def.sellPrice)}G`),
          h('label', {}, '數量 ', qtyIn), h('label', {}, ' 總價 ', priceIn), preview,
          h('button', { class: 'btn btn-primary', onclick: () => {
            upd();
            this.cs.send({ t: 'marketList', uid: sel.uid, qty: f.qty, price: f.price });
            this.sellSel = undefined;
          } }, '上架'));
      }
      content = h('div', {}, h('div', { class: 'muted' }, '選擇要販售的物品（綁定物品不會顯示）'), grid, form);
    } else {
      const mine = m.listings.filter((l) => l.seller === ch.name).map((l) => {
        const def = getDef(ITEM_DB, l.item.defId);
        return h('div', { class: 'shop-row' }, this.iconCell(def, l.item), h('span', { class: 'grow' }, `${itemDisplayName(def, l.item)} x${l.item.qty}`), h('span', { class: 'price' }, `${fmt(l.price)}G`),
          h('button', { class: 'btn btn-small', onclick: () => this.cs.send({ t: 'marketCancel', id: l.id }) }, '下架'));
      });
      const sales = m.mySales.slice(-8).reverse().map((s) =>
        h('div', { class: 'muted small' }, `${new Date(s.at).toLocaleTimeString()} ${getDef(ITEM_DB, s.defId).name} x${s.qty} → ${s.buyer}，實收 ${fmt(s.sellerReceived)}G`));
      content = h('div', {}, ...(mine.length ? mine : [h('div', { class: 'muted' }, '沒有上架中的商品。')]), h('h4', {}, '最近成交'), ...sales,
        h('div', { class: 'muted small', style: 'margin-top:8px' }, `市場已回收金幣：上架費 ${fmt(m.stats.goldSunkFees)}G、交易稅 ${fmt(m.stats.goldSunkTax)}G · 總成交額 ${fmt(m.stats.volume)}G`));
    }
    this.market.set(tabs, content, h('div', { class: 'muted small' }, `規則：上架費 ${MARKET_RULES.listingFeePct}%（最低 ${MARKET_RULES.minListingFee}G）、成交稅 ${MARKET_RULES.saleTaxPct}%（商人 -2%）、上架 72 小時。`));
  }

  private renderHelp(): void {
    this.help.set(h('div', { class: 'help', html: HELP_HTML }));
  }

  private renderDrops(): void {
    const ch = this.player;
    const d = ch.derived();
    const sections = MONSTERS.map((m) => {
      const rows = m.drops.drops.map((e) => {
        const def = getDef(ITEM_DB, e.itemId);
        return h('div', { class: 'drop-row' }, h('img', { src: itemIcon(def) }), h('span', { class: 'grow', style: `color:${RARITY_INFO[def.rarity].color}` }, def.name), h('span', {}, formatPpm(e.ratePpm)));
      });
      const pools = (m.drops.pools ?? []).map((pid) => h('div', { class: 'muted small' }, `＋寶箱池 ${pid}：${formatPpm(POOL_DB.get(pid)!.triggerPpm)} 機率從 ${POOL_DB.get(pid)!.entries.length} 種裝備中抽一件`));
      return h('details', {}, h('summary', {}, `${m.mvp ? '【MVP】' : ''}${m.name} Lv${m.level}`), ...rows, ...pools);
    });
    this.drops.set(
      h('div', { class: 'muted' }, `你的掉寶加成：裝備 ${d.dropBonusPct}% + LUK ${Math.floor(d.totalStats.luk / 10)}%（上限 100%，稀有度越高效果越低，卡片不受影響）。等級比怪物高 6 級以上掉率會下降。`),
      ...sections,
    );
  }
}

function skillIcon(def: SkillDef): string {
  return pixelIcon(def.kind === 'passive' ? 'sk_passive' : `sk_${def.element ?? 'physical'}`, 3);
}

function typeName(def: ItemDef): string {
  if (def.slot) return SLOT_NAMES[def.slot];
  return { weapon: '武器', armor: '防具', accessory: '飾品', consumable: '消耗品', material: '材料', card: `卡片（${def.cardTarget ? SLOT_NAMES[def.cardTarget] : ''}）`, scroll: '卷軸', tool: '工具' }[def.type];
}

function skillName(s: string): string {
  return ({ mining: '採礦', woodcutting: '伐木', smithing: '鍛造', carpentry: '木工', alchemy: '鍊金' } as Record<string, string>)[s] ?? s;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const HELP_HTML = `
<h4>操作</h4>
<ul>
<li><b>左鍵</b>地面：移動　·　<b>左鍵</b>怪物：自動攻擊　·　<b>左鍵</b>地上物品：撿取</li>
<li><b>右鍵拖曳</b>：旋轉視角　·　<b>滾輪</b>：縮放</li>
<li><b>Z</b> 撿取附近物品　·　<b>空白鍵</b> 攻擊最近的怪物　·　<b>1~4</b> 快捷藥水　·　<b>5~8</b> 快捷技能</li>
<li><b>I</b> 背包　·　<b>S</b> 角色　·　<b>K</b> 技能　·　<b>H</b> 家園　·　<b>D</b> 掉寶表　·　<b>Enter</b> 聊天　·　<b>Esc</b> 關閉視窗</li>
</ul>
<h4>冒險</h4>
<p>擊敗怪物獲得 Base / Job 經驗值。升級獲得素質點，Job Lv 10 可以轉職（劍士、弓箭手、魔法師、商人），
一轉 Job Lv 40 可以二轉（騎士、獵人、巫師、鐵匠）。每升一級 Job 得到 1 點技能點，按 <b>K</b> 學習技能。
東南方的骸骨巫妖王是 <b style="color:#ff9f1a">MVP</b>，每小時重生一次，擊敗者可獲得 MVP 專屬獎勵。</p>
<h4>寶物與交易</h4>
<p>每樣掉落物都獨立計算機率，稀有度以顏色區分：<span style="color:#e8e8e8">普通</span>、<span style="color:#5fd35f">優良</span>、<span style="color:#4aa3ff">稀有</span>、<span style="color:#b366ff">史詩</span>、<span style="color:#ff9f1a">傳說</span>、<span style="color:#ff4d6d">神話</span>。
卡片固定 0.01%。大部分物品可在<b>交易所</b>（廣場上的奧斯卡）買賣；<span style="color:#fc8">裝備後綁定</span>的物品穿上後就不能交易。</p>
<h4>強化</h4>
<p>在背包點選強化卷軸 →「強化裝備」→ 點選裝備。武器 +6、防具 +4 以內必定成功，超過後失敗會讓裝備<b style="color:#f66">蒸發</b>。持有保護卷軸時失敗只會 -1。</p>
<h4>家園</h4>
<p>從廣場左邊的傳送門進入家園。用礦鎬 / 斧頭點擊礦脈與樹木採集，再到熔爐、木工台、鐵砧、鍊金台加工。
升級家園可以解鎖更高階的資源（楓樹、鐵礦、秘銀礦）。自己打造的裝備會刻上你的名字。</p>
<p class="muted">遊戲每 30 秒自動存檔。</p>
`;
