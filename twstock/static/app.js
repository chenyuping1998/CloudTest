/* 台股監控分析平台 前端 */
'use strict';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const C = { up: css('--up'), down: css('--down'), accent: css('--accent'), muted: css('--muted'), text: css('--text'), border: css('--border'), warn: css('--warn') };
const PALETTE = ['#4c9aff', '#f59e0b', '#a78bfa', '#ec4899', '#14b8a6', '#eab308', '#f97316', '#94a3b8'];
const MA_COLORS = { ma5: '#eab308', ma10: '#ec4899', ma20: '#4c9aff', ma60: '#a78bfa', ma120: '#14b8a6', ma240: '#f97316' };

const state = { config: null, code: '2330', years: 1, overlays: new Set(['ma5', 'ma20', 'ma60']), history: null, charts: {} };

// ---------------------------------------------------------------- 工具
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v, d = 2) => (v == null || Number.isNaN(v) ? '—' : Number(v).toLocaleString('zh-TW', { minimumFractionDigits: d, maximumFractionDigits: d }));
const int = (v) => num(v, 0);
const pct = (v, d = 2, mult = 100) => (v == null ? '—' : `${v * mult > 0 ? '+' : ''}${(v * mult).toFixed(d)}%`);
const cls = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : '');
const signed = (v, d = 2) => (v == null ? '—' : `${v > 0 ? '+' : ''}${num(v, d)}`);

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (typeof admin !== 'undefined' && admin.password) headers['X-Admin-Password'] = admin.password;
  const res = await fetch(path, { headers, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail ? (typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail)) : res.statusText);
  return data;
}

let toastTimer;
function toast(msg, error = false) {
  const t = $('#toast');
  t.textContent = msg; t.className = `toast${error ? ' error' : ''}`; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 4000);
}

async function busy(btn, fn) {
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = '處理中…';
  try { return await fn(); } catch (e) { toast(e.message, true); } finally { btn.disabled = false; btn.textContent = label; }
}

function setSource(src) {
  const b = $('#source-badge');
  const names = { demo: '⚠ 示範資料（非真實行情）', yahoo: '資料：Yahoo Finance', twse: '資料：證交所', tpex: '資料：櫃買中心', realtime: '資料：證交所即時', live: '資料：證交所' };
  b.textContent = names[src] || src; b.className = `badge${src === 'demo' ? ' demo' : ''}`;
}

// ---------------------------------------------------------------- 圖表
function makeChart(el, opts = {}) {
  el.innerHTML = '';
  return LightweightCharts.createChart(el, {
    autoSize: true,
    layout: { background: { color: 'transparent' }, textColor: C.muted, fontSize: 11, attributionLogo: false },
    grid: { vertLines: { color: 'rgba(128,145,165,.08)' }, horzLines: { color: 'rgba(128,145,165,.08)' } },
    rightPriceScale: { borderColor: C.border, minimumWidth: 70 },
    timeScale: { borderColor: C.border },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    localization: { locale: 'zh-TW' },
    ...opts,
  });
}

function syncCharts(charts) {
  let syncing = false;
  charts.forEach((c) => c.timeScale().subscribeVisibleLogicalRangeChange((range) => {
    if (syncing || !range) return;
    syncing = true;
    charts.forEach((o) => o !== c && o.timeScale().setVisibleLogicalRange(range));
    syncing = false;
  }));
}

const line = (dates, values) => dates.map((t, i) => (values[i] == null ? { time: t } : { time: t, value: values[i] }));

function disposeCharts(group) {
  (state.charts[group] || []).forEach((c) => c.remove());
  state.charts[group] = [];
}

// ---------------------------------------------------------------- 分頁
function showTab(name) {
  $$('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$('.tab').forEach((s) => s.classList.toggle('active', s.id === `tab-${name}`));
  store.set('tab', name);
  if (name === 'monitor') loadMonitor();
  if (name === 'analysis' && !state.history) loadAnalysis();
}

// ================================================================ 個股分析
async function loadAnalysis(code = state.code) {
  state.code = code;
  try {
    const h = await api(`/api/history/${encodeURIComponent(code)}?years=${Math.max(state.years, 1.5)}`);
    state.history = h;
    setSource(h.source);
    renderAnalysis();
    loadInstitutional(h.code);
  } catch (e) { toast(e.message, true); }
}

function renderAnalysis() {
  const h = state.history, s = h.summary;
  $('#quote-head').innerHTML = `
    <span class="name">${esc(h.name)} <span class="muted">${esc(h.code)}</span></span>
    <span class="price ${cls(s.change)}">${num(s.price)}</span>
    <span class="${cls(s.change)}">${signed(s.change)} (${pct(s.change_pct)})</span>
    <span class="kv">資料日期 <b>${s.date}</b></span>
    <span class="kv">成交量 <b>${int(s.volume / 1000)} 張</b></span>
    <span class="kv">52週高/低 <b>${num(s.high_52w)} / ${num(s.low_52w)}</b></span>`;

  // 顯示期間
  const start = new Date(); start.setDate(start.getDate() - Math.round(state.years * 365));
  const startStr = start.toISOString().slice(0, 10);
  let i0 = h.dates.findIndex((d) => d >= startStr); if (i0 < 0) i0 = 0;
  const cut = (arr) => arr.slice(i0);
  const dates = cut(h.dates), o = h.ohlcv, ind = h.indicators;

  disposeCharts('analysis');
  const main = makeChart($('#chart-main'));
  const candles = main.addCandlestickSeries({ upColor: C.up, downColor: C.down, borderUpColor: C.up, borderDownColor: C.down, wickUpColor: C.up, wickDownColor: C.down });
  candles.setData(dates.map((t, i) => ({ time: t, open: o.open[i0 + i], high: o.high[i0 + i], low: o.low[i0 + i], close: o.close[i0 + i] })));
  const overlaySeries = {};
  for (const k of Object.keys(MA_COLORS)) {
    if (!state.overlays.has(k)) continue;
    overlaySeries[k] = main.addLineSeries({ color: MA_COLORS[k], lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    overlaySeries[k].setData(line(dates, cut(ind[k])));
  }
  if (state.overlays.has('bb')) {
    for (const k of ['bb_upper', 'bb_middle', 'bb_lower']) {
      const sr = main.addLineSeries({ color: 'rgba(148,163,184,.7)', lineWidth: 1, lineStyle: k === 'bb_middle' ? 2 : 0, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
      sr.setData(line(dates, cut(ind[k])));
    }
  }

  const vol = makeChart($('#chart-vol'));
  const volS = vol.addHistogramSeries({ priceFormat: { type: 'volume' }, priceLineVisible: false });
  volS.setData(dates.map((t, i) => ({ time: t, value: (o.volume[i0 + i] || 0) / 1000, color: o.close[i0 + i] >= o.open[i0 + i] ? 'rgba(239,68,68,.6)' : 'rgba(34,197,94,.6)' })));
  vol.addLineSeries({ color: C.warn, lineWidth: 1, priceLineVisible: false, lastValueVisible: false }).setData(line(dates, cut(ind.vol_ma20).map((v) => (v == null ? null : v / 1000))));

  const kd = makeChart($('#chart-kd'));
  const kS = kd.addLineSeries({ color: '#eab308', lineWidth: 1, priceLineVisible: false });
  const dS = kd.addLineSeries({ color: '#4c9aff', lineWidth: 1, priceLineVisible: false });
  kS.setData(line(dates, cut(ind.k))); dS.setData(line(dates, cut(ind.d)));
  [80, 20].forEach((p) => kS.createPriceLine({ price: p, color: C.border, lineStyle: 2, axisLabelVisible: false }));

  const macd = makeChart($('#chart-macd'));
  const hist = macd.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false });
  hist.setData(dates.map((t, i) => { const v = ind.hist[i0 + i]; return v == null ? { time: t } : { time: t, value: v, color: v >= 0 ? 'rgba(239,68,68,.6)' : 'rgba(34,197,94,.6)' }; }));
  const difS = macd.addLineSeries({ color: '#eab308', lineWidth: 1, priceLineVisible: false });
  const sigS = macd.addLineSeries({ color: '#4c9aff', lineWidth: 1, priceLineVisible: false });
  difS.setData(line(dates, cut(ind.dif))); sigS.setData(line(dates, cut(ind.signal)));

  const rsi = makeChart($('#chart-rsi'));
  const rS = rsi.addLineSeries({ color: '#a78bfa', lineWidth: 1, priceLineVisible: false });
  rS.setData(line(dates, cut(ind.rsi)));
  [70, 30].forEach((p) => rS.createPriceLine({ price: p, color: C.border, lineStyle: 2, axisLabelVisible: false }));

  const charts = [main, vol, kd, macd, rsi];
  state.charts.analysis = charts;
  syncCharts(charts);
  main.timeScale().fitContent();

  // 十字線圖例
  const legend = (idx) => {
    const j = i0 + idx;
    const ma = Object.keys(overlaySeries).map((k) => `<span><i style="background:${MA_COLORS[k]}"></i>${k.toUpperCase()} ${num(ind[k][j])}</span>`).join('');
    const chg = j > 0 ? o.close[j] / o.close[j - 1] - 1 : 0;
    $('#legend-main').innerHTML = `<span>${h.dates[j]}</span><span>開 ${num(o.open[j])}</span><span>高 ${num(o.high[j])}</span><span>低 ${num(o.low[j])}</span><span class="${cls(chg)}">收 ${num(o.close[j])} (${pct(chg)})</span>${ma}`;
    $('#legend-kd').innerHTML = `<span><i style="background:#eab308"></i>K ${num(ind.k[j])}</span><span><i style="background:#4c9aff"></i>D ${num(ind.d[j])}</span>`;
    $('#legend-macd').innerHTML = `<span><i style="background:#eab308"></i>DIF ${num(ind.dif[j])}</span><span><i style="background:#4c9aff"></i>MACD ${num(ind.signal[j])}</span><span class="${cls(ind.hist[j])}">OSC ${num(ind.hist[j])}</span>`;
    $('#legend-rsi').innerHTML = `<span><i style="background:#a78bfa"></i>RSI ${num(ind.rsi[j])}</span>`;
  };
  legend(dates.length - 1);
  charts.forEach((c) => c.subscribeCrosshairMove((p) => {
    if (!p.time) return legend(dates.length - 1);
    const idx = dates.indexOf(p.time); if (idx >= 0) legend(idx);
  }));

  // 訊號與統計
  $('#score').innerHTML = `<div class="muted">多空分數 <b style="color:var(--text)">${s.score}</b> / 100（依下列訊號多空比例計算，僅供參考）</div><div class="score-bar"><span style="left:calc(${s.score}% - 2px)"></span></div>`;
  $('#signal-list').innerHTML = s.signals.map((g) => `<li><span>${esc(g.text)}</span><span class="tag ${g.type}">${{ bull: '偏多', bear: '偏空', neutral: '中性' }[g.type]}</span></li>`).join('');
  const r = s.returns;
  const stat = (l, v, c = '') => `<div><div class="l">${l}</div><div class="v ${c}">${v}</div></div>`;
  $('#stats').innerHTML = `<div class="stat-grid">${Object.entries(r).map(([k, v]) => stat({ '1W': '近一週', '1M': '近一月', '3M': '近三月', '6M': '近半年', YTD: '今年以來', '1Y': '近一年' }[k], pct(v), cls(v))).join('')}
    ${stat('年化波動率', pct(s.volatility, 1))}${stat('距 52 週高', pct(s.price / s.high_52w - 1), cls(s.price / s.high_52w - 1))}
    ${stat('MA20', num(s.indicators.ma20))}${stat('MA60', num(s.indicators.ma60))}${stat('ATR(14)', num(s.indicators.atr))}
    ${stat('RSI(14)', num(s.indicators.rsi, 1))}${stat('K / D', `${num(s.indicators.k, 1)} / ${num(s.indicators.d, 1)}`)}</div>`;
}

async function loadInstitutional(code) {
  const box = $('#chart-inst');
  try {
    const d = await api(`/api/institutional/${encodeURIComponent(code)}?days=20`);
    $('#inst-source').textContent = d.source === 'demo' ? '（示範資料）' : '';
    disposeCharts('inst');
    if (!d.rows.length) { box.innerHTML = '<p class="muted">查無法人資料</p>'; $('#inst-table').innerHTML = ''; return; }
    const ch = makeChart(box, { timeScale: { borderColor: C.border, barSpacing: 18 } });
    const series = [['foreign', '外資', '#4c9aff'], ['trust', '投信', '#f59e0b'], ['dealer', '自營商', '#a78bfa']];
    // 柱狀：每日三大法人合計；線：各法人區間累計
    ch.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false, priceFormat: { type: 'volume' } })
      .setData(d.rows.map((r) => ({ time: r.date, value: r.inst ?? 0, color: (r.inst ?? 0) >= 0 ? 'rgba(239,68,68,.5)' : 'rgba(34,197,94,.5)' })));
    series.forEach(([k, , color]) => {
      let acc = 0;
      ch.addLineSeries({ color, lineWidth: 2, priceLineVisible: false, priceFormat: { type: 'volume' } })
        .setData(d.rows.map((r) => ({ time: r.date, value: (acc += r[k] ?? 0) })));
    });
    ch.timeScale().fitContent();
    state.charts.inst = [ch];
    const rows = [...d.rows].reverse();
    const tot = (k) => d.rows.reduce((a, r) => a + (r[k] || 0), 0);
    $('#inst-table').innerHTML = `<thead><tr><th>日期</th><th>收盤</th>${series.map(([, l, c]) => `<th><i class="bar" style="width:10px;background:${c}"></i> ${l}</th>`).join('')}<th>合計</th></tr></thead>
      <tbody><tr><td><b>區間合計</b></td><td></td>${['foreign', 'trust', 'dealer', 'inst'].map((k) => `<td class="${cls(tot(k))}"><b>${signed(tot(k), 0)}</b></td>`).join('')}</tr>
      ${rows.map((r) => `<tr><td>${r.date}</td><td>${num(r.close)}</td>${['foreign', 'trust', 'dealer', 'inst'].map((k) => `<td class="${cls(r[k])}">${signed(r[k], 0)}</td>`).join('')}</tr>`).join('')}</tbody>`;
  } catch (e) { box.innerHTML = `<p class="muted">法人資料載入失敗：${esc(e.message)}</p>`; }
}

function initAnalysis() {
  const labels = { ma5: 'MA5', ma10: 'MA10', ma20: 'MA20', ma60: 'MA60', ma120: 'MA120', ma240: 'MA240', bb: '布林' };
  $('#overlay-checks').innerHTML = Object.entries(labels).map(([k, l]) =>
    `<label class="check"><input type="checkbox" value="${k}" ${state.overlays.has(k) ? 'checked' : ''}><span style="color:${MA_COLORS[k] || C.muted}">${l}</span></label>`).join('');
  $('#overlay-checks').addEventListener('change', (e) => {
    e.target.checked ? state.overlays.add(e.target.value) : state.overlays.delete(e.target.value);
    if (state.history) renderAnalysis();
  });
  $('#range-seg').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    $$('#range-seg button').forEach((x) => x.classList.toggle('active', x === b));
    const prev = state.years; state.years = +b.dataset.years;
    Math.max(state.years, 1.5) > Math.max(prev, 1.5) ? loadAnalysis() : renderAnalysis();
  });
  $('#to-watch').addEventListener('click', () => addToWatch(state.code));
  $('#to-backtest').addEventListener('click', () => { $('#bt-code').value = state.code; showTab('backtest'); });
}

// ================================================================ 監控
let monitorTimer = null;
const notified = new Set();

function sparkline(values) {
  if (!values?.length) return '';
  const w = 110, h = 28, min = Math.min(...values), max = Math.max(...values), span = max - min || 1;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * w},${h - ((v - min) / span) * (h - 4) - 2}`).join(' ');
  const color = values[values.length - 1] >= values[0] ? C.up : C.down;
  return `<svg class="spark" width="${w}" height="${h}"><polyline fill="none" stroke="${color}" stroke-width="1.5" points="${pts}"/></svg>`;
}

function isMarketOpen() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const m = now.getHours() * 60 + now.getMinutes();
  return now.getDay() >= 1 && now.getDay() <= 5 && m >= 9 * 60 && m <= 13 * 60 + 35;
}

// 自選股存在各訪客自己的瀏覽器（公開網站不共用）
const DEFAULT_WATCHLIST = ['2330', '2317', '2454', '0050', '2881', '2603'];
const store = {
  get(k, fallback, area = localStorage) { try { const v = area.getItem(k); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(k, v, area = localStorage) { try { v == null ? area.removeItem(k) : area.setItem(k, JSON.stringify(v)); } catch { /* 瀏覽器封鎖儲存時忽略 */ } },
};
const getWatchlist = () => store.get('watchlist', DEFAULT_WATCHLIST);
const admin = { password: store.get('adminPw', '', sessionStorage), ok: false };

async function loadMonitor() {
  try {
    const d = await api(`/api/quotes?codes=${encodeURIComponent(getWatchlist().join(','))}`);
    renderWatchlist(d.rows);
    $('#monitor-time').textContent = `更新於 ${new Date().toLocaleTimeString('zh-TW')}${isMarketOpen() ? '（盤中）' : '（非交易時段）'}`;
  } catch (e) { toast(e.message, true); }
  if (admin.ok) loadAlerts();
}

function renderWatchlist(rows) {
  const sources = new Set(rows.map((r) => r.source).filter(Boolean));
  if (sources.size) setSource(sources.has('demo') ? 'demo' : [...sources][0]);
  $('#watch-table tbody').innerHTML = rows.map((r) => r.error
    ? `<tr><td>${esc(r.code)}</td><td>${esc(r.name)}</td><td colspan="11" class="muted">${esc(r.error)}</td><td><button class="ghost small" data-del="${esc(r.code)}">移除</button></td></tr>`
    : `<tr class="clickable" data-code="${esc(r.code)}"><td>${esc(r.code)}</td><td>${esc(r.name)}</td><td>${sparkline(r.spark)}</td>
      <td class="${cls(r.change)}"><b>${num(r.price)}</b></td><td class="${cls(r.change)}">${signed(r.change)}</td><td class="${cls(r.change)}">${pct(r.change_pct, 2, 1)}</td>
      <td>${num(r.open)}</td><td>${num(r.high)}</td><td>${num(r.low)}</td><td>${int(r.volume)}</td>
      <td class="${r.rsi >= 70 ? 'up' : r.rsi <= 30 ? 'down' : ''}">${num(r.rsi, 1)}</td><td>${num(r.k, 0)} / ${num(r.d, 0)}</td>
      <td class="muted">${esc(r.time)}</td><td><button class="ghost small" data-del="${esc(r.code)}">移除</button></td></tr>`).join('')
    || '<tr><td colspan="14" class="muted">自選清單是空的，從上方加入股票代號</td></tr>';
}

// ---- 管理員警示（伺服器端，會推播到 Telegram）
function renderAdmin() {
  $('#alert-login').hidden = admin.ok;
  $('#alert-admin').hidden = !admin.ok;
  $('#triggered-card').hidden = !admin.ok;
  $('#admin-logout').hidden = !admin.ok || !state.config.admin_enabled;
  $('#admin-login').hidden = !state.config.admin_enabled;
  $('#admin-disabled').hidden = state.config.admin_enabled;
}

async function tryAdmin(password, quiet = false) {
  admin.password = password;
  try {
    await api('/api/admin/check');
    admin.ok = true;
    store.set('adminPw', password || null, sessionStorage);
    if (!quiet) toast('已登入管理員');
  } catch (e) {
    admin.ok = false; admin.password = '';
    store.set('adminPw', null, sessionStorage);
    if (!quiet) toast(e.message, true);
  }
  renderAdmin();
  if (admin.ok) loadAlerts();
}

async function loadAlerts() {
  try {
    const d = await api('/api/alerts');
    const types = state.config.alert_types;
    $('#alert-list').innerHTML = d.alerts.length ? d.alerts.map((a) => `<li><span><b>${esc(a.code)}</b> ${esc(types[a.type]?.label || a.type)} ${a.value ?? ''}</span><button class="ghost small" data-alert="${a.id}">刪除</button></li>`).join('') : '<li class="muted">尚未設定警示</li>';
    $('#triggered-list').innerHTML = d.triggered.length ? d.triggered.map((t) => `<li><span><b>${esc(t.code)} ${esc(t.name)}</b>　${esc(t.message)}</span><span class="tag fire">觸發</span></li>`).join('') : '<li class="muted">目前沒有觸發的警示</li>';
    const today = new Date().toDateString();
    d.triggered.forEach((t) => {
      const key = `${t.id}-${today}`;
      if (notified.has(key)) return;
      notified.add(key);
      if (window.Notification && Notification.permission === 'granted') new Notification(`${t.code} ${t.name}`, { body: t.message });
    });
  } catch (e) {
    if (/密碼|管理員/.test(e.message)) { admin.ok = false; renderAdmin(); }
    toast(e.message, true);
  }
}

function saveWatchlist(codes) {
  store.set('watchlist', [...new Set(codes)]);
  loadMonitor();
}

function addToWatch(code) {
  code = String(code || '').trim().toUpperCase();
  if (!code) return;
  const codes = getWatchlist();
  if (codes.includes(code)) return toast(`${code} 已在自選清單中`);
  if (codes.length >= 30) return toast('自選清單最多 30 檔', true);
  saveWatchlist([...codes, code]);
  toast(`已將 ${code} 加入自選`);
}

function initMonitor() {
  const sel = $('#alert-type');
  sel.innerHTML = Object.entries(state.config.alert_types).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('');
  const syncValue = () => { $('#alert-value').disabled = !state.config.alert_types[sel.value].needs_value; };
  sel.addEventListener('change', syncValue); syncValue();

  $('#watch-add').addEventListener('submit', (e) => { e.preventDefault(); addToWatch($('#watch-code').value); $('#watch-code').value = ''; });
  $('#watch-table').addEventListener('click', (e) => {
    const del = e.target.closest('[data-del]');
    if (del) { e.stopPropagation(); return saveWatchlist(getWatchlist().filter((c) => c !== del.dataset.del)); }
    const tr = e.target.closest('tr[data-code]');
    if (tr) { showTab('analysis'); loadAnalysis(tr.dataset.code); }
  });
  $('#admin-login').addEventListener('submit', (e) => { e.preventDefault(); tryAdmin($('#admin-pw').value); $('#admin-pw').value = ''; });
  $('#admin-logout').addEventListener('click', () => { admin.ok = false; admin.password = ''; store.set('adminPw', null, sessionStorage); renderAdmin(); });
  $('#alert-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = $('#alert-value').value;
    try {
      await api('/api/alerts', { method: 'POST', body: { code: $('#alert-code').value.trim(), type: sel.value, value: v === '' ? null : +v } });
      $('#alert-value').value = ''; loadAlerts();
    } catch (err) { toast(err.message, true); }
  });
  $('#alert-list').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-alert]'); if (!b) return;
    try { await api(`/api/alerts/${b.dataset.alert}`, { method: 'DELETE' }); loadAlerts(); } catch (err) { toast(err.message, true); }
  });
  $('#refresh-now').addEventListener('click', loadMonitor);
  $('#notify-btn').addEventListener('click', async () => {
    if (!window.Notification) return toast('此瀏覽器不支援桌面通知', true);
    toast((await Notification.requestPermission()) === 'granted' ? '已開啟桌面通知' : '未取得通知權限');
  });
  monitorTimer = setInterval(() => {
    if ($('#auto-refresh').checked && isMarketOpen() && $('#tab-monitor').classList.contains('active')) loadMonitor();
  }, 60_000);
  renderAdmin();
  tryAdmin(admin.password, true); // 已存的密碼，或本機未設密碼時自動取得管理權限
}

// ================================================================ 回測
function renderParamInputs() {
  const st = state.config.strategies[$('#bt-strategy').value];
  $('#bt-desc').textContent = st.desc;
  $('#bt-params').innerHTML = Object.entries(st.params).map(([k, p]) =>
    `<label>${p.label}<input data-param="${k}" type="number" value="${p.default}" min="${p.min}" max="${p.max}" step="${p.step || 1}"></label>`).join('');
  $('#opt-grid').innerHTML = Object.entries(st.params).map(([k, p]) => {
    const step = p.step || Math.max(1, Math.round((p.max - p.min) / 20));
    const lo = p.step ? p.default - 4 * p.step : Math.max(p.min, Math.round(p.default / 2));
    const hi = p.step ? p.default + 4 * p.step : Math.min(p.max, p.default * 3);
    return `<label>${p.label}：起 / 迄 / 間距<span class="inline"><input data-opt="${k}" data-f="from" type="number" step="any" value="${+lo.toFixed(2)}"><input data-opt="${k}" data-f="to" type="number" step="any" value="${+hi.toFixed(2)}"><input data-opt="${k}" data-f="step" type="number" step="any" value="${p.step ? p.step * 2 : Math.max(1, Math.round((hi - lo) / 5))}"></span></label>`;
  }).join('') || '<p class="muted">此策略沒有可調整的參數</p>';
}

function btBody() {
  const params = {};
  $$('#bt-params [data-param]').forEach((i) => (params[i.dataset.param] = +i.value));
  const sl = $('#bt-sl').value, tp = $('#bt-tp').value;
  return {
    code: $('#bt-code').value.trim(), strategy: $('#bt-strategy').value, params, years: +$('#bt-years').value,
    initial_capital: +$('#bt-capital').value, fee_discount: +$('#bt-discount').value, lot_size: +$('#bt-lot').value,
    stop_loss: sl ? sl / 100 : null, take_profit: tp ? tp / 100 : null,
  };
}

async function runBacktest() {
  const r = await api('/api/backtest', { method: 'POST', body: btBody() });
  setSource(r.source);
  $('#bt-result').hidden = false;
  const m = r.metrics, st = state.config.strategies[$('#bt-strategy').value];
  $('#bt-title').innerHTML = `<span class="name">${esc(r.name)} <span class="muted">${esc(r.code)}</span></span><span class="kv">策略 <b>${esc(st.name)}</b></span><span class="kv">期間 <b>${r.dates[0]} ~ ${r.dates[r.dates.length - 1]}</b></span>`;
  const card = (l, v, c = '', s = '') => `<div class="metric"><div class="l">${l}</div><div class="v ${c}">${v}</div><div class="s">${s}</div></div>`;
  $('#bt-metrics').innerHTML = [
    card('總報酬', pct(m.total_return), cls(m.total_return), `買進持有 ${pct(m.benchmark_return)}`),
    card('年化報酬 CAGR', pct(m.cagr), cls(m.cagr), `買進持有 ${pct(m.benchmark_cagr)}`),
    card('最大回撤 MDD', pct(m.max_drawdown), 'down', `買進持有 ${pct(m.benchmark_mdd)}`),
    card('夏普值', num(m.sharpe), '', `Sortino ${num(m.sortino)}`),
    card('交易次數', m.trades, '', `平均持有 ${num(m.avg_bars, 0)} 日`),
    card('勝率', pct(m.win_rate, 1), '', `獲利因子 ${m.profit_factor == null ? '∞' : num(m.profit_factor)}`),
    card('平均每筆報酬', pct(m.avg_trade), cls(m.avg_trade)),
    card('期末資產', int(m.final_equity), cls(m.total_return), `持倉比例 ${pct(m.exposure, 0)}`),
  ].join('');

  disposeCharts('bt');
  const eq = makeChart($('#bt-equity'));
  eq.addAreaSeries({ lineColor: C.accent, topColor: 'rgba(76,154,255,.25)', bottomColor: 'rgba(76,154,255,0)', lineWidth: 2, priceLineVisible: false }).setData(line(r.dates, r.equity));
  eq.addLineSeries({ color: C.muted, lineWidth: 1, priceLineVisible: false }).setData(line(r.dates, r.benchmark));
  const dd = makeChart($('#bt-dd'));
  dd.addAreaSeries({ lineColor: C.down, topColor: 'rgba(34,197,94,0)', bottomColor: 'rgba(34,197,94,.35)', lineWidth: 1, priceFormat: { type: 'percent' }, priceLineVisible: false })
    .setData(line(r.dates, r.drawdown.map((v) => (v == null ? null : v * 100))));
  const pr = makeChart($('#bt-price'));
  const cs = pr.addCandlestickSeries({ upColor: C.up, downColor: C.down, borderUpColor: C.up, borderDownColor: C.down, wickUpColor: C.up, wickDownColor: C.down });
  cs.setData(r.dates.map((t, i) => ({ time: t, open: r.ohlcv.open[i], high: r.ohlcv.high[i], low: r.ohlcv.low[i], close: r.ohlcv.close[i] })));
  const markers = [];
  r.trades.forEach((t) => {
    markers.push({ time: t.entry_date, position: 'belowBar', color: C.up, shape: 'arrowUp', text: `買 ${num(t.entry_price)}` });
    if (t.exit_date) markers.push({ time: t.exit_date, position: 'aboveBar', color: C.down, shape: 'arrowDown', text: `${t.reason === '訊號出場' ? '賣' : t.reason} ${num(t.exit_price)}` });
  });
  cs.setMarkers(markers.sort((a, b) => (a.time < b.time ? -1 : 1)));
  state.charts.bt = [eq, dd, pr];
  syncCharts(state.charts.bt);
  eq.timeScale().fitContent();

  $('#bt-trades').innerHTML = `<thead><tr><th>#</th><th>進場日</th><th>進場價</th><th>出場日</th><th>出場價</th><th>股數</th><th>持有天數</th><th>損益(含費用)</th><th>報酬率</th><th>出場原因</th></tr></thead>
    <tbody>${r.trades.map((t, i) => `<tr><td>${i + 1}</td><td>${t.entry_date}</td><td>${num(t.entry_price)}</td><td>${t.exit_date || '—'}</td><td>${num(t.exit_price)}</td><td>${int(t.shares)}</td><td>${t.bars}</td>
      <td class="${cls(t.pnl)}">${signed(t.pnl, 0)}</td><td class="${cls(t.return_pct)}">${pct(t.return_pct)}</td><td>${esc(t.reason)}</td></tr>`).join('') || '<tr><td colspan="10" class="muted">期間內無交易</td></tr>'}</tbody>`;
}

async function runOptimize() {
  const grid = {};
  const keys = [...new Set($$('#opt-grid [data-opt]').map((i) => i.dataset.opt))];
  for (const k of keys) {
    const g = (f) => +$(`#opt-grid [data-opt="${k}"][data-f="${f}"]`).value;
    const [from, to, step] = [g('from'), g('to'), g('step')];
    if (!(step > 0) || to < from) throw new Error('最佳化範圍設定錯誤');
    const vals = [];
    for (let v = from; v <= to + 1e-9 && vals.length < 50; v += step) vals.push(+v.toFixed(4));
    grid[k] = vals;
  }
  if (!keys.length) throw new Error('此策略沒有參數可以最佳化');
  const body = { ...btBody(), grid, sort_by: $('#opt-sort').value };
  const r = await api('/api/optimize', { method: 'POST', body });
  const st = state.config.strategies[body.strategy];
  $('#opt-table').innerHTML = `<thead><tr><th>#</th><th>參數</th><th>總報酬</th><th>年化</th><th>MDD</th><th>夏普</th><th>勝率</th><th>交易數</th><th></th></tr></thead>
    <tbody>${r.results.slice(0, 30).map((x, i) => `<tr><td>${i + 1}</td><td>${Object.entries(x.params).map(([k, v]) => `${st.params[k].label} ${v}`).join('、')}</td>
      <td class="${cls(x.total_return)}">${pct(x.total_return)}</td><td class="${cls(x.cagr)}">${pct(x.cagr)}</td><td>${pct(x.max_drawdown)}</td><td>${num(x.sharpe)}</td><td>${pct(x.win_rate, 0)}</td><td>${x.trades}</td>
      <td><button class="ghost small" data-apply='${esc(JSON.stringify(x.params))}'>套用</button></td></tr>`).join('')}</tbody>`;
}

function initBacktest() {
  const sel = $('#bt-strategy');
  sel.innerHTML = Object.entries(state.config.strategies).map(([k, v]) => `<option value="${k}">${v.name}</option>`).join('');
  sel.addEventListener('change', renderParamInputs);
  renderParamInputs();
  $('#bt-form').addEventListener('submit', (e) => { e.preventDefault(); busy($('#bt-form button:not([type=button])'), runBacktest); });
  $('#opt-run').addEventListener('click', (e) => busy(e.target, runOptimize));
  $('#opt-table').addEventListener('click', (e) => {
    const b = e.target.closest('[data-apply]'); if (!b) return;
    Object.entries(JSON.parse(b.dataset.apply)).forEach(([k, v]) => { const i = $(`#bt-params [data-param="${k}"]`); if (i) i.value = v; });
    busy(b, runBacktest); window.scrollTo({ top: 0, behavior: 'smooth' });
  });
}

// ================================================================ 條件選股
const SC_OPS = ['>', '>=', '<', '<=', 'between'];
const SC_OP_LABEL = { '>': '>', '>=': '≥', '<': '<', '<=': '≤', between: '介於' };
const PRESETS = [
  { name: '投信近10日買超前10', days: 10, filters: [{ field: 'trust_net', op: '>', value: 0 }], sort: 'trust_net' },
  { name: '外資近5日買超前10', days: 5, filters: [{ field: 'foreign_net', op: '>', value: 0 }], sort: 'foreign_net' },
  { name: '投信連買3日以上', days: 10, filters: [{ field: 'trust_streak', op: '>=', value: 3 }], sort: 'trust_streak' },
  { name: '外資投信同步買超', days: 10, filters: [{ field: 'trust_net', op: '>', value: 0 }, { field: 'foreign_net', op: '>', value: 0 }], sort: 'inst_net' },
  { name: '投信認養（買超佔量>5%）', days: 20, filters: [{ field: 'trust_ratio', op: '>', value: 5 }, { field: 'volume_avg', op: '>', value: 500 }], sort: 'trust_ratio' },
  { name: '法人買超＋站上月線', days: 10, filters: [{ field: 'inst_net', op: '>', value: 0 }], technical: ['above_ma20'], sort: 'inst_net' },
  { name: '量增價漲', days: 5, filters: [{ field: 'volume_ratio', op: '>', value: 2 }, { field: 'day_change_pct', op: '>', value: 3 }], sort: 'volume_ratio' },
];
const DEFAULT_VALUES = { trust_net: 0, foreign_net: 0, dealer_net: 0, inst_net: 0, trust_days: 5, foreign_days: 5, trust_streak: 3, foreign_streak: 3, dealer_streak: 3, trust_ratio: 1, foreign_ratio: 1, close: 10, day_change_pct: 0, change_pct: 0, volume_avg: 1000, value_avg: 1, volume_ratio: 1.5 };

function initScreener() {
  const F = state.config.screener_fields;
  const groups = {};
  Object.entries(F).forEach(([k, f]) => (groups[f.group] ||= []).push([k, f]));
  $('#sc-fields').innerHTML = Object.entries(groups).map(([g, items]) => `<div class="fgroup"><div class="fgroup-title">${g}面（N = 統計天數）</div>
    ${items.map(([k, f]) => `<div class="frow off" data-field="${k}">
      <label class="check"><input type="checkbox" data-on> ${f.label}</label>
      <select data-op>${SC_OPS.map((o) => `<option value="${o}">${SC_OP_LABEL[o]}</option>`).join('')}</select>
      <input data-v type="number" step="any" value="${DEFAULT_VALUES[k] ?? 0}"><input data-v2 class="between" type="number" step="any" value="${(DEFAULT_VALUES[k] ?? 0) * 2 || 100}">
    </div>`).join('')}</div>`).join('');
  $('#sc-fields').addEventListener('change', (e) => {
    const row = e.target.closest('.frow'); if (!row) return;
    row.classList.toggle('off', !$('[data-on]', row).checked);
    row.classList.toggle('is-between', $('[data-op]', row).value === 'between');
    if (e.target.matches('[data-on]') && e.target.checked) $('#sc-sort').value = row.dataset.field;
  });
  $('#sc-fields').addEventListener('input', (e) => {
    const row = e.target.closest('.frow');
    if (row && !e.target.matches('[data-on]')) { $('[data-on]', row).checked = true; row.classList.remove('off'); }
  });
  $('#sc-tech').innerHTML = Object.entries(state.config.screener_technical).map(([k, t]) => `<label class="check"><input type="checkbox" value="${k}"> ${t.label}</label>`).join('');
  $('#sc-sort').innerHTML = Object.entries(F).map(([k, f]) => `<option value="${k}">${f.label}</option>`).join('');
  $('#presets').innerHTML = PRESETS.map((p, i) => `<button data-preset="${i}">${p.name}</button>`).join('');
  $('#presets').addEventListener('click', (e) => {
    const b = e.target.closest('[data-preset]'); if (!b) return;
    applyPreset(PRESETS[+b.dataset.preset]);
    busy($('#sc-run'), runScreen);
  });
  $('#sc-run').addEventListener('click', (e) => busy(e.target, runScreen));
  $('#sc-table').addEventListener('click', (e) => {
    const w = e.target.closest('[data-watch]'); if (w) { e.stopPropagation(); return addToWatch(w.dataset.watch); }
    const th = e.target.closest('th[data-sort]');
    if (th) { $('#sc-order').value = $('#sc-sort').value === th.dataset.sort && $('#sc-order').value === 'desc' ? 'asc' : 'desc'; $('#sc-sort').value = th.dataset.sort; return busy($('#sc-run'), runScreen); }
    const tr = e.target.closest('tr[data-code]'); if (tr) { showTab('analysis'); loadAnalysis(tr.dataset.code); }
  });
}

function applyPreset(p) {
  $('#sc-days').value = p.days;
  $$('#sc-fields .frow').forEach((row) => {
    const f = p.filters.find((x) => x.field === row.dataset.field);
    $('[data-on]', row).checked = !!f;
    row.classList.toggle('off', !f);
    if (f) { $('[data-op]', row).value = f.op; $('[data-v]', row).value = f.value; }
    row.classList.toggle('is-between', $('[data-op]', row).value === 'between');
  });
  $$('#sc-tech input').forEach((i) => (i.checked = (p.technical || []).includes(i.value)));
  $('#sc-sort').value = p.sort; $('#sc-order').value = 'desc';
}

async function runScreen() {
  const filters = $$('#sc-fields .frow').filter((r) => $('[data-on]', r).checked).map((r) => ({
    field: r.dataset.field, op: $('[data-op]', r).value, value: +$('[data-v]', r).value, value2: +$('[data-v2]', r).value,
  }));
  const body = {
    market: $('#sc-market').value, days: +$('#sc-days').value, filters,
    technical: $$('#sc-tech input:checked').map((i) => i.value),
    sort: $('#sc-sort').value, order: $('#sc-order').value, limit: +$('#sc-limit').value, include_etf: $('#sc-etf').checked,
  };
  $('#sc-summary').textContent = '篩選中…（首次查詢需下載每日資料，可能需要數十秒）';
  const r = await api('/api/screen', { method: 'POST', body });
  if (r.source === 'demo') setSource('demo');
  const F = state.config.screener_fields;
  const condText = [...r.filters.map((f) => `${F[f.field].label} ${SC_OP_LABEL[f.op]} ${f.value}${f.op === 'between' ? ` ~ ${f.value2}` : ''}`),
    ...r.technical.map((t) => state.config.screener_technical[t].label)].join('、') || '無';
  $('#sc-summary').innerHTML = `統計區間 <b>${r.dates[0]} ~ ${r.dates[r.dates.length - 1]}</b>（${r.days} 個交易日）｜全市場 ${r.universe} 檔，符合數值條件 ${r.matched} 檔${r.technical.length ? `，技術面檢查 ${r.technical_scanned} 檔` : ''}，顯示前 <b>${r.rows.length}</b> 檔<br>條件：${esc(condText)}${r.source === 'demo' ? '　<span class="tag fire">示範資料</span>' : ''}`;

  const cols = ['close', 'day_change_pct', 'change_pct', 'foreign_net', 'trust_net', 'dealer_net', 'inst_net', 'trust_streak', 'foreign_streak', 'trust_ratio', 'volume_avg'];
  if (!cols.includes(r.sort)) cols.push(r.sort);
  const short = { close: '收盤', day_change_pct: '當日%', change_pct: `${r.days}日%`, foreign_net: '外資(張)', trust_net: '投信(張)', dealer_net: '自營(張)', inst_net: '三大法人(張)', trust_streak: '投信連買', foreign_streak: '外資連買', trust_ratio: '投信/量%', volume_avg: '均量(張)' };
  const fmt = (k, v) => {
    if (k.endsWith('_pct')) return `<span class="${cls(v)}">${v == null ? '—' : `${v > 0 ? '+' : ''}${num(v)}%`}</span>`;
    if (k.endsWith('_net')) return `<span class="${cls(v)}">${signed(v, 0)}</span>`;
    if (k.endsWith('_streak') || k.endsWith('_days')) return `<span class="${cls(v)}">${v ?? '—'}</span>`;
    if (k === 'volume_avg') return int(v);
    return num(v);
  };
  $('#sc-table').innerHTML = `<thead><tr><th>代號</th><th>名稱</th>${cols.map((k) => `<th class="sortable ${k === r.sort ? 'sorted' : ''}" data-sort="${k}" title="${F[k].label}">${short[k] || F[k].label}${k === r.sort ? (r.order === 'desc' ? ' ▼' : ' ▲') : ''}</th>`).join('')}<th></th></tr></thead>
    <tbody>${r.rows.map((x) => `<tr class="clickable" data-code="${esc(x.code)}"><td>${esc(x.code)}</td><td>${esc(x.name)}</td>${cols.map((k) => `<td>${fmt(k, x[k])}</td>`).join('')}
      <td><button class="ghost small" data-watch="${esc(x.code)}">＋自選</button></td></tr>`).join('') || `<tr><td colspan="${cols.length + 3}" class="muted">沒有符合條件的股票</td></tr>`}</tbody>`;
}

// ================================================================ 走勢比較
async function runCompare() {
  const codes = $('#cmp-codes').value;
  const r = await api(`/api/compare?codes=${encodeURIComponent(codes)}&years=${$('#cmp-years').value}`);
  disposeCharts('cmp');
  const ch = makeChart($('#chart-cmp'));
  r.forEach((s, i) => ch.addLineSeries({ color: PALETTE[i % PALETTE.length], lineWidth: 2, priceLineVisible: false }).setData(line(s.dates, s.normalized)));
  ch.timeScale().fitContent();
  state.charts.cmp = [ch];
  if (r.some((s) => s.source === 'demo')) setSource('demo');
  $('#cmp-legend').innerHTML = r.map((s, i) => `<span><i style="background:${PALETTE[i % PALETTE.length]}"></i>${esc(s.code)} ${esc(s.name)}</span>`).join('');
  $('#cmp-table').innerHTML = `<thead><tr><th>代號</th><th>名稱</th><th>期間報酬</th><th>最高</th><th>最低</th></tr></thead><tbody>${r.map((s) => {
    const v = s.normalized.filter((x) => x != null); const ret = v[v.length - 1] / 100 - 1;
    return `<tr><td>${esc(s.code)}</td><td>${esc(s.name)}</td><td class="${cls(ret)}">${pct(ret)}</td><td>${num(Math.max(...v))}</td><td>${num(Math.min(...v))}</td></tr>`;
  }).join('')}</tbody>`;
}

// ================================================================ 初始化
async function init() {
  state.config = await api('/api/config');
  $('#stock-list').innerHTML = state.config.stocks.map((s) => `<option value="${esc(s.code)}">${esc(s.name)}</option>`).join('');
  if (state.config.source === 'demo') setSource('demo');
  $$('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
  $('#search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = $('#search-input').value.trim(); if (!code) return;
    showTab('analysis'); loadAnalysis(code);
  });
  $('#cmp-form').addEventListener('submit', (e) => { e.preventDefault(); busy($('#cmp-form button'), runCompare); });
  initAnalysis(); initMonitor(); initBacktest(); initScreener();
  const tab = new URLSearchParams(location.search).get('tab') || store.get('tab', null) || 'monitor';
  showTab(tab);
  if (tab === 'compare') runCompare();
}

init().catch((e) => toast(`初始化失敗：${e.message}`, true));
