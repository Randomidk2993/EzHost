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
  // Kick off stat counters once visible
  const statsEl = document.querySelector('.hero-stats');
  if (!statsEl) return;
  const obs = new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting) {
      animateCounter(document.getElementById('stat-hosts'),   targets.hosts);
      animateCounter(document.getElementById('stat-servers'), targets.servers);
      animateCounter(document.getElementById('stat-players'), targets.players);
      obs.disconnect();
    }
  });
  obs.observe(statsEl);
});

// ── Terminal typing animation ──
const termLines = [
  { id: 'tl1', text: '→ Connecting to CreeperCloud broker...', delay: 600 },
  { id: 'tl2', text: '✓ Registered as host [us-central-08]',  delay: 1300 },
  { id: 'tl3', text: '⚡ Waiting for server requests...',      delay: 2100 },
  { id: 'tl4', text: '🎮 Spinning up server for player!',      delay: 3200 },
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
    if (el) await typeText(el, line.text);
  }
}

// ── Tab switching ──
function switchTab(tab) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.steps').forEach(s => s.classList.add('hidden'));
  event.target.classList.add('active');
  document.getElementById('steps-' + tab).classList.remove('hidden');
}

// ── Broker URLs ──
const BROKER_WS   = 'wss://ezhost-production.up.railway.app';
const BROKER_HTTP = 'https://ezhost-production.up.railway.app';

// ── Live stats ────────────────────────────────────────────────────────────────
async function fetchLiveStats() {
  try {
    const res  = await fetch(`${BROKER_HTTP}/api/stats`);
    const data = await res.json();
    document.getElementById('stat-hosts').textContent   = data.activeHosts    ?? 0;
    document.getElementById('stat-servers').textContent = data.runningSessions ?? 0;
    document.getElementById('stat-players').textContent = data.totalPlayers    ?? 0;
  } catch {
    // Broker unreachable — leave animated defaults
  }
}
window.addEventListener('load', () => {
  fetchLiveStats();
  setInterval(fetchLiveStats, 15000);
});

// ── Stored session (so returning players can re-open the panel) ───────────────
const SESSION_KEY = 'cc_last_session';

function saveSession(data) {
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(data)); } catch {}
}
function loadSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch { return null; }
}

// On load, if there's a stored session, offer to re-open it
window.addEventListener('DOMContentLoaded', () => {
  const prev = loadSession();
  if (prev && prev.sessionId) {
    const banner = document.getElementById('resume-banner');
    if (banner) {
      banner.classList.remove('hidden');
      const ipEl = document.getElementById('resume-ip');
      if (ipEl) ipEl.textContent = prev.ip || prev.sessionId.slice(0, 8);
    }
  }
});

// ── Request server ────────────────────────────────────────────────────────────
function requestServer() {
  const btn      = document.querySelector('#get-server .btn-primary.wide');
  btn.textContent = '⏳ Finding a host...';
  btn.disabled    = true;

  const serverName = document.getElementById('server-name').value.trim() || 'My Epic World';
  const version    = document.getElementById('mc-version').value;
  const maxPlayers = parseInt(document.getElementById('max-players').value);
  const gameMode   = document.querySelector('input[name="mode"]:checked').value;

  let ws;
  try {
    ws = new WebSocket(BROKER_WS);
  } catch {
    btn.textContent = '✗ Could not connect to broker';
    btn.disabled    = false;
    return;
  }

  const timeout = setTimeout(() => {
    btn.textContent = '✗ Timed out — no hosts available right now';
    btn.disabled    = false;
    ws.close();
  }, 30000);

  ws.onopen = () => {
    ws.send(JSON.stringify({
      type: 'request_server',
      name: serverName,
      version,
      maxPlayers,
      gameMode,
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

      // Persist session for the panel and resume banner
      const sessionData = {
        sessionId:  msg.sessionId,
        ip:         msg.ip,
        name:       serverName,
        version,
        maxPlayers,
        region:     msg.region || 'Community',
      };
      saveSession(sessionData);

      // Show result card
      document.getElementById('result-ip').textContent       = msg.ip;
      document.getElementById('result-host').textContent     = 'Volunteer Host';
      document.getElementById('result-region').textContent   = msg.region || 'Community';
      document.querySelector('.server-form').classList.add('hidden');
      document.getElementById('server-result').classList.remove('hidden');

      // Build the "Manage Server" link
      const params = new URLSearchParams({
        session:    msg.sessionId,
        name:       serverName,
        version,
        maxPlayers: String(maxPlayers),
        region:     msg.region || 'Community',
      });
      const manageBtn = document.getElementById('manage-server-btn');
      if (manageBtn) {
        manageBtn.href = `server.html?${params.toString()}`;
        manageBtn.classList.remove('hidden');
      }

      fetchLiveStats();
      ws.close();
    }

    if (msg.type === 'error') {
      clearTimeout(timeout);
      btn.textContent = '✗ ' + (msg.message || 'Something went wrong');
      btn.disabled    = false;
      ws.close();
    }
  };

  ws.onerror = () => {
    clearTimeout(timeout);
    btn.textContent = '✗ Could not reach the broker';
    btn.disabled    = false;
  };

  ws.onclose = (e) => {
    if (e.code !== 1000) {
      clearTimeout(timeout);
      btn.textContent = '✗ Connection lost — please try again';
      btn.disabled    = false;
    }
  };
}

// ── Resume previous session ───────────────────────────────────────────────────
function resumeSession() {
  const prev = loadSession();
  if (!prev) return;
  const params = new URLSearchParams({
    session:    prev.sessionId,
    name:       prev.name       || 'My Server',
    version:    prev.version    || 'Paper 1.21.4',
    maxPlayers: String(prev.maxPlayers || 5),
    region:     prev.region     || 'Community',
  });
  window.location.href = `server.html?${params.toString()}`;
}

function dismissResume() {
  const banner = document.getElementById('resume-banner');
  if (banner) banner.classList.add('hidden');
}

// ── Copy helpers ──────────────────────────────────────────────────────────────
function copyIP() {
  const ip = document.getElementById('result-ip').textContent;
  navigator.clipboard.writeText(ip).then(() => showToast('IP Copied!'));
}
function copyCode(text) {
  navigator.clipboard.writeText(text).then(() => showToast('Copied!'));
}
function showToast(msg = 'Copied!') {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.remove('hidden');
  setTimeout(() => t.classList.add('hidden'), 2000);
}
