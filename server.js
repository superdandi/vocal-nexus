const express = require('express');
const http = require('http');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3777;

app.use(express.static(path.join(__dirname)));
app.use(express.json({ limit: '50mb', verify: (req, res, buf) => {} }));

const DATA_FILE = path.join(__dirname, 'voice-state.json');
const CACHE_DIR = path.join(__dirname, 'cache');

function loadState() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return { voiceTargets: [] }; }
}
function saveState() { fs.writeFileSync(DATA_FILE, JSON.stringify({ voiceTargets: [...voiceTargets] })); }

let state = loadState();
let voiceTargets = new Set(state.voiceTargets);
let clients = new Map();
let pollQueues = new Map();
let pollWaiters = new Map();

function getClientList() {
  return [...clients.entries()].map(([name, c]) => ({
    name, connected: c.connected, voiceEnabled: voiceTargets.has(name)
  }));
}

function queueEvent(name, event) {
  if (!pollQueues.has(name)) pollQueues.set(name, []);
  const q = pollQueues.get(name);
  q.push(event);
  if (q.length > 100) q.shift();
}

function broadcastAll(event, voiceOnly = false, targetName = null) {
  clients.forEach((c, name) => {
    if (targetName && name !== targetName) return;
    if (voiceOnly && !voiceTargets.has(name)) return;
    queueEvent(name, event);
    wakePoller(name);
  });
}

function broadcastClientList() {
  const event = { type: 'clients', clients: getClientList(), voiceTargets: [...voiceTargets] };
  broadcastAll(event);
}

function wakePoller(name) {
  const w = pollWaiters.get(name);
  if (w) {
    clearTimeout(w.timer);
    pollWaiters.delete(name);
    const queue = (pollQueues.get(name) || []).filter(e => e.timestamp > w.since);
    console.log(`[WAKE] ${name}: ${queue.length} events`);
    try { w.res.json({ events: queue, clients: getClientList(), voiceTargets: [...voiceTargets] }); } catch {}
  }
}

// Long polling endpoint
app.get('/api/poll', (req, res) => {
  const name = req.query.name || 'anonymous';
  const since = parseInt(req.query.since) || 0;

  clients.set(name, { name, connected: true, voiceEnabled: voiceTargets.has(name), lastSeen: Date.now() });

  const queue = (pollQueues.get(name) || []).filter(e => e.timestamp > since);
  if (queue.length > 0) {
    clients.get(name).lastSeen = Date.now();
    console.log(`[POLL] ${name}: ${queue.length} events immediately`);
    return res.json({ events: queue, clients: getClientList(), voiceTargets: [...voiceTargets] });
  }

  const existing = pollWaiters.get(name);
  if (existing) { clearTimeout(existing.timer); pollWaiters.delete(name); }

  const timer = setTimeout(() => {
    pollWaiters.delete(name);
    if (clients.has(name)) clients.get(name).lastSeen = Date.now();
    try { res.json({ events: [], clients: getClientList(), voiceTargets: [...voiceTargets] }); } catch {}
  }, 30000);

  pollWaiters.set(name, { res, since, timer });
  req.on('close', () => { clearTimeout(timer); pollWaiters.delete(name); });
});

// HTTP API endpoints
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', clients: clients.size, voiceTargets: [...voiceTargets] });
});

app.get('/api/clients', (req, res) => {
  res.json({ clients: getClientList(), voiceTargets: [...voiceTargets] });
});

app.delete('/api/client/:name', (req, res) => {
  const { name } = req.params;
  clients.delete(name);
  pollQueues.delete(name);
  const w = pollWaiters.get(name);
  if (w) { clearTimeout(w.timer); pollWaiters.delete(name); }
  voiceTargets.delete(name);
  saveState();
  broadcastClientList();
  res.json({ removed: name });
});

app.post('/api/voice-target', (req, res) => {
  const { name, enabled } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  if (enabled) { voiceTargets.add(name); } else { voiceTargets.delete(name); }
  if (clients.has(name)) { clients.get(name).voiceEnabled = enabled; }
  saveState();
  broadcastClientList();
  res.json({ name, voiceEnabled: enabled, voiceTargets: [...voiceTargets] });
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

// TTS endpoint with cache
function getCachedTTS(text) {
  const hash = crypto.createHash('md5').update(text).digest('hex');
  const p = path.join(CACHE_DIR, hash + '.wav');
  try { if (fs.existsSync(p)) return fs.readFileSync(p); } catch {} return null;
}
function cacheTTS(text, wav) {
  try { const h = crypto.createHash('md5').update(text).digest('hex'); fs.writeFileSync(path.join(CACHE_DIR, h + '.wav'), wav); } catch {}
}

app.get('/api/tts', (req, res) => {
  const text = req.query.text || '';
  if (!text) return res.status(400).json({ error: 'text required' });

  const cached = getCachedTTS(text);
  if (cached) { res.set('Content-Type', 'audio/wav'); return res.send(cached); }

  const tmpFile = '/tmp/tts_' + Date.now() + '.wav';
  const safeText = text.replace(/'/g, "'\\''");
  exec(`espeak-ng -v es-mx -w '${tmpFile}' '${safeText}'`, { timeout: 5000 }, (err) => {
    if (!err && fs.existsSync(tmpFile)) {
      const data = fs.readFileSync(tmpFile);
      fs.unlinkSync(tmpFile);
      if (data.length > 100) { cacheTTS(text, data); res.set('Content-Type', 'audio/wav'); return res.send(data); }
    }
    const kokoroPath = path.join(__dirname, 'venv', 'bin', 'python');
    const kokoroScript = path.join(__dirname, 'tts_kokoro.py');
    exec(`'${kokoroPath}' '${kokoroScript}' '${safeText}' > '${tmpFile}'`, { timeout: 30000 }, (err2) => {
      if (err2 || !fs.existsSync(tmpFile)) { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); return res.status(500).json({ error: 'tts failed' }); }
      const data = fs.readFileSync(tmpFile); fs.unlinkSync(tmpFile);
      cacheTTS(text, data);
      res.set('Content-Type', 'audio/wav'); res.send(data);
    });
  });
});

// Cleanup stale clients
setInterval(() => {
  const now = Date.now();
  clients.forEach((client, name) => {
    if (now - client.lastSeen > 300000) { clients.delete(name); pollQueues.delete(name); }
  });
}, 60000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  ╔══════════════════════════════════════╗`);
  console.log(`  ║   OpenCode Voice Nexus               ║`);
  console.log(`  ║   Puerto: ${PORT}                         ║`);
  console.log(`  ║   http://192.168.1.84:${PORT}           ║`);
  console.log(`  ╚══════════════════════════════════════╝\n`);
});
