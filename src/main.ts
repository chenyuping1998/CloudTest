import '@chinese-fonts/cubic/dist/Cubic/result.css';
import './style.css';
import * as THREE from 'three';
import { getDef } from './core/items';
import { ITEM_DB } from './data';
import { Hud } from './game/hud';
import { h } from './game/ui';
import { World } from './game/world';
import { audio } from './game/audio';
import { settings } from './game/settings';
import { ClientState } from './client/ClientState';
import { LocalConnection, WsConnection, type Connection } from './net/connection';
import { PROTOCOL_VERSION, type ServerMsg } from './net/protocol';
import { BrowserStorage } from './server/browserStorage';
import { platform } from './platform/platform';
import { ZONE_NAMES } from './shared/maps';

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

/** 預設伺服器：透過 HTTPS 開啟網頁版時走同網域的 /ws（Caddy 反向代理）；否則連本機開發伺服器 */
/** 依戰鬥 / 採集事件播放音效（距離越遠越小聲；受傷只播自己的） */
function fxSound(msg: Extract<ServerMsg, { t: 'fx' }>, dist: number): void {
  switch (msg.kind) {
    case 'dmg': return audio.play('hit', dist);
    case 'crit': return audio.play('crit', dist);
    case 'miss': return audio.play('miss', dist);
    case 'hurt': return msg.target === gameState?.myId ? audio.play('hurt') : undefined;
    case 'heal': return audio.play('heal', dist);
    case 'levelup': return audio.play('levelup', dist);
    case 'poof': return audio.play('death', dist);
    case 'chips': return audio.play(msg.y > 1 ? 'chop' : 'mine', dist);
    case 'skill': return audio.play(`skill_${(msg.element ?? 'physical') as 'physical'}`, dist);
    default: return undefined;
  }
}

let gameState: { myId: number } | undefined;

// 瀏覽器規定使用者操作後才能發聲：第一次點擊 / 按鍵時啟動音效
for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, () => audio.unlock(), { capture: true });
settings.subscribe(() => audio.applyVolumes());

const DEFAULT_SERVER = location.protocol === 'https:' ? `wss://${location.host}/ws` : `ws://${location.hostname || 'localhost'}:8787`;

/** 上次連的伺服器；Cloudflare 快速通道每次重開網址都會變，記住的舊通道網址直接作廢 */
function savedServer(): string {
  const saved = localStorage.getItem('roe:server');
  if (!saved) return DEFAULT_SERVER;
  try {
    const host = new URL(saved).host;
    if (host.endsWith('.trycloudflare.com') && host !== location.host) return DEFAULT_SERVER;
  } catch {
    return DEFAULT_SERVER;
  }
  return saved;
}

function titleScreen(error?: string): void {
  uiEl.replaceChildren();
  const last = BrowserStorage.lastPlayer();
  let mode: 'offline' | 'online' = (localStorage.getItem('roe:mode') as 'online' | null) ?? 'offline';
  const nameIn = h('input', { class: 'input', placeholder: '角色名稱（2~12 字）', maxlength: 12, value: localStorage.getItem('roe:name') ?? last?.name ?? platform.steam?.personaName?.replace(/[^\p{L}\p{N}_]/gu, '').slice(0, 12) ?? '冒險者' });
  const pwIn = h('input', { class: 'input', type: 'password', placeholder: '密碼（至少 4 字）', maxlength: 64 });
  const serverIn = h('input', { class: 'input wide', value: savedServer() });
  const errorEl = h('div', { class: 'title-error' }, error ?? '');
  const body = h('div', { class: 'title-form' });
  const goSteam = async () => {
    errorEl.textContent = '向 Steam 取得登入票證…';
    const ticket = await platform.steam?.getAuthTicket();
    if (!ticket) {
      errorEl.textContent = '無法取得 Steam 票證，請確認 Steam 已登入。';
      return;
    }
    const name = nameIn.value.trim();
    try {
      localStorage.setItem('roe:mode', 'online');
      localStorage.setItem('roe:name', name);
      localStorage.setItem('roe:server', serverIn.value.trim());
    } catch {
      /* ignore */
    }
    errorEl.textContent = '連線中…';
    startGame(new WsConnection(serverIn.value.trim()), name, undefined, (reason) => (errorEl.textContent = reason), ticket);
  };
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
      mode === 'online' && !platform.steam ? h('label', { class: 'field' }, h('span', {}, '密碼'), pwIn) : '',
      h('div', { class: 'muted small' }, mode === 'online'
        ? platform.steam ? '以 Steam 帳號登入，不需要密碼。第一次登入會用上面的名稱建立角色。' : '第一次登入會用這組名稱與密碼建立帳號。'
        : last ? `上次遊玩：${last.name}（Lv ${last.level}）。輸入同名即可繼續，輸入新名字會建立新角色。` : '單機模式：資料存在這台電腦上。'),
      mode === 'online' && platform.steam
        ? h('button', { class: 'btn big btn-primary', onclick: () => void goSteam() }, `以 Steam 登入（${platform.steam.personaName ?? ''}）`)
        : h('button', { class: 'btn big btn-primary', onclick: go }, mode === 'online' ? '連線進入' : '開始冒險'),
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

function startGame(conn: Connection, name: string, password: string | undefined, onError: (reason: string) => void, steamTicket?: string): void {
  const cs = new ClientState(conn);
  gameState = cs;
  let world: World | undefined;
  let hud: Hud | undefined;
  let started = false;
  let failed = false;

  const begin = () => {
    started = true;
    uiEl.replaceChildren();
    gameEl.replaceChildren();
    hud = new Hud(uiEl, cs, () => world!);
    try {
      world = createWorld();
    } catch (e) {
      console.error(e);
      uiEl.replaceChildren(h('div', { class: 'modal-overlay' }, h('div', { class: 'modal frame' },
        h('div', { html: '⚠ 無法啟動 3D 繪圖（WebGL）。<br>請更新顯示卡驅動程式，或在瀏覽器 / 系統設定中開啟硬體加速後再試一次。' }),
        h('div', { class: 'modal-actions' }, h('button', { class: 'btn btn-primary', onclick: () => location.reload() }, '重新整理')))));
      failed = true;
      conn.close();
      return;
    }
    hud.log(`歡迎來到餘燼王國，${cs.name}！按 F1 查看說明${cs.online ? '，按 Enter 聊天' : ''}。`, '#ffe680');
    bindInput(cs, world, hud);
    startLoop();
  };

  const createWorld = () =>
    new World(gameEl, cs, {
      floatText: (p, t, c, big) => {
        const s = world!.toScreen(p);
        if (s.visible) hud!.floatText(s.x, s.y, t, c, big);
      },
      playerMenu: (n, x, y) => hud!.playerMenu(n, x, y),
    });

  const startLoop = () => {
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
    (window as unknown as { game: unknown }).game = { cs, world, hud, conn, audio };
  };

  // 在收到 welcome 之前先暫存訊息（zone / self 會緊接著 welcome 送來）
  const pending: ServerMsg[] = [];
  const handle = (msg: ServerMsg) => {
    if (!world || !hud) {
      pending.push(msg);
      return;
    }
    switch (msg.t) {
      case 'skillUsed':
        cs.cooldowns.set(msg.skill, { until: performance.now() + msg.cooldownMs, total: Math.max(1, msg.cooldownMs) });
        break;
      case 'sfx':
        audio.play(msg.name);
        break;
      case 'achievement':
        audio.play('achievement');
        hud.achievement(msg.name, msg.desc);
        platform.unlockAchievement(msg.id);
        break;
      case 'zone':
        platform.setStatus(`${msg.zone === 'homestead' ? '在家園經營' : `在${ZONE_NAMES[msg.zone]}冒險`}`);
        if (cs.zone !== msg.zone || cs.zoneOwner !== msg.owner) audio.play('portal');
        audio.playMusic(msg.zone);
        cs.zone = msg.zone;
        cs.zoneOwner = msg.owner;
        if (msg.homestead) cs.setHome(msg.homestead);
        world.apply(msg);
        hud.closeZonePanels();
        hud.markDirty();
        break;
      case 'fx':
        fxSound(msg, world.distanceFromView(msg.x, msg.z));
        world.apply(msg);
        break;
      case 'snap':
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
        // 紅字 = 操作被拒絕
        if (msg.color === '#f99' || msg.color === '#f66') audio.play('error');
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
  conn.send({ t: 'login', name, password, steamTicket, version: PROTOCOL_VERSION });
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
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
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
    if (k === 'f1' || k === 'f8') e.preventDefault();
    if (k === 'f11') {
      e.preventDefault();
      platform.toggleFullscreen();
      return;
    }
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
