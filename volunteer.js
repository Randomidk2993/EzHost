#!/usr/bin/env node
/**
 * CreeperCloud — Volunteer Host Client
 * =====================================
 * Run this on your PC to donate spare resources for hosting Minecraft servers.
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
 *   --ram <MB>       Max RAM per server (default: 1024)
 *   --max-servers <n> Max concurrent servers (default: 1)
 *   --region <name>  Your region label (default: auto-detect)
 *   --broker <url>   Broker WebSocket URL (default: wss://broker.creepercloud.io)
 */

const { execFile, exec } = require('child_process');
const WebSocket = require('ws');
const https = require('https');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ── Config ──────────────────────────────────────────────────────────────────
const args = parseArgs(process.argv.slice(2));
const CONFIG = {
  brokerUrl: args['broker'] || 'wss://broker.creepercloud.io',
  maxRamMB: parseInt(args['ram']) || 1024,
  maxServers: parseInt(args['max-servers']) || 1,
  region: args['region'] || detectRegion(),
  javaPath: args['java'] || 'java',
  dataDir: path.join(os.homedir(), '.creepercloud'),
};

const SERVER_JAR_URL = 'https://api.papermc.io/v2/projects/paper/versions/1.21.4/builds/latest/downloads/paper-1.21.4-latest.jar';
const SERVER_JAR_PATH = path.join(CONFIG.dataDir, 'server.jar');

// ── State ────────────────────────────────────────────────────────────────────
const activeServers = new Map(); // sessionId → { process, port, playerCount }
let ws = null;
let reconnectTimer = null;

// ── Startup ──────────────────────────────────────────────────────────────────
async function main() {
  printBanner();
  ensureDataDir();
  await ensureJavaInstalled();
  await ensureServerJar();
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
  console.log('  \x1b[2mCreeperCloud Volunteer Host — creepercloud.io\x1b[0m\n');
  console.log(`  RAM per server : \x1b[33m${CONFIG.maxRamMB}MB\x1b[0m`);
  console.log(`  Max servers    : \x1b[33m${CONFIG.maxServers}\x1b[0m`);
  console.log(`  Region         : \x1b[33m${CONFIG.region}\x1b[0m`);
  console.log(`  Broker         : \x1b[33m${CONFIG.brokerUrl}\x1b[0m\n`);
}

// ── Broker WebSocket connection ──────────────────────────────────────────────
function connectToBroker() {
  log('Connecting to CreeperCloud broker...');

  ws = new WebSocket(CONFIG.brokerUrl, {
    headers: { 'User-Agent': 'CreeperCloud-Host/1.0' }
  });

  ws.on('open', () => {
    log('\x1b[32m✓ Connected to broker\x1b[0m');
    register();
  });

  ws.on('message', async (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); }
    catch { return; }
    await handleBrokerMessage(msg);
  });

  ws.on('close', (code) => {
    log(`\x1b[33m⚠ Broker disconnected (${code}). Reconnecting in 5s...\x1b[0m`);
    reconnectTimer = setTimeout(connectToBroker, 5000);
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
    }
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
      log(`\x1b[36m🎮 Server request received! Session: ${msg.sessionId}\x1b[0m`);
      await startMinecraftServer(msg);
      break;

    case 'stop_server':
      await stopMinecraftServer(msg.sessionId);
      break;

    case 'ping':
      send({ type: 'pong', activeServers: activeServers.size });
      break;

    default:
      // Unknown message — ignore
  }
}

// ── Minecraft Server Management ──────────────────────────────────────────────
async function startMinecraftServer(req) {
  const { sessionId, version = '1.21.4', maxPlayers = 5, gameMode = 'survival' } = req;

  // Find a free port
  const port = await findFreePort(25565);
  const serverDir = path.join(CONFIG.dataDir, 'servers', sessionId);
  fs.mkdirSync(serverDir, { recursive: true });

  // Write server.properties
  fs.writeFileSync(path.join(serverDir, 'server.properties'), [
    `server-port=${port}`,
    `max-players=${maxPlayers}`,
    `gamemode=${gameMode}`,
    `online-mode=false`,
    `motd=CreeperCloud Server | Session ${sessionId.slice(0, 8)}`,
    `enable-rcon=false`,
    `view-distance=8`,
    `simulation-distance=6`,
    `spawn-protection=0`,
  ].join('\n'));

  // Accept EULA
  fs.writeFileSync(path.join(serverDir, 'eula.txt'), 'eula=true\n');

  // Copy (symlink) the server jar
  const jarDest = path.join(serverDir, 'server.jar');
  if (!fs.existsSync(jarDest)) {
    fs.copyFileSync(SERVER_JAR_PATH, jarDest);
  }

  log(`Starting Minecraft server on port ${port}...`);

  const javaArgs = [
    `-Xmx${CONFIG.maxRamMB}M`,
    `-Xms256M`,
    '-XX:+UseG1GC',
    '-XX:+ParallelRefProcEnabled',
    '-XX:MaxGCPauseMillis=200',
    '-jar', 'server.jar',
    '--nogui',
  ];

  const proc = execFile(CONFIG.javaPath, javaArgs, {
    cwd: serverDir,
    maxBuffer: 10 * 1024 * 1024,
  });

  activeServers.set(sessionId, { process: proc, port, playerCount: 0, startTime: Date.now() });

  proc.stdout.on('data', (data) => {
    const text = data.toString();
    // Detect server ready
    if (text.includes('Done') && text.includes('For help')) {
      log(`\x1b[32m✓ Server ready on port ${port} [session: ${sessionId.slice(0, 8)}]\x1b[0m`);
      send({ type: 'server_ready', sessionId, port, hostPort: port });
      updateBrokerSlots();
    }
    // Detect player joins
    if (text.includes('joined the game')) {
      const s = activeServers.get(sessionId);
      if (s) { s.playerCount++; send({ type: 'player_joined', sessionId }); }
    }
    if (text.includes('left the game')) {
      const s = activeServers.get(sessionId);
      if (s) { s.playerCount = Math.max(0, s.playerCount - 1); send({ type: 'player_left', sessionId }); }
    }
  });

  proc.stderr.on('data', () => {}); // suppress stderr noise

  proc.on('exit', (code) => {
    log(`Server exited [session: ${sessionId.slice(0, 8)}] code=${code}`);
    activeServers.delete(sessionId);
    send({ type: 'server_stopped', sessionId });
    updateBrokerSlots();
    // Cleanup server dir
    fs.rmSync(serverDir, { recursive: true, force: true });
  });
}

async function stopMinecraftServer(sessionId) {
  const s = activeServers.get(sessionId);
  if (!s) return;
  log(`Stopping server [session: ${sessionId.slice(0, 8)}]`);
  s.process.stdin.write('stop\n');
  setTimeout(() => {
    try { s.process.kill('SIGKILL'); } catch {}
  }, 10000);
}

function updateBrokerSlots() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    send({ type: 'update_slots', availableSlots: CONFIG.maxServers - activeServers.size });
  }
}

// ── Server JAR download ──────────────────────────────────────────────────────
async function ensureServerJar() {
  if (fs.existsSync(SERVER_JAR_PATH)) {
    log(`\x1b[32m✓ Server JAR found\x1b[0m`);
    return;
  }
  log('Downloading Minecraft server JAR (Paper 1.21.4)...');
  // In production: fetch latest build URL from PaperMC API first
  await downloadFile(SERVER_JAR_URL, SERVER_JAR_PATH);
  log('\x1b[32m✓ Server JAR downloaded\x1b[0m');
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const get = url.startsWith('https') ? https : http;
    get.get(url, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        return downloadFile(res.headers.location, dest).then(resolve).catch(reject);
      }
      const total = parseInt(res.headers['content-length'] || '0');
      let downloaded = 0;
      res.on('data', (chunk) => {
        downloaded += chunk.length;
        if (total) {
          const pct = Math.floor((downloaded / total) * 100);
          process.stdout.write(`\r  Downloading... ${pct}%`);
        }
        file.write(chunk);
      });
      res.on('end', () => { file.end(); process.stdout.write('\n'); resolve(); });
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ── Java check ──────────────────────────────────────────────────────────────
async function ensureJavaInstalled() {
  return new Promise((resolve) => {
    exec(`${CONFIG.javaPath} -version`, (err, stdout, stderr) => {
      if (err) {
        console.error('\x1b[31m✗ Java not found. Please install Java 17+: https://adoptium.net\x1b[0m');
        process.exit(1);
      }
      const version = (stderr || stdout).match(/version "(\d+)/);
      const major = version ? parseInt(version[1]) : 0;
      if (major < 17) {
        console.error(`\x1b[31m✗ Java ${major} found, but Java 17+ is required.\x1b[0m`);
        process.exit(1);
      }
      log(`\x1b[32m✓ Java ${major} detected\x1b[0m`);
      resolve();
    });
  });
}

// ── Utilities ────────────────────────────────────────────────────────────────
function findFreePort(start = 25565) {
  return new Promise((resolve) => {
    const used = new Set([...activeServers.values()].map(s => s.port));
    let port = start;
    while (used.has(port)) port++;
    resolve(port);
  });
}

function ensureDataDir() {
  fs.mkdirSync(path.join(CONFIG.dataDir, 'servers'), { recursive: true });
}

function detectRegion() {
  // Very rough — production would use IP geolocation
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (tz.startsWith('America/')) return 'US';
  if (tz.startsWith('Europe/')) return 'EU';
  if (tz.startsWith('Asia/')) return 'ASIA';
  return 'OTHER';
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
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

// ── Graceful shutdown ────────────────────────────────────────────────────────
process.on('SIGINT', async () => {
  log('\nShutting down gracefully...');
  for (const [sessionId] of activeServers) {
    await stopMinecraftServer(sessionId);
  }
  if (ws) ws.close();
  setTimeout(() => process.exit(0), 3000);
});

// ── Run ──────────────────────────────────────────────────────────────────────
main().catch(err => {
  console.error('\x1b[31m✗ Fatal error:\x1b[0m', err.message);
  process.exit(1);
});
