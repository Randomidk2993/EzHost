// app.js — CreeperCloud frontend logic

// ── Animated stats counter ──
const targets = { hosts: 12, servers: 7, players: 34 };
function animateCounter(el, target, duration = 1500) {
  let start = null;
  function step(ts) {
    if (!start) start = ts;
    const p = Math.min((ts - start) / duration, 1);
    el.textContent = Math.floor(p * target);
    if (p < 1) requestAnimationFrame(step);
    else el.textContent = target;
  }
  requestAnimationFrame(step);
}
window.addEventListener('load', () => {
  animateTerminal();
});

// ── Terminal typing animation ──
const termLines = [
  { id: 'tl1', text: '→ Connecting to CreeperCloud broker...', delay: 600 },
  { id: 'tl2', text: '✓ Registered as host [us-central-08]', delay: 1300 },
  { id: 'tl3', text: '⚡ Waiting for server requests...', delay: 2100 },
  { id: 'tl4', text: '🎮 Spinning up server for player!', delay: 3200 },
];
function typeText(el, text, speed = 28) {
  return new Promise(resolve => {
    let i = 0;
    const interval = setInterval(() => {
      el.textContent += text[i++];
      if (i >= text.length) { clearInterval(interval); resolve(); }
    }, speed);
  });
}
async function animateTerminal() {
  for (const line of termLines) {
    await new Promise(r => setTimeout(r, line.delay));
    const el = document.getElementById(line.id);
    await typeText(el, line.text);
  }
}

// ── Tab switching ──
function switchTab(tab) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.steps').forEach(s => s.classList.add('hidden'));
  event.target.classList.add('active');
  document.getElementById('steps-' + tab).classList.remove('hidden');
}

// ── Broker URL ──
const BROKER_WS = 'wss://ezhost-production.up.railway.app';
const BROKER_HTTP = 'https://ezhost-production.up.railway.app';

// ── Fetch live stats from broker ──
async function fetchLiveStats() {
  try {
    const res = await fetch(`${BROKER_HTTP}/api/stats`);
    const data = await res.json();
    document.getElementById('stat-hosts').textContent = data.activeHosts ?? 0;
    document.getElementById('stat-servers').textContent = data.runningSessions ?? 0;
    document.getElementById('stat-players').textContent = data.totalPlayers ?? 0;
  } catch {
    // Broker unreachable — leave animated defaults
  }
}
window.addEventListener('load', () => {
  fetchLiveStats();
  setInterval(fetchLiveStats, 15000); // refresh every 15s
});

// ── Request server — real broker WebSocket ──
function requestServer() {
  const btn = document.querySelector('.btn-primary.wide');
  btn.textContent = '⏳ Finding a host...';
  btn.disabled = true;

  let ws;
  try {
    ws = new WebSocket(BROKER_WS);
  } catch {
    btn.textContent = '✗ Could not connect to broker';
    btn.disabled = false;
    return;
  }

  const timeout = setTimeout(() => {
    btn.textContent = '✗ Timed out — no hosts available';
    btn.disabled = false;
    ws.close();
  }, 20000);

  ws.onopen = () => {
    ws.send(JSON.stringify({
      type: 'request_server',
      version: document.getElementById('mc-version').value,
      maxPlayers: parseInt(document.getElementById('max-players').value),
      gameMode: document.querySelector('input[name="mode"]:checked').value,
    }));
  };

  ws.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }

    if (msg.type === 'queued') {
      btn.textContent = '⚡ Host found! Starting server...';
    }

    if (msg.type === 'server_ready') {
      clearTimeout(timeout);
      document.getElementById('result-ip').textContent = msg.ip;
      document.getElementById('result-host').textContent = 'Volunteer Host';
      document.getElementById('result-region').textContent = 'Community';
      document.querySelector('.server-form').classList.add('hidden');
      document.getElementById('server-result').classList.remove('hidden');
      fetchLiveStats();
      ws.close();
    }

    if (msg.type === 'error') {
      clearTimeout(timeout);
      btn.textContent = '✗ ' + msg.message;
      btn.disabled = false;
      ws.close();
    }
  };

  ws.onerror = () => {
    clearTimeout(timeout);
    btn.textContent = '✗ Could not reach broker';
    btn.disabled = false;
  };

  ws.onclose = (e) => {
    if (e.code !== 1000) {
      clearTimeout(timeout);
      btn.textContent = '✗ Connection lost — try again';
      btn.disabled = false;
    }
  };
}

// ── Copy helpers ──
function copyIP() {
  const ip = document.getElementById('result-ip').textContent;
  navigator.clipboard.writeText(ip).then(() => showToast('IP Copied!'));
}
function copyCode(text) {
  navigator.clipboard.writeText(text).then(() => showToast('Copied!'));
}
function showToast(msg = 'Copied!') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  setTimeout(() => t.classList.add('hidden'), 2000);
}
