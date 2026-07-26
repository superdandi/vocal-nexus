const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3777;

// Static files
app.use(express.static(path.join(__dirname)));
app.use(express.json({ limit: '50mb' }));

// State
let clients = new Map();
let activeTargets = [];
let outputMode = 'dual';
let eviAvailable = false;

// SSE connections
const sseClients = new Map();

app.get('/events', (req, res) => {
  const name = req.query.name || 'anonymous';
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });

  clients.set(name, { name, connected: true, lastSeen: Date.now() });
  sseClients.set(name, res);

  // Send initial state
  res.write(`data: ${JSON.stringify({
    type: 'connected',
    clients: Array.from(clients.keys()),
    activeTargets,
    eviAvailable
  })}\n\n`);

  // Broadcast updated client list
  broadcastClients();

  req.on('close', () => {
    sseClients.delete(name);
    clients.delete(name);
    broadcastClients();
  });
});

function broadcast(event, targetName) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  if (targetName) {
    const res = sseClients.get(targetName);
    if (res) res.write(data);
  } else {
    sseClients.forEach((res) => res.write(data));
  }
}

function broadcastClients() {
  broadcast({
    type: 'clients',
    clients: Array.from(clients.keys()),
    activeTargets
  });
}

// API endpoints
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', eviAvailable, clients: clients.size });
});

app.get('/api/clients', (req, res) => {
  res.json({
    clients: Array.from(clients.keys()),
    activeTargets
  });
});

app.post('/api/output', (req, res) => {
  outputMode = req.body.mode || outputMode;
  broadcast({ type: 'output_mode', mode: outputMode });
  res.json({ mode: outputMode });
});

app.post('/api/active-target', (req, res) => {
  const { name } = req.body;
  const idx = activeTargets.indexOf(name);
  if (idx >= 0) {
    activeTargets.splice(idx, 1);
  } else {
    activeTargets.push(name);
  }
  broadcast({ type: 'active_targets', targets: activeTargets });
  res.json({ targets: activeTargets });
});

// TTS endpoint (placeholder - returns empty audio)
app.get('/api/tts', (req, res) => {
  const text = req.query.text || '';
  console.log(`[TTS] Request: "${text}"`);
  // Return silence WAV (16kHz, 16-bit, mono)
  const sampleRate = 16000;
  const duration = Math.min(text.length * 0.05, 10);
  const numSamples = Math.floor(sampleRate * duration);
  const dataSize = numSamples * 2;
  const buffer = Buffer.alloc(44 + dataSize);

  // WAV header
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

// STT from browser (placeholder)
app.post('/api/stt-from-browser', (req, res) => {
  console.log('[STT] Received browser audio');
  res.json({ text: '', status: 'received' });
});

// WebSocket server
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const name = url.searchParams.get('name') || 'anonymous';
  console.log(`[WS] Client connected: ${name}`);

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      console.log(`[WS] Message from ${name}:`, msg.type);

      if (msg.type === 'speak') {
        broadcast({ type: 'speak', text: msg.text }, msg.target);
      } else if (msg.type === 'listen') {
        broadcast({ type: 'listening', active: msg.active }, msg.target);
      } else if (msg.type === 'start_mic') {
        broadcast({ type: 'start_mic', timeout: msg.timeout || 10 }, msg.target);
      }
    } catch (e) {
      console.error('[WS] Parse error:', e.message);
    }
  });

  ws.on('close', () => {
    console.log(`[WS] Client disconnected: ${name}`);
  });
});

// EVI WebSocket (separate path)
const eviWss = new WebSocketServer({ server, path: '/ws/evi' });

eviWss.on('connection', (ws) => {
  console.log('[EVI] Client connected');
  ws.send(JSON.stringify({ type: 'evi_ready' }));

  ws.on('close', () => {
    console.log('[EVI] Client disconnected');
  });
});

// Cleanup stale clients every 30s
setInterval(() => {
  const now = Date.now();
  clients.forEach((client, name) => {
    if (now - client.lastSeen > 60000) {
      clients.delete(name);
      sseClients.delete(name);
    }
  });
}, 30000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  ╔══════════════════════════════════════╗`);
  console.log(`  ║   OPencode Voice Nexus               ║`);
  console.log(`  ║   Server running on port ${PORT}        ║`);
  console.log(`  ║   http://localhost:${PORT}              ║`);
  console.log(`  ╚══════════════════════════════════════╝\n`);
});
