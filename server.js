const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { execFile } = require('child_process');
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

const notificationQueues = new Map();
const pollWaiters = new Map();
const POLL_TIMEOUT = 30000;

function queueNotification(name, event) {
  if (!notificationQueues.has(name)) {
    notificationQueues.set(name, []);
  }
  const queue = notificationQueues.get(name);
  queue.push(event);
  if (queue.length > 100) queue.shift();
}

function getQueuedNotifications(name, since) {
  const queue = notificationQueues.get(name) || [];
  return queue.filter(e => e.timestamp > since);
}

function wakePoller(name) {
  const waiter = pollWaiters.get(name);
  if (waiter) {
    clearTimeout(waiter.timer);
    pollWaiters.delete(name);
    const queue = getQueuedNotifications(name, waiter.since);
    try {
      waiter.res.json({ events: queue, clients: getClientList(), voiceTargets: [...voiceTargets] });
    } catch {}
  }
}

app.get('/api/poll', (req, res) => {
  const name = req.query.name || 'anonymous';
  const since = parseInt(req.query.since) || 0;

  clients.set(name, {
    name,
    connected: true,
    voiceEnabled: voiceTargets.has(name),
    lastSeen: Date.now()
  });

  const queue = getQueuedNotifications(name, since);
  if (queue.length > 0) {
    clients.get(name).lastSeen = Date.now();
    return res.json({ events: queue, clients: getClientList(), voiceTargets: [...voiceTargets] });
  }

  const existing = pollWaiters.get(name);
  if (existing) {
    clearTimeout(existing.timer);
    pollWaiters.delete(name);
  }

  const timer = setTimeout(() => {
    pollWaiters.delete(name);
    if (clients.has(name)) clients.get(name).lastSeen = Date.now();
    try {
      res.json({ events: [], clients: getClientList(), voiceTargets: [...voiceTargets] });
    } catch {}
  }, POLL_TIMEOUT);

  pollWaiters.set(name, { res, since, timer });

  req.on('close', () => {
    clearTimeout(timer);
    pollWaiters.delete(name);
  });
});

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

  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch {}
  }, 6000);

  req.on('close', () => {
    clearInterval(heartbeat);
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
  const event = {
    type: 'clients',
    clients: getClientList(),
    voiceTargets: [...voiceTargets]
  };
  const data = `data: ${JSON.stringify(event)}\n\n`;
  sseClients.forEach((res, name) => {
    try { res.write(data); } catch {}
  });
  clients.forEach((c, name) => {
    queueNotification(name, event);
    wakePoller(name);
  });
}

function broadcast(event, voiceOnly = false, targetName = null) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  sseClients.forEach((res, name) => {
    if (targetName && name !== targetName) return;
    if (voiceOnly && !voiceTargets.has(name)) return;
    try { res.write(data); } catch {}
  });
  clients.forEach((c, name) => {
    if (targetName && name !== targetName) return;
    if (voiceOnly && !voiceTargets.has(name)) return;
    queueNotification(name, event);
    wakePoller(name);
  });
}

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', clients: clients.size, voiceTargets: [...voiceTargets] });
});

app.get('/api/clients', (req, res) => {
  res.json({
    clients: getClientList(),
    voiceTargets: [...voiceTargets]
  });
});

app.delete('/api/client/:name', (req, res) => {
  const { name } = req.params;
  clients.delete(name);
  sseClients.delete(name);
  notificationQueues.delete(name);
  const waiter = pollWaiters.get(name);
  if (waiter) { clearTimeout(waiter.timer); pollWaiters.delete(name); }
  voiceTargets.delete(name);
  saveState();
  broadcastClientList();
  res.json({ removed: name });
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
  const { text, eventType, target, broadcast: isBroadcast } = req.body;
  console.log(`[NOTIFY] ${eventType}: "${text}"${target ? ` → ${target}` : ''}${isBroadcast ? ' [BROADCAST]' : ''}`);

  const ts = Date.now();

  broadcast({
    type: 'notification',
    text,
    eventType,
    timestamp: ts
  }, false, target || null);

  broadcast({
    type: 'speak',
    text,
    lang: 'es-MX',
    timestamp: ts
  }, !isBroadcast, target || null);

  res.json({ status: 'sent', broadcast: !!isBroadcast });
});

app.post('/api/tts', (req, res) => {
  const { text, target } = req.body;
  broadcast({ type: 'speak', text, lang: 'es-MX', timestamp: Date.now() }, true, target || null);
  res.json({ status: 'speaking' });
});

app.get('/api/tts', (req, res) => {
  const text = req.query.text || '';
  if (!text) return res.status(400).json({ error: 'text required' });

  const kokoroPath = path.join(__dirname, 'venv', 'bin', 'python');
  const kokoroScript = path.join(__dirname, 'tts_kokoro.py');

  execFile(kokoroPath, [kokoroScript, text], { encoding: 'buffer', maxBuffer: 1024 * 1024, timeout: 30000 }, (err, stdout) => {
    if (!err && stdout && stdout.length > 100) {
      console.log(`[TTS] Kokoro OK (${stdout.length} bytes)`);
      res.set('Content-Type', 'audio/wav');
      return res.send(stdout);
    }
    console.log('[TTS] Kokoro failed, falling back to espeak-ng');
    execFile('espeak-ng', ['-v', 'es-mx', '--stdout', text], { encoding: 'buffer', maxBuffer: 1024 * 1024 }, (err2, stdout2) => {
      if (err2) {
        console.log('[TTS] espeak-ng error:', err2.message);
        return res.status(500).json({ error: 'tts failed' });
      }
      console.log(`[TTS] espeak-ng OK (${stdout2.length} bytes)`);
      res.set('Content-Type', 'audio/wav');
      res.send(stdout2);
    });
  });
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
        broadcast({ type: 'speak', text: msg.text, lang: 'es-MX', timestamp: Date.now() }, true);
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
      notificationQueues.delete(name);
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
