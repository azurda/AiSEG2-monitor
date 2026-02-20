'use strict';

/**
 * AiSEG2 API client.
 * Handles HTTP Digest auth transparently; all methods return parsed data.
 */

const crypto = require('crypto');

const BASE   = 'http://192.168.0.216';
const USER   = 'aiseg';
const PASS   = '0123456789';

// ── Digest auth ─────────────────────────────────────────────────────────────

function md5(s) {
  return crypto.createHash('md5').update(s).digest('hex');
}

function parseWWWAuth(header) {
  const r = {};
  header.replace(/(\w+)="([^"]+)"/g, (_, k, v) => { r[k] = v; });
  return r;
}

async function digestFetch(path, method = 'GET', body = null) {
  const url = BASE + path;
  const baseHeaders = {};
  let baseBody = undefined;
  if (body !== null) {
    baseHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
    baseBody = body;
  }

  // First pass — get the 401 challenge
  const r1 = await fetch(url, { method, headers: baseHeaders, body: baseBody });
  if (r1.status !== 401) return r1;

  const wwwAuth = r1.headers.get('www-authenticate') || '';
  const { realm = 'AiSEG', nonce = '', opaque, qop } = parseWWWAuth(wwwAuth);

  const nc     = '00000001';
  const cnonce = crypto.randomBytes(8).toString('hex');
  const ha1    = md5(`${USER}:${realm}:${PASS}`);
  const ha2    = md5(`${method}:${path}`);   // uri must match the Authorization header's uri field

  const response = qop === 'auth'
    ? md5(`${ha1}:${nonce}:${nc}:${cnonce}:auth:${ha2}`)
    : md5(`${ha1}:${nonce}:${ha2}`);

  let auth = `Digest username="${USER}", realm="${realm}", nonce="${nonce}", uri="${path}", response="${response}"`;
  if (qop)    auth += `, qop=auth, nc=${nc}, cnonce="${cnonce}"`;
  if (opaque) auth += `, opaque="${opaque}"`;

  return fetch(url, {
    method,
    headers: { ...baseHeaders, Authorization: auth },
    body: baseBody,
  });
}

// ── HTML helpers ─────────────────────────────────────────────────────────────

function parseKwh(html) {
  const m = html.match(/<span[^>]+id="val_kwh"[^>]*>([\d.,]+)<\/span>/);
  return m ? parseFloat(m[1].replace(',', '')) : null;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Live power data (generation, consumption, buy/sell, top 3 consumers).
 * Maps directly from POST /data/electricflow/111/update JSON.
 */
async function getRealtime() {
  const r = await digestFetch('/data/electricflow/111/update', 'POST', '');
  if (!r.ok) throw new Error(`AiSEG2 HTTP ${r.status}`);
  const d = await r.json();

  // Decode Japanese fields for the API consumer
  return {
    gen_kw:         parseFloat(d.g_capacity) || 0,
    use_kw:         parseFloat(d.u_capacity) || 0,
    solar_w:        d.g_d_1_capacity ?? 0,
    enefarm_w:      d.g_d_2_capacity ?? 0,
    selling:        d.lo_buy_sell === 1,   // true=selling, false=buying
    top: [
      { name: d.u_d_1_title, watts: d.u_d_1_capacity, visible: d.best1 === 1 },
      { name: d.u_d_2_title, watts: d.u_d_2_capacity, visible: d.best2 === 1 },
      { name: d.u_d_3_title, watts: d.u_d_3_capacity, visible: d.best3 === 1 },
    ].filter(c => c.visible),
    ev_connected:   d.connEv === 1,
    battery_pct:    d.connSb ? d.percent : null,
    fc_connected:   d.connFc > 0,          // Enefarm
    raw:            d,
  };
}

/**
 * Daily kWh totals (4 scrape requests, run in parallel).
 */
async function getTotals() {
  const pages = { solar: 51111, consumption: 52111, purchase: 53111, sold: 54111 };
  const entries = Object.entries(pages);
  const results = await Promise.all(
    entries.map(([, id]) =>
      digestFetch(`/page/graph/${id}`)
        .then(r => r.text())
        .then(parseKwh)
        .catch(() => null)
    )
  );
  return Object.fromEntries(entries.map(([key], i) => [key, results[i]]));
}

/**
 * List of active circuits (ID + Japanese name). Cached by caller.
 */
async function getCircuits() {
  const r = await digestFetch('/page/setting/installation/734');
  const html = await r.text();

  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  for (const s of scripts) {
    if (!s.includes('arrayCircuitNameList')) continue;
    const l = s.indexOf('(');
    const rpos = s.lastIndexOf(')');
    if (l < 0 || rpos <= l) continue;
    try {
      const data = JSON.parse(s.slice(l + 1, rpos).trim());
      return (data.arrayCircuitNameList || [])
        .filter(c => c.strBtnType === '1')
        .map(c => ({ id: String(c.strId), name: c.strCircuit || `Circuit ${c.strId}` }));
    } catch { /* try next script */ }
  }
  return [];
}

/**
 * Today's kWh for one circuit.
 */
async function getCircuitKwh(id) {
  const data = Buffer.from(JSON.stringify({ circuitid: String(id) })).toString('base64');
  const r = await digestFetch(`/page/graph/584?data=${data}`);
  return parseKwh(await r.text());
}

/**
 * Fetch kWh for all circuits concurrently (rate-limited to 10 at a time).
 */
async function getAllCircuitKwh(circuits) {
  const CONCURRENCY = 10;
  const results = new Array(circuits.length).fill(null);
  for (let i = 0; i < circuits.length; i += CONCURRENCY) {
    const batch = circuits.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(c => getCircuitKwh(c.id).catch(() => null))
    );
    batchResults.forEach((v, j) => { results[i + j] = v; });
  }
  return results;
}

// ── Device control helpers ────────────────────────────────────────────────────

/**
 * POST with X-Requested-With header and data=JSON.stringify(params) body.
 * Used for all AiSEG2 device data/action endpoints.
 */
async function devicePost(path, params) {
  const url  = BASE + path;
  const body = 'data=' + encodeURIComponent(JSON.stringify(params));
  const hdrs = {
    'Content-Type':     'application/x-www-form-urlencoded',
    'X-Requested-With': 'XMLHttpRequest',
  };

  const r1 = await fetch(url, { method: 'POST', headers: hdrs, body });
  if (r1.status !== 401) return r1;

  const wwwAuth = r1.headers.get('www-authenticate') || '';
  const { realm = 'AiSEG', nonce = '', opaque, qop } = parseWWWAuth(wwwAuth);
  const nc     = '00000001';
  const cnonce = crypto.randomBytes(8).toString('hex');
  const ha1    = md5(`${USER}:${realm}:${PASS}`);
  const ha2    = md5(`POST:${path}`);
  const response = qop === 'auth'
    ? md5(`${ha1}:${nonce}:${nc}:${cnonce}:auth:${ha2}`)
    : md5(`${ha1}:${nonce}:${ha2}`);

  let auth = `Digest username="${USER}", realm="${realm}", nonce="${nonce}", uri="${path}", response="${response}"`;
  if (qop)    auth += `, qop=auth, nc=${nc}, cnonce="${cnonce}"`;
  if (opaque) auth += `, opaque="${opaque}"`;

  return fetch(url, { method: 'POST', headers: { ...hdrs, Authorization: auth }, body });
}

// Cached token (changes only on AiSEG2 reboot, refresh every hour)
let _token = null;
let _tokenAt = 0;

async function getToken() {
  if (_token && Date.now() - _tokenAt < 3_600_000) return _token;
  const r    = await digestFetch('/page/devices/device/32');
  const html = await r.text();
  const m    = html.match(/init\s*\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*(\d+)/);
  _token  = m ? m[1] : '32140';
  _tokenAt = Date.now();
  return _token;
}

// Static device lists (from the group page init() call)
const AC_DEVICES = [
  { nodeId: '1073741827', eoj: '0x013001', type: '0x33', name: 'エアコンA' },
  { nodeId: '1073741828', eoj: '0x013001', type: '0x33', name: 'エアコンB' },
  { nodeId: '1073741829', eoj: '0x013001', type: '0x33', name: 'エアコンC' },
];

const FH_DEVICES = [
  { nodeId: '1073741826', eoj: '0x0f7001', type: '0x34', name: '床暖房A' },
  { nodeId: '1073741826', eoj: '0x0f7002', type: '0x34', name: '床暖房B' },
];

const ENEFARM = {
  nodeid: '1073741826', eoj: '0x027c01', devtype: '0x32',
  bath_nodeid: '1073741826', bath_eoj: '0x027201', bath_devtype: '0x37',
  bathcmd: '0x41', generatecmd: '0x42',
};

// Full device list for group auto_update (must match group page init() order)
const ALL_DEVICES = [
  ...AC_DEVICES,
  { nodeId: ENEFARM.nodeid,       eoj: ENEFARM.eoj,       type: ENEFARM.devtype },
  ...FH_DEVICES,
  { nodeId: ENEFARM.bath_nodeid,  eoj: ENEFARM.bath_eoj,  type: ENEFARM.bath_devtype },
];

/**
 * Get current status of all controllable devices.
 */
async function getDevices() {
  const token = await getToken();

  const [acRes, fhRes, grpRes] = await Promise.all([
    devicePost('/data/devices/device/321/auto_update',
      { list: AC_DEVICES.map(({ nodeId, eoj, type }) => ({ nodeId, eoj, type })), page: 1, old_page: 0, token }),
    devicePost('/data/devices/device/32b/auto_update',
      { list: FH_DEVICES.map(({ nodeId, eoj, type }) => ({ nodeId, eoj, type })), page: 1, old_page: 0, token }),
    devicePost('/data/devices/device/32/auto_update',
      { list: ALL_DEVICES.map(({ nodeId, eoj, type }) => ({ nodeId, eoj, type })),
        page: 1, old_page: 0, token }),
  ]);

  const acData  = acRes.ok  ? await acRes.json()  : { links: [] };
  const fhData  = fhRes.ok  ? await fhRes.json()  : { links: [] };
  const grpData = grpRes.ok ? await grpRes.json() : {};

  // Fetch per-AC detail (mode, temp°C, fan speed) in parallel
  const acDetails = await Promise.all(
    AC_DEVICES.map(({ nodeId, eoj }) =>
      devicePost('/data/devices/device/3211/update',
        { nodeId, eoj, type: '0x33', page: 1, individual_page: 1 })
        .then(r => r.ok ? r.json() : {})
        .catch(() => ({}))
    )
  );

  const acs = (acData.links || []).map((a, i) => {
    const det = acDetails[i] || {};
    // mode from detail (hex), temp from detail (hex → int), fan from modify_items
    const modeVal = det.mode || null;
    const tempHex = det.temp || null;
    const tempC   = tempHex ? parseInt(tempHex, 16) : null;
    const items   = det.modify_items || [];
    const fanItem = items.find(x => x.id_str === 's_img_ac');
    const fanVal  = fanItem?.current?.value || null;
    return {
      nodeId:      a.nodeId,
      eoj:         a.eoj,
      type:        a.type,
      name:        a.name,
      state:       a.state,
      running:     a.state === '0x30',
      stateLabel:  a.state_str,
      buttonLabel: a.index_mode_button,
      inner:       a.inner  || null,
      outer:       (a.outer  && a.outer  !== '-') ? a.outer  : null,
      humidity:    (a.humidity && a.humidity !== '-') ? a.humidity : null,
      mode:        modeVal,
      tempC:       tempC,
      fan:         fanVal,
    };
  });

  const fhs = (fhData.links || []).map(f => ({
    nodeId:      f.nodeId,
    eoj:         f.eoj,
    type:        f.type,
    name:        f.name,
    state:       f.state,
    running:     f.state === '0x30',
    stateLabel:  f.state_str,
    buttonLabel: f.index_mode_button,
    templevel:   f.templevel || null,
  }));

  const ene = grpData.list2?.lanEnefarm ?? {};
  const enefarm = {
    bathRunning:     ene.bath_onoff    === 'on',
    bathLabel:       ene.bath_state    || '—',
    bathButton:      ene.bath_button   || 'ふろ自動',
    generateRunning: ene.generate_onoff === 'on',
    generateLabel:   ene.generate_state || '—',
    generateButton:  (ene.generate_button || '').replace(/<br\s*\/?>/gi, ' '),
  };

  return { token, acs, fhs, enefarm };
}

/**
 * Change AC mode / temperature / fan speed.
 * settingType: 1=mode, 2=temperature(°C int), 3=fan speed
 * value: hex string for mode/fan (e.g. "0x43"), integer for temp (e.g. 18)
 */
async function setACSettings(nodeId, eoj, settingType, value, token) {
  const tok = token || await getToken();
  const r = await devicePost('/action/devices/device/3211/change', {
    nodeId, eoj, type: '0x33',
    page: '1', individual_page: '1',
    setting_type: String(settingType),
    value:        String(value),
    token:        tok,
  });
  return r.ok ? r.json() : { result: 'error', status: r.status };
}

/**
 * Toggle an air conditioner (send current state; server toggles).
 * Returns the JSON response from AiSEG2.
 */
async function controlAC(nodeId, eoj, state, token) {
  const tok = token || await getToken();
  const r = await devicePost('/action/devices/device/321/change',
    { nodeId, eoj, type: '0x33', state, token: tok });
  return r.ok ? r.json() : { result: 'error', status: r.status };
}

/**
 * Set floor heating temperature level (1–9).
 * level: integer 1–9 → encoded as "0x31"–"0x39"
 */
async function setFHLevel(nodeId, eoj, currentState, level, token) {
  const tok      = token || await getToken();
  const lvl      = Math.max(1, Math.min(9, level));
  const templevel = '0x3' + lvl;            // 0x31=1 … 0x39=9
  const r = await devicePost('/action/devices/device/32b/change', {
    nodeId, eoj, type: '0x34',
    state: currentState,
    templevel,
    token: tok,
  });
  return r.ok ? r.json() : { result: 'error', status: r.status };
}

/**
 * Toggle a floor heater (send current state; server toggles).
 */
async function controlFH(nodeId, eoj, state, token) {
  const tok = token || await getToken();
  const r = await devicePost('/action/devices/device/32b/change',
    { nodeId, eoj, type: '0x34', state, token: tok });
  return r.ok ? r.json() : { result: 'error', status: r.status };
}

/**
 * Toggle bath hot water (ふろ自動). Command is always 0x41 (toggle).
 */
async function controlBath(token) {
  const tok = token || await getToken();
  const params = new URLSearchParams({
    page: '1', old_page: '1',
    nodeid: ENEFARM.bath_nodeid, eoj: ENEFARM.bath_eoj, devtype: ENEFARM.bath_devtype,
    bathcmd: ENEFARM.bathcmd,
    generatecmd: '-', geneHeatcmd: '-', cleancmd: '-',
    token: tok,
  });
  const path = `/action/devices/device/301?${params}`;
  const r = await digestFetch(path);
  return r.ok ? r.json() : { result: 'error', status: r.status };
}

/**
 * Toggle Enefarm power generation. Command is always 0x42 (toggle).
 */
async function controlGenerate(token) {
  const tok = token || await getToken();
  const r = await devicePost('/action/devices/device/32/ctrl_lanEnefirm_generate',
    { token: tok, generatecmd: ENEFARM.generatecmd });
  return r.ok ? r.json() : { result: 'error', status: r.status };
}

module.exports = {
  getRealtime, getTotals, getCircuits, getCircuitKwh, getAllCircuitKwh,
  getDevices, controlAC, controlFH, controlBath, controlGenerate, getToken,
  setACSettings, setFHLevel,
};
