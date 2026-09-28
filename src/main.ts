import './style.css';
import * as THREE from 'three';
import { getDef } from './core/items';
import { ITEM_DB } from './data';
import { Hud } from './game/hud';
import { MarketSim } from './game/marketSim';
import { GameState } from './game/state';
import { h } from './game/ui';
import { World } from './game/world';

const gameEl = document.getElementById('game')!;
const uiEl = document.getElementById('ui')!;

function titleScreen(): void {
  const existing = GameState.load();
  const nameIn = h('input', { class: 'input', placeholder: '輸入角色名稱', maxlength: 12, value: '冒險者' });
  const start = (state: GameState) => {
    screen.remove();
    startGame(state);
  };
  const screen = h('div', { class: 'title-screen' },
    h('div', { class: 'title-box' },
      h('h1', {}, '餘燼王國'),
      h('div', { class: 'subtitle' }, 'Realm of Embers — 2.5D 經營 RPG 原型'),
      existing ? h('button', { class: 'btn btn-primary big', onclick: () => start(existing) }, `繼續遊戲（${existing.player.name} Lv ${existing.player.progression.baseLevel}）`) : undefined,
      h('div', { class: 'new-game' }, nameIn,
        h('button', { class: 'btn big', onclick: () => {
          const name = nameIn.value.trim() || '冒險者';
          if (existing) GameState.wipe();
          start(GameState.newGame(name));
        } }, existing ? '開新遊戲（覆蓋存檔）' : '開始冒險')),
      h('div', { class: 'muted small' }, '左鍵移動 / 攻擊 · 右鍵拖曳旋轉視角 · 滾輪縮放 · F1 說明'),
    ),
  );
  uiEl.appendChild(screen);
}

function startGame(state: GameState): void {
  let world!: World;
  const hud = new Hud(uiEl, state, () => world);
  world = new World(gameEl, state, {
    log: (m, c) => hud.log(m, c),
    announce: (m, c) => hud.announce(m, c),
    floatText: (p, t, c, big) => {
      const s = world.toScreen(p);
      if (s.visible) hud.floatText(s.x, s.y, t, c, big);
    },
    openStation: (id) => hud.openStation(id),
    openNpc: (id) => hud.openNpc(id),
    zoneChanged: () => hud.closeZonePanels(),
    changed: () => hud.markDirty(),
  });
  const sim = new MarketSim(state);
  hud.log(`歡迎來到餘燼王國，${state.player.name}！按 F1 查看說明。`, '#ffe680');

  // ---- 輸入 ----
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
    if (p?.type === 'item') {
      const it = p.ref.item;
      hud.showTooltip(e.clientX, e.clientY, hud.itemTooltip(getDef(ITEM_DB, it.defId), it));
    } else hud.showTooltip(0, 0, undefined);
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
    if (k === 'f1') e.preventDefault();
    if (k === 'z') world.pickupNearest();
    else if (k === ' ') {
      e.preventDefault();
      world.attackNearest();
    } else if (k === 'q') world.rotateCamera(0.3);
    else if (k === 'e') world.rotateCamera(-0.3);
    else hud.key(k);
  });

  // ---- 主迴圈 ----
  const clock = new THREE.Clock();
  let saveAt = performance.now() + 30_000;
  const loop = () => {
    const dt = Math.min(clock.getDelta(), 0.1);
    world.update(dt);
    world.render();
    hud.frame();
    sim.tick(Date.now(), (msg) => {
      hud.announce(msg, '#ffd24a');
      hud.markDirty();
    });
    if (performance.now() > saveAt) {
      saveAt = performance.now() + 30_000;
      state.save();
    }
    requestAnimationFrame(loop);
  };
  window.addEventListener('beforeunload', () => state.save());
  loop();
  // 方便除錯 / 自動化測試
  (window as unknown as { game: unknown }).game = { state, world, hud };
}

titleScreen();
