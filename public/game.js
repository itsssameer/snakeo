(() => {
  'use strict';

  // WebSocket-only transport: skips Socket.IO's HTTP long-polling probe and
  // upgrades, which costs a couple of round-trips on Render free.
  const socket = io({ transports: ['websocket'], upgrade: false });
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d', { alpha: false });
  const minimap = document.getElementById('minimap');
  const minictx = minimap.getContext('2d');

  // ===== DOM refs =====
  const menu = document.getElementById('menu');
  const death = document.getElementById('death');
  const playBtn = document.getElementById('play-btn');
  const respawnBtn = document.getElementById('respawn-btn');
  const statusEl = document.getElementById('status');
  const lengthEl = document.getElementById('length');
  const length2El = document.getElementById('length-2');
  const lbList = document.getElementById('lb-list');
  const deathLen = document.getElementById('death-length');
  const p1KeysEl = document.getElementById('p1-keys');
  const nameInputs = [
    document.getElementById('name-input-0'),
    document.getElementById('name-input-1'),
  ];
  const colorPickers = [
    document.getElementById('color-picker-0'),
    document.getElementById('color-picker-1'),
  ];
  const playerConfigs = [
    document.getElementById('config-0'),
    document.getElementById('config-1'),
  ];
  const deathHalves = [
    document.getElementById('death-half-0'),
    document.getElementById('death-half-1'),
  ];
  const killFeedEl = document.getElementById('kill-feed');
  const comboEl = document.getElementById('combo');
  const milestoneEl = document.getElementById('milestone');
  const bountyBannerEl = document.getElementById('bounty-banner');
  const bountyNameEl = document.getElementById('bounty-name');
  const flashEl = document.getElementById('flash');
  const deathNameInput = document.getElementById('death-name-input');
  const deathColorPicker = document.getElementById('death-color-picker');
  const deathCauseLineEl = document.getElementById('death-cause-line');

  // ===== Mobile detection (drives perf + UX) =====
  const isTouchDevice = window.matchMedia('(pointer: coarse)').matches || (navigator.maxTouchPoints || 0) > 1;

  // ===== Canvas sizing =====
  // On mobile we cap DPR at 1.0 — flagship phones are 3x density and Canvas2D
  // is fill-rate-bound. 1.0 looks crisp at viewing distance and renders 3x
  // fewer pixels per frame than native, keeping 60fps trivially.
  let dpr = Math.min(window.devicePixelRatio || 1, isTouchDevice ? 1.0 : 2);
  function resize() {
    canvas.width = Math.floor(window.innerWidth * dpr);
    canvas.height = Math.floor(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
  }
  window.addEventListener('resize', resize);
  resize();

  // ===== Constants =====
  const HUES = [0, 28, 50, 90, 140, 175, 200, 225, 270, 305, 335];
  const FUNNY = ['SneakySnek', 'Slither', 'Mambo', 'Hisstrix', 'Coil', 'Wormie', 'Noodle', 'Slinky', 'Spaghet'];
  const FUNNY2 = ['Wiggles', 'Mamba', 'Linguini', 'Ramen', 'Boa', 'Squiggle', 'Zigzag'];
  let tickInterval = 1000 / 28;
  // Physics constants (overwritten by server's hello payload). Defaults match server.
  const physics = {
    turnRate: 4.6,
    baseSpeed: 175,
    boostSpeed: 320,
    segSpacing: 9,
    minBoostLen: 14,
  };
  const PARTICLE_CAP = isTouchDevice ? 220 : 800;
  const PARTICLE_SCALE = isTouchDevice ? 0.4 : 1;
  const COOL_NAMES = [
    'ShadowFang', 'NeonCobra', 'VenomSlither', 'TurboSnek', 'PixelPython',
    'GoldVenom', 'CyberCoil', 'RogueViper', 'SkullSnek', 'GlitchBoa',
    'StealthFang', 'FrostMamba', 'SonicSlither', 'NovaSnek', 'PhoenixCoil',
    'LaserVenom', 'GhostSlither', 'DarkRook', 'HyperHiss', 'NeonHydra',
  ];

  function deviceUUID() {
    let u = null;
    try { u = localStorage.getItem('snakeo:uuid'); } catch {}
    if (!u) {
      try {
        u = (window.crypto && window.crypto.randomUUID) ? window.crypto.randomUUID()
          : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
              const r = Math.random() * 16 | 0;
              return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
            });
      } catch {
        u = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
          const r = Math.random() * 16 | 0;
          return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
      }
      try { localStorage.setItem('snakeo:uuid', u); } catch {}
    }
    return u;
  }

  function autoName() {
    const u = deviceUUID().replace(/[^a-fA-F0-9]/g, '').slice(0, 3).toUpperCase();
    const base = COOL_NAMES[Math.floor(Math.random() * COOL_NAMES.length)];
    return base + u;
  }

  // ===== Client-side predictor =====
  // Runs the server's exact physics locally for the player's own snake so
  // input -> visual response feels instant even with 30-200ms RTT. Server is
  // still authoritative; we lerp toward server snapshots smoothly.
  class Predictor {
    constructor() {
      this.segments = [];
      this.direction = 0;
      this.alive = false;
      this.lastUpdateAt = 0;
    }
    reset() {
      this.alive = false;
      this.segments.length = 0;
    }
    initFromServer(seg, dir) {
      this.segments = [];
      for (let i = 0; i < seg.length; i += 2) {
        this.segments.push({ x: seg[i], y: seg[i + 1] });
      }
      this.direction = dir;
      this.alive = true;
      this.lastUpdateAt = performance.now();
    }
    update(targetDir, boost) {
      if (!this.alive || this.segments.length < 2) return;
      const now = performance.now();
      const dt = Math.min(0.04, (now - this.lastUpdateAt) / 1000);
      this.lastUpdateAt = now;
      if (dt <= 0) return;

      let diff = targetDir - this.direction;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      const maxTurn = physics.turnRate * dt;
      this.direction += Math.max(-maxTurn, Math.min(maxTurn, diff));

      const speed = (boost && this.segments.length > physics.minBoostLen)
        ? physics.boostSpeed : physics.baseSpeed;
      this.segments[0].x += Math.cos(this.direction) * speed * dt;
      this.segments[0].y += Math.sin(this.direction) * speed * dt;

      const ssp = physics.segSpacing;
      const sspSq = ssp * ssp;
      for (let i = 1; i < this.segments.length; i++) {
        const dx = this.segments[i - 1].x - this.segments[i].x;
        const dy = this.segments[i - 1].y - this.segments[i].y;
        const d2 = dx * dx + dy * dy;
        if (d2 > sspSq) {
          const d = Math.sqrt(d2);
          const t = (d - ssp) / d;
          this.segments[i].x += dx * t;
          this.segments[i].y += dy * t;
        }
      }

      // Clamp head just inside the world boundary so visuals don't punch
      // through the red ring before the server's death verdict lands.
      const headDistSq = this.segments[0].x * this.segments[0].x + this.segments[0].y * this.segments[0].y;
      const limit = world - 4;
      if (headDistSq > limit * limit) {
        const headDist = Math.sqrt(headDistSq);
        const k = limit / headDist;
        this.segments[0].x *= k;
        this.segments[0].y *= k;
      }
    }
    reconcile(seg, dir) {
      if (!this.alive) {
        this.initFromServer(seg, dir);
        return;
      }
      const targetLen = seg.length / 2;
      while (this.segments.length < targetLen) {
        const tail = this.segments[this.segments.length - 1] || { x: seg[0], y: seg[1] };
        this.segments.push({ x: tail.x, y: tail.y });
      }
      while (this.segments.length > targetLen) this.segments.pop();

      const headDX = seg[0] - this.segments[0].x;
      const headDY = seg[1] - this.segments[0].y;
      if (headDX * headDX + headDY * headDY > 250 * 250) {
        // Big jump (respawn / teleport) — snap
        this.initFromServer(seg, dir);
        return;
      }

      // Smooth lerp toward authoritative state
      const lerpAmt = 0.16;
      for (let i = 0; i < this.segments.length; i++) {
        const sx = seg[i * 2], sy = seg[i * 2 + 1];
        this.segments[i].x += (sx - this.segments[i].x) * lerpAmt;
        this.segments[i].y += (sy - this.segments[i].y) * lerpAmt;
      }
      let dirDiff = dir - this.direction;
      while (dirDiff > Math.PI) dirDiff -= Math.PI * 2;
      while (dirDiff < -Math.PI) dirDiff += Math.PI * 2;
      this.direction += dirDiff * lerpAmt;
    }
    exportFlat() {
      const out = new Array(this.segments.length * 2);
      for (let i = 0; i < this.segments.length; i++) {
        out[i * 2] = this.segments[i].x;
        out[i * 2 + 1] = this.segments[i].y;
      }
      return out;
    }
  }

  function computePlayerTargetDir(p, currentDir) {
    if (!p) return currentDir;
    const c = p.controls;
    if (c?.type === 'mouse') {
      const cw = window.innerWidth, ch = window.innerHeight;
      return Math.atan2(mouseY - ch / 2, mouseX - cw / 2);
    } else if (c?.type === 'keyboard') {
      const turn = (p.turnRight ? 1 : 0) - (p.turnLeft ? 1 : 0);
      if (turn !== 0) return currentDir + turn * 1.8;
    }
    return currentDir;
  }

  function updatePredictors() {
    for (const p of players) {
      if (!p.alive || !p.predictor || !p.predictor.alive) continue;
      const td = computePlayerTargetDir(p, p.predictor.direction);
      p.predictor.update(td, p.boost);
    }
  }

  const CONTROLS = {
    solo: {
      type: 'mouse',
      boost: ['Space'],
      respawn: ['Space', 'Enter'],
    },
    p1_kbd: {
      type: 'keyboard',
      turnLeft: ['KeyA'],
      turnRight: ['KeyD'],
      boost: ['KeyW', 'KeyS', 'ShiftLeft'],
      respawn: ['KeyW', 'KeyS', 'ShiftLeft', 'Enter'],
    },
    p2_kbd: {
      type: 'keyboard',
      turnLeft: ['ArrowLeft'],
      turnRight: ['ArrowRight'],
      boost: ['ArrowUp', 'ArrowDown', 'ShiftRight', 'Slash'],
      respawn: ['ArrowUp', 'ArrowDown', 'ShiftRight', 'Slash'],
    },
  };

  // ===== Audio (procedural Web Audio SFX) =====
  class SFX {
    constructor() { this.ctx = null; this.master = null; this.muted = false; }
    ensure() {
      if (this.ctx) return;
      const C = window.AudioContext || window.webkitAudioContext;
      if (!C) return;
      this.ctx = new C();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.45;
      this.master.connect(this.ctx.destination);
    }
    resume() {
      this.ensure();
      if (this.ctx?.state === 'suspended') this.ctx.resume().catch(() => {});
    }
    blip({ freq = 880, dur = 0.08, type = 'sine', vol = 0.15, freqEnd = null, attack = 0.005, release = 0.04 }) {
      if (this.muted) return;
      this.ensure();
      if (!this.ctx) return;
      const t0 = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = freq;
      if (freqEnd != null) osc.frequency.exponentialRampToValueAtTime(Math.max(20, freqEnd), t0 + dur);
      const g = this.ctx.createGain();
      g.gain.value = 0;
      g.gain.linearRampToValueAtTime(vol, t0 + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur + release);
      osc.connect(g).connect(this.master);
      osc.start(t0);
      osc.stop(t0 + dur + release + 0.02);
    }
    noise({ dur = 0.12, vol = 0.2, lp = 2000 }) {
      if (this.muted) return;
      this.ensure();
      if (!this.ctx) return;
      const t0 = this.ctx.currentTime;
      const len = Math.max(1, Math.floor(this.ctx.sampleRate * dur));
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const ch = buf.getChannelData(0);
      for (let i = 0; i < len; i++) ch[i] = Math.random() * 2 - 1;
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      let node = src;
      if (lp) {
        const f = this.ctx.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.value = lp;
        node.connect(f);
        node = f;
      }
      const g = this.ctx.createGain();
      g.gain.value = 0;
      g.gain.linearRampToValueAtTime(vol, t0 + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      node.connect(g).connect(this.master);
      src.start(t0);
      src.stop(t0 + dur + 0.05);
    }
    eat() { this.blip({ freq: 880, freqEnd: 1320, dur: 0.05, type: 'square', vol: 0.05 }); }
    boost() { this.noise({ dur: 0.08, vol: 0.05, lp: 700 }); }
    die() {
      this.blip({ freq: 220, freqEnd: 60, dur: 0.55, type: 'sawtooth', vol: 0.18 });
      this.noise({ dur: 0.32, vol: 0.12, lp: 1500 });
    }
    kill() {
      this.blip({ freq: 110, freqEnd: 880, dur: 0.18, type: 'square', vol: 0.18 });
      setTimeout(() => this.blip({ freq: 1320, dur: 0.08, type: 'sine', vol: 0.1 }), 70);
    }
    milestone() {
      this.blip({ freq: 880, dur: 0.06, type: 'triangle', vol: 0.1 });
      setTimeout(() => this.blip({ freq: 1320, dur: 0.06, type: 'triangle', vol: 0.1 }), 60);
      setTimeout(() => this.blip({ freq: 1760, dur: 0.1, type: 'triangle', vol: 0.12 }), 120);
    }
  }
  const sfx = new SFX();

  // ===== Particles =====
  const particles = [];
  function spawnParticles(x, y, opts = {}) {
    const count = Math.max(2, Math.round((opts.count || 12) * PARTICLE_SCALE));
    const speed = opts.speed || 3;
    const life = (opts.life || 700) * (isTouchDevice ? 0.8 : 1);
    const baseHue = opts.hue ?? 0;
    const size = opts.size || 3;
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = speed * (0.4 + Math.random() * 0.8);
      particles.push({
        x, y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        born: performance.now(),
        life,
        hue: baseHue + (Math.random() - 0.5) * 30,
        size: size * (0.7 + Math.random() * 0.7),
      });
    }
    if (particles.length > PARTICLE_CAP) particles.splice(0, particles.length - PARTICLE_CAP);
  }
  function updateParticles() {
    const now = performance.now();
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      if (now - p.born >= p.life) { particles.splice(i, 1); continue; }
      p.x += p.vx;
      p.y += p.vy;
      p.vx *= 0.93;
      p.vy *= 0.93;
    }
  }
  function drawParticles(ox, oy, vx, vy, vw, vh) {
    const now = performance.now();
    for (const p of particles) {
      const t = (now - p.born) / p.life;
      if (t > 1) continue;
      const fade = 1 - t;
      const sx = p.x + ox, sy = p.y + oy;
      if (sx < vx - 6 || sx > vx + vw + 6 || sy < vy - 6 || sy > vy + vh + 6) continue;
      ctx.fillStyle = `hsla(${p.hue}, 90%, 70%, ${fade})`;
      ctx.beginPath();
      ctx.arc(sx, sy, p.size * (0.4 + 0.7 * fade), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ===== Camera shake / flash / milestone =====
  let shakeAmount = 0;
  function cameraShake(amount) { shakeAmount = Math.max(shakeAmount, amount); }
  function flash(kind) {
    flashEl.classList.remove('show-red', 'show-gold');
    void flashEl.offsetWidth;
    flashEl.classList.add(kind === 'gold' ? 'show-gold' : 'show-red');
  }
  function showMilestone(text) {
    milestoneEl.textContent = text;
    milestoneEl.classList.remove('pop');
    void milestoneEl.offsetWidth;
    milestoneEl.classList.add('pop');
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
  }

  // ===== Wake lock + fullscreen =====
  let wakeLock = null;
  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator) {
        wakeLock = await navigator.wakeLock.request('screen');
      }
    } catch {}
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && players.length) requestWakeLock();
  });
  function tryFullscreen() {
    const isTouch = window.matchMedia('(pointer: coarse)').matches;
    if (!isTouch) return;
    const el = document.documentElement;
    try {
      const req = el.requestFullscreen || el.webkitRequestFullscreen;
      if (req) Promise.resolve(req.call(el)).catch(() => {});
    } catch {}
  }

  // ===== Death cause tracking =====
  let lastDeathCauseHTML = '';

  // ===== Kill feed =====
  let lastSeenKillId = 0;
  function processKills(killsList) {
    if (!killsList || !killsList.length) return;
    const myIds = new Set(players.map(p => p.id).filter(Boolean));
    for (const k of killsList) {
      if (!k || k.id <= lastSeenKillId) continue;
      lastSeenKillId = k.id;
      addKillRow(k);

      if (myIds.has(k.kid)) {
        sfx.kill();
        flash('gold');
        cameraShake(11);
        const ks = curr && curr.sn.find(s => s.id === k.kid);
        if (ks) spawnParticles(ks.s[0], ks.s[1], { count: 32, hue: k.vh, life: 900, speed: 5 });
        if (k.bountied) { showMilestone('💰 BOUNTY!'); sfx.milestone(); }
        else if (k.big) showMilestone('+' + k.vlen + ' EATS!');
      }
      if (myIds.has(k.vid)) {
        sfx.die();
        flash('red');
        cameraShake(20);
        const myP = players.find(p => p.id === k.vid);
        if (myP) spawnParticles(myP.headX, myP.headY, { count: 60, hue: myP.hue, life: 1200, speed: 7, size: 4 });
        // Capture cause for the death overlay text
        if (k.kn) {
          lastDeathCauseHTML = 'Killed by <strong style="color:hsl(' + k.kh + ',80%,68%)">' + escapeHtml(k.kn) + '</strong>';
        } else if (k.cause === 'hazard') {
          lastDeathCauseHTML = 'Hit a mine 💥';
        } else if (k.cause === 'wall') {
          lastDeathCauseHTML = 'Hit the wall 🧱';
        } else {
          lastDeathCauseHTML = 'You died';
        }
      }
    }
  }
  function addKillRow(k) {
    if (!killFeedEl) return;
    const div = document.createElement('div');
    div.className = 'kill-row';
    if (k.bountied) div.classList.add('bountied');
    const killer = k.kn ? `<span class="kn" style="color:hsl(${k.kh},80%,68%)">${escapeHtml(k.kn)}</span>` : '';
    let arrow;
    if (!k.kn) {
      if (k.cause === 'hazard') arrow = '<span class="arrow">💥</span>';
      else if (k.cause === 'wall') arrow = '<span class="arrow">🧱</span>';
      else arrow = '<span class="arrow">💀</span>';
    } else {
      arrow = '<span class="arrow">⚔</span>';
    }
    const victim = `<span class="vn" style="color:hsl(${k.vh},80%,68%)">${escapeHtml(k.vn)}</span>`;
    const bountyTag = k.bountied ? '<span class="bounty-tag">BOUNTY</span>' : '';
    div.innerHTML = killer + arrow + victim + bountyTag;
    killFeedEl.appendChild(div);
    setTimeout(() => div.classList.add('fade'), 4500);
    setTimeout(() => div.remove(), 5500);
    while (killFeedEl.children.length > 6) killFeedEl.firstChild.remove();
  }

  // ===== Combo HUD =====
  function updateComboHud() {
    let maxCombo = 0;
    for (const p of players) {
      if (!p.id) continue;
      const me = curr && curr.sn.find(s => s.id === p.id);
      if (me && me.c) maxCombo = Math.max(maxCombo, me.c);
    }
    if (maxCombo >= 3) {
      comboEl.textContent = 'x' + maxCombo;
      comboEl.classList.add('show');
    } else {
      comboEl.classList.remove('show');
    }
  }

  // ===== Bounty banner =====
  function updateBountyBanner() {
    let leader = null;
    if (curr) {
      for (const s of curr.sn) {
        if (s.l) { leader = s; break; }
      }
    }
    const myIds = new Set(players.map(p => p.id).filter(Boolean));
    if (leader) {
      bountyBannerEl.classList.remove('hidden');
      bountyNameEl.textContent = myIds.has(leader.id) ? 'YOU' : leader.name;
    } else {
      bountyBannerEl.classList.add('hidden');
    }
  }

  // ===== State =====
  class Player {
    constructor(slot) {
      this.slot = slot;
      this.id = null;
      this.name = '';
      this.hue = 200;
      this.alive = false;
      this.dead = false;
      this.length = 0;
      this.headX = 0;
      this.headY = 0;
      this.lastDir = 0;
      this.boost = false;
      this.turnLeft = false;
      this.turnRight = false;
      this.controls = null;
      this.respawnGraceUntil = 0;
      this.deathLength = 0;
      this.camX = 0;
      this.camY = 0;
      this.predictor = new Predictor();
    }
  }

  const players = [];
  let menuMode = 'solo';
  let curr = null;
  let prev = null;
  let currRecvAt = 0;
  let world = 2200;
  let hazards = [];
  let mouseX = window.innerWidth / 2;
  let mouseY = window.innerHeight / 2;
  let pickedHue = [HUES[Math.floor(Math.random() * HUES.length)],
                   HUES[Math.floor(Math.random() * HUES.length)]];

  // ===== Color pickers =====
  function buildColorPicker(slot) {
    const picker = colorPickers[slot];
    picker.innerHTML = '';
    HUES.forEach(h => {
      const sw = document.createElement('div');
      sw.className = 'swatch';
      sw.style.background = `hsl(${h}, 80%, 60%)`;
      sw.dataset.hue = h;
      if (h === pickedHue[slot]) sw.classList.add('selected');
      sw.addEventListener('click', () => {
        pickedHue[slot] = +sw.dataset.hue;
        picker.querySelectorAll('.swatch').forEach(c => c.classList.remove('selected'));
        sw.classList.add('selected');
      });
      picker.appendChild(sw);
    });
  }
  buildColorPicker(0);
  buildColorPicker(1);

  nameInputs[0].placeholder = FUNNY[Math.floor(Math.random() * FUNNY.length)];
  nameInputs[1].placeholder = FUNNY2[Math.floor(Math.random() * FUNNY2.length)];

  // ===== Persistence =====
  let savedName0 = null;
  try {
    savedName0 = localStorage.getItem('snakeo:p0name');
    if (savedName0) nameInputs[0].value = savedName0;
    const n1 = localStorage.getItem('snakeo:p1name');
    if (n1) nameInputs[1].value = n1;
    const h0 = localStorage.getItem('snakeo:p0hue');
    if (h0 !== null && HUES.includes(+h0)) {
      pickedHue[0] = +h0;
      buildColorPicker(0);
    }
    const h1 = localStorage.getItem('snakeo:p1hue');
    if (h1 !== null && HUES.includes(+h1)) {
      pickedHue[1] = +h1;
      buildColorPicker(1);
    }
    const savedMode = localStorage.getItem('snakeo:mode');
    if (savedMode === 'duo' && !isTouchDevice) {
      document.querySelector('.mode-tab[data-mode="duo"]').click();
    }
  } catch {}

  // ===== Mobile zero-tap auto-join =====
  // On touch devices, always auto-join as soon as the socket connects so cousins
  // can just open the URL and start playing. First visit gets a unique auto-name
  // (cool base + 3-char hex from a persistent device UUID), so cousins on different
  // phones never clash. Subsequent visits reuse their saved name.
  let autoJoinPending = false;
  if (isTouchDevice) {
    if (!savedName0) {
      const auto = autoName();
      nameInputs[0].value = auto;
      pickedHue[0] = HUES[Math.floor(Math.random() * HUES.length)];
      buildColorPicker(0);
    }
    autoJoinPending = true;
  }

  // ===== Mode tabs =====
  document.querySelectorAll('.mode-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.mode-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      menuMode = btn.dataset.mode;
      playerConfigs[1].classList.toggle('hidden', menuMode === 'solo');
      p1KeysEl.textContent = menuMode === 'duo' ? 'A · D · W' : '🖱 Mouse · Space';
    });
  });

  // ===== Start / respawn =====
  function startGame() {
    if (playBtn.disabled) return;
    const isDuo = menuMode === 'duo';
    players.length = 0;

    const p1 = new Player(0);
    p1.name = (nameInputs[0].value || nameInputs[0].placeholder).trim().slice(0, 16) || 'snake';
    p1.hue = pickedHue[0];
    p1.controls = isDuo ? CONTROLS.p1_kbd : CONTROLS.solo;
    players.push(p1);

    if (isDuo) {
      const p2 = new Player(1);
      p2.name = (nameInputs[1].value || nameInputs[1].placeholder).trim().slice(0, 16) || 'noodle';
      p2.hue = pickedHue[1];
      p2.controls = CONTROLS.p2_kbd;
      players.push(p2);
    }

    try {
      localStorage.setItem('snakeo:p0name', p1.name);
      localStorage.setItem('snakeo:p0hue', String(p1.hue));
      if (isDuo) {
        localStorage.setItem('snakeo:p1name', players[1].name);
        localStorage.setItem('snakeo:p1hue', String(players[1].hue));
      }
      localStorage.setItem('snakeo:mode', isDuo ? 'duo' : 'solo');
    } catch {}

    socket.emit('join', {
      players: players.map(p => ({ name: p.name, hue: p.hue })),
    });

    document.body.dataset.mode = isDuo ? 'duo' : 'solo';
    hideAllMenus();
    const now = performance.now();
    for (const p of players) {
      p.alive = true;
      p.dead = false;
      p.respawnGraceUntil = now + 1500;
    }
    sfx.resume();
    requestWakeLock();
    tryFullscreen();
  }

  function respawnPlayer(slot) {
    const p = players[slot];
    if (!p) return;
    if (performance.now() < p.respawnGraceUntil) return;
    // Solo: pick up any name/color the user just edited on the death overlay
    if (slot === 0 && players.length === 1 && deathNameInput) {
      const v = deathNameInput.value.trim().slice(0, 16);
      if (v) p.name = v;
      try {
        localStorage.setItem('snakeo:p0name', p.name);
        localStorage.setItem('snakeo:p0hue', String(p.hue));
      } catch {}
    }
    socket.emit('rejoin', { slot, name: p.name, hue: p.hue });
    hideDeathOverlay(slot);
    p.alive = true;
    p.dead = false;
    p.respawnGraceUntil = performance.now() + 1500;
    sfx.resume();
    requestWakeLock();
  }

  function hideAllMenus() {
    menu.classList.remove('show');
    menu.classList.add('hidden');
    death.classList.remove('show');
    death.classList.add('hidden');
    deathHalves.forEach(d => d.classList.add('hidden'));
  }

  function showDeathOverlay(slot, length) {
    if (players.length === 1) {
      const p = players[0];
      deathLen.textContent = length;
      if (deathCauseLineEl) {
        const cause = lastDeathCauseHTML || 'You died';
        deathCauseLineEl.innerHTML = cause + ' · Length ' + length;
      }
      if (deathNameInput && p) deathNameInput.value = p.name || '';
      if (deathColorPicker && p) {
        deathColorPicker.querySelectorAll('.swatch').forEach(c => {
          c.classList.toggle('selected', +c.dataset.hue === p.hue);
        });
      }
      death.classList.remove('hidden');
      death.classList.add('show');
    } else {
      const half = deathHalves[slot];
      half.querySelector('.dh-length').textContent = length;
      half.classList.remove('hidden');
    }
  }

  function hideDeathOverlay(slot) {
    if (players.length === 1) {
      death.classList.remove('show');
      death.classList.add('hidden');
    } else {
      deathHalves[slot]?.classList.add('hidden');
    }
  }

  playBtn.addEventListener('click', startGame);
  respawnBtn.addEventListener('click', () => respawnPlayer(0));
  nameInputs.forEach(inp => inp.addEventListener('keydown', e => {
    if (e.key === 'Enter') startGame();
  }));
  if (deathNameInput) {
    deathNameInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        respawnPlayer(0);
      }
      e.stopPropagation();
    });
  }
  // Build the death-screen color picker (independent of the menu's pickers)
  function buildDeathColorPicker() {
    if (!deathColorPicker) return;
    deathColorPicker.innerHTML = '';
    HUES.forEach(h => {
      const sw = document.createElement('div');
      sw.className = 'swatch';
      sw.style.background = `hsl(${h}, 80%, 60%)`;
      sw.dataset.hue = h;
      sw.addEventListener('click', () => {
        const newHue = +sw.dataset.hue;
        if (players[0]) players[0].hue = newHue;
        pickedHue[0] = newHue;
        deathColorPicker.querySelectorAll('.swatch').forEach(c => c.classList.remove('selected'));
        sw.classList.add('selected');
      });
      deathColorPicker.appendChild(sw);
    });
  }
  buildDeathColorPicker();

  // ===== Socket =====
  socket.on('connect', () => {
    statusEl.textContent = 'Connected!';
    statusEl.classList.remove('error');
    playBtn.disabled = false;
    playBtn.textContent = 'PLAY';
    if (autoJoinPending) {
      autoJoinPending = false;
      // Tiny delay so first frame paints and audio context can unlock on first tap
      setTimeout(() => startGame(), 120);
    }
  });
  socket.on('connect_error', (err) => {
    statusEl.textContent = 'Connection failed: ' + (err && err.message ? err.message : err);
    statusEl.classList.add('error');
  });
  socket.on('disconnect', () => {
    statusEl.textContent = 'Disconnected — refresh to reconnect.';
    statusEl.classList.add('error');
    for (const p of players) {
      if (p.alive) {
        p.alive = false;
        p.dead = true;
        showDeathOverlay(p.slot, p.length);
      }
    }
    playBtn.disabled = true;
    playBtn.textContent = 'Reconnecting…';
  });
  socket.on('hello', (data) => {
    if (!data) return;
    if (data.world) world = data.world;
    if (data.tickRate) tickInterval = 1000 / data.tickRate;
    if (Array.isArray(data.hazards)) hazards = data.hazards;
    if (data.physics) {
      if (typeof data.physics.turnRate === 'number') physics.turnRate = data.physics.turnRate;
      if (typeof data.physics.baseSpeed === 'number') physics.baseSpeed = data.physics.baseSpeed;
      if (typeof data.physics.boostSpeed === 'number') physics.boostSpeed = data.physics.boostSpeed;
      if (typeof data.physics.segSpacing === 'number') physics.segSpacing = data.physics.segSpacing;
      if (typeof data.physics.minBoostLen === 'number') physics.minBoostLen = data.physics.minBoostLen;
    }
  });
  socket.on('state', (data) => {
    if (!data) return;
    // Decode delta-encoded segments in-place: [hx, hy, dx, dy, ...] -> absolute
    if (data.sn) {
      for (let si = 0; si < data.sn.length; si++) {
        const seg = data.sn[si].s;
        if (!seg || seg.length < 4) continue;
        let x = seg[0], y = seg[1];
        for (let i = 2; i < seg.length; i += 2) {
          x += seg[i];
          y += seg[i + 1];
          seg[i] = x;
          seg[i + 1] = y;
        }
      }
    }
    prev = curr;
    curr = data;
    currRecvAt = performance.now();
    if (data.world) world = data.world;

    if (Array.isArray(data.yourIds)) {
      for (let i = 0; i < players.length; i++) {
        players[i].id = data.yourIds[i] || null;
      }
    }

    for (const p of players) {
      if (!p.id) continue;
      const me = data.sn.find(s => s.id === p.id);
      if (me && me.a) {
        const wasAlive = p.alive;
        if (p.dead) {
          p.dead = false;
          hideDeathOverlay(p.slot);
        }
        p.alive = true;
        const newLen = Math.floor(me.s.length / 2);
        if (p.length > 0 && newLen > p.length) {
          const now = performance.now();
          if (now - (p.lastEatSfx || 0) > 70) {
            p.lastEatSfx = now;
            sfx.eat();
            spawnParticles(me.s[0], me.s[1], { count: 4, hue: p.hue, life: 380, speed: 1.6, size: 2 });
          }
        }
        p.length = newLen;
        p.headX = me.s[0];
        p.headY = me.s[1];
        p.lastDir = me.d;
        // Client-side prediction reconciliation
        if (!wasAlive || !p.predictor.alive) {
          p.predictor.initFromServer(me.s, me.d);
        } else {
          p.predictor.reconcile(me.s, me.d);
        }
      } else if (me && !me.a) {
        if (p.alive && performance.now() > p.respawnGraceUntil) {
          p.alive = false;
          p.dead = true;
          p.deathLength = p.length;
          p.predictor.reset();
          showDeathOverlay(p.slot, p.length);
        }
      } else if (!me && p.alive && performance.now() > p.respawnGraceUntil) {
        p.alive = false;
        p.dead = true;
        p.deathLength = p.length;
        p.predictor.reset();
        showDeathOverlay(p.slot, p.length);
      }
    }

    processKills(data.kills);
    updateBountyBanner();
    updateComboHud();
    updateHud();
    updateLeaderboard(data.lb);
  });

  function updateHud() {
    if (players[0]) lengthEl.textContent = players[0].length;
    if (players[1]) length2El.textContent = players[1].length;
  }

  function updateLeaderboard(lb) {
    if (!lb) return;
    lbList.innerHTML = '';
    const myIds = new Set(players.map(p => p.id).filter(Boolean));
    lb.forEach((e, idx) => {
      const li = document.createElement('li');
      if (myIds.has(e.id)) li.classList.add('you');
      const rank = document.createElement('span');
      rank.className = 'rank';
      rank.textContent = (idx + 1) + '.';
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = `hsl(${e.hue}, 80%, 60%)`;
      const name = document.createElement('span');
      name.className = 'lname';
      name.textContent = e.name;
      if (e.bot) li.classList.add('bot-row');
      const sc = document.createElement('span');
      sc.className = 'lscore';
      sc.textContent = e.score;
      li.append(rank, dot, name, sc);
      lbList.appendChild(li);
    });
  }

  // ===== Input =====
  canvas.addEventListener('mousemove', e => { mouseX = e.clientX; mouseY = e.clientY; });
  canvas.addEventListener('mousedown', e => {
    if (e.button === 0) {
      for (const p of players) if (p.controls?.type === 'mouse' && p.alive) p.boost = true;
    }
  });
  window.addEventListener('mouseup', () => {
    for (const p of players) if (p.controls?.type === 'mouse') p.boost = false;
  });
  window.addEventListener('blur', () => { for (const p of players) p.boost = false; });

  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    // Don't intercept while typing in the menu/death name inputs.
    const tgt = e.target;
    if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA')) return;
    for (const p of players) {
      const c = p.controls;
      if (!c) continue;
      if (p.dead) {
        if (c.respawn?.includes(e.code)) {
          respawnPlayer(p.slot);
          e.preventDefault();
        }
        continue;
      }
      if (!p.alive) continue;
      if (c.type === 'keyboard') {
        if (c.turnLeft.includes(e.code)) { p.turnLeft = true; e.preventDefault(); }
        if (c.turnRight.includes(e.code)) { p.turnRight = true; e.preventDefault(); }
        if (c.boost.includes(e.code)) { p.boost = true; e.preventDefault(); }
      } else if (c.type === 'mouse') {
        if (c.boost.includes(e.code)) { p.boost = true; e.preventDefault(); }
      }
    }
  });
  window.addEventListener('keyup', (e) => {
    for (const p of players) {
      const c = p.controls;
      if (!c) continue;
      if (c.type === 'keyboard') {
        if (c.turnLeft?.includes(e.code)) p.turnLeft = false;
        if (c.turnRight?.includes(e.code)) p.turnRight = false;
      }
      if (c.boost?.includes(e.code)) p.boost = false;
    }
  });

  // Touch input (solo only):
  //  - One finger: steer in the direction it's pointing
  //  - Double-tap-and-hold: the second tap held activates BOOST while held
  let steerTouchId = null;
  let boostTouchId = null;
  let steerStartedAt = 0;
  let lastQuickTapEndAt = 0;
  const DOUBLE_TAP_GAP_MS = 280;
  const QUICK_TAP_MAX_MS = 220;

  function isTouchModePlayer() {
    return players.length === 1 && players[0]?.controls?.type === 'mouse';
  }

  canvas.addEventListener('touchstart', (e) => {
    sfx.resume();
    if (!isTouchModePlayer()) return;
    const now = performance.now();
    for (let i = 0; i < e.changedTouches.length; i++) {
      const t = e.changedTouches[i];
      if (boostTouchId === null && lastQuickTapEndAt > 0 && (now - lastQuickTapEndAt) < DOUBLE_TAP_GAP_MS) {
        // Second tap of a double-tap-and-hold → BOOST
        boostTouchId = t.identifier;
        if (players[0]) players[0].boost = true;
        lastQuickTapEndAt = 0;
        mouseX = t.clientX;
        mouseY = t.clientY;
        const hint = document.getElementById('boost-hint');
        if (hint) { hint.classList.add('faded'); setTimeout(() => hint.remove(), 800); }
      } else if (steerTouchId === null) {
        steerTouchId = t.identifier;
        steerStartedAt = now;
        mouseX = t.clientX;
        mouseY = t.clientY;
      }
    }
    if (players[0].dead) respawnPlayer(0);
    e.preventDefault();
  }, { passive: false });

  canvas.addEventListener('touchmove', (e) => {
    if (!isTouchModePlayer()) return;
    for (let i = 0; i < e.changedTouches.length; i++) {
      const t = e.changedTouches[i];
      if (t.identifier === steerTouchId || t.identifier === boostTouchId) {
        mouseX = t.clientX;
        mouseY = t.clientY;
      }
    }
    e.preventDefault();
  }, { passive: false });

  function endTouch(e) {
    const now = performance.now();
    for (let i = 0; i < e.changedTouches.length; i++) {
      const t = e.changedTouches[i];
      if (t.identifier === steerTouchId) {
        const dur = now - steerStartedAt;
        steerTouchId = null;
        // A short tap arms the double-tap-and-hold window
        if (dur > 0 && dur < QUICK_TAP_MAX_MS) lastQuickTapEndAt = now;
        else lastQuickTapEndAt = 0;
      } else if (t.identifier === boostTouchId) {
        boostTouchId = null;
        if (players[0]) players[0].boost = false;
        lastQuickTapEndAt = 0;
      }
    }
  }
  canvas.addEventListener('touchend', endTouch);
  canvas.addEventListener('touchcancel', endTouch);

  // ===== 30Hz input loop =====
  setInterval(() => {
    if (!players.length) {
      socket.emit('input', { views: [{ x: 0, y: 0 }] });
      return;
    }
    const inputs = [];
    const views = [];
    for (const p of players) {
      let angle = p.lastDir;
      if (p.alive) {
        const c = p.controls;
        if (c?.type === 'mouse') {
          const cw = window.innerWidth, ch = window.innerHeight;
          angle = Math.atan2(mouseY - ch / 2, mouseX - cw / 2);
        } else if (c?.type === 'keyboard') {
          const turn = (p.turnRight ? 1 : 0) - (p.turnLeft ? 1 : 0);
          if (turn !== 0) angle = p.lastDir + turn * 1.8;
        }
      }
      inputs.push({ a: angle, b: !!p.boost });
      views.push({ x: p.headX || 0, y: p.headY || 0 });
      if (p.boost && !p.lastBoost && p.alive) sfx.boost();
      p.lastBoost = p.boost;
    }
    socket.emit('input', { inputs, views });
  }, 1000 / 30);

  // ===== Interpolation =====
  // Allow extrapolation up to 2x past the latest snapshot — masks bigger
  // network jitters on cellular while still snapping cleanly when reality
  // arrives. Combined with delta encoding the snapshots arrive faster too.
  const MAX_INTERP_ALPHA = 2.0;

  function getInterpolatedHead(snakeId) {
    // Local players: use the predictor for instant input response
    for (const p of players) {
      if (p.id === snakeId && p.predictor && p.predictor.alive && p.predictor.segments.length > 0) {
        return { x: p.predictor.segments[0].x, y: p.predictor.segments[0].y };
      }
    }
    if (!curr) return null;
    const cs = curr.sn.find(s => s.id === snakeId);
    if (!cs) return null;
    if (!prev) return { x: cs.s[0], y: cs.s[1] };
    const ps = prev.sn.find(s => s.id === snakeId);
    if (!ps) return { x: cs.s[0], y: cs.s[1] };
    const dt = performance.now() - currRecvAt;
    const a = Math.min(MAX_INTERP_ALPHA, dt / tickInterval);
    return {
      x: ps.s[0] + (cs.s[0] - ps.s[0]) * a,
      y: ps.s[1] + (cs.s[1] - ps.s[1]) * a,
    };
  }

  function lerpSegments(snake) {
    if (!prev) return snake.s;
    const ps = prev.sn.find(s => s.id === snake.id);
    if (!ps) return snake.s;
    const cs = snake.s;
    const dt = performance.now() - currRecvAt;
    const a = Math.min(MAX_INTERP_ALPHA, dt / tickInterval);
    // Lerp matching indices; for any new tail (snake grew), use curr verbatim.
    const matchLen = Math.min(cs.length, ps.s.length);
    const out = new Array(cs.length);
    for (let i = 0; i < matchLen; i++) {
      out[i] = ps.s[i] + (cs[i] - ps.s[i]) * a;
    }
    for (let i = matchLen; i < cs.length; i++) out[i] = cs[i];
    return out;
  }

  // ===== Rendering =====
  function render() {
    requestAnimationFrame(render);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const w = window.innerWidth, h = window.innerHeight;

    // Decay shake once per frame and update particles + predictors once per frame
    if (shakeAmount > 0.5) shakeAmount *= 0.85;
    else shakeAmount = 0;
    updateParticles();
    updatePredictors();

    if (!curr || !players.length) {
      ctx.fillStyle = '#06060e';
      ctx.fillRect(0, 0, w, h);
      return;
    }

    if (players.length === 2) {
      const halfW = w / 2;
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, halfW, h);
      ctx.clip();
      drawWorldFor(players[0], 0, 0, halfW, h);
      ctx.restore();

      ctx.save();
      ctx.beginPath();
      ctx.rect(halfW, 0, halfW, h);
      ctx.clip();
      drawWorldFor(players[1], halfW, 0, halfW, h);
      ctx.restore();

      // Divider with subtle glow
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(halfW - 2, 0, 4, h);
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      ctx.fillRect(halfW - 0.5, 0, 1, h);
    } else {
      drawWorldFor(players[0], 0, 0, w, h);
    }

    drawMinimap();
  }

  function drawWorldFor(player, vx, vy, vw, vh) {
    let camX = 0, camY = 0;
    if (player.id) {
      const head = getInterpolatedHead(player.id);
      if (head) { camX = head.x; camY = head.y; }
      else { camX = player.headX; camY = player.headY; }
    } else {
      camX = player.headX; camY = player.headY;
    }
    player.camX = camX;
    player.camY = camY;

    const shakeX = (Math.random() - 0.5) * shakeAmount;
    const shakeY = (Math.random() - 0.5) * shakeAmount;
    const ox = vx + vw / 2 - camX + shakeX;
    const oy = vy + vh / 2 - camY + shakeY;

    ctx.fillStyle = '#06060e';
    ctx.fillRect(vx, vy, vw, vh);

    drawGrid(camX, camY, ox, oy, vx, vy, vw, vh);
    drawWorldBoundary(ox, oy);
    drawHazards(ox, oy, vx, vy, vw, vh);
    drawFood(ox, oy, vx, vy, vw, vh);
    drawSnakes(ox, oy, vx, vy, vw, vh, player);
    drawParticles(ox, oy, vx, vy, vw, vh);
    drawOffScreenIndicators(player, vx, vy, vw, vh, ox, oy);
  }

  function drawOffScreenIndicators(player, vx, vy, vw, vh, ox, oy) {
    if (!curr) return;
    const myIds = new Set(players.map(p => p.id).filter(Boolean));
    const ccX = vx + vw / 2;
    const ccY = vy + vh / 2;
    const margin = Math.min(60, vw / 8);
    const radius = Math.min(vw, vh) / 2 - margin;
    const time = performance.now();

    const candidates = [];
    for (const s of curr.sn) {
      if (!s.a || s.bot) continue;
      if (myIds.has(s.id)) continue;
      if (!s.s || s.s.length < 2) continue;
      const head = getInterpolatedHead(s.id);
      if (!head) continue;
      const sx = head.x + ox;
      const sy = head.y + oy;
      if (sx >= vx + 30 && sx <= vx + vw - 30 && sy >= vy + 30 && sy <= vy + vh - 30) continue;
      const dx = head.x - player.camX;
      const dy = head.y - player.camY;
      candidates.push({ s, head, dx, dy, dist: Math.hypot(dx, dy) });
    }
    candidates.sort((a, b) => (b.s.l ? 1 : 0) - (a.s.l ? 1 : 0) || a.dist - b.dist);
    const limit = isTouchDevice ? 4 : 8;

    for (let i = 0; i < Math.min(limit, candidates.length); i++) {
      const c = candidates[i];
      const s = c.s;
      const ang = Math.atan2(c.dy, c.dx);
      const ax = ccX + Math.cos(ang) * radius;
      const ay = ccY + Math.sin(ang) * radius;

      ctx.save();
      ctx.translate(ax, ay);
      ctx.rotate(ang);
      if (s.l) {
        const pulse = Math.sin(time * 0.006) * 0.3 + 1;
        ctx.fillStyle = `hsla(50, 95%, 65%, ${0.7 + pulse * 0.3})`;
      } else {
        ctx.fillStyle = `hsl(${s.hue}, 80%, 65%)`;
      }
      ctx.beginPath();
      ctx.moveTo(13, 0);
      ctx.lineTo(-9, -8);
      ctx.lineTo(-9, 8);
      ctx.closePath();
      ctx.fill();
      if (s.l) {
        ctx.strokeStyle = '#ffe066';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      ctx.restore();

      ctx.font = '600 11px Segoe UI, Inter, sans-serif';
      ctx.textAlign = 'center';
      const label = (s.l ? '💰 ' : '') + s.name + ' · ' + Math.round(c.dist);
      if (isTouchDevice) {
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(0,0,0,0.85)';
        ctx.strokeText(label, ax, ay + 22);
      } else {
        ctx.shadowColor = 'rgba(0,0,0,0.85)';
        ctx.shadowBlur = 4;
      }
      ctx.fillStyle = s.l ? '#ffe066' : `hsl(${s.hue}, 85%, 78%)`;
      ctx.fillText(label, ax, ay + 22);
      ctx.shadowBlur = 0;
    }
  }

  function drawGrid(camX, camY, ox, oy, vx, vy, vw, vh) {
    const gridSize = 48;
    const startX = Math.floor((camX - vw / 2) / gridSize) * gridSize;
    const endX = camX + vw / 2 + gridSize;
    const startY = Math.floor((camY - vh / 2) / gridSize) * gridSize;
    const endY = camY + vh / 2 + gridSize;

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.035)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = startX; x <= endX; x += gridSize) {
      ctx.moveTo(x + ox, vy);
      ctx.lineTo(x + ox, vy + vh);
    }
    for (let y = startY; y <= endY; y += gridSize) {
      ctx.moveTo(vx, y + oy);
      ctx.lineTo(vx + vw, y + oy);
    }
    ctx.stroke();
  }

  function drawWorldBoundary(ox, oy) {
    ctx.beginPath();
    ctx.arc(ox, oy, world + 14, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255, 60, 60, 0.18)';
    ctx.lineWidth = 32;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(ox, oy, world, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255, 110, 110, 0.55)';
    ctx.lineWidth = 3;
    ctx.stroke();
  }

  function drawHazards(ox, oy, vx, vy, vw, vh) {
    const t = performance.now();
    for (const h of hazards) {
      const sx = h.x + ox, sy = h.y + oy;
      const margin = h.r * 2 + 30;
      if (sx + margin < vx || sx - margin > vx + vw) continue;
      if (sy + margin < vy || sy - margin > vy + vh) continue;

      const pulse = 1 + Math.sin(t * 0.004 + h.id) * 0.12;

      if (isTouchDevice) {
        // Mobile: cheap two-circle hazard. Visually clear, ~5x less Canvas work.
        ctx.fillStyle = 'rgba(255, 60, 60, 0.22)';
        ctx.beginPath();
        ctx.arc(sx, sy, h.r * 1.45 * pulse, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#d92525';
        ctx.beginPath();
        ctx.arc(sx, sy, h.r, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#ffe6a0';
        ctx.beginPath();
        ctx.arc(sx, sy, h.r * 0.32, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }

      // Desktop: full glow + spinning spike rotor
      const gr = h.r * 1.6 * pulse;
      const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, gr);
      g.addColorStop(0, 'rgba(255, 60, 60, 0.55)');
      g.addColorStop(0.5, 'rgba(255, 30, 30, 0.18)');
      g.addColorStop(1, 'rgba(255, 30, 30, 0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(sx, sy, gr, 0, Math.PI * 2);
      ctx.fill();

      ctx.save();
      ctx.translate(sx, sy);
      ctx.rotate((t * 0.0009 * (h.spin || 1) + h.id) % (Math.PI * 2));
      const spikes = 8;
      const rOut = h.r;
      const rIn = h.r * 0.45;
      ctx.beginPath();
      for (let i = 0; i < spikes; i++) {
        const a1 = (i / spikes) * Math.PI * 2;
        const a2 = ((i + 0.5) / spikes) * Math.PI * 2;
        if (i === 0) ctx.moveTo(Math.cos(a1) * rOut, Math.sin(a1) * rOut);
        else ctx.lineTo(Math.cos(a1) * rOut, Math.sin(a1) * rOut);
        ctx.lineTo(Math.cos(a2) * rIn, Math.sin(a2) * rIn);
      }
      ctx.closePath();
      const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, rOut);
      grad.addColorStop(0, '#ff5050');
      grad.addColorStop(1, '#7a0010');
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = 'rgba(255, 200, 200, 0.5)';
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(0, 0, h.r * 0.28, 0, Math.PI * 2);
      ctx.fillStyle = '#ffe6a0';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(0, 0, h.r * 0.16, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.restore();
    }
  }

  function drawFood(ox, oy, vx, vy, vw, vh) {
    if (!curr || !curr.f) return;
    const f = curr.f;
    const t = performance.now() * 0.0025;
    for (let i = 0; i < f.length; i += 5) {
      const id = f[i];
      const fx = f[i + 1], fy = f[i + 2], fh = f[i + 3], fs = f[i + 4];
      const sx = fx + ox, sy = fy + oy;
      if (sx < vx - 30 || sx > vx + vw + 30 || sy < vy - 30 || sy > vy + vh + 30) continue;

      const isGold = fh === 51 && fs >= 4;
      const r = isGold ? 8 : 4 + fs * 1.4;

      // Outer glow gradient is the most expensive part — keep on desktop and for gold orbs only on mobile
      if (!isTouchDevice || isGold) {
        const pulse = 1 + Math.sin(t + id * 0.7) * 0.18;
        const glowR = r * (isGold ? 4.5 : 3) * pulse;
        const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, glowR);
        if (isGold) {
          g.addColorStop(0, 'rgba(255, 220, 100, 0.85)');
          g.addColorStop(0.5, 'rgba(255, 200, 80, 0.3)');
          g.addColorStop(1, 'rgba(255, 200, 80, 0)');
        } else {
          g.addColorStop(0, `hsla(${fh}, 90%, 70%, 0.55)`);
          g.addColorStop(1, `hsla(${fh}, 90%, 70%, 0)`);
        }
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(sx, sy, glowR, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.fillStyle = isGold ? '#ffd95a' : `hsl(${fh}, 95%, 65%)`;
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fill();

      if (!isTouchDevice || isGold) {
        ctx.fillStyle = isGold ? 'rgba(255, 255, 200, 0.95)' : `hsla(${fh}, 100%, 90%, 0.7)`;
        ctx.beginPath();
        ctx.arc(sx - r * 0.3, sy - r * 0.3, r * 0.4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  function drawSnakes(ox, oy, vx, vy, vw, vh, player) {
    if (!curr) return;
    const sorted = curr.sn.slice().sort((a, b) => a.s.length - b.s.length);
    const time = performance.now();
    for (const s of sorted) drawSnake(s, ox, oy, vx, vy, vw, vh, player, time);
  }

  function drawSnake(s, ox, oy, vx, vy, vw, vh, player, time) {
    if (!s.a) return;
    const isLocal = player && s.id === player.id;
    // Use the predictor's segments for our own snake — feels instant.
    let seg;
    if (isLocal && player.predictor && player.predictor.alive && player.predictor.segments.length > 1) {
      seg = player.predictor.exportFlat();
    } else {
      seg = lerpSegments(s);
    }
    if (!seg || seg.length < 4) return;

    const r = 9;
    const reach = (seg.length / 2) * 9 + 30;
    const hx0 = seg[0] + ox, hy0 = seg[1] + oy;
    if (hx0 + reach < vx || hx0 - reach > vx + vw) return;
    if (hy0 + reach < vy || hy0 - reach > vy + vh) return;

    // Bounty leader gold halo around head (drawn first, under body)
    if (s.l) {
      const pulse = 1 + Math.sin(time * 0.006) * 0.18;
      const gradR = 38 * pulse;
      const grad = ctx.createRadialGradient(hx0, hy0, 0, hx0, hy0, gradR);
      grad.addColorStop(0, 'rgba(255, 220, 80, 0.55)');
      grad.addColorStop(1, 'rgba(255, 220, 80, 0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(hx0, hy0, gradR, 0, Math.PI * 2);
      ctx.fill();
    }

    const bodyColor = `hsl(${s.hue}, 75%, 50%)`;
    const darkColor = `hsl(${s.hue}, 85%, 22%)`;
    const lightColor = `hsl(${s.hue}, 90%, 70%)`;

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    ctx.beginPath();
    ctx.moveTo(seg[0] + ox, seg[1] + oy);
    for (let i = 2; i < seg.length; i += 2) {
      ctx.lineTo(seg[i] + ox, seg[i + 1] + oy);
    }

    if (s.b && !isTouchDevice) {
      ctx.shadowColor = lightColor;
      ctx.shadowBlur = 22;
    } else {
      ctx.shadowBlur = 0;
    }

    ctx.strokeStyle = darkColor;
    ctx.lineWidth = r * 2 + 2;
    ctx.stroke();

    ctx.shadowBlur = 0;
    ctx.strokeStyle = bodyColor;
    ctx.lineWidth = r * 2;
    ctx.stroke();

    // Animated dashed stripe — desktop only. On mobile this stroke costs more
    // than it adds because Canvas2D recomputes the dash pattern over the
    // whole polyline every frame.
    if (!isTouchDevice) {
      const speedFactor = s.b ? 4.0 : 1.4;
      ctx.strokeStyle = lightColor;
      ctx.lineWidth = r * 0.6;
      ctx.setLineDash([12, 22]);
      const idHash = (s.id && typeof s.id === 'string') ? (parseInt(s.id.slice(0, 4), 36) || 0) : 0;
      ctx.lineDashOffset = -((time * 0.05 * speedFactor + idHash * 0.001) % 10000);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Eyes
    const headX = seg[0] + ox, headY = seg[1] + oy;
    let ang = s.d;
    if (typeof ang !== 'number') {
      const nx = seg[0] - seg[2], ny = seg[1] - seg[3];
      ang = Math.atan2(ny, nx);
    }
    const eyeOff = r * 0.55;
    const eyeFwd = r * 0.35;
    const ex = headX + Math.cos(ang) * eyeFwd;
    const ey = headY + Math.sin(ang) * eyeFwd;
    const px = -Math.sin(ang) * eyeOff, py = Math.cos(ang) * eyeOff;

    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(ex + px, ey + py, r * 0.42, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(ex - px, ey - py, r * 0.42, 0, Math.PI * 2); ctx.fill();

    let pAng = ang;
    if (isLocal) {
      if (player.controls?.type === 'mouse') {
        pAng = Math.atan2(mouseY - window.innerHeight / 2, mouseX - window.innerWidth / 2);
      } else if (player.controls?.type === 'keyboard') {
        const turn = (player.turnRight ? 1 : 0) - (player.turnLeft ? 1 : 0);
        if (turn !== 0) pAng = ang + turn * 0.55;
      }
    }
    const pOff = r * 0.2;
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.arc(ex + px + Math.cos(pAng) * pOff, ey + py + Math.sin(pAng) * pOff, r * 0.22, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(ex - px + Math.cos(pAng) * pOff, ey - py + Math.sin(pAng) * pOff, r * 0.22, 0, Math.PI * 2);
    ctx.fill();

    // Name tag
    const youSuffix = isLocal ? ' (you)' : '';
    const leaderPrefix = s.l ? '💰 ' : '';
    const label = leaderPrefix + s.name + youSuffix;
    ctx.font = '600 12px Segoe UI, Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    if (isTouchDevice) {
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.strokeText(label, headX, headY - r - 8);
    } else {
      ctx.shadowColor = 'rgba(0,0,0,0.85)';
      ctx.shadowBlur = 4;
    }
    ctx.fillStyle = s.l ? '#ffe066' : (isLocal ? '#ffe066' : 'rgba(255,255,255,0.92)');
    ctx.fillText(label, headX, headY - r - 8);
    ctx.shadowBlur = 0;
  }

  function drawMinimap() {
    minictx.clearRect(0, 0, 160, 160);
    minictx.fillStyle = 'rgba(7, 8, 15, 0.85)';
    minictx.fillRect(0, 0, 160, 160);

    const cx = 80, cy = 80, r = 72;
    minictx.beginPath();
    minictx.arc(cx, cy, r, 0, Math.PI * 2);
    minictx.fillStyle = 'rgba(91, 140, 255, 0.06)';
    minictx.fill();
    minictx.strokeStyle = 'rgba(255, 110, 110, 0.5)';
    minictx.lineWidth = 1.5;
    minictx.stroke();

    // Hazards
    minictx.fillStyle = 'rgba(255, 60, 60, 0.7)';
    for (const h of hazards) {
      const x = (h.x / world) * r + cx;
      const y = (h.y / world) * r + cy;
      minictx.beginPath();
      minictx.arc(x, y, 1.5, 0, Math.PI * 2);
      minictx.fill();
    }

    if (!curr) return;
    const myIds = new Set(players.map(p => p.id).filter(Boolean));
    for (const s of curr.sn) {
      if (!s.a) continue;
      const x = (s.s[0] / world) * r + cx;
      const y = (s.s[1] / world) * r + cy;
      const isMine = myIds.has(s.id);
      minictx.fillStyle = isMine ? '#ffe066' : `hsl(${s.hue}, 75%, 60%)`;
      const sz = isMine ? 3.5 : (s.bot ? 1.8 : 2.5);
      minictx.beginPath();
      minictx.arc(x, y, sz, 0, Math.PI * 2);
      minictx.fill();
    }
  }

  render();
})();
