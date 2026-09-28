import '@chinese-fonts/cubic/dist/Cubic/result.css';
import './style.css';
import * as THREE from 'three';
import { getDef } from './core/items';
import { ITEM_DB } from './data';
import { Hud } from './game/hud';
import { h } from './game/ui';
import { World } from './game/world';
import { ClientState } from './client/ClientState';
import { LocalConnection, WsConnection, type Connection } from './net/connection';
import { PROTOCOL_VERSION, type ServerMsg } from './net/protocol';
import { BrowserStorage } from './server/browserStorage';

const gameEl = document.getElementById('game')!;
const uiEl = document.getElementById('ui')!;

/** 標題畫面底部的像素地景（草方塊、泥土、樹） */
function titleLandscape(): HTMLCanvasElement {
  const W = 240;
  const H = 40;
  const c = h('canvas', { class: 'title-land', width: W, height: H });
  const g = c.getContext('2d')!;
  let seed = 7;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const heights: number[] = [];
  let hgt = 22;
  for (let x = 0; x < W; x += 4) {
    if (rnd() < 0.35) hgt = Math.max(14, Math.min(28, hgt + (rnd() < 0.5 ? -4 : 4)));
    heights.push(hgt);
  }
  heights.forEach((top, i) => {
    const x = i * 4;
    for (let y = top; y < H; y++) {
      const grass = y < top + 1;
      const shade = rnd() * 16 - 8;
      const base = grass ? [95, 160, 58] : y < top + 2 && rnd() < 0.5 ? [95, 160, 58] : [122, 82, 52];
      g.fillStyle = `rgb(${base[0] + shade},${base[1] + shade},${base[2] + shade})`;
      g.fillRect(x, y, 4, 1);
    }
    // 樹
    if (rnd() < 0.12) {
      g.fillStyle = '#5a4329';
      g.fillRect(x + 1, top - 6, 2, 6);
      g.fillStyle = '#2f6a20';
      g.fillRect(x - 2, top - 11, 8, 5);
      g.fillStyle = '#3f7f2c';
      g.fillRect(x - 1, top - 13, 6, 3);
    }
  });
  return c;
}

const DEFAULT_SERVER = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.hostname || 'localhost'}:8787`;

function titleScreen(error?: string): void {
  uiEl.replaceChildren();
  const last = BrowserStorage.lastPlayer();
  let mode: 'offline' | 'online' = (localStorage.getItem('roe:mode') as 'online' | null) ?? 'offline';
  const nameIn = h('input', { class: 'input', placeholder: '角色名稱（2~12 字）', maxlength: 12, value: localStorage.getItem('roe:name') ?? last?.name ?? '冒險者' });
  const pwIn = h('input', { class: 'input', type: 'password', placeholder: '密碼（至少 4 字）', maxlength: 64 });
  const serverIn = h('input', { class: 'input wide', value: localStorage.getItem('roe:server') ?? DEFAULT_SERVER });
  const errorEl = h('div', { class: 'title-error' }, error ?? '');
  const body = h('div', { class: 'title-form' });
  const go = () => {
    const name = nameIn.value.trim();
    try {
      localStorage.setItem('roe:mode', mode);
      localStorage.setItem('roe:name', name);
      if (mode === 'online') localStorage.setItem('roe:server', serverIn.value.trim());
    } catch {
      /* ignore */
    }
    errorEl.textContent = '連線中…';
    const conn = mode === 'online' ? new WsConnection(serverIn.value.trim()) : new LocalConnection();
    startGame(conn, name, mode === 'online' ? pwIn.value : undefined, (reason) => (errorEl.textContent = reason));
  };
  const renderForm = () => {
    tabOff.className = `tab${mode === 'offline' ? ' active' : ''}`;
    tabOn.className = `tab${mode === 'online' ? ' active' : ''}`;
    body.replaceChildren(
      mode === 'online' ? h('label', { class: 'field' }, h('span', {}, '伺服器'), serverIn) : '',
      h('label', { class: 'field' }, h('span', {}, '角色'), nameIn),
      mode === 'online' ? h('label', { class: 'field' }, h('span', {}, '密碼'), pwIn) : '',
      h('div', { class: 'muted small' }, mode === 'online'
        ? '第一次登入會用這組名稱與密碼建立帳號。'
        : last ? `上次遊玩：${last.name}（Lv ${last.level}）。輸入同名即可繼續，輸入新名字會建立新角色。` : '單機模式：資料存在這台電腦上。'),
      h('button', { class: 'btn big btn-primary', onclick: go }, mode === 'online' ? '連線進入' : '開始冒險'),
    );
  };
  const tabOff = h('button', { class: 'tab', onclick: () => { mode = 'offline'; renderForm(); } }, '單機遊玩');
  const tabOn = h('button', { class: 'tab', onclick: () => { mode = 'online'; renderForm(); } }, '連線遊玩');
  for (const inp of [nameIn, pwIn, serverIn]) inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  renderForm();
  const screen = h('div', { class: 'title-screen' },
    titleLandscape(),
    h('div', { class: 'title-box' },
      h('h1', {}, '餘燼王國'),
      h('div', { class: 'subtitle' }, '— REALM OF EMBERS —'),
      h('div', { class: 'title-panel frame' },
        h('div', { class: 'tabs' }, tabOff, tabOn),
        body,
        errorEl,
        h('div', { class: 'muted small' }, '左鍵移動 / 攻擊 · 右鍵拖曳旋轉視角 · 滾輪縮放 · Enter 聊天 · F1 說明'),
      ),
    ),
  );
  uiEl.appendChild(screen);
}

function startGame(conn: Connection, name: string, password: string | undefined, onError: (reason: string) => void): void {
  const cs = new ClientState(conn);
  let world: World | undefined;
  let hud: Hud | undefined;
  let started = false;
  let failed = false;

  const begin = () => {
    started = true;
    uiEl.replaceChildren();
    gameEl.replaceChildren();
    hud = new Hud(uiEl, cs, () => world!);
    world = new World(gameEl, cs, {
      floatText: (p, t, c, big) => {
        const s = world!.toScreen(p);
        if (s.visible) hud!.floatText(s.x, s.y, t, c, big);
      },
      playerMenu: (n, x, y) => hud!.playerMenu(n, x, y),
    });
    hud.log(`歡迎來到餘燼王國，${cs.name}！按 F1 查看說明${cs.online ? '，按 Enter 聊天' : ''}。`, '#ffe680');
    bindInput(cs, world, hud);
    const timer = new THREE.Timer();
    const loop = (t?: number) => {
      if (!world) return;
      timer.update(t);
      const dt = Math.min(timer.getDelta(), 0.1);
      world.update(dt);
      world.render();
      hud!.frame();
      requestAnimationFrame(loop);
    };
    loop();
    (window as unknown as { game: unknown }).game = { cs, world, hud, conn };
  };

  // 在收到 welcome 之前先暫存訊息（zone / self 會緊接著 welcome 送來）
  const pending: ServerMsg[] = [];
  const handle = (msg: ServerMsg) => {
    if (!world || !hud) {
      pending.push(msg);
      return;
    }
    switch (msg.t) {
      case 'zone':
        cs.zone = msg.zone;
        cs.zoneOwner = msg.owner;
        if (msg.homestead) cs.setHome(msg.homestead);
        world.apply(msg);
        hud.closeZonePanels();
        hud.markDirty();
        break;
      case 'snap':
      case 'fx':
        world.apply(msg);
        break;
      case 'self':
        cs.setSelf(msg.data);
        hud.markDirty();
        break;
      case 'home':
        cs.setHome(msg.data);
        hud.markDirty();
        break;
      case 'log':
        hud.log(msg.msg, msg.color);
        break;
      case 'announce':
        hud.announce(msg.msg, msg.color);
        break;
      case 'open':
        if (msg.kind === 'npc') hud.openNpc(msg.id);
        else hud.openStation(msg.id);
        break;
      case 'market':
        cs.market = msg.view;
        hud.markDirty();
        break;
      case 'trade':
        cs.trade = msg.view;
        hud.markDirty();
        break;
      case 'tradeInvite':
        hud.tradeInvite(msg.from);
        break;
      case 'partyInvite':
        hud.partyInvite(msg.from);
        break;
      case 'party':
        cs.party = msg.view;
        hud.markDirty();
        break;
      case 'chat':
        hud.chat(msg.from, msg.text, msg.system, msg.channel);
        break;
      case 'players':
        cs.onlinePlayers = msg.names;
        hud.markDirty();
        break;
      default:
        break;
    }
  };

  conn.onMessage((msg) => {
    if (msg.t === 'loginFailed') {
      failed = true;
      conn.close();
      onError(msg.reason);
      return;
    }
    if (msg.t === 'welcome') {
      cs.myId = msg.id;
      cs.name = msg.name;
      cs.online = msg.online;
      begin();
      for (const m of pending.splice(0)) handle(m);
      return;
    }
    handle(msg);
  });
  conn.onClose((reason) => {
    if (failed) return;
    if (!started) {
      onError(reason);
      return;
    }
    world = undefined;
    const overlay = h('div', { class: 'modal-overlay' }, h('div', { class: 'modal frame' },
      h('div', {}, `⚠ ${reason}`),
      h('div', { class: 'modal-actions' }, h('button', { class: 'btn btn-primary', onclick: () => location.reload() }, '回到標題畫面'))));
    uiEl.appendChild(overlay);
  });
  conn.send({ t: 'login', name, password, version: PROTOCOL_VERSION });
}

function bindInput(cs: ClientState, world: World, hud: Hud): void {
  const canvas = world.renderer.domElement;
  let rightDrag: { x: number } | undefined;
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('mousedown', (e) => {
    if (e.button === 0) world.click(e.clientX, e.clientY);
    if (e.button === 2) rightDrag = { x: e.clientX };
  });
  window.addEventListener('mouseup', () => (rightDrag = undefined));
  canvas.addEventListener('mousemove', (e) => {
    if (rightDrag) {
      world.rotateCamera((e.clientX - rightDrag.x) * -0.008);
      rightDrag.x = e.clientX;
    }
    const p = world.hover(e.clientX, e.clientY);
    canvas.style.cursor = !p ? 'default' : p.type === 'monster' ? 'crosshair' : 'pointer';
    const it = world.hoveredItem();
    if (it) hud.showTooltip(e.clientX, e.clientY, hud.itemTooltip(getDef(ITEM_DB, it.defId)));
    else hud.showTooltip(0, 0, undefined);
  });
  canvas.addEventListener('wheel', (e) => {
    world.zoomCamera(e.deltaY * 0.01);
    e.preventDefault();
  }, { passive: false });
  window.addEventListener('keydown', (e) => {
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    const k = e.key.toLowerCase();
    if (k === 'escape') {
      hud.closeTopPanel();
      return;
    }
    if (k === 'enter') {
      e.preventDefault();
      hud.focusChat();
      return;
    }
    if (k === 'f1') e.preventDefault();
    if (k === 'z') world.pickupNearest();
    else if (k === ' ') {
      e.preventDefault();
      world.attackNearest();
    } else if (k === 'q') world.rotateCamera(0.3);
    else if (k === 'e') world.rotateCamera(-0.3);
    else hud.key(k);
  });
  void cs;
}

titleScreen();
