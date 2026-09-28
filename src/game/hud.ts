import { ENCHANT_RULES, enchantSuccessRate, tryEnchant, type EnchantKind } from '../core/enchant';
import { craft, craftSuccessRate, type StationId } from '../core/homestead';
import { createItem, getDef, isTradeable, itemDisplayName } from '../core/items';
import { baseExpToNext, jobExpToNext, lifeSkillExpToNext, statRaiseCost } from '../core/leveling';
import { listingFee, MARKET_RULES } from '../core/market';
import { formatPpm, mathRng } from '../core/rng';
import { RARITY_INFO, STAT_KEYS, STAT_NAMES, type EquipSlot, type ItemDef, type ItemInstance } from '../core/types';
import {
  CLASSES, HOMESTEAD_UPGRADES, ITEM_DB, JOB_CHOICES, MONSTERS, NODE_DB, NPC_SHOP, POOL_DB, RECIPES, STATION_MAX_LEVEL,
  STATION_NAMES, stationUpgradeCost,
} from '../data';
import { referencePrice } from './marketSim';
import { itemIcon } from './sprites';
import type { GameState } from './state';
import { ask, bar, fmt, h, Panel } from './ui';
import type { NpcId, World } from './world';

type InvFilter = 'all' | 'equip' | 'use' | 'mat' | 'etc';

const SLOT_NAMES: Record<EquipSlot, string> = { weapon: '武器', armor: '鎧甲', helm: '頭盔', shield: '盾牌', boots: '鞋子', accessory: '飾品' };
const HOTBAR = ['red_potion', 'orange_potion', 'white_potion', 'blue_potion'];

export class Hud {
  private status: HTMLDivElement;
  private logEl: HTMLDivElement;
  private announceEl: HTMLDivElement;
  private labelLayer: HTMLDivElement;
  private floatLayer: HTMLDivElement;
  private hotbar: HTMLDivElement;
  private tooltip: HTMLDivElement;
  private labelPool: HTMLDivElement[] = [];

  private inv: Panel;
  private stats: Panel;
  private home: Panel;
  private station: Panel;
  private shop: Panel;
  private market: Panel;
  private help: Panel;
  private drops: Panel;

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
    private readonly state: GameState,
    private readonly world: () => World,
  ) {
    this.labelLayer = h('div', { class: 'label-layer' });
    this.floatLayer = h('div', { class: 'float-layer' });
    this.status = h('div', { class: 'hud-status' });
    this.logEl = h('div', { class: 'hud-log' });
    this.announceEl = h('div', { class: 'hud-announce' });
    this.hotbar = h('div', { class: 'hud-hotbar' });
    this.tooltip = h('div', { class: 'tooltip', style: 'display:none' });
    const menu = h(
      'div',
      { class: 'hud-menu' },
      h('button', { class: 'btn', onclick: () => this.toggle(this.inv) }, '背包 (I)'),
      h('button', { class: 'btn', onclick: () => this.toggle(this.stats) }, '角色 (S)'),
      h('button', { class: 'btn', onclick: () => this.toggle(this.home) }, '家園 (H)'),
      h('button', { class: 'btn', onclick: () => this.toggle(this.drops) }, '掉寶表 (D)'),
      h('button', { class: 'btn', onclick: () => this.toggle(this.help) }, '說明 (F1)'),
    );
    root.addEventListener('mousedown', () => (this.pointerDown = true));
    window.addEventListener('mouseup', () => (this.pointerDown = false));
    root.append(this.labelLayer, this.floatLayer, this.status, menu, this.logEl, this.announceEl, this.hotbar, this.tooltip);

    this.inv = new Panel(root, '背包', { x: window.innerWidth - 400, y: 70, w: 370 }, () => (this.pending = undefined));
    this.stats = new Panel(root, '角色資訊', { x: 20, y: 200, w: 360 });
    this.home = new Panel(root, '我的家園', { x: 400, y: 80, w: 400 });
    this.station = new Panel(root, '設施', { x: 400, y: 80, w: 460 });
    this.shop = new Panel(root, '道具商人', { x: 400, y: 80, w: 420 });
    this.market = new Panel(root, '交易所', { x: 360, y: 60, w: 560 });
    this.help = new Panel(root, '遊戲說明', { x: 380, y: 60, w: 520 });
    this.drops = new Panel(root, '怪物掉寶表', { x: 380, y: 60, w: 520 });
    for (const p of [this.inv, this.stats, this.home, this.station, this.shop, this.market, this.help, this.drops]) {
      p.body.addEventListener('click', () => this.markDirty());
    }
  }

  // ------------------------------------------------------------ 通用

  markDirty(): void {
    this.dirty = true;
  }

  private toggle(p: Panel): void {
    p.toggle();
    this.markDirty();
  }

  anyPanelOpen(): boolean {
    return [this.inv, this.stats, this.home, this.station, this.shop, this.market, this.help, this.drops].some((p) => p.visible);
  }

  closeTopPanel(): boolean {
    const open = [this.inv, this.stats, this.home, this.station, this.shop, this.market, this.help, this.drops]
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
  }

  key(k: string): void {
    const map: Record<string, Panel> = { i: this.inv, s: this.stats, h: this.home, d: this.drops, f1: this.help };
    const p = map[k];
    if (p) this.toggle(p);
    const idx = ['1', '2', '3', '4'].indexOf(k);
    if (idx >= 0) this.useHotbar(idx);
  }

  log(msg: string, color = '#ddd'): void {
    const line = h('div', { class: 'log-line', style: `color:${color}` }, msg);
    this.logEl.appendChild(line);
    while (this.logEl.childElementCount > 80) this.logEl.firstElementChild!.remove();
    this.logEl.scrollTop = this.logEl.scrollHeight;
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
    if (this.dirty && !this.pointerDown) {
      this.dirty = false;
      this.render();
    }
  }

  private render(): void {
    this.renderStatus();
    this.renderHotbar();
    // 正在輸入的視窗不重繪，避免輸入內容與焦點被清掉
    const typing = document.activeElement instanceof HTMLInputElement ? document.activeElement.closest('.panel') : null;
    if (typing) {
      this.dirty = true;
      if (typing === this.market.el) return;
    }
    if (this.inv.visible) this.renderInventory();
    if (this.stats.visible) this.renderStats();
    if (this.home.visible) this.renderHome();
    if (this.station.visible) this.renderStation();
    if (this.shop.visible) this.renderShop();
    if (this.market.visible) this.renderMarket();
    if (this.help.visible) this.renderHelp();
    if (this.drops.visible) this.renderDrops();
  }

  // ------------------------------------------------------------ 狀態列

  private renderStatus(): void {
    const ch = this.state.player;
    const p = ch.progression;
    const d = ch.derived();
    const wt = ch.inventory.totalWeight();
    const bNeed = baseExpToNext(p.baseLevel);
    const jNeed = jobExpToNext(p.jobLevel);
    const hint = p.statPoints > 0 || ch.canChangeJob()
      ? h('div', { class: 'status-hint', onclick: () => this.toggle(this.stats) }, ch.canChangeJob() ? '★ 可以轉職！' : `★ 剩餘素質點 ${p.statPoints}`)
      : '';
    this.status.replaceChildren(
      h('div', { class: 'status-name' }, `${ch.name}`, h('span', { class: 'status-class' }, ` ${ch.classDef.name}`)),
      h('div', { class: 'status-row' }, `Base Lv ${p.baseLevel}`, h('span', {}, `Job Lv ${p.jobLevel}`)),
      bar(ch.data.hp / d.maxHp, 'hp', `HP ${fmt(ch.data.hp)} / ${fmt(d.maxHp)}`),
      bar(ch.data.sp / d.maxSp, 'sp', `SP ${fmt(ch.data.sp)} / ${fmt(d.maxSp)}`),
      bar(Number.isFinite(bNeed) ? p.baseExp / bNeed : 1, 'exp', `Base ${Number.isFinite(bNeed) ? ((p.baseExp / bNeed) * 100).toFixed(1) : 'MAX'}%`),
      bar(Number.isFinite(jNeed) ? p.jobExp / jNeed : 1, 'jexp', `Job ${Number.isFinite(jNeed) ? ((p.jobExp / jNeed) * 100).toFixed(1) : 'MAX'}%`),
      h('div', { class: 'status-row' }, `💰 ${fmt(ch.data.gold)} G`, h('span', { style: wt > d.maxWeight ? 'color:#f66' : '' }, `負重 ${fmt(wt)}/${fmt(d.maxWeight)}`)),
      hint,
    );
  }

  private renderHotbar(): void {
    const ch = this.state.player;
    this.hotbar.replaceChildren(
      ...HOTBAR.map((id, i) => {
        const def = getDef(ITEM_DB, id);
        const n = ch.inventory.count(id);
        return h('div', { class: `hot-slot${n ? '' : ' empty'}`, title: def.name, onclick: () => this.useHotbar(i) },
          h('img', { src: itemIcon(def) }), h('span', { class: 'hot-key' }, String(i + 1)), h('span', { class: 'hot-qty' }, String(n)));
      }),
    );
  }

  private useHotbar(i: number): void {
    const it = this.state.player.inventory.items.find((x) => x.defId === HOTBAR[i]);
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
    lines.push(`<div class="tt-desc">${escapeHtml(def.desc)}</div>`);
    const bindTxt = it?.bound || def.bind === 'bound' ? '<span style="color:#f88">已綁定（無法交易）</span>' : def.bind === 'bindOnEquip' ? '<span style="color:#fc8">裝備後綁定</span>' : '<span style="color:#8f8">可交易</span>';
    lines.push(`${bindTxt} · 重量 ${def.weight} · NPC 收購 ${fmt(def.sellPrice)}G`);
    return lines.join('<br>');
  }

  private iconCell(def: ItemDef, it: ItemInstance | undefined, onclick?: () => void, selected = false): HTMLDivElement {
    const cell = h('div', { class: `item-cell r${def.rarity}${selected ? ' selected' : ''}`, onclick },
      h('img', { src: itemIcon(def), draggable: 'false' }),
      it && it.qty > 1 ? h('span', { class: 'qty' }, String(it.qty)) : undefined,
      it && it.enchant > 0 ? h('span', { class: 'plus' }, `+${it.enchant}`) : undefined,
    );
    cell.addEventListener('mousemove', (e) => this.showTooltip(e.clientX, e.clientY, this.itemTooltip(def, it)));
    cell.addEventListener('mouseleave', () => this.showTooltip(0, 0, undefined));
    return cell;
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
    const ch = this.state.player;
    const inv = ch.inventory;
    const tabs = h('div', { class: 'tabs' },
      ...(['all', 'equip', 'use', 'mat', 'etc'] as InvFilter[]).map((f) =>
        h('button', { class: `tab${this.invFilter === f ? ' active' : ''}`, onclick: () => (this.invFilter = f) },
          { all: '全部', equip: '裝備', use: '消耗', mat: '材料', etc: '卡片' }[f])),
    );
    const grid = h('div', { class: 'item-grid' });
    for (const it of inv.items) {
      const def = getDef(ITEM_DB, it.defId);
      if (!this.matchesFilter(def)) continue;
      grid.appendChild(this.iconCell(def, it, () => this.onInventoryClick(it), it.uid === this.selectedUid));
    }
    const sel = this.selectedUid ? inv.get(this.selectedUid) : undefined;
    let detail: HTMLElement | undefined;
    if (this.pending) {
      detail = h('div', { class: 'pending' }, this.pending.kind === 'enchant' ? '請點選要強化的裝備（未裝備中的）' : '請點選要鑲嵌的裝備（需先卸下）',
        h('button', { class: 'btn', onclick: () => (this.pending = undefined) }, '取消'));
    } else if (sel) {
      const def = getDef(ITEM_DB, sel.defId);
      const actions: HTMLElement[] = [];
      if (def.type === 'consumable') actions.push(h('button', { class: 'btn btn-primary', onclick: () => this.useItem(sel) }, '使用'));
      if (def.slot) actions.push(h('button', { class: 'btn btn-primary', onclick: () => this.equip(sel) }, '裝備'));
      if (def.scroll && def.scroll !== 'protection') actions.push(h('button', { class: 'btn btn-primary', onclick: () => (this.pending = { kind: 'enchant', uid: sel.uid }) }, '強化裝備'));
      if (def.type === 'card') actions.push(h('button', { class: 'btn btn-primary', onclick: () => (this.pending = { kind: 'card', uid: sel.uid }) }, '鑲嵌卡片'));
      actions.push(h('button', { class: 'btn btn-danger', onclick: () => void this.discard(sel) }, '丟棄'));
      detail = h('div', { class: 'item-detail' }, h('div', { html: this.itemTooltip(def, sel) }), h('div', { class: 'actions' }, ...actions));
    }
    this.inv.setTitle(`背包 ${inv.usedSlots}/${inv.capacity}`);
    this.inv.set(tabs, grid, detail, h('div', { class: 'muted' }, `負重 ${fmt(inv.totalWeight())} / ${fmt(ch.derived().maxWeight)}　·　Z 撿取　·　點選物品查看操作`));
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
    const ch = this.state.player;
    const def = getDef(ITEM_DB, it.defId);
    if (!def.heal) return;
    const d = ch.derived();
    ch.inventory.consume(def.id, 1);
    if (def.heal.hp) ch.data.hp = Math.min(d.maxHp, ch.data.hp + def.heal.hp);
    if (def.heal.sp) ch.data.sp = Math.min(d.maxSp, ch.data.sp + def.heal.sp);
    const pos = this.world().playerScreenPos();
    this.floatText(pos.x, pos.y, `+${def.heal.hp ?? def.heal.sp}`, def.heal.hp ? '#6f6' : '#6af');
    this.markDirty();
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
    const r = this.state.player.equip(it.uid);
    if (!r.ok) this.log(r.reason!, '#f99');
    else this.selectedUid = undefined;
    this.markDirty();
  }

  private async discard(it: ItemInstance): Promise<void> {
    const def = getDef(ITEM_DB, it.defId);
    if (!(await ask(this.root, `確定要丟棄 <b>${def.name}</b> x${it.qty} 嗎？（無法復原）`, '丟棄'))) return;
    this.state.player.inventory.take(it.uid, it.qty);
    this.selectedUid = undefined;
    this.markDirty();
  }

  private async enchant(scrollUid: string, targetUid: string): Promise<void> {
    const ch = this.state.player;
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
    ch.inventory.consume(sdef.id, 1);
    const useProtect = hasProtect && target.enchant >= safe;
    if (useProtect) ch.inventory.consume('scroll_protect', 1);
    const blessed = sdef.scroll === 'blessedWeaponEnchant' || sdef.scroll === 'blessedArmorEnchant';
    const res = tryEnchant(kind, target.enchant, { blessed, protectedByScroll: useProtect }, mathRng);
    const name = tdef.name;
    if (res.outcome === 'success') {
      const gain = res.newLevel - target.enchant;
      target.enchant = res.newLevel;
      this.announce(`${name} 發出${gain > 1 ? '耀眼的' : '一陣'}${kind === 'weapon' ? '藍色' : '銀色'}光芒！（+${res.newLevel}）`, '#8cf');
      if (res.newLevel >= safe + 3) this.announce(`【全服公告】${ch.name} 成功將 ${name} 強化到 +${res.newLevel}！`, '#ff9f1a');
    } else if (res.outcome === 'downgraded') {
      target.enchant = res.newLevel;
      this.announce(`強化失敗… 保護卷軸發揮效果，${name} 變為 +${res.newLevel}。`, '#fc8');
    } else if (res.outcome === 'destroyed') {
      ch.inventory.take(target.uid, 1);
      this.announce(`${name} 發出強烈的黑色光芒後蒸發了…`, '#f66');
      if (this.selectedUid === target.uid) this.selectedUid = undefined;
    }
    this.markDirty();
  }

  private compound(cardUid: string, equipUid: string): void {
    const r = this.state.player.compoundCard(cardUid, equipUid);
    if (r.ok) this.announce('卡片鑲嵌成功！', '#b366ff');
    else this.log(r.reason!, '#f99');
    this.selectedUid = undefined;
    this.markDirty();
  }

  // ------------------------------------------------------------ 角色

  private renderStats(): void {
    const ch = this.state.player;
    const p = ch.progression;
    const d = ch.derived();
    const jb = ch.jobBonus();
    const statRows = STAT_KEYS.map((k) => {
      const cost = statRaiseCost(ch.data.stats[k]);
      return h('tr', {},
        h('td', {}, STAT_NAMES[k]),
        h('td', { class: 'num' }, String(ch.data.stats[k]), jb[k] ? h('span', { class: 'bonus' }, ` +${jb[k]}`) : undefined, d.totalStats[k] - ch.data.stats[k] - jb[k] ? h('span', { class: 'bonus2' }, ` +${d.totalStats[k] - ch.data.stats[k] - jb[k]}`) : undefined),
        h('td', {}, h('button', { class: 'btn btn-small', disabled: p.statPoints < cost, onclick: () => { ch.raiseStat(k); this.markDirty(); } }, `+ (${cost})`)),
      );
    });
    const derived = [
      ['ATK', d.atk], ['MATK', d.matk], ['DEF', d.def], ['HIT', d.hit], ['FLEE', d.flee], ['爆擊', `${d.critPct.toFixed(1)}%`],
      ['攻速', `${d.attacksPerSec.toFixed(2)}/秒`], ['掉寶加成', `${d.dropBonusPct}%`],
    ];
    const equipRows = (Object.keys(SLOT_NAMES) as EquipSlot[]).map((slot) => {
      const it = ch.data.equipment[slot];
      const def = it ? getDef(ITEM_DB, it.defId) : undefined;
      const cell = def && it ? this.iconCell(def, it) : h('div', { class: 'item-cell empty' });
      return h('div', { class: 'equip-row' }, h('span', { class: 'slot-name' }, SLOT_NAMES[slot]), cell,
        h('span', { style: def ? `color:${RARITY_INFO[def.rarity].color}` : 'color:#777' }, def && it ? itemDisplayName(def, it) : '—'),
        it ? h('button', { class: 'btn btn-small', onclick: () => { ch.unequip(slot); this.markDirty(); } }, '卸下') : undefined);
    });
    const job = ch.canChangeJob()
      ? h('div', { class: 'job-change' }, h('b', {}, '轉職：'), ...JOB_CHOICES.map((id) =>
          h('button', { class: 'btn btn-primary', title: CLASSES[id].desc, onclick: () => void this.changeJob(id) }, CLASSES[id].name)))
      : undefined;
    const ls = ch.data.lifeSkills;
    this.stats.set(
      h('div', { class: 'muted' }, `${ch.classDef.name} — ${ch.classDef.desc}`),
      job,
      h('div', { class: 'cols' },
        h('table', { class: 'stat-table' }, ...statRows, h('tr', {}, h('td', { colspan: 3, class: 'muted' }, `剩餘素質點：${p.statPoints}`))),
        h('table', { class: 'stat-table' }, ...derived.map(([k, v]) => h('tr', {}, h('td', {}, String(k)), h('td', { class: 'num' }, String(v))))),
      ),
      h('h4', {}, '裝備'),
      ...equipRows,
      h('h4', {}, '生活技能'),
      h('div', { class: 'life-skills' }, ...(Object.entries(ls) as [string, { level: number; exp: number }][]).map(([k, s]) =>
        h('div', {}, `${{ mining: '採礦', woodcutting: '伐木', smithing: '鍛造', carpentry: '木工', alchemy: '鍊金' }[k]} Lv ${s.level}`,
          bar(s.exp / lifeSkillExpToNext(s.level), 'exp small', '')))),
    );
  }

  private async changeJob(id: (typeof JOB_CHOICES)[number]): Promise<void> {
    if (!(await ask(this.root, `確定要轉職為 <b>${CLASSES[id].name}</b> 嗎？<br>${CLASSES[id].desc}<br><span class="muted">轉職後 Job Lv 重設為 1。</span>`, '轉職'))) return;
    if (this.state.player.changeJob(id)) {
      this.announce(`恭喜轉職為 ${CLASSES[id].name}！`, '#ffe680');
      this.world().refreshPlayerLook();
    }
    this.markDirty();
  }

  // ------------------------------------------------------------ 家園

  private need(itemId: string, qty: number): HTMLElement {
    const have = this.state.player.inventory.count(itemId);
    const def = getDef(ITEM_DB, itemId);
    return h('span', { class: `need ${have >= qty ? 'ok' : 'lack'}` }, h('img', { src: itemIcon(def) }), `${def.name} ${have}/${qty}`);
  }

  private renderHome(): void {
    const hs = this.state.homestead;
    const ch = this.state.player;
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
        h('button', { class: 'btn btn-primary', onclick: () => {
          const r = hs.upgrade(ch, next, NODE_DB);
          if (r.ok) {
            this.announce(`家園升級到 Lv ${hs.data.level}！`, '#9fffb0');
            if (this.world().zone === 'homestead') this.world().buildNodes();
          } else this.log(r.reason!, '#f99');
          this.markDirty();
        } }, '升級家園'),
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
    const hs = this.state.homestead;
    const ch = this.state.player;
    const lv = hs.buildingLevel(id);
    this.station.setTitle(`${STATION_NAMES[id]}（Lv ${lv}）`);
    const recipes = RECIPES.filter((r) => r.station === id);
    const rows = recipes.map((r) => {
      const out = getDef(ITEM_DB, r.output.itemId);
      const skill = ch.data.lifeSkills[r.skill];
      const locked = skill.level < r.skillReq || lv < r.stationLevelReq;
      const canMake = !locked && r.inputs.every((i) => ch.inventory.count(i.itemId) >= i.qty) && ch.data.gold >= r.goldCost;
      const doCraft = (times: number) => {
        let ok = 0;
        let fail = 0;
        for (let i = 0; i < times; i++) {
          const res = craft(ch, r, hs, ITEM_DB, this.state.uids, mathRng, Date.now());
          if (!res.ok) {
            if (i === 0) this.log(res.reason!, '#f99');
            break;
          }
          if (res.success) ok++;
          else fail++;
          if (res.levelUps) this.announce(`${skillName(r.skill)}等級提升！`, '#9fffb0');
        }
        if (ok + fail > 0) this.log(`製作 ${out.name}：成功 ${ok} 次${fail ? `、失敗 ${fail} 次（材料已消耗）` : ''}`, fail && !ok ? '#f99' : RARITY_INFO[out.rarity].color);
        this.markDirty();
      };
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
          const r = hs.upgradeBuilding(ch, id, cost, STATION_MAX_LEVEL);
          if (r.ok) this.announce(`${STATION_NAMES[id]} 升級到 Lv ${hs.buildingLevel(id)}！`, '#9fffb0');
          else this.log(r.reason!, '#f99');
          this.markDirty();
        } }, '升級'));
    }
    this.station.set(h('div', { class: 'recipes' }, ...rows), upgrade);
  }

  // ------------------------------------------------------------ NPC

  openNpc(id: NpcId): void {
    if (id === 'shop') this.shop.show();
    if (id === 'market') {
      const got = this.state.market.collectPayout(this.state.player);
      if (got) this.log(`領取交易所收入 ${fmt(got)}G`, '#ffd24a');
      this.market.show();
    }
    if (id === 'guide') this.help.show();
    this.markDirty();
  }

  private renderShop(): void {
    const ch = this.state.player;
    const buy = NPC_SHOP.map(({ itemId, price }) => {
      const def = getDef(ITEM_DB, itemId);
      const buyN = (n: number) => {
        if (ch.data.gold < price * n) return this.log('金幣不足。', '#f99');
        const it = createItem(ITEM_DB, this.state.uids, itemId, def.stackable ? n : 1, { kind: 'npc', at: Date.now() });
        if (!ch.inventory.add(it)) return this.log('背包已滿。', '#f99');
        ch.data.gold -= price * (def.stackable ? n : 1);
        this.markDirty();
      };
      return h('div', { class: 'shop-row' }, this.iconCell(def, undefined), h('span', { class: 'grow' }, def.name), h('span', { class: 'price' }, `${fmt(price)}G`),
        h('button', { class: 'btn btn-small', onclick: () => buyN(1) }, '買 1'), def.stackable ? h('button', { class: 'btn btn-small', onclick: () => buyN(10) }, '買 10') : undefined);
    });
    const bonus = 1 + (ch.classDef.perks.npcSellBonusPct ?? 0) / 100;
    const sell = ch.inventory.items.filter((i) => !i.bound && getDef(ITEM_DB, i.defId).bind !== 'bound').map((it) => {
      const def = getDef(ITEM_DB, it.defId);
      return h('div', { class: 'shop-row' }, this.iconCell(def, it), h('span', { class: 'grow', style: `color:${RARITY_INFO[def.rarity].color}` }, `${itemDisplayName(def, it)} x${it.qty}`),
        h('span', { class: 'price' }, `${fmt(Math.floor(def.sellPrice * bonus))}G/個`),
        h('button', { class: 'btn btn-small', onclick: () => { const g = ch.sellToNpc(it.uid, it.qty); this.log(`賣出 ${def.name} x${it.qty}，獲得 ${fmt(g)}G`, '#ffd24a'); this.markDirty(); } }, '全部賣出'));
    });
    this.shop.set(h('h4', {}, '購買'), ...buy, h('h4', {}, `賣出${bonus > 1 ? `（商人加成 +${Math.round((bonus - 1) * 100)}%）` : ''}`), h('div', { class: 'scroll-list' }, ...sell));
  }

  private renderMarket(): void {
    const ch = this.state.player;
    const m = this.state.market;
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
          h('button', { class: 'btn btn-small', disabled: ch.data.gold < l.price, onclick: () => {
            const r = m.buy(ch, l.id);
            if (r.ok) this.log(`購買 ${def.name} x${l.item.qty}，花費 ${fmt(l.price)}G`, '#ffd24a');
            else this.log(r.reason!, '#f99');
            this.markDirty();
          } }, '購買'));
      });
      content = h('div', { class: 'scroll-list tall' }, ...(rows.length ? rows : [h('div', { class: 'muted' }, '目前沒有商品。')]));
    } else if (this.marketTab === 'sell') {
      const tradeables = ch.inventory.items.filter((i) => isTradeable(getDef(ITEM_DB, i.defId), i));
      const sel = this.sellSel ? ch.inventory.get(this.sellSel) : undefined;
      const grid = h('div', { class: 'item-grid' }, ...tradeables.map((it) => this.iconCell(getDef(ITEM_DB, it.defId), it, () => (this.sellSel = it.uid), it.uid === this.sellSel)));
      let form: HTMLElement | undefined;
      if (sel) {
        const def = getDef(ITEM_DB, sel.defId);
        const ref = referencePrice(this.state, def.id);
        const avg = m.averagePrice(def.id);
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
            const r = m.list(ch, sel.uid, f.qty, f.price);
            if (r.ok) {
              this.log(`已上架 ${def.name}，支付上架費 ${fmt(listingFee(r.listing!.price))}G`, '#ffd24a');
              this.sellSel = undefined;
            } else this.log(r.reason!, '#f99');
            this.markDirty();
          } }, '上架'));
      }
      content = h('div', {}, h('div', { class: 'muted' }, '選擇要販售的物品（綁定物品不會顯示）'), grid, form);
    } else {
      const mine = m.listings.filter((l) => l.seller === ch.name).map((l) => {
        const def = getDef(ITEM_DB, l.item.defId);
        return h('div', { class: 'shop-row' }, this.iconCell(def, l.item), h('span', { class: 'grow' }, `${itemDisplayName(def, l.item)} x${l.item.qty}`), h('span', { class: 'price' }, `${fmt(l.price)}G`),
          h('button', { class: 'btn btn-small', onclick: () => { const r = m.cancel(ch, l.id); if (!r.ok) this.log(r.reason!, '#f99'); this.markDirty(); } }, '下架'));
      });
      const sales = m.history.filter((s) => s.seller === ch.name).slice(-8).reverse().map((s) =>
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
    const ch = this.state.player;
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
<li><b>Z</b> 撿取附近物品　·　<b>空白鍵</b> 攻擊最近的怪物　·　<b>1~4</b> 快捷藥水</li>
<li><b>I</b> 背包　·　<b>S</b> 角色　·　<b>H</b> 家園　·　<b>D</b> 掉寶表　·　<b>Esc</b> 關閉視窗</li>
</ul>
<h4>冒險</h4>
<p>擊敗怪物獲得 Base / Job 經驗值。升級獲得素質點，Job Lv 10 可以轉職（劍士、弓箭手、魔法師、商人）。
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
