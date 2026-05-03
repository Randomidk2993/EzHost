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
  animateCounter(document.getElementById('stat-hosts'), targets.hosts);
  animateCounter(document.getElementById('stat-servers'), targets.servers);
  animateCounter(document.getElementById('stat-players'), targets.players);
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

// ── Request server (simulated — replace with real broker call) ──
const mockHosts = [
  { name: 'CoolDude42', region: 'US-Central' },
  { name: 'Steve_IRL', region: 'US-East' },
  { name: 'Anonymous Volunteer', region: 'EU-West' },
  { name: 'Notch_fan99', region: 'US-West' },
];
const mockPorts = [25565, 25566, 25567, 25568];

function requestServer() {
  const btn = document.querySelector('.btn-primary.wide');
  btn.textContent = '⏳ Finding a host...';
  btn.disabled = true;

  // Simulate broker matchmaking delay
  setTimeout(() => {
    const host = mockHosts[Math.floor(Math.random() * mockHosts.length)];
    const port = mockPorts[Math.floor(Math.random() * mockPorts.length)];
    const ip = `mc.creepercloud.io:${port}`;

    document.getElementById('result-ip').textContent = ip;
    document.getElementById('result-host').textContent = host.name;
    document.getElementById('result-region').textContent = host.region;

    document.querySelector('.server-form').classList.add('hidden');
    document.getElementById('server-result').classList.remove('hidden');

    // Update live stats
    targets.servers++;
    document.getElementById('stat-servers').textContent = targets.servers;
  }, 2200);
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
