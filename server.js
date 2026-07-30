const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const PORT = process.env.PORT || 3777;

app.use(express.static(path.join(__dirname)));
app.use(express.json({ limit: '50mb' }));

const DATA_DIR = path.join(__dirname, 'data');
const REGISTRY_FILE = path.join(DATA_DIR, 'registry.json');
const CACHE_DIR = path.join(__dirname, 'cache');

const CACHE_MAX_FILES = 500;
const CACHE_MAX_SIZE_MB = 200;
const EVENT_TTL_MS = 30 * 60 * 1000; // 30 min

let cacheErrors = [];

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

// ─── Persistent Registry ────────────────────────────────────────────────
function loadRegistry() {
  try {
    const raw = fs.readFileSync(REGISTRY_FILE, 'utf8');
    return JSON.parse(raw);
  } catch { return { terminals: {} }; }
}
function saveRegistry() {
  const obj = {};
  terminals.forEach((t, name) => { obj[name] = t; });
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify({ terminals: obj }, null, 2));
}

let terminals = new Map();
let pollQueues = new Map();
let pollWaiters = new Map();
let wsClients = new Map();

function initRegistry() {
  const data = loadRegistry();
  for (const [name, t] of Object.entries(data.terminals || {})) {
    t.status = 'offline';
    terminals.set(name, t);
  }
  console.log(`[REGISTRY] Cargados ${terminals.size} terminales conocidos`);
}
initRegistry();

// ─── Cache Management ──────────────────────────────────────────────────
function isValidWav(filepath) {
  try {
    const fd = fs.openSync(filepath, 'r');
    const buf = Buffer.alloc(12);
    fs.readSync(fd, buf, 0, 12, 0);
    fs.closeSync(fd);
    return buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE';
  } catch { return false; }
}

function getCacheStats() {
  let files = 0, sizeBytes = 0, corrupt = 0;
  try {
    const entries = fs.readdirSync(CACHE_DIR);
    for (const entry of entries) {
      const p = path.join(CACHE_DIR, entry);
      try {
        const st = fs.statSync(p);
        if (!st.isFile()) continue;
        if (st.size === 0 || !isValidWav(p)) { corrupt++; fs.unlinkSync(p); continue; }
        files++;
        sizeBytes += st.size;
      } catch { try { fs.unlinkSync(p); } catch {} corrupt++; }
    }
  } catch {}
  return { files, sizeMB: Math.round(sizeBytes / (1024 * 1024) * 10) / 10, corrupt };
}

function enforceCacheLimits() {
  try {
    const entries = fs.readdirSync(CACHE_DIR).filter(f => f.endsWith('.wav')).map(f => {
      const p = path.join(CACHE_DIR, f);
      try { const st = fs.statSync(p); return { path: p, mtime: st.mtimeMs, size: st.size }; } catch { return null; }
    }).filter(Boolean);

    let totalSize = entries.reduce((s, e) => s + e.size, 0);
    let exceeded = entries.length > CACHE_MAX_FILES || totalSize > CACHE_MAX_SIZE_MB * 1024 * 1024;

    if (exceeded) {
      entries.sort((a, b) => a.mtime - b.mtime);
      const removeCount = Math.ceil(entries.length * 0.1);
      const toRemove = entries.slice(0, removeCount);
      for (const e of toRemove) { try { fs.unlinkSync(e.path); } catch {} }
      console.log(`[CACHE] Evicción LRU: eliminados ${toRemove.length} archivos (${entries.length} → ${entries.length - toRemove.length})`);
      cacheErrors.push({ type: 'eviction', at: Date.now(), detail: `${toRemove.length} archivos eliminados (LRU)` });
      if (cacheErrors.length > 50) cacheErrors.shift();
    }
  } catch (e) {
    cacheErrors.push({ type: 'enforce_error', at: Date.now(), detail: e.message });
    if (cacheErrors.length > 50) cacheErrors.shift();
  }
}

function logCacheError(type, detail) {
  cacheErrors.push({ type, at: Date.now(), detail });
  if (cacheErrors.length > 50) cacheErrors.shift();
}

function getCachedTTS(text) {
  const hash = crypto.createHash('md5').update(text).digest('hex');
  const p = path.join(CACHE_DIR, hash + '.wav');
  try {
    if (!fs.existsSync(p)) return null;
    if (!isValidWav(p)) {
      logCacheError('corrupt', `Archivo corrupto: ${hash}.wav`);
      fs.unlinkSync(p);
      return null;
    }
    const data = fs.readFileSync(p);
    if (data.length < 100) {
      fs.unlinkSync(p);
      return null;
    }
    return data;
  } catch { return null; }
}

function cacheTTS(text, wav) {
  try {
    if (!wav || wav.length < 100) return;
    enforceCacheLimits();
    const h = crypto.createHash('md5').update(text).digest('hex');
    const p = path.join(CACHE_DIR, h + '.wav');
    fs.writeFileSync(p, wav);
  } catch (e) {
    logCacheError('write', e.message);
  }
}

function cleanEventQueues() {
  const cutoff = Date.now() - EVENT_TTL_MS;
  pollQueues.forEach((q, name) => {
    const filtered = q.filter(e => e.timestamp && e.timestamp > cutoff);
    if (filtered.length !== q.length) pollQueues.set(name, filtered);
  });
}

function cacheMaintenance() {
  const stats = getCacheStats();
  if (stats.corrupt > 0) {
    logCacheError('cleanup', `${stats.corrupt} archivos corruptos eliminados`);
  }
  enforceCacheLimits();
  cleanEventQueues();
}

setInterval(cacheMaintenance, 10 * 60 * 1000); // cada 10 min

function ensureTerminal(name, metadata = {}) {
  let t = terminals.get(name);
  const now = Date.now();
  if (!t) {
    t = { name, firstSeen: now, lastSeen: now, voiceEnabled: false, status: 'online', metadata };
    terminals.set(name, t);
    console.log(`[REGISTRY] Nuevo terminal: ${name}`);
  } else {
    t.lastSeen = now;
    t.status = 'online';
    Object.assign(t.metadata, metadata);
  }
  saveRegistry();
  broadcastClientList();
  return t;
}

function setTerminalOffline(name) {
  const t = terminals.get(name);
  if (t) {
    t.status = 'offline';
    t.lastSeen = Date.now();
    saveRegistry();
    broadcastClientList();
  }
}

function deleteTerminal(name) {
  terminals.delete(name);
  pollQueues.delete(name);
  const w = pollWaiters.get(name);
  if (w) { clearTimeout(w.timer); pollWaiters.delete(name); }
  saveRegistry();
  broadcastClientList();
}

function getClientList() {
  return [...terminals.entries()].map(([name, t]) => ({
    name,
    connected: t.status === 'online',
    voiceEnabled: t.voiceEnabled,
    firstSeen: t.firstSeen,
    lastSeen: t.lastSeen
  }));
}

// ─── Event Queue ────────────────────────────────────────────────────────
function queueEvent(name, event) {
  if (!pollQueues.has(name)) pollQueues.set(name, []);
  const q = pollQueues.get(name);
  q.push(event);
  if (q.length > 200) q.shift();
  return event;
}

function broadcastAll(event, voiceOnly = false, targetName = null) {
  terminals.forEach((t, name) => {
    if (targetName && name !== targetName) return;
    if (voiceOnly && !t.voiceEnabled) return;
    queueEvent(name, event);
    wakePoller(name);
    sendViaWS(name, event);
  });
}

function broadcastAllExcept(event, excludeName) {
  terminals.forEach((t, name) => {
    if (name === excludeName) return;
    queueEvent(name, event);
    wakePoller(name);
    sendViaWS(name, event);
  });
}

function broadcastClientList() {
  const event = { type: 'clients', clients: getClientList() };
  terminals.forEach((t, name) => {
    queueEvent(name, event);
    sendViaWS(name, event);
  });
  pollWaiters.forEach((w, name) => wakePoller(name));
}

function wakePoller(name) {
  const w = pollWaiters.get(name);
  if (w) {
    clearTimeout(w.timer);
    pollWaiters.delete(name);
    const queue = (pollQueues.get(name) || []).filter(e => e.timestamp > w.since);
    try { w.res.json({ events: queue, clients: getClientList() }); } catch {}
  }
}

// ─── WebSocket ──────────────────────────────────────────────────────────
function sendViaWS(name, event) {
  wsClients.forEach((n, ws) => {
    if (n === name && ws.readyState === 1) {
      try { ws.send(JSON.stringify({ type: 'event', event })); } catch {}
    }
  });
}

wss.on('connection', (ws, req) => {
  let registeredName = null;
  const ip = req.socket.remoteAddress;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'register') {
      const name = (msg.name || '').trim().toLowerCase().replace(/[^a-z0-9\-_]/g, '-');
      if (!name) return ws.send(JSON.stringify({ type: 'error', message: 'invalid name' }));

      if (registeredName) wsClients.delete(ws);
      registeredName = name;
      wsClients.set(ws, name);
      ensureTerminal(name, { ip, transport: 'ws' });

      const pending = (pollQueues.get(name) || []).filter(e => true);
      pollQueues.set(name, []);
      ws.send(JSON.stringify({ type: 'connected', events: pending, clients: getClientList() }));
      console.log(`[WS] ${name} registrado`);
      return;
    }

    if (msg.type === 'chat' && registeredName) {
      const { to, text } = msg;
      if (!to || !text) return;
      const chatEvent = { type: 'chat', from: registeredName, text, timestamp: Date.now() };
      if (to === '*') {
        broadcastAllExcept(chatEvent, registeredName);
      } else {
        queueEvent(to, chatEvent);
        sendViaWS(to, chatEvent);
        wakePoller(to);
      }
      return;
    }

    if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }));
    }
  });

  ws.on('close', () => {
    if (registeredName) {
      wsClients.delete(ws);
      setTimeout(() => {
        const stillConnected = [...wsClients.values()].some(n => n === registeredName);
        if (!stillConnected) setTerminalOffline(registeredName);
      }, 60000);
    }
  });

  ws.on('error', () => {});
});

// ─── Long Polling (backward compat) ─────────────────────────────────────
app.get('/api/poll', (req, res) => {
  const name = req.query.name || 'anonymous';
  const since = parseInt(req.query.since) || 0;

  const t = ensureTerminal(name, { transport: 'poll', ip: req.ip });
  t.lastSeen = Date.now();

  const queue = (pollQueues.get(name) || []).filter(e => e.timestamp > since);
  if (queue.length > 0) {
    return res.json({ events: queue, clients: getClientList() });
  }

  const existing = pollWaiters.get(name);
  if (existing) { clearTimeout(existing.timer); pollWaiters.delete(name); }

  const timer = setTimeout(() => {
    pollWaiters.delete(name);
    try { res.json({ events: [], clients: getClientList() }); } catch {}
  }, 30000);

  pollWaiters.set(name, { res, since, timer });
  req.on('close', () => { clearTimeout(timer); pollWaiters.delete(name); });
});

// ─── API ────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  const online = [...terminals.values()].filter(t => t.status === 'online').length;
  const voices = [...terminals.values()].filter(t => t.voiceEnabled).map(t => t.name);
  const cache = getCacheStats();
  res.json({ status: 'ok', online, total: terminals.size, voiceTargets: voices, cache });
});

app.get('/api/clients', (req, res) => {
  res.json({ clients: getClientList() });
});

app.get('/api/registry', (req, res) => {
  res.json({ terminals: Object.fromEntries(terminals) });
});

app.get('/api/terminal/:name', (req, res) => {
  const t = terminals.get(req.params.name);
  if (!t) return res.status(404).json({ error: 'terminal not found' });
  res.json(t);
});

app.delete('/api/terminal/:name', (req, res) => {
  if (!terminals.has(req.params.name)) return res.status(404).json({ error: 'terminal not found' });
  deleteTerminal(req.params.name);
  res.json({ removed: req.params.name });
});

app.post('/api/voice-target', (req, res) => {
  const { name, enabled } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const t = ensureTerminal(name);
  t.voiceEnabled = !!enabled;
  saveRegistry();
  broadcastClientList();
  res.json({ name, voiceEnabled: t.voiceEnabled });
});

app.post('/api/notify', (req, res) => {
  const { text, eventType, target, broadcast: isBroadcast } = req.body;
  console.log(`[NOTIFY] ${eventType}: "${text}"${target ? ` -> ${target}` : ''}${isBroadcast ? ' [BROADCAST]' : ''}`);
  const ts = Date.now();
  broadcastAll({ type: 'notification', text, eventType, timestamp: ts }, false, target || null);
  broadcastAll({ type: 'speak', text, lang: 'es-MX', timestamp: ts }, !isBroadcast, target || null);
  res.json({ status: 'sent', broadcast: !!isBroadcast });
});

app.post('/api/tts', (req, res) => {
  const { text, target } = req.body;
  broadcastAll({ type: 'speak', text, lang: 'es-MX', timestamp: Date.now() }, true, target || null);
  res.json({ status: 'speaking' });
});

// ─── Chat entre terminales ──────────────────────────────────────────────
app.post('/api/message', (req, res) => {
  const { from, to, text } = req.body;
  if (!from || !to || !text) return res.status(400).json({ error: 'from, to, text required' });

  const chatEvent = { type: 'chat', from, text, timestamp: Date.now() };
  if (to === '*') {
    broadcastAllExcept(chatEvent, from);
  } else {
    if (!terminals.has(to)) return res.status(404).json({ error: `terminal '${to}' not found` });
    queueEvent(to, chatEvent);
    sendViaWS(to, chatEvent);
    wakePoller(to);
  }
  res.json({ status: 'sent', to, from });
});

app.get('/api/messages/:name', (req, res) => {
  const q = pollQueues.get(req.params.name) || [];
  const msgs = q.filter(e => e.type === 'chat').slice(-50);
  res.json({ messages: msgs });
});

// ─── Cache API ─────────────────────────────────────────────────────────
app.get('/api/cache', (req, res) => {
  const stats = getCacheStats();
  res.json({
    status: stats.files < CACHE_MAX_FILES && stats.sizeMB < CACHE_MAX_SIZE_MB ? 'ok' : 'warning',
    files: stats.files,
    sizeMB: stats.sizeMB,
    config: { maxFiles: CACHE_MAX_FILES, maxSizeMB: CACHE_MAX_SIZE_MB },
    errors: cacheErrors.slice(-10)
  });
});

app.delete('/api/cache', (req, res) => {
  const { text } = req.query;
  if (text) {
    const hash = crypto.createHash('md5').update(text).digest('hex');
    const p = path.join(CACHE_DIR, hash + '.wav');
    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
    res.json({ removed: text });
  } else {
    let removed = 0;
    try {
      const files = fs.readdirSync(CACHE_DIR);
      for (const f of files) { try { fs.unlinkSync(path.join(CACHE_DIR, f)); removed++; } catch {} }
    } catch {}
    cacheErrors = [];
    res.json({ removed: `${removed} archivos eliminados` });
  }
});

// ─── TTS ────────────────────────────────────────────────────────────────

app.get('/api/tts', (req, res) => {
  const text = req.query.text || '';
  if (!text) return res.status(400).json({ error: 'text required' });

  const cached = getCachedTTS(text);
  if (cached) { res.set('Content-Type', 'audio/wav'); return res.send(cached); }

  const tmpFile = '/tmp/tts_' + Date.now() + '.wav';
  const safeText = text.replace(/'/g, "'\\''");
  const kokoroPath = path.join(__dirname, 'venv', 'bin', 'python');
  const kokoroScript = path.join(__dirname, 'tts_kokoro.py');

  exec(`'${kokoroPath}' '${kokoroScript}' '${safeText}' > '${tmpFile}'`, { timeout: 120000 }, (errK) => {
    if (!errK && fs.existsSync(tmpFile)) {
      const data = fs.readFileSync(tmpFile); fs.unlinkSync(tmpFile);
      if (data.length > 100) { cacheTTS(text, data); res.set('Content-Type', 'audio/wav'); return res.send(data); }
    }
    exec(`espeak-ng -v es-mx -w '${tmpFile}' '${safeText}'`, { timeout: 5000 }, (errE) => {
      if (errE || !fs.existsSync(tmpFile)) { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); return res.status(500).json({ error: 'tts failed' }); }
      const data = fs.readFileSync(tmpFile); fs.unlinkSync(tmpFile);
      if (data.length > 100) { cacheTTS(text, data); res.set('Content-Type', 'audio/wav'); return res.send(data); }
      res.status(500).json({ error: 'tts empty' });
    });
  });
});

// ─── Stale client cleanup (marca offline, no borra) ────────────────────
setInterval(() => {
  const now = Date.now();
  terminals.forEach((t, name) => {
    if (t.status === 'online' && now - t.lastSeen > 300000) {
      const stillOnWS = [...wsClients.values()].some(n => n === name);
      const stillOnPoll = pollWaiters.has(name);
      if (!stillOnWS && !stillOnPoll) {
        console.log(`[CLEANUP] ${name} offline (5min timeout)`);
        t.status = 'offline';
        saveRegistry();
      }
    }
  });
}, 60000);

// ─── Start ──────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  const known = terminals.size;
  const voices = [...terminals.values()].filter(t => t.voiceEnabled).map(t => t.name);
  console.log(`\n  ╔══════════════════════════════════════╗`);
  console.log(`  ║   OpenCode Voice Nexus v2            ║`);
  console.log(`  ║   Puerto: ${PORT}                         ║`);
  console.log(`  ║   Terminales: ${known} conocidos                ║`);
  console.log(`  ║   Voz activa: ${voices.join(', ') || '(ninguno)'}      ║`);
  console.log(`  ╚══════════════════════════════════════╝\n`);
});
