(() => {
  'use strict';

  const socket = io();
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
  const touchBoost = document.getElementById('touch-boost');

  // ===== Canvas sizing =====
  let dpr = Math.min(window.devicePixelRatio || 1, 2);
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
  const tickInterval = 1000 / 30;

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
  try {
    const n0 = localStorage.getItem('snakeo:p0name');
    if (n0) nameInputs[0].value = n0;
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
    if (savedMode === 'duo') {
      document.querySelector('.mode-tab[data-mode="duo"]').click();
    }
  } catch {}

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
  }

  function respawnPlayer(slot) {
    const p = players[slot];
    if (!p) return;
    if (performance.now() < p.respawnGraceUntil) return;
    socket.emit('rejoin', { slot, name: p.name, hue: p.hue });
    hideDeathOverlay(slot);
    p.alive = true;
    p.dead = false;
    p.respawnGraceUntil = performance.now() + 1500;
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
      deathLen.textContent = length;
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

  // ===== Socket =====
  socket.on('connect', () => {
    statusEl.textContent = 'Connected!';
    statusEl.classList.remove('error');
    playBtn.disabled = false;
    playBtn.textContent = 'PLAY';
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
    if (Array.isArray(data.hazards)) hazards = data.hazards;
  });
  socket.on('state', (data) => {
    if (!data) return;
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
        if (p.dead) {
          p.dead = false;
          hideDeathOverlay(p.slot);
        }
        p.alive = true;
        p.length = Math.floor(me.s.length / 2);
        p.headX = me.s[0];
        p.headY = me.s[1];
        p.lastDir = me.d;
      } else if (me && !me.a) {
        if (p.alive && performance.now() > p.respawnGraceUntil) {
          p.alive = false;
          p.dead = true;
          p.deathLength = p.length;
          showDeathOverlay(p.slot, p.length);
        }
      } else if (!me && p.alive && performance.now() > p.respawnGraceUntil) {
        p.alive = false;
        p.dead = true;
        p.deathLength = p.length;
        showDeathOverlay(p.slot, p.length);
      }
    }

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
      name.textContent = (e.bot ? '' : '') + e.name;
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

  // Touch steering (solo only) — track a single canvas touch as the steering finger
  let steerTouchId = null;
  canvas.addEventListener('touchstart', (e) => {
    if (players.length !== 1 || players[0].controls?.type !== 'mouse') return;
    if (steerTouchId === null && e.changedTouches.length > 0) {
      const t = e.changedTouches[0];
      steerTouchId = t.identifier;
      mouseX = t.clientX;
      mouseY = t.clientY;
    }
    if (players[0].dead) respawnPlayer(0);
    e.preventDefault();
  }, { passive: false });
  canvas.addEventListener('touchmove', (e) => {
    if (players.length !== 1 || players[0].controls?.type !== 'mouse') return;
    for (let i = 0; i < e.changedTouches.length; i++) {
      const t = e.changedTouches[i];
      if (t.identifier === steerTouchId) {
        mouseX = t.clientX;
        mouseY = t.clientY;
        break;
      }
    }
    e.preventDefault();
  }, { passive: false });
  function endSteerTouch(e) {
    for (let i = 0; i < e.changedTouches.length; i++) {
      if (e.changedTouches[i].identifier === steerTouchId) {
        steerTouchId = null;
        break;
      }
    }
  }
  canvas.addEventListener('touchend', endSteerTouch);
  canvas.addEventListener('touchcancel', endSteerTouch);

  // Boost button (touch + mouse via pointer events)
  function setTouchBoost(on) {
    for (const p of players) if (p.controls?.type === 'mouse') p.boost = on;
    touchBoost.classList.toggle('active', on);
  }
  if (touchBoost) {
    touchBoost.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try { touchBoost.setPointerCapture(e.pointerId); } catch {}
      setTouchBoost(true);
    });
    const releaseBoost = (e) => {
      try { touchBoost.releasePointerCapture(e.pointerId); } catch {}
      setTouchBoost(false);
    };
    touchBoost.addEventListener('pointerup', releaseBoost);
    touchBoost.addEventListener('pointercancel', releaseBoost);
    touchBoost.addEventListener('pointerleave', releaseBoost);
    touchBoost.addEventListener('contextmenu', (e) => e.preventDefault());
  }

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
    }
    socket.emit('input', { inputs, views });
  }, 1000 / 30);

  // ===== Interpolation =====
  function getInterpolatedHead(snakeId) {
    if (!curr) return null;
    const cs = curr.sn.find(s => s.id === snakeId);
    if (!cs) return null;
    if (!prev) return { x: cs.s[0], y: cs.s[1] };
    const ps = prev.sn.find(s => s.id === snakeId);
    if (!ps || ps.s.length !== cs.s.length) return { x: cs.s[0], y: cs.s[1] };
    const dt = performance.now() - currRecvAt;
    const a = Math.min(1, dt / tickInterval);
    return {
      x: ps.s[0] + (cs.s[0] - ps.s[0]) * a,
      y: ps.s[1] + (cs.s[1] - ps.s[1]) * a,
    };
  }

  function lerpSegments(snake) {
    if (!prev) return snake.s;
    const ps = prev.sn.find(s => s.id === snake.id);
    if (!ps || ps.s.length !== snake.s.length) return snake.s;
    const dt = performance.now() - currRecvAt;
    const a = Math.min(1, dt / tickInterval);
    const cs = snake.s;
    const out = new Array(cs.length);
    for (let i = 0; i < cs.length; i++) {
      out[i] = ps.s[i] + (cs[i] - ps.s[i]) * a;
    }
    return out;
  }

  // ===== Rendering =====
  function render() {
    requestAnimationFrame(render);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const w = window.innerWidth, h = window.innerHeight;

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

    if (players.length === 1) drawMinimap();
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

    const ox = vx + vw / 2 - camX;
    const oy = vy + vh / 2 - camY;

    ctx.fillStyle = '#06060e';
    ctx.fillRect(vx, vy, vw, vh);

    drawGrid(camX, camY, ox, oy, vx, vy, vw, vh);
    drawWorldBoundary(ox, oy);
    drawHazards(ox, oy, vx, vy, vw, vh);
    drawFood(ox, oy, vx, vy, vw, vh);
    drawSnakes(ox, oy, vx, vy, vw, vh, player);
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

      // Outer pulsing glow
      const pulse = 1 + Math.sin(t * 0.004 + h.id) * 0.12;
      const gr = h.r * 1.6 * pulse;
      const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, gr);
      g.addColorStop(0, 'rgba(255, 60, 60, 0.55)');
      g.addColorStop(0.5, 'rgba(255, 30, 30, 0.18)');
      g.addColorStop(1, 'rgba(255, 30, 30, 0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(sx, sy, gr, 0, Math.PI * 2);
      ctx.fill();

      // Spinning spike body
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

      // Inner core
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

      ctx.fillStyle = isGold ? '#ffd95a' : `hsl(${fh}, 95%, 65%)`;
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = isGold ? 'rgba(255, 255, 200, 0.95)' : `hsla(${fh}, 100%, 90%, 0.7)`;
      ctx.beginPath();
      ctx.arc(sx - r * 0.3, sy - r * 0.3, r * 0.4, 0, Math.PI * 2);
      ctx.fill();
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
    const seg = lerpSegments(s);
    if (!seg || seg.length < 4) return;

    const r = 9;
    const isLocal = player && s.id === player.id;
    const reach = (seg.length / 2) * 9 + 30;
    const hx0 = seg[0] + ox, hy0 = seg[1] + oy;
    if (hx0 + reach < vx || hx0 - reach > vx + vw) return;
    if (hy0 + reach < vy || hy0 - reach > vy + vh) return;

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

    if (s.b) {
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

    const speedFactor = s.b ? 4.0 : 1.4;
    ctx.strokeStyle = lightColor;
    ctx.lineWidth = r * 0.6;
    ctx.setLineDash([12, 22]);
    const idHash = (s.id && typeof s.id === 'string') ? (parseInt(s.id.slice(0, 4), 36) || 0) : 0;
    ctx.lineDashOffset = -((time * 0.05 * speedFactor + idHash * 0.001) % 10000);
    ctx.stroke();
    ctx.setLineDash([]);

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
    const label = (s.bot ? '' : '') + s.name + youSuffix;
    ctx.font = '600 12px Segoe UI, Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = isLocal ? '#ffe066' : 'rgba(255,255,255,0.92)';
    ctx.shadowColor = 'rgba(0,0,0,0.85)';
    ctx.shadowBlur = 4;
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
