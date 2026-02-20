'use strict';

// ── DOM refs ──────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const statusDot     = $('status-dot');
const clock         = $('clock');
const genKw         = $('gen-kw');
const solarW        = $('solar-w');
const enefarmW      = $('enefarm-w');
const enefarmRow    = $('enefarm-row');
const useKw         = $('use-kw');
const flowArrow     = $('flow-arrow');
const flowGridLabel = $('flow-grid-label');
const topConsumers  = $('top-consumers');
const totalsDate    = $('totals-date');
const totalSolar    = $('total-solar');
const totalUse      = $('total-use');
const totalBuy      = $('total-buy');
const totalSell     = $('total-sell');
const circuitsList  = $('circuits-list');
const circuitsBtn   = $('circuits-btn');

// ── Clock ─────────────────────────────────────────────────────────────────────
function updateClock() {
  clock.textContent = new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
}
updateClock();
setInterval(updateClock, 10_000);

// ── Flash helper (subtle highlight when a value updates) ─────────────────────
function flash(el) {
  el.classList.remove('flash');
  // force reflow so re-adding the class triggers the animation
  void el.offsetWidth;
  el.classList.add('flash');
}

// ── Realtime render ───────────────────────────────────────────────────────────
let lastGen = null, lastUse = null;

function renderRealtime(d) {
  const genStr = d.gen_kw.toFixed(1);
  const useStr = d.use_kw.toFixed(1);

  if (genStr !== lastGen) { genKw.textContent = genStr; flash(genKw); lastGen = genStr; }
  if (useStr !== lastUse) { useKw.textContent = useStr; flash(useKw); lastUse = useStr; }

  solarW.textContent = `${d.solar_w}W`;

  if (d.fc_connected) {
    enefarmRow.style.display = '';
    enefarmW.textContent = `${d.enefarm_w}W`;
  } else {
    enefarmRow.style.display = 'none';
  }

  const netW = Math.abs(Math.round((d.gen_kw - d.use_kw) * 1000));
  if (d.selling) {
    flowArrow.className       = 'flow-arrow sell';
    flowArrow.textContent     = '→';
    flowGridLabel.className   = 'flow-grid-label sell-color';
    flowGridLabel.textContent = `↑ ${netW}W 売電`;
  } else {
    flowArrow.className       = 'flow-arrow buy';
    flowArrow.textContent     = '→';
    flowGridLabel.className   = 'flow-grid-label buy-color';
    flowGridLabel.textContent = `↓ ${netW}W 買電`;
  }

  if (d.top && d.top.length > 0) {
    topConsumers.innerHTML = d.top.map(c =>
      `<div class="top-item">
         <span class="top-name">${escHtml(c.name)}</span>
         <span class="top-watts">${c.watts}W</span>
       </div>`
    ).join('');
  } else {
    topConsumers.innerHTML = '<div class="skeleton">データなし</div>';
  }
}

// ── Totals render ─────────────────────────────────────────────────────────────
function renderTotals(d) {
  const fmt = v => v != null ? v.toFixed(2) : '—';
  totalSolar.textContent = fmt(d.solar);
  totalUse.textContent   = fmt(d.consumption);
  totalBuy.textContent   = fmt(d.purchase);
  totalSell.textContent  = fmt(d.sold);
  totalsDate.textContent = new Date().toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' });
}

// ── Circuits render ───────────────────────────────────────────────────────────
function renderCircuits(data) {
  if (!data || data.length === 0) {
    circuitsList.innerHTML = '<div class="circuits-msg">回路データなし</div>';
    return;
  }
  const sorted = [...data].sort((a, b) => (b.kwh ?? -1) - (a.kwh ?? -1));
  const maxKwh = sorted[0]?.kwh ?? 1;
  circuitsList.innerHTML = sorted.map(c => {
    const pct   = maxKwh > 0 ? Math.round((c.kwh ?? 0) / maxKwh * 100) : 0;
    const kwhTx = c.kwh != null ? c.kwh.toFixed(3) + ' kWh' : '—';
    return `<div class="circuit-item">
        <span class="circuit-name">${escHtml(c.name)}</span>
        <span class="circuit-kwh">${kwhTx}</span>
        <div class="circuit-bar-wrap"><div class="circuit-bar" style="width:${pct}%"></div></div>
      </div>`;
  }).join('');
  circuitsBtn.textContent = '更新';
  circuitsBtn.disabled    = false;
}

// ── Utils ─────────────────────────────────────────────────────────────────────
function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── REST fetch (used for initial load and WS offline fallback) ────────────────
async function fetchRealtime() {
  const r = await fetch('/api/realtime');
  if (r.ok) renderRealtime(await r.json());
}
async function fetchTotals() {
  const r = await fetch('/api/totals');
  if (r.ok) renderTotals(await r.json());
}
async function initialFetch() {
  try { await Promise.all([fetchRealtime(), fetchTotals()]); } catch { /* offline */ }
}

// ── REST polling fallback (active when WebSocket is offline) ──────────────────
let pollTimer = null;
function startPoll() {
  if (pollTimer) return;
  pollTimer = setInterval(() => fetchRealtime().catch(() => {}), 5_000);
}
function stopPoll() {
  clearInterval(pollTimer);
  pollTimer = null;
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
let ws             = null;
let reconnectDelay = 1_000;
let reconnectTimer = null;

function connect() {
  clearTimeout(reconnectTimer);
  if (ws && ws.readyState <= WebSocket.OPEN) return; // already connecting or open

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  try {
    ws = new WebSocket(`${proto}://${location.host}/ws`);
  } catch {
    scheduleReconnect();
    return;
  }

  ws.addEventListener('open', () => {
    statusDot.className = 'status-dot live';
    reconnectDelay = 1_000;
    stopPoll();
  });

  ws.addEventListener('message', evt => {
    try {
      const { type, data } = JSON.parse(evt.data);
      if (type === 'realtime') renderRealtime(data);
      if (type === 'totals')   renderTotals(data);
      if (type === 'circuits') { renderCircuits(data); circuitsBtn.textContent = '更新'; circuitsBtn.disabled = false; }
      if (type === 'devices')  renderDevices(data);
    } catch { /* bad frame */ }
  });

  ws.addEventListener('close', () => {
    ws = null;
    statusDot.className = 'status-dot offline';
    startPoll();          // keep data fresh while reconnecting
    scheduleReconnect();
  });

  ws.addEventListener('error', () => { try { ws && ws.close(); } catch {} });
}

function scheduleReconnect() {
  reconnectTimer = setTimeout(connect, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 1.5, 10_000); // max 10s (was 30s)
}

// ── Reconnect immediately when tab/app becomes visible ────────────────────────
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    reconnectDelay = 1_000;                           // reset backoff
    if (!ws || ws.readyState > WebSocket.OPEN) {
      clearTimeout(reconnectTimer);
      connect();        // reconnect NOW, don't wait for the timer
      fetchRealtime().catch(() => {}); // also refresh via REST immediately
    }
  }
});

// ── Tab switching ─────────────────────────────────────────────────────────────
let activeTab = 'energy';

function switchTab(tab) {
  activeTab = tab;
  document.getElementById('tab-energy').classList.toggle('hidden', tab !== 'energy');
  document.getElementById('tab-devices').classList.toggle('hidden', tab !== 'devices');
  document.getElementById('tab-btn-energy').classList.toggle('active', tab === 'energy');
  document.getElementById('tab-btn-devices').classList.toggle('active', tab === 'devices');
  if (tab === 'devices' && !devicesLoaded) loadDevices();
}
window.switchTab = switchTab;

let devicesLoaded = false;

// ── Devices state ─────────────────────────────────────────────────────────────
let currentDevices = null;
const expandedAC   = new Set();   // eoj strings of expanded AC cards

// ── AC mode / fan tables ──────────────────────────────────────────────────────
const AC_MODES = [
  { v: '0x41', l: '自動' },
  { v: '0x42', l: '冷房' },
  { v: '0x43', l: '暖房' },
  { v: '0x44', l: '除湿' },
  { v: '0x45', l: '送風' },
];
const AC_FANS = [
  { v: '0x41', l: '自動' },
  { v: '0x31', l: '1' }, { v: '0x32', l: '2' }, { v: '0x33', l: '3' },
  { v: '0x34', l: '4' }, { v: '0x35', l: '5' }, { v: '0x36', l: '6' },
];

// ── Devices render ────────────────────────────────────────────────────────────
function renderDevices(d) {
  if (!d) return;
  currentDevices = d;
  devicesLoaded  = true;

  const acGrid = document.getElementById('ac-grid');
  acGrid.innerHTML = d.acs && d.acs.length
    ? d.acs.map(ac => acCard(ac)).join('')
    : '<div class="device-placeholder">データなし</div>';

  const fhGrid = document.getElementById('fh-grid');
  fhGrid.innerHTML = d.fhs && d.fhs.length
    ? d.fhs.map(fh => fhCard(fh)).join('')
    : '<div class="device-placeholder">データなし</div>';

  const eneGrid = document.getElementById('ene-grid');
  eneGrid.innerHTML = d.enefarm
    ? enefarmCards(d.enefarm)
    : '<div class="device-placeholder">データなし</div>';
}

// ── AC card ───────────────────────────────────────────────────────────────────
function acDisplayName(ac) {
  return escHtml(ac.nickname || ac.name);
}

function acCard(ac) {
  const isOn     = ac.running;
  const expanded = expandedAC.has(ac.eoj);
  const infoLine = [
    ac.inner    ? `室内 ${ac.inner}`    : '',
    ac.outer    ? `室外 ${ac.outer}`    : '',
    ac.humidity ? `湿度 ${ac.humidity}` : '',
  ].filter(Boolean).join('　');

  const controlsHtml = (expanded && isOn) ? acControls(ac) : '';

  return `<div class="device-card ac-card${isOn ? ' running' : ''}${expanded ? ' expanded' : ''}"
      data-dev="ac" data-node="${escHtml(ac.nodeId)}" data-eoj="${escHtml(ac.eoj)}"
      data-state="${escHtml(ac.state)}" data-mode="${escHtml(ac.mode||'')}"
      data-temp="${ac.tempC||0}" data-fan="${escHtml(ac.fan||'')}">
    <div class="ac-header">
      <div class="ac-title-row">
        <span class="device-name" title="${escHtml(ac.name)}">${acDisplayName(ac)}</span>
        <button class="icon-btn rename-btn" onclick="openRename(this)" title="名前を変更">✏️</button>
      </div>
      <div class="ac-title-row">
        <span class="device-status${isOn ? ' on' : ''}">${escHtml(ac.stateLabel)}</span>
        ${isOn && ac.tempC ? `<span class="ac-temp-badge">${ac.tempC}℃</span>` : ''}
      </div>
      ${infoLine ? `<div class="ac-info-line">${escHtml(infoLine)}</div>` : ''}
    </div>
    <div class="ac-btn-row">
      <button class="device-btn${isOn ? ' stop-btn' : ''}" onclick="controlDevice(this,'ac')">${escHtml(ac.buttonLabel)}</button>
      ${isOn ? `<button class="icon-btn expand-btn${expanded ? ' active' : ''}" onclick="toggleACExpand('${escHtml(ac.eoj)}')" title="詳細設定">${expanded ? '▲' : '⚙'}</button>` : ''}
    </div>
    ${controlsHtml}
  </div>`;
}

function acControls(ac) {
  const modeRow = AC_MODES.map(m =>
    `<button class="seg-btn${ac.mode === m.v ? ' active' : ''}"
       onclick="sendACControl(this,'mode','${m.v}')">${m.l}</button>`
  ).join('');

  const fanRow = AC_FANS.map(f =>
    `<button class="seg-btn${ac.fan === f.v ? ' active' : ''}"
       onclick="sendACControl(this,'fan','${f.v}')">${f.l}</button>`
  ).join('');

  const min = 16, max = 30;
  const t   = ac.tempC || 20;

  return `<div class="ac-controls">
    <div class="ac-ctrl-row">
      <span class="ctrl-label">モード</span>
      <div class="seg-group">${modeRow}</div>
    </div>
    <div class="ac-ctrl-row">
      <span class="ctrl-label">温度</span>
      <div class="temp-ctrl">
        <button class="temp-btn" onclick="adjustACTemp(this,-1)" ${t <= min ? 'disabled' : ''}>−</button>
        <span class="temp-val" data-min="${min}" data-max="${max}">${t}℃</span>
        <button class="temp-btn" onclick="adjustACTemp(this,+1)" ${t >= max ? 'disabled' : ''}>＋</button>
      </div>
    </div>
    <div class="ac-ctrl-row">
      <span class="ctrl-label">風量</span>
      <div class="seg-group seg-scroll">${fanRow}</div>
    </div>
  </div>`;
}

function toggleACExpand(eoj) {
  if (expandedAC.has(eoj)) expandedAC.delete(eoj);
  else                      expandedAC.add(eoj);
  if (currentDevices) renderDevices(currentDevices);
}
window.toggleACExpand = toggleACExpand;

// ── FH card ───────────────────────────────────────────────────────────────────
function fhCard(fh) {
  const isOn = fh.running;
  // Parse level from templevel string "温度レベル：5" or from state
  const lvlMatch = (fh.templevel || '').match(/(\d+)/);
  const lvl = lvlMatch ? parseInt(lvlMatch[1]) : null;

  return `<div class="device-card fh-card${isOn ? ' running' : ''}"
      data-dev="fh" data-node="${escHtml(fh.nodeId)}" data-eoj="${escHtml(fh.eoj)}"
      data-state="${escHtml(fh.state)}" data-level="${lvl || 0}">
    <div class="ac-title-row">
      <span class="device-name" title="${escHtml(fh.name)}">${escHtml(fh.nickname || fh.name)}</span>
      <button class="icon-btn rename-btn" onclick="openRename(this)" title="名前を変更">✏️</button>
    </div>
    <span class="device-status${isOn ? ' on' : ''}">${escHtml(fh.stateLabel)}</span>
    <div class="level-ctrl">
      <button class="temp-btn" onclick="adjustFHLevel(this,-1)" ${!lvl || lvl <= 1 ? 'disabled' : ''}>−</button>
      <span class="temp-val">${lvl != null ? lvl : '—'}</span>
      <button class="temp-btn" onclick="adjustFHLevel(this,+1)" ${!lvl || lvl >= 9 ? 'disabled' : ''}>＋</button>
    </div>
    <button class="device-btn${isOn ? ' stop-btn' : ''}" onclick="controlDevice(this,'fh')">${escHtml(fh.buttonLabel)}</button>
  </div>`;
}

// ── Enefarm cards ─────────────────────────────────────────────────────────────
function enefarmCards(ene) {
  const bathOn = ene.bathRunning;
  const genOn  = ene.generateRunning;
  return `
  <div class="device-card${bathOn ? ' running' : ''}">
    <div class="device-name">ふろ自動</div>
    <span class="device-status${bathOn ? ' on' : ''}">${escHtml(ene.bathLabel)}</span>
    <div class="device-info">&nbsp;</div>
    <button class="device-btn${bathOn ? ' stop-btn' : ''}" onclick="controlDevice(this,'bath')">${escHtml(ene.bathButton)}</button>
  </div>
  <div class="device-card${genOn ? ' running' : ''}">
    <div class="device-name">発電</div>
    <span class="device-status${genOn ? ' on' : ''}">${escHtml(ene.generateLabel)}</span>
    <div class="device-info">&nbsp;</div>
    <button class="device-btn${genOn ? ' stop-btn' : ''}" onclick="controlDevice(this,'generate')">${escHtml(ene.generateButton)}</button>
  </div>`;
}

// ── Generic device toggle ─────────────────────────────────────────────────────
async function controlDevice(btn, type) {
  if (btn.disabled) return;
  btn.disabled = true;
  const origText = btn.textContent;
  btn.textContent = '…';
  const card = btn.closest('.device-card');

  let body;
  if      (type === 'ac')       body = { action: 'toggleAC',       nodeId: card.dataset.node, eoj: card.dataset.eoj, state: card.dataset.state };
  else if (type === 'fh')       body = { action: 'toggleFH',       nodeId: card.dataset.node, eoj: card.dataset.eoj, state: card.dataset.state };
  else if (type === 'bath')     body = { action: 'toggleBath' };
  else if (type === 'generate') body = { action: 'toggleGenerate' };

  await postControl(body);
  setTimeout(() => { if (btn.disabled) { btn.textContent = origText; btn.disabled = false; } }, 3_500);
}
window.controlDevice = controlDevice;

// ── AC detailed controls ──────────────────────────────────────────────────────
async function sendACControl(btn, type, value) {
  if (btn.disabled) return;
  btn.disabled = true;
  const card = btn.closest('.device-card');
  const body = {
    action:  type === 'mode' ? 'setACMode' : type === 'fan' ? 'setACFan' : 'setACTemp',
    nodeId:  card.dataset.node,
    eoj:     card.dataset.eoj,
    value,
  };
  await postControl(body);
  // Optimistically update the active button
  if (type === 'mode' || type === 'fan') {
    btn.closest('.seg-group').querySelectorAll('.seg-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  }
  setTimeout(() => { btn.disabled = false; }, 3_000);
}
window.sendACControl = sendACControl;

async function adjustACTemp(btn, delta) {
  if (btn.disabled) return;
  const valEl = btn.parentElement.querySelector('.temp-val');
  const cur   = parseInt(valEl.textContent) || 20;
  const min   = parseInt(valEl.dataset.min);
  const max   = parseInt(valEl.dataset.max);
  const next  = Math.max(min, Math.min(max, cur + delta));
  if (next === cur) return;

  btn.disabled = true;
  valEl.textContent = next + '℃';
  const card = btn.closest('.device-card');

  await postControl({ action: 'setACTemp', nodeId: card.dataset.node, eoj: card.dataset.eoj, value: next });

  // Update +/− disabled state
  btn.parentElement.querySelector('[onclick*="-1"]').disabled = next <= min;
  btn.parentElement.querySelector('[onclick*="+1"]').disabled = next >= max;
  btn.disabled = false;
}
window.adjustACTemp = adjustACTemp;

// ── FH level control ──────────────────────────────────────────────────────────
async function adjustFHLevel(btn, delta) {
  if (btn.disabled) return;
  const valEl = btn.parentElement.querySelector('.temp-val');
  const cur   = parseInt(valEl.textContent) || 1;
  const next  = Math.max(1, Math.min(9, cur + delta));
  if (next === cur) return;

  btn.disabled = true;
  valEl.textContent = next;
  const card = btn.closest('.device-card');

  await postControl({
    action: 'setFHLevel',
    nodeId: card.dataset.node,
    eoj:    card.dataset.eoj,
    state:  card.dataset.state,
    value:  next,
  });

  btn.parentElement.querySelector('[onclick*="-1"]').disabled = next <= 1;
  btn.parentElement.querySelector('[onclick*="+1"]').disabled = next >= 9;
  btn.disabled = false;
}
window.adjustFHLevel = adjustFHLevel;

// ── Nickname editing ──────────────────────────────────────────────────────────
function openRename(btn) {
  const card = btn.closest('.device-card');
  const nameEl = card.querySelector('.device-name');
  const cur  = nameEl.textContent.trim();
  const eoj  = card.dataset.eoj;
  const all  = [...(currentDevices?.acs || []), ...(currentDevices?.fhs || [])];
  const orig = eoj ? (all.find(d => d.eoj === eoj)?.name || cur) : cur;

  const input = prompt(`「${escHtml(orig)}」の表示名を入力\n（空欄でリセット）`, cur === orig ? '' : cur);
  if (input === null) return;   // cancelled

  fetch('/api/nicknames', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ nodeId: card.dataset.node, eoj: card.dataset.eoj, name: input.trim() }),
  }).then(() => {
    nameEl.textContent = input.trim() || orig;
  }).catch(() => {});
}
window.openRename = openRename;

// ── Shared control POST ───────────────────────────────────────────────────────
async function postControl(body) {
  try {
    const r = await fetch('/api/devices/control', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
    if (!r.ok) console.warn('control error', r.status);
  } catch (e) {
    console.warn('control fetch failed', e);
  }
}

function loadDevices() {
  fetch('/api/devices').then(r => r.json()).then(renderDevices).catch(() => {});
}

// ── Circuits on demand ────────────────────────────────────────────────────────
function loadCircuits() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    circuitsBtn.textContent = '読み込み中…';
    circuitsBtn.disabled    = true;
    ws.send(JSON.stringify({ action: 'loadCircuits' }));
  } else {
    // WS offline — fall back to REST
    circuitsBtn.textContent = '読み込み中…';
    circuitsBtn.disabled    = true;
    fetch('/api/circuits')
      .then(r => r.json())
      .then(renderCircuits)
      .catch(() => {
        circuitsList.innerHTML = '<div class="circuits-msg">読み込み失敗</div>';
        circuitsBtn.textContent = '再試行';
        circuitsBtn.disabled    = false;
      });
  }
}
window.loadCircuits = loadCircuits;

// ── Service worker ────────────────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// ── Boot: REST first for instant data, then WebSocket for live updates ─────────
initialFetch();
connect();
