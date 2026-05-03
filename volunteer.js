#!/usr/bin/env node
/**
 * CreeperCloud — Volunteer Host Client
 * =====================================
 * Run this on your PC to donate spare resources for hosting Minecraft servers.
 * Tunneling is handled automatically via bore — no port forwarding needed.
 * A local web dashboard is served at http://localhost:7766
 *
 * Requirements:
 *   - Node.js 18+
 *   - Internet connection
 *   (Java, Paper MC, and bore are installed automatically!)
 *
 * Usage:
 *   node volunteer.js [options]
 *
 * Options:
 *   --ram <MB>           Max RAM per server (default: 1024)
 *   --max-servers <n>    Max concurrent servers (default: 1)
 *   --region <name>      Your region label (default: auto-detect)
 *   --broker <url>       Broker WebSocket URL
 *   --bore-server <host> Custom bore server (default: bore.pub)
 *   --auto-start         Immediately spin up a server on launch
 *   --no-broker          Run standalone without connecting to broker
 *   --ui-port <n>        Local dashboard port (default: 7766)
 */

// ── Bootstrap: ensure 'ws' is installed before doing anything else ─────────────
const { execSync, execFile, exec, spawn } = require('child_process');
const path  = require('path');
const fs    = require('fs');
const os    = require('os');
const https = require('https');
const http  = require('http');

function ensureWsPackage() {
  try { require.resolve('ws'); }
  catch {
    console.log('[setup] Installing required npm package: ws...');
    try { execSync('npm install ws --save', { stdio: 'inherit' }); console.log('[setup] ✓ ws installed\n'); }
    catch { console.error('✗ Failed to install "ws". Run: npm install ws'); process.exit(1); }
  }
}
ensureWsPackage();
const WebSocket = require('ws');

// ── Config ────────────────────────────────────────────────────────────────────
const args     = parseArgs(process.argv.slice(2));
const DATA_DIR = path.join(os.homedir(), '.creepercloud');
const JRE_DIR  = path.join(DATA_DIR, 'jre');

const CONFIG = {
  brokerUrl:  args['broker']      || 'wss://ezhost-production.up.railway.app',
  maxRamMB:   parseInt(args['ram'])         || 1024,
  maxServers: parseInt(args['max-servers']) || 1,
  region:     args['region']      || detectRegion(),
  boreServer: args['bore-server'] || 'bore.pub',
  autoStart:  !!args['auto-start'],
  noBroker:   !!args['no-broker'],
  uiPort:     parseInt(args['ui-port']) || 7766,
  dataDir:    DATA_DIR,
};

let JAVA_BIN = args['java'] || 'java';

// ── Platform maps ─────────────────────────────────────────────────────────────
const BORE_RELEASES = {
  'linux-x64':    { file: 'bore-v0.5.0-x86_64-unknown-linux-musl.tar.gz',  bin: 'bore' },
  'linux-arm64':  { file: 'bore-v0.5.0-aarch64-unknown-linux-musl.tar.gz', bin: 'bore' },
  'darwin-x64':   { file: 'bore-v0.5.0-x86_64-apple-darwin.tar.gz',        bin: 'bore' },
  'darwin-arm64': { file: 'bore-v0.5.0-aarch64-apple-darwin.tar.gz',       bin: 'bore' },
  'win32-x64':    { file: 'bore-v0.5.0-x86_64-pc-windows-msvc.zip',        bin: 'bore.exe' },
};
const BORE_BASE_URL = 'https://github.com/ekzhang/bore/releases/download/v0.5.0/';
const BORE_BIN_PATH = path.join(DATA_DIR, os.platform() === 'win32' ? 'bore.exe' : 'bore');

const MC_VERSION      = '1.21.4';
const PAPER_API_BASE  = `https://api.papermc.io/v2/projects/paper/versions/${MC_VERSION}/builds`;
const SERVER_JAR_PATH = path.join(DATA_DIR, `paper-${MC_VERSION}.jar`);

const ADOPTIUM_PLATFORM_MAP = {
  'linux-x64':    { os: 'linux',   arch: 'x64',    ext: 'tar.gz' },
  'linux-arm64':  { os: 'linux',   arch: 'aarch64', ext: 'tar.gz' },
  'darwin-x64':   { os: 'mac',     arch: 'x64',    ext: 'tar.gz' },
  'darwin-arm64': { os: 'mac',     arch: 'aarch64', ext: 'tar.gz' },
  'win32-x64':    { os: 'windows', arch: 'x64',    ext: 'zip'    },
};
const JAVA_VERSION = 21;

// ── State ─────────────────────────────────────────────────────────────────────
// sessionId → { mcProcess, tunnelProcess, localPort, publicHost, publicPort,
//               playerCount, startTime, consoleBuffer }
const activeServers = new Map();
let brokerWs = null;

// UI WebSocket server (for the local dashboard)
let uiWss = null;
const uiClients = new Set();

// ── Startup ───────────────────────────────────────────────────────────────────
async function main() {
  printBanner();
  ensureDataDir();
  await ensureJava();
  await ensureServerJar();
  await ensureBore();
  startLocalUI();
  if (!CONFIG.noBroker) connectToBroker();
  if (CONFIG.autoStart || CONFIG.noBroker) {
    log('\x1b[36m▶ Auto-starting server...\x1b[0m');
    await startMinecraftServer({ sessionId: makeId(), maxPlayers: 5, gameMode: 'survival' });
  }
}

function printBanner() {
  console.log('\x1b[32m');
  console.log('  ██████╗██████╗ ███████╗███████╗██████╗ ███████╗██████╗ ');
  console.log(' ██╔════╝██╔══██╗██╔════╝██╔════╝██╔══██╗██╔════╝██╔══██╗');
  console.log(' ██║     ██████╔╝█████╗  █████╗  ██████╔╝█████╗  ██████╔╝');
  console.log(' ██║     ██╔══██╗██╔══╝  ██╔══╝  ██╔═══╝ ██╔══╝  ██╔══██╗');
  console.log(' ╚██████╗██║  ██║███████╗███████╗██║     ███████╗██║  ██║');
  console.log('  ╚═════╝╚═╝  ╚═╝╚══════╝╚══════╝╚═╝     ╚══════╝╚═╝  ╚═╝');
  console.log('\x1b[0m');
  console.log('  \x1b[2mCreeperCloud Volunteer Host — Auto-Tunnel Edition\x1b[0m\n');
  console.log(`  RAM per server : \x1b[33m${CONFIG.maxRamMB}MB\x1b[0m`);
  console.log(`  Max servers    : \x1b[33m${CONFIG.maxServers}\x1b[0m`);
  console.log(`  Region         : \x1b[33m${CONFIG.region}\x1b[0m`);
  console.log(`  Broker         : \x1b[33m${CONFIG.noBroker ? 'disabled' : CONFIG.brokerUrl}\x1b[0m`);
  console.log(`  Tunnel via     : \x1b[33m${CONFIG.boreServer}\x1b[0m`);
  console.log(`  Dashboard      : \x1b[33mhttp://localhost:${CONFIG.uiPort}\x1b[0m\n`);
}

// ── Local HTTP + WebSocket dashboard ─────────────────────────────────────────
// Serves a minimal dashboard on localhost:7766 for the volunteer to see status
// and allows the server.html panel to connect locally without the broker.

function startLocalUI() {
  const httpServer = http.createServer((req, res) => {
    const url = req.url.split('?')[0];

    // ── REST API ──
    if (url === '/api/status') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      const servers = [...activeServers.entries()].map(([id, s]) => ({
        sessionId:   id,
        status:      s.publicHost ? 'online' : 'starting',
        ip:          s.publicHost ? `${s.publicHost}:${s.publicPort}` : null,
        localPort:   s.localPort,
        playerCount: s.playerCount,
        startTime:   s.startTime,
        ramMB:       CONFIG.maxRamMB,
      }));
      res.end(JSON.stringify({ servers, maxServers: CONFIG.maxServers }));
      return;
    }

    if (url.startsWith('/api/session/') && url.endsWith('/status')) {
      const id = url.split('/')[3];
      const s  = activeServers.get(id);
      res.writeHead(s ? 200 : 404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      if (!s) { res.end(JSON.stringify({ error: 'not found' })); return; }
      res.end(JSON.stringify({
        sessionId: id,
        status:    s.publicHost ? 'online' : 'starting',
        ip:        s.publicHost ? `${s.publicHost}:${s.publicPort}` : null,
        playerCount: s.playerCount,
        maxRamMB:  CONFIG.maxRamMB,
        uptimeMs:  Date.now() - s.startTime,
      }));
      return;
    }

    if (req.method === 'POST' && url === '/api/create') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', async () => {
        let opts = {};
        try { opts = JSON.parse(body || '{}'); } catch {}
        if (activeServers.size >= CONFIG.maxServers) {
          res.writeHead(503, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ error: 'at_capacity' })); return;
        }
        const sessionId = makeId();
        res.writeHead(202, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ sessionId, status: 'starting' }));
        await startMinecraftServer({ sessionId, maxPlayers: opts.maxPlayers || 5, gameMode: opts.gameMode || 'survival' });
      });
      return;
    }

    if (req.method === 'POST' && url.match(/^\/api\/session\/[^/]+\/stop$/)) {
      const id = url.split('/')[3];
      stopMinecraftServer(id);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // ── Dashboard HTML ──
    if (url === '/' || url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(localDashboardHtml());
      return;
    }

    res.writeHead(404); res.end('Not found');
  });

  // WebSocket server for local real-time console (panel can connect here directly)
  uiWss = new WebSocket.Server({ server: httpServer });

  uiWss.on('connection', (sock) => {
    uiClients.add(sock);
    // Send current state immediately on connect
    const servers = [...activeServers.entries()].map(([id, s]) => ({
      type:        'server_status',
      sessionId:   id,
      status:      s.publicHost ? 'online' : 'starting',
      ip:          s.publicHost ? `${s.publicHost}:${s.publicPort}` : null,
      playerCount: s.playerCount,
      ramMB:       CONFIG.maxRamMB,
    }));
    servers.forEach(msg => sock.send(JSON.stringify(msg)));

    // Replay last 200 console lines for each server
    for (const [id, s] of activeServers) {
      if (s.consoleBuffer) {
        for (const line of s.consoleBuffer.slice(-200)) {
          sock.send(JSON.stringify({ type: 'console_line', sessionId: id, line }));
        }
      }
    }

    sock.on('message', async (data) => {
      let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
      await handleLocalMessage(msg, sock);
    });

    sock.on('close', () => uiClients.delete(sock));
    sock.on('error', () => uiClients.delete(sock));
  });

  httpServer.listen(CONFIG.uiPort, '127.0.0.1', () => {
    log(`\x1b[32m✓ Local dashboard running at http://localhost:${CONFIG.uiPort}\x1b[0m`);
  });
}

// Handle messages from the local UI WebSocket (same protocol as broker)
async function handleLocalMessage(msg, sock) {
  switch (msg.type) {
    case 'attach_console': {
      const s = activeServers.get(msg.sessionId);
      if (!s) { sock.send(JSON.stringify({ type: 'session_not_found', sessionId: msg.sessionId })); return; }
      sock.send(JSON.stringify({ type: 'console_attached', sessionId: msg.sessionId }));
      break;
    }
    case 'send_command':
      sendCommandToServer(msg.sessionId, msg.command);
      break;
    case 'stop_server':
      await stopMinecraftServer(msg.sessionId);
      break;
    case 'restart_server':
      await restartMinecraftServer(msg.sessionId);
      break;
    case 'start_server':
      if (activeServers.size >= CONFIG.maxServers) {
        sock.send(JSON.stringify({ type: 'error', message: 'At capacity' })); return;
      }
      await startMinecraftServer({ sessionId: msg.sessionId || makeId(), maxPlayers: 5, gameMode: 'survival' });
      break;
  }
}

// Broadcast a message to all local UI clients (and optionally the broker too)
function broadcast(obj, { toBroker = false } = {}) {
  const json = JSON.stringify(obj);
  for (const client of uiClients) {
    if (client.readyState === WebSocket.OPEN) client.send(json);
  }
  if (toBroker) brokerSend(obj);
}

// ── Broker connection ─────────────────────────────────────────────────────────
function connectToBroker() {
  log('Connecting to CreeperCloud broker...');
  brokerWs = new WebSocket(CONFIG.brokerUrl, { headers: { 'User-Agent': 'CreeperCloud-Host/1.0' } });

  brokerWs.on('open', () => {
    log('\x1b[32m✓ Connected to broker\x1b[0m');
    brokerRegister();
  });

  brokerWs.on('message', async (data) => {
    let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
    await handleBrokerMessage(msg);
  });

  brokerWs.on('close', (code) => {
    log(`\x1b[33m⚠ Broker disconnected (${code}). Reconnecting in 5s...\x1b[0m`);
    setTimeout(connectToBroker, 5000);
  });

  brokerWs.on('error', (err) => log(`\x1b[31m✗ Broker error: ${err.message}\x1b[0m`));
}

function brokerRegister() {
  brokerSend({
    type: 'register', role: 'host',
    region:        CONFIG.region,
    maxServers:    CONFIG.maxServers,
    availableSlots: CONFIG.maxServers - activeServers.size,
    ramPerServerMB: CONFIG.maxRamMB,
    systemInfo: {
      platform:   os.platform(),
      arch:       os.arch(),
      totalRamMB: Math.floor(os.totalmem() / 1024 / 1024),
      cpuCores:   os.cpus().length,
    },
  });
}

async function handleBrokerMessage(msg) {
  switch (msg.type) {
    case 'registered':
      log(`\x1b[32m⚡ Registered as host [${msg.hostId}]\x1b[0m`);
      log('Waiting for server requests...\n');
      break;

    case 'start_server':
      if (activeServers.size >= CONFIG.maxServers) {
        brokerSend({ type: 'start_server_error', sessionId: msg.sessionId, reason: 'at_capacity' });
        return;
      }
      log(`\x1b[36m🎮 Server request! Session: ${msg.sessionId.slice(0, 8)}\x1b[0m`);
      await startMinecraftServer(msg);
      break;

    case 'stop_server':
      await stopMinecraftServer(msg.sessionId);
      break;

    // Broker is forwarding a player's send_command request
    case 'send_command':
      sendCommandToServer(msg.sessionId, msg.command);
      break;

    // Broker wants to attach a player's panel to this session's console
    case 'attach_console': {
      const s = activeServers.get(msg.sessionId);
      if (!s) { brokerSend({ type: 'session_not_found', sessionId: msg.sessionId }); return; }
      brokerSend({ type: 'console_attached', sessionId: msg.sessionId });
      // Replay last 200 buffered lines to the broker so the panel catches up
      if (s.consoleBuffer) {
        for (const line of s.consoleBuffer.slice(-200)) {
          brokerSend({ type: 'console_line', sessionId: msg.sessionId, line });
        }
      }
      break;
    }

    case 'ping':
      brokerSend({ type: 'pong', activeServers: activeServers.size });
      break;
  }
}

function brokerSend(obj) {
  if (brokerWs && brokerWs.readyState === WebSocket.OPEN) brokerWs.send(JSON.stringify(obj));
}

// ── Minecraft server lifecycle ────────────────────────────────────────────────
async function startMinecraftServer(req) {
  const { sessionId, maxPlayers = 5, gameMode = 'survival' } = req;
  const localPort = await findFreePort(25565);
  const serverDir = path.join(CONFIG.dataDir, 'servers', sessionId);
  fs.mkdirSync(serverDir, { recursive: true });

  fs.writeFileSync(path.join(serverDir, 'server.properties'), [
    `server-port=${localPort}`,
    `max-players=${maxPlayers}`,
    `gamemode=${gameMode}`,
    `online-mode=false`,
    `motd=CreeperCloud | Session ${sessionId.slice(0, 8)}`,
    `enable-rcon=false`,
    `view-distance=8`,
    `simulation-distance=6`,
    `spawn-protection=0`,
  ].join('\n'));

  fs.writeFileSync(path.join(serverDir, 'eula.txt'), 'eula=true\n');

  const jarDest = path.join(serverDir, 'server.jar');
  if (!fs.existsSync(jarDest)) fs.copyFileSync(SERVER_JAR_PATH, jarDest);

  log(`[${sessionId.slice(0,8)}] Starting Minecraft on local port ${localPort}...`);
  broadcast({ type: 'server_starting', sessionId }, { toBroker: true });

  const mcProc = execFile(JAVA_BIN, [
    `-Xmx${CONFIG.maxRamMB}M`, `-Xms256M`,
    '-XX:+UseG1GC', '-XX:+ParallelRefProcEnabled', '-XX:MaxGCPauseMillis=200',
    '-jar', 'server.jar', '--nogui',
  ], { cwd: serverDir, maxBuffer: 10 * 1024 * 1024 });

  activeServers.set(sessionId, {
    mcProcess:     mcProc,
    tunnelProcess: null,
    localPort,
    publicHost:    null,
    publicPort:    null,
    playerCount:   0,
    startTime:     Date.now(),
    consoleBuffer: [],   // ring buffer for panel catch-up
  });

  // ── stdout: forward every line to UI clients and broker ──
  let lineBuf = '';
  mcProc.stdout.on('data', async (data) => {
    lineBuf += data.toString();
    const lines = lineBuf.split('\n');
    lineBuf = lines.pop(); // keep incomplete line

    for (const rawLine of lines) {
      if (!rawLine.trim()) continue;

      // Buffer for late-connecting panels
      const s = activeServers.get(sessionId);
      if (s) {
        s.consoleBuffer.push(rawLine);
        if (s.consoleBuffer.length > 500) s.consoleBuffer.shift();
      }

      // Forward to all UI clients and to broker
      broadcast({ type: 'console_line', sessionId, line: rawLine }, { toBroker: true });

      // ── Parse meaningful events from the log ──
      if (rawLine.includes('Done') && rawLine.includes('For help')) {
        log(`[${sessionId.slice(0,8)}] Minecraft ready — opening bore tunnel...`);
        try {
          const { publicHost, publicPort, tunnelProcess } = await openTunnel(localPort);
          const sv = activeServers.get(sessionId);
          if (sv) {
            sv.tunnelProcess = tunnelProcess;
            sv.publicHost    = publicHost;
            sv.publicPort    = publicPort;
          }
          const ip = `${publicHost}:${publicPort}`;
          log(`[${sessionId.slice(0,8)}] \x1b[32m✓ Tunnel open → ${ip}\x1b[0m`);
          broadcast({ type: 'server_ready', sessionId, ip, region: CONFIG.region }, { toBroker: true });
          updateBrokerSlots();
        } catch (err) {
          log(`[${sessionId.slice(0,8)}] \x1b[31m✗ Tunnel failed: ${err.message}\x1b[0m`);
          brokerSend({ type: 'start_server_error', sessionId, reason: 'tunnel_failed' });
          await stopMinecraftServer(sessionId);
        }
      }

      // Player join / leave (parse name from log)
      const joinMatch = rawLine.match(/(\w+) joined the game/);
      if (joinMatch) {
        const sv = activeServers.get(sessionId);
        if (sv) sv.playerCount++;
        broadcast({ type: 'player_joined', sessionId, name: joinMatch[1] }, { toBroker: true });
      }

      const leaveMatch = rawLine.match(/(\w+) left the game/);
      if (leaveMatch) {
        const sv = activeServers.get(sessionId);
        if (sv) sv.playerCount = Math.max(0, sv.playerCount - 1);
        broadcast({ type: 'player_left', sessionId, name: leaveMatch[1] }, { toBroker: true });
      }
    }
  });

  mcProc.stderr.on('data', () => {}); // swallow JVM noise

  mcProc.on('exit', (code) => {
    log(`[${sessionId.slice(0,8)}] Server process exited (code ${code})`);
    const sv = activeServers.get(sessionId);
    if (sv?.tunnelProcess) { try { sv.tunnelProcess.kill(); } catch {} }
    activeServers.delete(sessionId);
    broadcast({ type: 'server_stopped', sessionId }, { toBroker: true });
    updateBrokerSlots();
    fs.rmSync(serverDir, { recursive: true, force: true });

    // If --auto-start and no other servers running, restart after a short delay
    if (CONFIG.autoStart && activeServers.size === 0) {
      log('\x1b[33m⚠ Auto-start: restarting server in 5s...\x1b[0m');
      setTimeout(() => startMinecraftServer({ sessionId: makeId(), maxPlayers: 5, gameMode: 'survival' }), 5000);
    }
  });
}

async function stopMinecraftServer(sessionId) {
  const s = activeServers.get(sessionId);
  if (!s) return;
  log(`[${sessionId.slice(0,8)}] Stopping server and closing tunnel...`);
  if (s.tunnelProcess) { try { s.tunnelProcess.kill(); } catch {} }
  try { s.mcProcess.stdin.write('stop\n'); } catch {}
  setTimeout(() => { try { s.mcProcess.kill('SIGKILL'); } catch {} }, 10000);
}

async function restartMinecraftServer(sessionId) {
  const s = activeServers.get(sessionId);
  if (!s) return;
  const opts = { sessionId, maxPlayers: 5, gameMode: 'survival' };
  await stopMinecraftServer(sessionId);
  // Wait for process to fully exit before restarting
  s.mcProcess.once('exit', async () => {
    await new Promise(r => setTimeout(r, 2000));
    await startMinecraftServer(opts);
  });
}

function sendCommandToServer(sessionId, command) {
  const s = activeServers.get(sessionId);
  if (!s) return;
  try { s.mcProcess.stdin.write(command.trim() + '\n'); } catch {}
}

function updateBrokerSlots() {
  brokerSend({ type: 'update_slots', availableSlots: CONFIG.maxServers - activeServers.size });
}

// ── Bore tunnel ───────────────────────────────────────────────────────────────
function openTunnel(localPort) {
  return new Promise((resolve, reject) => {
    const tunnelProc = spawn(BORE_BIN_PATH, ['local', String(localPort), '--to', CONFIG.boreServer]);
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) { tunnelProc.kill(); reject(new Error('Tunnel startup timed out (30s)')); }
    }, 30000);

    function tryParse(data) {
      const text = data.toString();
      const match = text.match(/listening at ([^\s:]+):(\d+)/i)
                 || text.match(/([a-z0-9.-]+\.pub):(\d+)/i)
                 || text.match(/bore\S*:(\d+)/i);
      if (match) {
        clearTimeout(timer); resolved = true;
        const publicHost = match[2] ? match[1] : CONFIG.boreServer;
        const publicPort = parseInt(match[2] || match[1]);
        resolve({ publicHost, publicPort, tunnelProcess: tunnelProc });
      }
    }
    tunnelProc.stdout.on('data', tryParse);
    tunnelProc.stderr.on('data', tryParse);
    tunnelProc.on('exit', (code) => { if (!resolved) { clearTimeout(timer); reject(new Error(`bore exited (${code})`)); } });
    tunnelProc.on('error', (err) => { if (!resolved) { clearTimeout(timer); reject(err); } });
  });
}

// ── Java installation ─────────────────────────────────────────────────────────
async function ensureJava() {
  const bundledJava = findBundledJavaBin();
  if (bundledJava) {
    const ver = await getJavaVersion(bundledJava);
    if (ver >= 17) { JAVA_BIN = bundledJava; log(`\x1b[32m✓ Using bundled Java ${ver}\x1b[0m`); return; }
  }
  const systemVer = await getJavaVersion(args['java'] || 'java').catch(() => 0);
  if (systemVer >= 17) { JAVA_BIN = args['java'] || 'java'; log(`\x1b[32m✓ System Java ${systemVer} detected\x1b[0m`); return; }
  if (systemVer > 0) log(`\x1b[33m⚠ System Java ${systemVer} too old. Downloading bundled JRE...\x1b[0m`);
  else               log('\x1b[33m⚠ Java not found. Downloading bundled JRE automatically...\x1b[0m');
  await downloadAndInstallJre();
  const newBin = findBundledJavaBin();
  if (!newBin) throw new Error('JRE install succeeded but binary not found.');
  const newVer = await getJavaVersion(newBin);
  JAVA_BIN = newBin;
  log(`\x1b[32m✓ Bundled Java ${newVer} installed\x1b[0m`);
}

function getJavaVersion(javaBin) {
  return new Promise((resolve) => {
    exec(`"${javaBin}" -version`, (err, stdout, stderr) => {
      if (err) return resolve(0);
      const m = (stderr || stdout).match(/version "(\d+)/);
      resolve(m ? parseInt(m[1]) : 0);
    });
  });
}

function findBundledJavaBin() {
  if (!fs.existsSync(JRE_DIR)) return null;
  const binName = os.platform() === 'win32' ? 'java.exe' : 'java';
  for (const entry of fs.readdirSync(JRE_DIR)) {
    for (const c of [
      path.join(JRE_DIR, entry, 'bin', binName),
      path.join(JRE_DIR, entry, 'Contents', 'Home', 'bin', binName),
      path.join(JRE_DIR, 'bin', binName),
    ]) { if (fs.existsSync(c)) return c; }
  }
  return null;
}

async function downloadAndInstallJre() {
  const platformKey = `${os.platform()}-${os.arch()}`;
  const info = ADOPTIUM_PLATFORM_MAP[platformKey];
  if (!info) { console.error(`\x1b[31m✗ No bundled JRE for ${platformKey}. Install Java ${JAVA_VERSION}+: https://adoptium.net\x1b[0m`); process.exit(1); }
  const apiUrl = `https://api.adoptium.net/v3/assets/latest/${JAVA_VERSION}/hotspot?architecture=${info.arch}&image_type=jre&os=${info.os}&vendor=eclipse`;
  log(`Fetching JRE download URL from Adoptium...`);
  const releaseInfo = await fetchJson(apiUrl);
  if (!Array.isArray(releaseInfo) || !releaseInfo.length) throw new Error('Adoptium returned no releases.');
  const pkg = releaseInfo[0]?.binary?.package;
  if (!pkg?.link) throw new Error('Could not parse JRE URL from Adoptium.');
  const archivePath = path.join(DATA_DIR, pkg.name);
  log(`Downloading Java ${JAVA_VERSION} JRE (${Math.round(pkg.size/1024/1024)}MB)...`);
  await downloadFile(pkg.link, archivePath, true);
  log('Extracting JRE...');
  fs.mkdirSync(JRE_DIR, { recursive: true });
  await new Promise((resolve, reject) => {
    const cmd = info.ext === 'zip'
      ? (os.platform() === 'win32' ? `powershell -Command "Expand-Archive -Path '${archivePath}' -DestinationPath '${JRE_DIR}' -Force"` : `unzip -o "${archivePath}" -d "${JRE_DIR}"`)
      : `tar -xzf "${archivePath}" -C "${JRE_DIR}"`;
    exec(cmd, (err) => err ? reject(new Error(`Extraction failed: ${err.message}`)) : resolve());
  });
  const newBin = findBundledJavaBin();
  if (newBin && os.platform() !== 'win32') fs.chmodSync(newBin, 0o755);
  fs.rmSync(archivePath, { force: true });
}

// ── Paper MC JAR ──────────────────────────────────────────────────────────────
async function ensureServerJar() {
  if (fs.existsSync(SERVER_JAR_PATH)) { log('\x1b[32m✓ Minecraft server JAR found\x1b[0m'); return; }
  log(`Fetching latest Paper ${MC_VERSION} build info...`);
  const data = await fetchJson(PAPER_API_BASE);
  const builds = data.builds;
  if (!Array.isArray(builds) || !builds.length) throw new Error('No Paper builds returned.');
  const latest = builds[builds.length - 1];
  const buildNumber = latest.build;
  const jarName = latest.downloads?.application?.name || `paper-${MC_VERSION}-${buildNumber}.jar`;
  const jarUrl = `${PAPER_API_BASE}/${buildNumber}/downloads/${jarName}`;
  log(`Downloading Paper Minecraft ${MC_VERSION} build #${buildNumber}...`);
  await downloadFile(jarUrl, SERVER_JAR_PATH, true);
  log('\x1b[32m✓ Server JAR downloaded\x1b[0m');
}

// ── Bore binary ───────────────────────────────────────────────────────────────
async function ensureBore() {
  if (fs.existsSync(BORE_BIN_PATH)) { log('\x1b[32m✓ bore tunnel binary found\x1b[0m'); return; }
  const platformKey = `${os.platform()}-${os.arch()}`;
  const release = BORE_RELEASES[platformKey];
  if (!release) { console.error(`\x1b[31m✗ No bore binary for ${platformKey}. Install manually: https://github.com/ekzhang/bore/releases\x1b[0m`); process.exit(1); }
  log(`Downloading bore for ${platformKey}...`);
  const archivePath = path.join(DATA_DIR, release.file);
  await downloadFile(BORE_BASE_URL + release.file, archivePath, true);
  await new Promise((resolve, reject) => {
    const cmd = release.file.endsWith('.zip')
      ? (os.platform() === 'win32' ? `powershell -Command "Expand-Archive -Path '${archivePath}' -DestinationPath '${DATA_DIR}' -Force"` : `unzip -o "${archivePath}" -d "${DATA_DIR}"`)
      : `tar -xzf "${archivePath}" -C "${DATA_DIR}"`;
    exec(cmd, (err) => err ? reject(err) : resolve());
  });
  if (os.platform() !== 'win32') fs.chmodSync(BORE_BIN_PATH, 0o755);
  fs.rmSync(archivePath, { force: true });
  log('\x1b[32m✓ bore installed\x1b[0m');
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const get = url.startsWith('https') ? https : http;
    get.get(url, { headers: { 'User-Agent': 'CreeperCloud-Host/1.0' } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) return fetchJson(res.headers.location).then(resolve).catch(reject);
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      let body = ''; res.on('data', c => body += c);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
      res.on('error', reject);
    }).on('error', reject);
  });
}

function downloadFile(url, dest, showProgress = false) {
  return new Promise((resolve, reject) => {
    const get = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(dest);
    get.get(url, { headers: { 'User-Agent': 'CreeperCloud-Host/1.0' } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close(() => fs.rmSync(dest, { force: true }));
        return downloadFile(res.headers.location, dest, showProgress).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) { file.close(() => fs.rmSync(dest, { force: true })); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const total = parseInt(res.headers['content-length'] || '0');
      let downloaded = 0, lastPct = -1;
      res.on('data', (chunk) => {
        downloaded += chunk.length; file.write(chunk);
        if (showProgress && total) {
          const pct = Math.floor((downloaded / total) * 100);
          if (pct !== lastPct) { lastPct = pct; const bar = '█'.repeat(Math.floor(pct/4)) + '░'.repeat(25-Math.floor(pct/4)); process.stdout.write(`\r  [${bar}] ${pct}%  (${(downloaded/1024/1024).toFixed(1)}MB)`); }
        }
      });
      res.on('end', () => { file.end(() => { if (showProgress) process.stdout.write('\n'); resolve(); }); });
      res.on('error', (err) => { file.close(() => fs.rmSync(dest, { force: true })); reject(err); });
    }).on('error', (err) => { file.close(() => fs.rmSync(dest, { force: true })); reject(err); });
  });
}

// ── Local dashboard HTML ──────────────────────────────────────────────────────
function localDashboardHtml() {
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>CreeperCloud Host Dashboard</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0d0d0d;color:#f0f0f0;font-family:'Courier New',monospace;padding:24px}
  h1{color:#a3ff47;font-size:1.4rem;margin-bottom:4px}
  .sub{color:#555;font-size:0.75rem;margin-bottom:24px}
  .card{background:#141414;border:1px solid #2a2a2a;border-radius:8px;padding:20px;margin-bottom:16px}
  .card h2{font-size:0.7rem;letter-spacing:.14em;color:#555;margin-bottom:14px}
  .row{display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid #1c1c1c}
  .row:last-child{border-bottom:none}
  .label{color:#888;font-size:.75rem}
  .val{color:#f0f0f0;font-size:.8rem}
  .val.green{color:#a3ff47}
  .val.yellow{color:#ffd447}
  .btn{background:#a3ff47;color:#0d0d0d;border:none;padding:8px 18px;border-radius:4px;font-family:inherit;font-size:.75rem;font-weight:700;cursor:pointer;margin-right:8px;margin-top:12px}
  .btn.danger{background:transparent;border:1px solid #ff4747;color:#ff4747}
  .ip{background:#0a0a0a;border:1px solid #a3ff47;border-radius:4px;padding:10px 14px;color:#a3ff47;font-size:.9rem;margin:10px 0;word-break:break-all}
  #status{font-size:.75rem;color:#555;margin-top:8px}
  .empty{color:#555;font-size:.8rem;padding:10px 0}
</style>
</head><body>
<h1>⛏ CreeperCloud Host</h1>
<p class="sub">Local dashboard — http://localhost:${CONFIG.uiPort}</p>
<div class="card" id="info-card">
  <h2>HOST STATUS</h2>
  <div class="row"><span class="label">Region</span><span class="val">${CONFIG.region}</span></div>
  <div class="row"><span class="label">Max RAM / server</span><span class="val">${CONFIG.maxRamMB}MB</span></div>
  <div class="row"><span class="label">Max servers</span><span class="val">${CONFIG.maxServers}</span></div>
  <div class="row"><span class="label">Broker</span><span class="val ${CONFIG.noBroker ? 'yellow' : 'green'}">${CONFIG.noBroker ? 'Disabled' : 'Connected'}</span></div>
</div>
<div class="card">
  <h2>ACTIVE SERVERS</h2>
  <div id="servers-list"><span class="empty">No servers running</span></div>
  <button class="btn" onclick="createServer()">▶ Start New Server</button>
</div>
<div id="status"></div>
<script>
  const ws = new WebSocket('ws://localhost:${CONFIG.uiPort}');
  const servers = {};
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'server_ready' || msg.type === 'server_starting' || msg.type === 'server_status') {
      servers[msg.sessionId] = { ...servers[msg.sessionId], ...msg };
      renderServers();
    }
    if (msg.type === 'server_stopped') { delete servers[msg.sessionId]; renderServers(); }
    if (msg.type === 'player_joined' && servers[msg.sessionId]) { servers[msg.sessionId].playerCount = (servers[msg.sessionId].playerCount||0)+1; renderServers(); }
    if (msg.type === 'player_left'   && servers[msg.sessionId]) { servers[msg.sessionId].playerCount = Math.max(0,(servers[msg.sessionId].playerCount||1)-1); renderServers(); }
  };
  function renderServers() {
    const el = document.getElementById('servers-list');
    const ids = Object.keys(servers);
    if (!ids.length) { el.innerHTML = '<span class="empty">No servers running</span>'; return; }
    el.innerHTML = ids.map(id => {
      const s = servers[id];
      const ip = s.ip || 'Starting...';
      const isOnline = !!s.ip;
      return \`<div style="margin-bottom:12px">
        <div class="row"><span class="label">Session</span><span class="val">\${id.slice(0,8)}</span></div>
        <div class="row"><span class="label">Status</span><span class="val \${isOnline?'green':'yellow'}">\${isOnline?'ONLINE':'STARTING'}</span></div>
        <div class="row"><span class="label">Players</span><span class="val">\${s.playerCount||0}</span></div>
        \${isOnline ? \`<div class="ip">\${ip}</div>\` : ''}
        <button class="btn danger" onclick="stopServer('\${id}')">■ Stop</button>
        \${isOnline ? \`<a href="server.html?session=\${id}&name=CreeperCloud+Server" style="color:#a3ff47;font-size:.75rem;text-decoration:none">⚙ Open Panel →</a>\` : ''}
      </div>\`;
    }).join('<hr style="border-color:#1c1c1c;margin:12px 0"/>');
  }
  async function createServer() {
    document.getElementById('status').textContent = 'Starting server...';
    const res = await fetch('/api/create', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({maxPlayers:5,gameMode:'survival'}) });
    const data = await res.json();
    document.getElementById('status').textContent = data.error ? 'Error: '+data.error : 'Server starting (session: '+data.sessionId.slice(0,8)+')...';
  }
  async function stopServer(id) {
    await fetch('/api/session/'+id+'/stop', {method:'POST'});
    document.getElementById('status').textContent = 'Stopping '+id.slice(0,8)+'...';
  }
</script>
</body></html>`;
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function findFreePort(start = 25565) {
  return new Promise((resolve) => {
    const used = new Set([...activeServers.values()].map(s => s.localPort));
    let port = start; while (used.has(port)) port++;
    resolve(port);
  });
}
function ensureDataDir() { fs.mkdirSync(path.join(CONFIG.dataDir, 'servers'), { recursive: true }); }
function detectRegion() {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (tz.startsWith('America/')) return 'US';
  if (tz.startsWith('Europe/'))  return 'EU';
  if (tz.startsWith('Asia/'))    return 'ASIA';
  return 'OTHER';
}
function makeId() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36); }
function log(msg) { const t = new Date().toISOString().slice(11,19); console.log(`\x1b[2m[${t}]\x1b[0m ${msg}`); }
function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { const key = argv[i].slice(2); result[key] = argv[i+1] && !argv[i+1].startsWith('--') ? argv[++i] : true; }
  }
  return result;
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────
process.on('SIGINT', async () => {
  log('\nShutting down...');
  for (const [id] of activeServers) await stopMinecraftServer(id);
  if (brokerWs) brokerWs.close();
  if (uiWss)    uiWss.close();
  setTimeout(() => process.exit(0), 4000);
});

// ── Run ───────────────────────────────────────────────────────────────────────
main().catch(err => { console.error('\x1b[31m✗ Fatal:\x1b[0m', err.message); process.exit(1); });
