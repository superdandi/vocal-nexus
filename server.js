const express = require('express');
const https = require('https');
const http = require('http');
const { WebSocketServer } = require('ws');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3777;
const HTTP_PORT = 3778;

let server;
const certPath = path.join(__dirname, '192.168.1.84+2.pem');
const keyPath = path.join(__dirname, '192.168.1.84+2-key.pem');

if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
  console.log('[HTTPS] SSL certificates found, starting HTTPS server');
  const options = {
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath)
  };
  server = https.createServer(options, app);
} else {
  console.log('[HTTP] No SSL certificates, starting HTTP server');
  server = http.createServer(app);
}

const wss = new WebSocketServer({ server });

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
let wsClients = new Map();

function getClientList() {
  return [...clients.entries()].map(([name, c]) => ({
    name, connected: c.connected, voiceEnabled: voiceTargets.has(name)
  }));
}

function broadcastClientList() {
  const event = { type: 'clients', clients: getClientList(), voiceTargets: [...voiceTargets] };
  wsClients.forEach((ws, name) => { try { ws.send(JSON.stringify(event)); } catch {} });
}

function broadcast(event, voiceOnly = false, targetName = null) {
  wsClients.forEach((ws, name) => {
    if (targetName && name !== targetName) return;
    if (voiceOnly && !voiceTargets.has(name)) return;
    try { ws.send(JSON.stringify(event)); } catch {}
  });
}

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
  wsClients.delete(name);
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

  broadcast({ type: 'notification', text, eventType, timestamp: ts }, false, target || null);
  broadcast({ type: 'speak', text, lang: 'es-MX', timestamp: ts }, !isBroadcast, target || null);

  res.json({ status: 'sent', broadcast: !!isBroadcast });
});

app.post('/api/tts', (req, res) => {
  const { text, target } = req.body;
  broadcast({ type: 'speak', text, lang: 'es-MX', timestamp: Date.now() }, true, target || null);
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

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const name = url.searchParams.get('name') || 'anonymous';
  console.log(`[WS] Connected: ${name}`);

  clients.set(name, { name, connected: true, voiceEnabled: voiceTargets.has(name), lastSeen: Date.now() });
  wsClients.set(name, ws);

  ws.send(JSON.stringify({ type: 'connected', clients: getClientList(), voiceTargets: [...voiceTargets] }));
  broadcastClientList();

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'speak') {
        broadcast({ type: 'speak', text: msg.text, lang: 'es-MX', timestamp: Date.now() }, true);
      } else if (msg.type === 'listen') {
        broadcast({ type: 'listening', active: msg.active });
      }
    } catch (e) {}
  });

  ws.on('close', () => {
    console.log(`[WS] Disconnected: ${name}`);
    if (clients.has(name)) clients.get(name).connected = false;
    wsClients.delete(name);
    broadcastClientList();
  });

  ws.on('pong', () => {
    if (clients.has(name)) clients.get(name).lastSeen = Date.now();
  });
});

// WebSocket heartbeat
setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('connection', (ws) => { ws.isAlive = true; });

// Cleanup stale clients
setInterval(() => {
  const now = Date.now();
  clients.forEach((client, name) => {
    if (now - client.lastSeen > 300000) { clients.delete(name); wsClients.delete(name); }
  });
}, 60000);

// EVI WebSocket
const eviWss = new WebSocketServer({ server, path: '/ws/evi' });
eviWss.on('connection', (ws) => { ws.send(JSON.stringify({ type: 'evi_ready' })); ws.on('close', () => {}); });

// HTTP fallback server for health checks and backward compatibility
const httpApp = express();
httpApp.get('/{path}', (req, res) => {
  res.redirect(`https://192.168.1.84:${PORT}${req.path}`);
});
httpApp.get('/', (req, res) => {
  res.redirect(`https://192.168.1.84:${PORT}/`);
});
const httpServer = http.createServer(httpApp);
httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
  console.log(`  [HTTP] Redirect server on port ${HTTP_PORT}`);
});

server.listen(PORT, '0.0.0.0', () => {
  const proto = fs.existsSync(certPath) ? 'https' : 'http';
  console.log(`\n  ╔══════════════════════════════════════╗`);
  console.log(`  ║   OpenCode Voice Nexus               ║`);
  console.log(`  ║   Puerto: ${PORT} (${proto.toUpperCase()})              ║`);
  console.log(`  ║   ${proto}://192.168.1.84:${PORT}           ║`);
  console.log(`  ╚══════════════════════════════════════╝\n`);
});
