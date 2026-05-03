/**
 * CreeperCloud — Broker Server
 * =============================
 * Runs on a cheap VPS or free tier (Railway, Render, Fly.io).
 * Matches player requests to available volunteer hosts,
 * and sets up tunneling so players can reach the host's Minecraft server.
 *
 * Usage:
 *   npm install ws uuid
 *   node broker.js
 *
 * Environment variables:
 *   PORT          HTTP/WS port (default: 8080)
 *   SECRET        Shared secret for host auth (optional)
 */

const { WebSocketServer, WebSocket } = require('ws');
const http = require('http');
const { randomUUID } = require('crypto');

const PORT = parseInt(process.env.PORT || '8080');

// ── State ────────────────────────────────────────────────────────────────────
const hosts = new Map();     // hostId → { ws, region, slots, info }
const players = new Map();   // sessionId → { ws, hostId, status }
const sessions = new Map();  // sessionId → full session object

// ── HTTP server (health check + REST API) ───────────────────────────────────
const httpServer = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.url === '/api/stats') {
    const activeHosts = [...hosts.values()].filter(h => h.slots > 0).length;
    const totalSlots = [...hosts.values()].reduce((s, h) => s + h.slots, 0);
    const runningSessions = [...sessions.values()].filter(s => s.status === 'running').length;
    const totalPlayers = [...sessions.values()].reduce((s, sess) => s + (sess.playerCount || 0), 0);
    res.end(JSON.stringify({ activeHosts, totalSlots, runningSessions, totalPlayers }));
    return;
  }

  if (req.url === '/api/request' && req.method === 'POST') {
    // Player requesting a server via REST
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const opts = JSON.parse(body || '{}');
        const result = matchHost(opts);
        if (!result) {
          res.statusCode = 503;
          res.end(JSON.stringify({ error: 'No hosts available', retry: true }));
          return;
        }
        res.end(JSON.stringify(result));
      } catch {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'Bad request' }));
      }
    });
    return;
  }

  if (req.url === '/health') {
    res.end(JSON.stringify({ status: 'ok', hosts: hosts.size, sessions: sessions.size }));
    return;
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ error: 'Not found' }));
});

// ── WebSocket server ─────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws, req) => {
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  log(`New connection from ${clientIp}`);
  ws.clientId = randomUUID();
  ws.role = null;

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); }
    catch { return ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' })); }

    handleMessage(ws, msg);
  });

  ws.on('close', () => handleDisconnect(ws));
  ws.on('error', (err) => log(`WS error [${ws.clientId}]: ${err.message}`));

  // Ping keepalive
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
});

// Heartbeat to detect dead connections
setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

// ── Message handler ──────────────────────────────────────────────────────────
function handleMessage(ws, msg) {
  switch (msg.type) {
    // ── Host registration ──
    case 'register': {
      if (msg.role !== 'host') break;
      const hostId = randomUUID();
      ws.role = 'host';
      ws.hostId = hostId;
      hosts.set(hostId, {
        ws,
        hostId,
        region: msg.region || 'UNKNOWN',
        slots: msg.availableSlots || 1,
        maxServers: msg.maxServers || 1,
        ramPerServerMB: msg.ramPerServerMB || 1024,
        systemInfo: msg.systemInfo || {},
        connectedAt: Date.now(),
      });
      ws.send(JSON.stringify({ type: 'registered', hostId }));
      log(`Host registered: ${hostId} [${msg.region}] slots=${msg.availableSlots}`);
      break;
    }

    // ── Host: slot update ──
    case 'update_slots': {
      if (ws.role !== 'host') break;
      const h = hosts.get(ws.hostId);
      if (h) { h.slots = msg.availableSlots; }
      break;
    }

    // ── Host: server ready ──
    case 'server_ready': {
      const sess = sessions.get(msg.sessionId);
      if (!sess) break;
      sess.status = 'running';
      sess.port = msg.port;
      // Notify player
      const playerWs = players.get(msg.sessionId)?.ws;
      if (playerWs && playerWs.readyState === WebSocket.OPEN) {
        playerWs.send(JSON.stringify({
          type: 'server_ready',
          sessionId: msg.sessionId,
          ip: `${sess.hostPublicIp}:${msg.port}`,
        }));
      }
      log(`Server ready: session=${msg.sessionId} port=${msg.port}`);
      break;
    }

    // ── Host: server stopped ──
    case 'server_stopped': {
      cleanupSession(msg.sessionId);
      break;
    }

    // ── Host: pong ──
    case 'pong': {
      const h = hosts.get(ws.hostId);
      if (h) h.slots = msg.activeServers !== undefined ? (h.maxServers - msg.activeServers) : h.slots;
      break;
    }

    // ── Host: start_server error ──
    case 'start_server_error': {
      log(`Host refused session ${msg.sessionId}: ${msg.reason}`);
      cleanupSession(msg.sessionId);
      // Retry with different host?
      break;
    }

    // ── Player: request via WS ──
    case 'request_server': {
      ws.role = 'player';
      const result = matchHost(msg);
      if (!result) {
        ws.send(JSON.stringify({ type: 'error', message: 'No hosts available right now. Try again in a moment.' }));
        return;
      }
      players.set(result.sessionId, { ws, hostId: result.hostId });
      ws.send(JSON.stringify({ type: 'queued', sessionId: result.sessionId, message: 'Host found. Starting server...' }));
      break;
    }

    default:
      log(`Unknown message type: ${msg.type}`);
  }
}

// ── Matchmaking ──────────────────────────────────────────────────────────────
function matchHost(opts = {}) {
  const { region, maxPlayers = 5, version = '1.21.4', gameMode = 'survival' } = opts;

  // Find best available host
  let candidates = [...hosts.values()].filter(h => h.slots > 0 && h.ws.readyState === WebSocket.OPEN);

  // Prefer region match
  if (region) {
    const regional = candidates.filter(h => h.region === region);
    if (regional.length > 0) candidates = regional;
  }

  if (candidates.length === 0) return null;

  // Pick the host with most slots (load balance)
  candidates.sort((a, b) => b.slots - a.slots);
  const host = candidates[0];

  const sessionId = randomUUID();
  sessions.set(sessionId, {
    sessionId,
    hostId: host.hostId,
    status: 'starting',
    playerCount: 0,
    startTime: Date.now(),
    hostPublicIp: host.systemInfo?.publicIp || 'mc.creepercloud.io',
  });

  // Decrement slot immediately to avoid double-assignment
  host.slots = Math.max(0, host.slots - 1);

  // Tell host to start server
  host.ws.send(JSON.stringify({
    type: 'start_server',
    sessionId,
    version,
    maxPlayers,
    gameMode,
  }));

  log(`Matched session ${sessionId} → host ${host.hostId} [${host.region}]`);
  return { sessionId, hostId: host.hostId, status: 'starting' };
}

// ── Cleanup ──────────────────────────────────────────────────────────────────
function handleDisconnect(ws) {
  if (ws.role === 'host' && ws.hostId) {
    log(`Host disconnected: ${ws.hostId}`);
    hosts.delete(ws.hostId);
    // Clean up any sessions this host was running
    for (const [sessionId, sess] of sessions) {
      if (sess.hostId === ws.hostId) cleanupSession(sessionId);
    }
  }
  if (ws.role === 'player') {
    // Find and clean up their session
    for (const [sessionId, p] of players) {
      if (p.ws === ws) {
        // Tell host to stop server
        const sess = sessions.get(sessionId);
        if (sess) {
          const host = hosts.get(sess.hostId);
          if (host && host.ws.readyState === WebSocket.OPEN) {
            host.ws.send(JSON.stringify({ type: 'stop_server', sessionId }));
          }
        }
        cleanupSession(sessionId);
        break;
      }
    }
  }
}

function cleanupSession(sessionId) {
  sessions.delete(sessionId);
  players.delete(sessionId);
}

// ── Logging ──────────────────────────────────────────────────────────────────
function log(msg) {
  const t = new Date().toISOString().slice(11, 19);
  console.log(`[${t}] ${msg}`);
}

// ── Start ────────────────────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
  log(`CreeperCloud Broker listening on port ${PORT}`);
  log(`WebSocket: ws://0.0.0.0:${PORT}`);
  log(`Stats API: http://0.0.0.0:${PORT}/api/stats`);
});
