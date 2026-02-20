'use strict';

const express = require('express');
const { WebSocketServer } = require('ws');
const http    = require('http');
const path    = require('path');
const fs      = require('fs');
const aiseg2  = require('./aiseg2');

// ── Nicknames (persisted to nicknames.json) ───────────────────────────────────

const NICKNAMES_FILE = path.join(__dirname, 'nicknames.json');

function loadNicknames() {
  try { return JSON.parse(fs.readFileSync(NICKNAMES_FILE, 'utf8')); } catch { return {}; }
}

function saveNicknames(obj) {
  fs.writeFileSync(NICKNAMES_FILE, JSON.stringify(obj, null, 2));
}

let nicknames = loadNicknames(); // { "<nodeId>_<eoj>": "Custom Name" }

const PORT = process.env.PORT || 3000;

// ── App setup ────────────────────────────────────────────────────────────────

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server, path: '/ws' });

app.use(express.static(path.join(__dirname, 'public')));

// ── In-memory cache ──────────────────────────────────────────────────────────

const cache = {
  realtime:   null,
  realtimeAt: 0,
  totals:     null,
  totalsAt:   0,
  circuits:   null,   // list of {id, name}
  circuitKwh: null,   // list of {id, name, kwh}
  circuitKwhAt: 0,
  devices:    null,
  devicesAt:  0,
};

const TTL = {
  realtime:   5_000,
  totals:     60_000,
  circuitKwh: 300_000,
  devices:    10_000,
};

// ── AiSEG2 helpers with cache ────────────────────────────────────────────────

async function fetchRealtime() {
  const data = await aiseg2.getRealtime();
  cache.realtime   = data;
  cache.realtimeAt = Date.now();
  return data;
}

async function fetchTotals() {
  const data = await aiseg2.getTotals();
  cache.totals   = data;
  cache.totalsAt = Date.now();
  return data;
}

function applyNicknames(data) {
  if (!data) return data;
  const applyName = d => {
    const key = `${d.nodeId}_${d.eoj}`;
    return nicknames[key] ? { ...d, nickname: nicknames[key] } : d;
  };
  return {
    ...data,
    acs: (data.acs || []).map(applyName),
    fhs: (data.fhs || []).map(applyName),
  };
}

async function fetchDevices() {
  const raw  = await aiseg2.getDevices();
  const data = applyNicknames(raw);
  cache.devices   = data;
  cache.devicesAt = Date.now();
  return data;
}

async function fetchCircuits() {
  if (!cache.circuits) {
    cache.circuits = await aiseg2.getCircuits();
  }
  if (Date.now() - cache.circuitKwhAt > TTL.circuitKwh) {
    console.log(`Fetching kWh for ${cache.circuits.length} circuits...`);
    const kwh = await aiseg2.getAllCircuitKwh(cache.circuits);
    cache.circuitKwh   = cache.circuits.map((c, i) => ({ ...c, kwh: kwh[i] }));
    cache.circuitKwhAt = Date.now();
    console.log('Circuit kWh fetch complete.');
  }
  return cache.circuitKwh;
}

// ── REST API ─────────────────────────────────────────────────────────────────

app.get('/api/realtime', async (req, res) => {
  try {
    if (Date.now() - cache.realtimeAt > TTL.realtime) await fetchRealtime();
    res.json(cache.realtime);
  } catch (e) {
    console.error('GET /api/realtime:', e.message);
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/totals', async (req, res) => {
  try {
    if (Date.now() - cache.totalsAt > TTL.totals) await fetchTotals();
    res.json(cache.totals);
  } catch (e) {
    console.error('GET /api/totals:', e.message);
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/devices', async (req, res) => {
  try {
    if (Date.now() - cache.devicesAt > TTL.devices) await fetchDevices();
    res.json(cache.devices);
  } catch (e) {
    console.error('GET /api/devices:', e.message);
    res.status(502).json({ error: e.message });
  }
});

app.use(express.json());

app.post('/api/devices/control', async (req, res) => {
  const { action, nodeId, eoj, state, value } = req.body || {};
  try {
    const token = cache.devices?.token || await aiseg2.getToken();
    let result;
    if      (action === 'toggleAC')       result = await aiseg2.controlAC(nodeId, eoj, state, token);
    else if (action === 'toggleFH')       result = await aiseg2.controlFH(nodeId, eoj, state, token);
    else if (action === 'toggleBath')     result = await aiseg2.controlBath(token);
    else if (action === 'toggleGenerate') result = await aiseg2.controlGenerate(token);
    else if (action === 'setACMode')      result = await aiseg2.setACSettings(nodeId, eoj, 1, value, token);
    else if (action === 'setACTemp')      result = await aiseg2.setACSettings(nodeId, eoj, 2, value, token);
    else if (action === 'setACFan')       result = await aiseg2.setACSettings(nodeId, eoj, 3, value, token);
    else if (action === 'setFHLevel')     result = await aiseg2.setFHLevel(nodeId, eoj, state, value, token);
    else return res.status(400).json({ error: 'unknown action' });

    res.json(result);

    // Re-fetch device status after a short delay and broadcast
    setTimeout(async () => {
      try {
        const data = await fetchDevices();
        broadcast('devices', data);
      } catch { /* ignore */ }
    }, 2_500);
  } catch (e) {
    console.error('POST /api/devices/control:', e.message);
    res.status(502).json({ error: e.message });
  }
});

// ── Nickname endpoints ────────────────────────────────────────────────────────

app.get('/api/nicknames', (req, res) => res.json(nicknames));

app.post('/api/nicknames', (req, res) => {
  const { nodeId, eoj, name } = req.body || {};
  if (!nodeId || !eoj) return res.status(400).json({ error: 'nodeId and eoj required' });
  const key = `${nodeId}_${eoj}`;
  if (name && name.trim()) {
    nicknames[key] = name.trim();
  } else {
    delete nicknames[key];   // empty name = reset to default
  }
  saveNicknames(nicknames);
  // Rebuild cache with new nicknames
  if (cache.devices) cache.devices = applyNicknames(cache.devices);
  res.json({ ok: true });
});

app.get('/api/circuits', async (req, res) => {
  try {
    const data = await fetchCircuits();
    res.json(data);
  } catch (e) {
    console.error('GET /api/circuits:', e.message);
    res.status(502).json({ error: e.message });
  }
});

// ── WebSocket — live push ─────────────────────────────────────────────────────

let pollHandle   = null;
let totalsHandle = null;
let devicesHandle = null;

function broadcast(type, data) {
  const msg = JSON.stringify({ type, data, ts: Date.now() });
  wss.clients.forEach(ws => { if (ws.readyState === 1) ws.send(msg); });
}

async function pollRealtime() {
  try {
    const data = await fetchRealtime();
    broadcast('realtime', data);
  } catch (e) {
    console.error('Realtime poll:', e.message);
  }
}

async function pollTotals() {
  try {
    const data = await fetchTotals();
    broadcast('totals', data);
  } catch (e) {
    console.error('Totals poll:', e.message);
  }
}

async function pollDevices() {
  try {
    const data = await fetchDevices();
    broadcast('devices', data);
  } catch (e) {
    console.error('Devices poll:', e.message);
  }
}

function startPolling() {
  if (pollHandle) return;
  console.log('Starting live polling.');
  pollRealtime();                                           // immediate
  pollHandle    = setInterval(pollRealtime,  5_000);
  totalsHandle  = setInterval(pollTotals,   60_000);
  devicesHandle = setInterval(pollDevices,  10_000);
}

function stopPolling() {
  if (!pollHandle) return;
  clearInterval(pollHandle);
  clearInterval(totalsHandle);
  clearInterval(devicesHandle);
  pollHandle = totalsHandle = devicesHandle = null;
  console.log('Live polling stopped (no clients).');
}

wss.on('connection', ws => {
  console.log(`WS connected  (${wss.clients.size} clients)`);

  // Send cached data immediately so the UI isn't blank
  if (cache.realtime)   ws.send(JSON.stringify({ type: 'realtime', data: cache.realtime,   ts: cache.realtimeAt }));
  if (cache.totals)     ws.send(JSON.stringify({ type: 'totals',   data: cache.totals,     ts: cache.totalsAt }));
  if (cache.circuitKwh) ws.send(JSON.stringify({ type: 'circuits', data: cache.circuitKwh, ts: cache.circuitKwhAt }));
  if (cache.devices)    ws.send(JSON.stringify({ type: 'devices',  data: cache.devices,    ts: cache.devicesAt }));

  startPolling();

  ws.on('message', msg => {
    try {
      const { action } = JSON.parse(msg);
      if (action === 'loadCircuits') {
        fetchCircuits()
          .then(data => ws.send(JSON.stringify({ type: 'circuits', data, ts: Date.now() })))
          .catch(e  => ws.send(JSON.stringify({ type: 'error', message: e.message })));
      }
    } catch { /* ignore bad frames */ }
  });

  ws.on('close', () => {
    console.log(`WS disconnected (${wss.clients.size} clients)`);
    if (wss.clients.size === 0) stopPolling();
  });
});

// ── Startup ──────────────────────────────────────────────────────────────────

server.listen(PORT, '0.0.0.0', async () => {
  const { networkInterfaces } = require('os');
  const nets = networkInterfaces();
  const lanIPs = Object.values(nets).flat()
    .filter(n => n.family === 'IPv4' && !n.internal)
    .map(n => n.address);

  console.log('');
  console.log('  AiSEG2 Dashboard');
  console.log('  ─────────────────────────────');
  console.log(`  Local:   http://localhost:${PORT}`);
  lanIPs.forEach(ip => console.log(`  Network: http://${ip}:${PORT}`));
  console.log('');

  // Pre-warm caches on startup
  try {
    await Promise.all([fetchRealtime(), fetchTotals()]);
    console.log('  Initial data loaded.');
  } catch (e) {
    console.warn('  Warning: initial fetch failed:', e.message);
  }
});
