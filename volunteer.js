#!/usr/bin/env node
/**
 * CreeperCloud — Volunteer Host Client
 * =====================================
 * Run this on your PC to donate spare resources for hosting Minecraft servers.
 * Tunneling is handled automatically via bore — no port forwarding needed.
 *
 * Requirements:
 *   - Node.js 18+
 *   - Java 17+ (for Minecraft server)
 *   - Internet connection
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
 */

const { execFile, exec, spawn } = require('child_process');
const WebSocket = require('ws');
const https = require('https');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ── Config ───────────────────────────────────────────────────────────────────
const args = parseArgs(process.argv.slice(2));
const CONFIG = {
  brokerUrl:  args['broker']       || 'wss://ezhost-production.up.railway.app',
  maxRamMB:   parseInt(args['ram'])          || 1024,
  maxServers: parseInt(args['max-servers'])  || 1,
  region:     args['region']       || detectRegion(),
  javaPath:   args['java']         || 'java',
  boreServer: args['bore-server']  || 'bore.pub',
  dataDir:    path.join(os.homedir(), '.creepercloud'),
};

// bore binary download info per platform
const BORE_RELEASES = {
  'linux-x64':    { file: 'bore-v0.5.0-x86_64-unknown-linux-musl.tar.gz',  bin: 'bore' },
  'linux-arm64':  { file: 'bore-v0.5.0-aarch64-unknown-linux-musl.tar.gz', bin: 'bore' },
  'darwin-x64':   { file: 'bore-v0.5.0-x86_64-apple-darwin.tar.gz',        bin: 'bore' },
  'darwin-arm64': { file: 'bore-v0.5.0-aarch64-apple-darwin.tar.gz',       bin: 'bore' },
  'win32-x64':    { file: 'bore-v0.5.0-x86_64-pc-windows-msvc.zip',        bin: 'bore.exe' },
};
const BORE_BASE_URL  = 'https://github.com/ekzhang/bore/releases/download/v0.5.0/';
const BORE_BIN_PATH  = path.join(CONFIG.dataDir, os.platform() === 'win32' ? 'bore.exe' : 'bore');
const SERVER_JAR_URL = 'https://api.papermc.io/v2/projects/paper/versions/1.21.4/builds/latest/downloads/paper-1.21.4-latest.jar';
const SERVER_JAR_PATH = path.join(CONFIG.dataDir, 'server.jar');

// ── State ─────────────────────────────────────────────────────────────────────
// sessionId → { mcProcess, tunnelProcess, localPort, publicHost, publicPort, playerCount, startTime }
const activeServers = new Map();
let ws = null;

// ── Startup ───────────────────────────────────────────────────────────────────
async function main() {
  printBanner();
  ensureDataDir();
  await ensureJavaInstalled();
  await ensureServerJar();
  await ensureBore();
  connectToBroker();
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
  console.log(`  Broker         : \x1b[33m${CONFIG.brokerUrl}\x1b[0m`);
  console.log(`  Tunnel via     : \x1b[33m${CONFIG.boreServer}\x1b[0m\n`);
}

// ── Broker connection ─────────────────────────────────────────────────────────
function connectToBroker() {
  log('Connecting to CreeperCloud broker...');
  ws = new WebSocket(CONFIG.brokerUrl, { headers: { 'User-Agent': 'CreeperCloud-Host/1.0' } });

  ws.on('open', () => {
    log('\x1b[32m✓ Connected to broker\x1b[0m');
    register();
  });

  ws.on('message', async (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    await handleBrokerMessage(msg);
  });

  ws.on('close', (code) => {
    log(`\x1b[33m⚠ Broker disconnected (${code}). Reconnecting in 5s...\x1b[0m`);
    setTimeout(connectToBroker, 5000);
  });

  ws.on('error', (err) => {
    log(`\x1b[31m✗ Broker error: ${err.message}\x1b[0m`);
  });
}

function register() {
  send({
    type: 'register',
    role: 'host',
    region: CONFIG.region,
    maxServers: CONFIG.maxServers,
    availableSlots: CONFIG.maxServers - activeServers.size,
    ramPerServerMB: CONFIG.maxRamMB,
    systemInfo: {
      platform: os.platform(),
      arch: os.arch(),
      totalRamMB: Math.floor(os.totalmem() / 1024 / 1024),
      cpuCores: os.cpus().length,
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
        send({ type: 'start_server_error', sessionId: msg.sessionId, reason: 'at_capacity' });
        return;
      }
      log(`\x1b[36m🎮 Server request! Session: ${msg.sessionId.slice(0, 8)}\x1b[0m`);
      await startMinecraftServer(msg);
      break;

    case 'stop_server':
      await stopMinecraftServer(msg.sessionId);
      break;

    case 'ping':
      send({ type: 'pong', activeServers: activeServers.size });
      break;
  }
}

// ── Minecraft Server ──────────────────────────────────────────────────────────
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

  const mcProc = execFile(CONFIG.javaPath, [
    `-Xmx${CONFIG.maxRamMB}M`, `-Xms256M`,
    '-XX:+UseG1GC', '-XX:+ParallelRefProcEnabled', '-XX:MaxGCPauseMillis=200',
    '-jar', 'server.jar', '--nogui',
  ], { cwd: serverDir, maxBuffer: 10 * 1024 * 1024 });

  activeServers.set(sessionId, {
    mcProcess: mcProc,
    tunnelProcess: null,
    localPort,
    publicHost: null,
    publicPort: null,
    playerCount: 0,
    startTime: Date.now(),
  });

  mcProc.stdout.on('data', async (data) => {
    const text = data.toString();

    // Server fully booted — open tunnel now
    if (text.includes('Done') && text.includes('For help')) {
      log(`[${sessionId.slice(0,8)}] Minecraft ready — opening bore tunnel...`);
      try {
        const { publicHost, publicPort, tunnelProcess } = await openTunnel(localPort);
        const s = activeServers.get(sessionId);
        if (s) {
          s.tunnelProcess = tunnelProcess;
          s.publicHost    = publicHost;
          s.publicPort    = publicPort;
        }
        const ip = `${publicHost}:${publicPort}`;
        log(`[${sessionId.slice(0,8)}] \x1b[32m✓ Tunnel open! Players connect to: ${ip}\x1b[0m`);
        send({ type: 'server_ready', sessionId, ip });
        updateBrokerSlots();
      } catch (err) {
        log(`[${sessionId.slice(0,8)}] \x1b[31m✗ Tunnel failed: ${err.message}\x1b[0m`);
        send({ type: 'start_server_error', sessionId, reason: 'tunnel_failed' });
        await stopMinecraftServer(sessionId);
      }
    }

    if (text.includes('joined the game')) {
      const s = activeServers.get(sessionId);
      if (s) { s.playerCount++; send({ type: 'player_joined', sessionId }); }
    }
    if (text.includes('left the game')) {
      const s = activeServers.get(sessionId);
      if (s) { s.playerCount = Math.max(0, s.playerCount - 1); send({ type: 'player_left', sessionId }); }
    }
  });

  mcProc.stderr.on('data', () => {});

  mcProc.on('exit', (code) => {
    log(`[${sessionId.slice(0,8)}] Server process exited (code ${code})`);
    const s = activeServers.get(sessionId);
    if (s?.tunnelProcess) { try { s.tunnelProcess.kill(); } catch {} }
    activeServers.delete(sessionId);
    send({ type: 'server_stopped', sessionId });
    updateBrokerSlots();
    fs.rmSync(serverDir, { recursive: true, force: true });
  });
}

// ── Bore tunnel ───────────────────────────────────────────────────────────────
function openTunnel(localPort) {
  return new Promise((resolve, reject) => {
    // bore local <port> --to bore.pub
    const tunnelProc = spawn(BORE_BIN_PATH, [
      'local', String(localPort),
      '--to', CONFIG.boreServer,
    ]);

    let resolved = false;

    const timer = setTimeout(() => {
      if (!resolved) {
        tunnelProc.kill();
        reject(new Error('Tunnel startup timed out (30s)'));
      }
    }, 30000);

    function tryParse(data) {
      const text = data.toString();
      // bore outputs a line like: "listening at bore.pub:NNNNN"
      const match = text.match(/listening at ([^\s:]+):(\d+)/i)
                 || text.match(/([a-z0-9.-]+\.pub):(\d+)/i)
                 || text.match(/bore\S*:(\d+)/i);
      if (match) {
        clearTimeout(timer);
        resolved = true;
        const publicHost = match[2] ? match[1] : CONFIG.boreServer;
        const publicPort = parseInt(match[2] || match[1]);
        resolve({ publicHost, publicPort, tunnelProcess: tunnelProc });
      }
    }

    tunnelProc.stdout.on('data', tryParse);
    tunnelProc.stderr.on('data', tryParse);

    tunnelProc.on('exit', (code) => {
      if (!resolved) {
        clearTimeout(timer);
        reject(new Error(`bore exited early with code ${code}`));
      }
    });

    tunnelProc.on('error', (err) => {
      if (!resolved) { clearTimeout(timer); reject(err); }
    });
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

function updateBrokerSlots() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    send({ type: 'update_slots', availableSlots: CONFIG.maxServers - activeServers.size });
  }
}

// ── Ensure bore binary ────────────────────────────────────────────────────────
async function ensureBore() {
  if (fs.existsSync(BORE_BIN_PATH)) {
    log('\x1b[32m✓ bore tunnel binary found\x1b[0m');
    return;
  }

  const platform = `${os.platform()}-${os.arch()}`;
  const release  = BORE_RELEASES[platform];

  if (!release) {
    console.error(`\x1b[31m✗ No bore binary available for ${platform}.\x1b[0m`);
    console.error('  Install bore manually: https://github.com/ekzhang/bore/releases');
    console.error('  Place the binary at:', BORE_BIN_PATH);
    process.exit(1);
  }

  log(`Downloading bore for ${platform}...`);
  const archivePath = path.join(CONFIG.dataDir, release.file);
  await downloadFile(BORE_BASE_URL + release.file, archivePath);

  // Extract archive
  await new Promise((resolve, reject) => {
    const cmd = release.file.endsWith('.zip')
      ? (os.platform() === 'win32'
          ? `powershell -Command "Expand-Archive -Path '${archivePath}' -DestinationPath '${CONFIG.dataDir}' -Force"`
          : `unzip -o "${archivePath}" -d "${CONFIG.dataDir}"`)
      : `tar -xzf "${archivePath}" -C "${CONFIG.dataDir}"`;
    exec(cmd, (err) => err ? reject(err) : resolve());
  });

  // Make executable on unix
  if (os.platform() !== 'win32') fs.chmodSync(BORE_BIN_PATH, 0o755);
  fs.rmSync(archivePath, { force: true });
  log('\x1b[32m✓ bore installed successfully\x1b[0m');
}

// ── Ensure server JAR ─────────────────────────────────────────────────────────
async function ensureServerJar() {
  if (fs.existsSync(SERVER_JAR_PATH)) {
    log('\x1b[32m✓ Minecraft server JAR found\x1b[0m');
    return;
  }
  log('Downloading Paper Minecraft 1.21.4 server JAR...');
  await downloadFile(SERVER_JAR_URL, SERVER_JAR_PATH);
  log('\x1b[32m✓ Server JAR downloaded\x1b[0m');
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const get  = url.startsWith('https') ? https : http;
    get.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        return downloadFile(res.headers.location, dest).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
      const total = parseInt(res.headers['content-length'] || '0');
      let downloaded = 0;
      res.on('data', (chunk) => {
        downloaded += chunk.length;
        if (total) process.stdout.write(`\r  Downloading... ${Math.floor((downloaded / total) * 100)}%`);
        file.write(chunk);
      });
      res.on('end', () => { file.end(); process.stdout.write('\n'); resolve(); });
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ── Java check ────────────────────────────────────────────────────────────────
async function ensureJavaInstalled() {
  return new Promise((resolve) => {
    exec(`${CONFIG.javaPath} -version`, (err, stdout, stderr) => {
      if (err) {
        console.error('\x1b[31m✗ Java not found. Install Java 17+: https://adoptium.net\x1b[0m');
        process.exit(1);
      }
      const v = (stderr || stdout).match(/version "(\d+)/);
      const major = v ? parseInt(v[1]) : 0;
      if (major < 17) {
        console.error(`\x1b[31m✗ Java ${major} found but Java 17+ is required.\x1b[0m`);
        process.exit(1);
      }
      log(`\x1b[32m✓ Java ${major} detected\x1b[0m`);
      resolve();
    });
  });
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function findFreePort(start = 25565) {
  return new Promise((resolve) => {
    const used = new Set([...activeServers.values()].map(s => s.localPort));
    let port = start;
    while (used.has(port)) port++;
    resolve(port);
  });
}

function ensureDataDir() {
  fs.mkdirSync(path.join(CONFIG.dataDir, 'servers'), { recursive: true });
}

function detectRegion() {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (tz.startsWith('America/')) return 'US';
  if (tz.startsWith('Europe/'))  return 'EU';
  if (tz.startsWith('Asia/'))    return 'ASIA';
  return 'OTHER';
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function log(msg) {
  const t = new Date().toISOString().slice(11, 19);
  console.log(`\x1b[2m[${t}]\x1b[0m ${msg}`);
}

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      result[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    }
  }
  return result;
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────
process.on('SIGINT', async () => {
  log('\nShutting down — stopping all servers and tunnels...');
  for (const [sessionId] of activeServers) await stopMinecraftServer(sessionId);
  if (ws) ws.close();
  setTimeout(() => process.exit(0), 4000);
});

// ── Run ───────────────────────────────────────────────────────────────────────
main().catch(err => {
  console.error('\x1b[31m✗ Fatal:\x1b[0m', err.message);
  process.exit(1);
});
