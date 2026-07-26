const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3777;

app.use(express.static(path.join(__dirname)));
app.use(express.json({ limit: '50mb' }));

const DATA_FILE = path.join(__dirname, 'voice-state.json');

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return { voiceTargets: [] };
  }
}

function saveState() {
  fs.writeFileSync(DATA_FILE, JSON.stringify({ voiceTargets: [...voiceTargets] }));
}

let state = loadState();
let voiceTargets = new Set(state.voiceTargets);
let clients = new Map();
const sseClients = new Map();

app.get('/events', (req, res) => {
  const name = req.query.name || 'anonymous';
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });

  clients.set(name, {
    name,
    connected: true,
    voiceEnabled: voiceTargets.has(name),
    lastSeen: Date.now()
  });
  sseClients.set(name, res);

  res.write(`data: ${JSON.stringify({
    type: 'connected',
    clients: getClientList(),
    voiceTargets: [...voiceTargets]
  })}\n\n`);

  broadcastClientList();

  req.on('close', () => {
    if (clients.has(name)) {
      clients.get(name).connected = false;
    }
    sseClients.delete(name);
    broadcastClientList();
  });
});

function getClientList() {
  return [...clients.entries()].map(([name, c]) => ({
    name,
    connected: c.connected,
    voiceEnabled: voiceTargets.has(name)
  }));
}

function broadcastClientList() {
  broadcast({
    type: 'clients',
    clients: getClientList(),
    voiceTargets: [...voiceTargets]
  });
}

function broadcast(event, voiceOnly = false) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  sseClients.forEach((res, name) => {
    if (voiceOnly && !voiceTargets.has(name)) return;
    try { res.write(data); } catch {}
  });
}

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', clients: sseClients.size, voiceTargets: [...voiceTargets] });
});

app.get('/api/clients', (req, res) => {
  res.json({
    clients: getClientList(),
    voiceTargets: [...voiceTargets]
  });
});

app.post('/api/voice-target', (req, res) => {
  const { name, enabled } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });

  if (enabled) {
    voiceTargets.add(name);
  } else {
    voiceTargets.delete(name);
  }

  if (clients.has(name)) {
    clients.get(name).voiceEnabled = enabled;
  }

  saveState();
  broadcastClientList();
  res.json({ name, voiceEnabled: enabled, voiceTargets: [...voiceTargets] });
});

app.post('/api/notify', (req, res) => {
  const { text, eventType } = req.body;
  console.log(`[NOTIFY] ${eventType}: "${text}"`);

  broadcast({
    type: 'notification',
    text,
    eventType,
    timestamp: Date.now()
  });

  broadcast({
    type: 'speak',
    text,
    lang: 'es-MX'
  }, true);

  res.json({ status: 'sent' });
});

app.post('/api/tts', (req, res) => {
  const { text } = req.body;
  broadcast({ type: 'speak', text, lang: 'es-MX' }, true);
  res.json({ status: 'speaking' });
});

app.get('/api/tts', (req, res) => {
  const text = req.query.text || '';
  const sampleRate = 16000;
  const duration = Math.min(text.length * 0.05, 10);
  const numSamples = Math.floor(sampleRate * duration);
  const dataSize = numSamples * 2;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  res.set('Content-Type', 'audio/wav');
  res.send(buffer);
});

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const name = url.searchParams.get('name') || 'anonymous';
  console.log(`[WS] Client connected: ${name}`);

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'speak') {
        broadcast({ type: 'speak', text: msg.text, lang: 'es-MX' }, true);
      } else if (msg.type === 'listen') {
        broadcast({ type: 'listening', active: msg.active });
      }
    } catch (e) {}
  });

  ws.on('close', () => {
    console.log(`[WS] Client disconnected: ${name}`);
  });
});

const eviWss = new WebSocketServer({ server, path: '/ws/evi' });
eviWss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'evi_ready' }));
  ws.on('close', () => {});
});

setInterval(() => {
  const now = Date.now();
  clients.forEach((client, name) => {
    if (now - client.lastSeen > 300000) {
      clients.delete(name);
      sseClients.delete(name);
    }
  });
}, 60000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  ╔══════════════════════════════════════╗`);
  console.log(`  ║   OpenCode Voice Nexus               ║`);
  console.log(`  ║   Puerto: ${PORT}                         ║`);
  console.log(`  ║   http://192.168.1.84:${PORT}           ║`);
  console.log(`  ╚══════════════════════════════════════╝\n`);
});
