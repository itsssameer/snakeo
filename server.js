const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, p) => {
    if (p.endsWith('.js') || p.endsWith('.css') || p.endsWith('.html')) {
      res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    }
  },
}));

// ===== Tunable game constants =====
const WORLD_RADIUS = 2200;
const TICK_RATE = 22; // 22 Hz — Render-free-tier friendly
const TICK_MS = 1000 / TICK_RATE;
const TARGET_FOOD = 600;
const MAX_FOOD = 1500;
const BASE_SPEED = 175;
const BOOST_SPEED = 320;
const TURN_RATE = 4.6;
const SEGMENT_SPACING = 9;
const SEGMENT_RADIUS = 9;
const STARTING_SEGMENTS = 18;
const MIN_BOOST_LENGTH = 14;
const BOOST_DRAIN_PER_SEC = 6;
const FOOD_PICKUP_RADIUS = 22;
const NUM_BOTS = 5;
const HUNTER_BOTS = 1;
const SPAWN_INVINCIBLE_MS = 3500; // longer grace after spawn
const VIEWPORT_RANGE = 1150;
const HAZARD_COUNT = 8;
const HAZARD_MIN_RADIUS = 480; // bigger central safe zone
const GOLD_ORB_CHANCE = 0.025;
const GOLD_ORB_VALUE = 5;
const COLLISION_TOLERANCE = 1.55; // x SEGMENT_RADIUS — sub-circle tolerance, more forgiving than full overlap
const HUNTER_MIN_TARGET_LEN = 40; // hunters ignore players smaller than this
const HUNTER_BOOST_DIST = 180; // hunters only boost-attack at very close range

// ===== State =====
const snakes = new Map();
const food = new Map();
const clients = new Map();
const kills = []; // recent kill events for kill feed
let nextFoodId = 1;
let nextKillId = 1;
const KILL_FEED_KEEP = 30;
const COMBO_WINDOW_MS = 2200;
const LEADER_MIN_LENGTH = 30;
const HUMAN_KILL_BONUS_RATIO = 0.12;
const LEADER_KILL_BONUS_RATIO = 0.18;

// ===== Utilities =====
const TAU = Math.PI * 2;
function randomHue() { return Math.floor(Math.random() * 360); }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function angleDiff(a, b) {
  let d = (a - b) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}
function randomSpawnPoint() {
  const a = Math.random() * TAU;
  const r = Math.sqrt(Math.random()) * WORLD_RADIUS * 0.55;
  return { x: Math.cos(a) * r, y: Math.sin(a) * r };
}

function safeRandomSpawnPoint() {
  for (let attempt = 0; attempt < 25; attempt++) {
    const p = randomSpawnPoint();
    let ok = true;
    for (const s of snakes.values()) {
      if (!s.alive) continue;
      const head = s.segments[0];
      const dx = head.x - p.x, dy = head.y - p.y;
      if (dx * dx + dy * dy < 360 * 360) { ok = false; break; }
    }
    if (!ok) continue;
    for (const h of HAZARDS) {
      const dx = h.x - p.x, dy = h.y - p.y;
      const safe = h.r + 90;
      if (dx * dx + dy * dy < safe * safe) { ok = false; break; }
    }
    if (ok) return p;
  }
  return randomSpawnPoint();
}

// ===== Food =====
function addFood(x, y, hue, size = 1) {
  if (food.size >= MAX_FOOD) {
    const it = food.keys().next();
    if (!it.done) food.delete(it.value);
  }
  const id = nextFoodId++;
  food.set(id, { id, x, y, hue: hue ?? randomHue(), size });
}
function refillFood() {
  while (food.size < TARGET_FOOD) {
    const { x, y } = randomSpawnPoint();
    if (Math.random() < GOLD_ORB_CHANCE) {
      addFood(x, y, 51, GOLD_ORB_VALUE);
    } else {
      addFood(x, y);
    }
  }
}
refillFood();

// ===== Hazards (spinning mines) =====
const HAZARDS = [];
function generateHazards() {
  HAZARDS.length = 0;
  for (let i = 0; i < HAZARD_COUNT; i++) {
    const a = Math.random() * TAU;
    const r = HAZARD_MIN_RADIUS + Math.random() * (WORLD_RADIUS - HAZARD_MIN_RADIUS - 200);
    HAZARDS.push({
      id: i,
      x: Math.cos(a) * r,
      y: Math.sin(a) * r,
      r: 26 + Math.random() * 10, // slightly smaller hit radius
      spin: Math.random() < 0.5 ? 1 : -1,
    });
  }
}
generateHazards();

// ===== Snakes =====
function createSnake(id, name, hue, isBot = false) {
  const start = safeRandomSpawnPoint();
  const dir = Math.random() * TAU;
  const segments = [];
  for (let i = 0; i < STARTING_SEGMENTS; i++) {
    segments.push({
      x: start.x - Math.cos(dir) * i * SEGMENT_SPACING,
      y: start.y - Math.sin(dir) * i * SEGMENT_SPACING,
    });
  }
  return {
    id,
    name: (name || 'snake').slice(0, 16),
    hue: hue ?? randomHue(),
    segments,
    direction: dir,
    targetDir: dir,
    boosting: false,
    pendingGrowth: 0,
    boostBank: 0,
    alive: true,
    isBot,
    isLeader: false,
    combo: 0,
    comboUntil: 0,
    killCause: null,
    spawnInvincibleUntil: Date.now() + SPAWN_INVINCIBLE_MS,
  };
}
function spawnSnake(id, name, hue, isBot = false) {
  const s = createSnake(id, name, hue, isBot);
  snakes.set(id, s);
  return s;
}
function killSnake(s, killer = null) {
  if (!s.alive) return;
  s.alive = false;

  const wasLeader = !!s.isLeader;
  const humanKill = killer && !s.isBot && !killer.isBot;

  // Body drops (existing)
  const drops = Math.max(6, Math.floor(s.segments.length * 0.6));
  const totalValue = Math.max(s.segments.length, Math.floor(s.segments.length * 0.8));
  let remaining = totalValue;
  for (let i = 0; i < drops; i++) {
    const idx = Math.floor((i * s.segments.length) / drops);
    const seg = s.segments[idx];
    if (Math.hypot(seg.x, seg.y) > WORLD_RADIUS) continue;
    const value = Math.max(1, Math.round(remaining / (drops - i)));
    remaining -= value;
    addFood(
      seg.x + (Math.random() - 0.5) * 14,
      seg.y + (Math.random() - 0.5) * 14,
      s.hue,
      value
    );
  }

  // Bounty bonus drops (gold orbs) — for human-killed-human and leader takedowns
  let bonusOrbs = 0;
  if (killer) {
    if (wasLeader) bonusOrbs += Math.max(4, Math.floor(s.segments.length * LEADER_KILL_BONUS_RATIO));
    if (humanKill) bonusOrbs += Math.max(3, Math.floor(s.segments.length * HUMAN_KILL_BONUS_RATIO));
  }
  for (let i = 0; i < bonusOrbs; i++) {
    const seg = s.segments[Math.floor(Math.random() * s.segments.length)];
    if (Math.hypot(seg.x, seg.y) > WORLD_RADIUS) continue;
    addFood(
      seg.x + (Math.random() - 0.5) * 32,
      seg.y + (Math.random() - 0.5) * 32,
      51, // gold
      Math.max(2, Math.floor(s.segments.length / 22))
    );
  }

  // Kill feed event
  kills.push({
    id: nextKillId++,
    t: Date.now(),
    kn: killer ? killer.name : null,
    kh: killer ? killer.hue : 0,
    kbot: killer ? !!killer.isBot : false,
    kid: killer ? killer.id : null,
    vn: s.name,
    vh: s.hue,
    vbot: !!s.isBot,
    vid: s.id,
    vlen: s.segments.length,
    cause: killer ? 'snake' : (s.killCause || 'wall'),
    bountied: wasLeader,
    big: bonusOrbs > 0,
  });
  while (kills.length > KILL_FEED_KEEP) kills.shift();

  snakes.delete(s.id);
}

function moveSnake(s, dt) {
  if (!s.alive) return;
  const diff = angleDiff(s.targetDir, s.direction);
  const maxTurn = TURN_RATE * dt;
  s.direction += clamp(diff, -maxTurn, maxTurn);

  const canBoost = s.boosting && s.segments.length > MIN_BOOST_LENGTH;
  const speed = canBoost ? BOOST_SPEED : BASE_SPEED;

  const segs = s.segments;
  segs[0].x += Math.cos(s.direction) * speed * dt;
  segs[0].y += Math.sin(s.direction) * speed * dt;

  if (Math.hypot(segs[0].x, segs[0].y) > WORLD_RADIUS) {
    s.killCause = 'wall';
    killSnake(s);
    return;
  }

  // Hazard collision (spinning mines)
  if (Date.now() >= s.spawnInvincibleUntil) {
    for (const h of HAZARDS) {
      const dx = segs[0].x - h.x;
      const dy = segs[0].y - h.y;
      const rad = h.r + SEGMENT_RADIUS;
      if (dx * dx + dy * dy < rad * rad) {
        s.killCause = 'hazard';
        killSnake(s);
        return;
      }
    }
  }

  // Rope-drag body
  for (let i = 1; i < segs.length; i++) {
    const dx = segs[i - 1].x - segs[i].x;
    const dy = segs[i - 1].y - segs[i].y;
    const d2 = dx * dx + dy * dy;
    if (d2 > SEGMENT_SPACING * SEGMENT_SPACING) {
      const d = Math.sqrt(d2);
      const t = (d - SEGMENT_SPACING) / d;
      segs[i].x += dx * t;
      segs[i].y += dy * t;
    }
  }

  // Boost: drop tail segments as food
  if (canBoost) {
    s.boostBank += BOOST_DRAIN_PER_SEC * dt;
    while (s.boostBank >= 1 && segs.length > MIN_BOOST_LENGTH) {
      s.boostBank -= 1;
      const tail = segs[segs.length - 1];
      addFood(
        tail.x + (Math.random() - 0.5) * 8,
        tail.y + (Math.random() - 0.5) * 8,
        s.hue,
        1
      );
      segs.pop();
    }
  }

  while (s.pendingGrowth > 0) {
    const tail = segs[segs.length - 1];
    segs.push({ x: tail.x, y: tail.y });
    s.pendingGrowth--;
  }
}

function snakeFoodCollisions() {
  const range = SEGMENT_RADIUS + FOOD_PICKUP_RADIUS;
  const r2 = range * range;
  const now = Date.now();
  for (const s of snakes.values()) {
    if (!s.alive) continue;
    const head = s.segments[0];
    let ate = 0;
    for (const f of food.values()) {
      const dx = f.x - head.x;
      if (Math.abs(dx) > range) continue;
      const dy = f.y - head.y;
      if (Math.abs(dy) > range) continue;
      if (dx * dx + dy * dy <= r2) {
        s.pendingGrowth += f.size;
        ate += f.size;
        food.delete(f.id);
      }
    }
    if (ate > 0) {
      if (now < s.comboUntil) s.combo += 1;
      else s.combo = 1;
      s.comboUntil = now + COMBO_WINDOW_MS;
      const bonus = Math.floor(s.combo / 4);
      if (bonus > 0) s.pendingGrowth += bonus;
    } else if (now > s.comboUntil && s.combo) {
      s.combo = 0;
    }
  }
}

function snakeSnakeCollisions() {
  const list = [];
  for (const s of snakes.values()) if (s.alive) list.push(s);
  const toKill = new Map(); // victim id -> killer snake
  const now = Date.now();
  const collisionR = SEGMENT_RADIUS * COLLISION_TOLERANCE; // forgiving sub-overlap
  const cR2 = collisionR * collisionR;
  for (const a of list) {
    if (now < a.spawnInvincibleUntil) continue;
    const head = a.segments[0];
    for (const b of list) {
      if (a.id === b.id) continue;
      const reach = b.segments.length * SEGMENT_SPACING + collisionR;
      const bHead = b.segments[0];
      const dxh = bHead.x - head.x;
      const dyh = bHead.y - head.y;
      if (dxh * dxh + dyh * dyh > reach * reach) continue;

      const segs = b.segments;
      for (let i = 0; i < segs.length; i++) {
        const seg = segs[i];
        const dx = seg.x - head.x;
        if (Math.abs(dx) > collisionR) continue;
        const dy = seg.y - head.y;
        if (Math.abs(dy) > collisionR) continue;
        if (dx * dx + dy * dy < cR2) {
          toKill.set(a.id, b);
          break;
        }
      }
    }
  }
  for (const [vid, killer] of toKill) {
    const a = snakes.get(vid);
    if (a && a.alive) killSnake(a, killer);
  }
}

function updateBounty() {
  let leader = null;
  for (const s of snakes.values()) {
    if (!s.alive || s.isBot) continue;
    if (s.segments.length < LEADER_MIN_LENGTH) continue;
    if (!leader || s.segments.length > leader.segments.length) leader = s;
  }
  for (const s of snakes.values()) {
    s.isLeader = (s === leader);
  }
}

// ===== Bots =====
const BOT_NAMES = [
  'Slytherin', 'Wiggles', 'Noodle', 'Coily', 'Hisstor', 'Slinky', 'Boa',
  'Viper', 'Sneki', 'Anaconda', 'Mamba', 'Fang', 'Kaa', 'Nag', 'Naga',
  'Slimon', 'Wormle', 'Spaghetti', 'Linguini', 'Ramen',
];
function ensureBots() {
  let count = 0;
  let hunters = 0;
  for (const s of snakes.values()) {
    if (s.isBot) count++;
    if (s.botType === 'hunter') hunters++;
  }
  while (count < NUM_BOTS) {
    const id = 'bot_' + Math.random().toString(36).slice(2, 9);
    const isHunter = hunters < HUNTER_BOTS;
    const name = isHunter
      ? '☠ ' + BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)]
      : BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)];
    const hue = isHunter ? 0 : randomHue();
    const snake = spawnSnake(id, name, hue, true);
    snake.botType = isHunter ? 'hunter' : 'forager';
    if (isHunter) hunters++;
    count++;
  }
}
ensureBots();

function botThink(s) {
  if (!s.alive) return;
  const head = s.segments[0];

  // Wall avoidance dominates
  const headDist = Math.hypot(head.x, head.y);
  if (headDist > WORLD_RADIUS - 250) {
    s.targetDir = Math.atan2(-head.y, -head.x);
    s.boosting = false;
    return;
  }

  // Hazard avoidance
  let hazardThreat = null;
  let hazardD2 = Infinity;
  for (const h of HAZARDS) {
    const dx = h.x - head.x, dy = h.y - head.y;
    const safe = h.r + 90;
    if (Math.abs(dx) > safe || Math.abs(dy) > safe) continue;
    const d2 = dx * dx + dy * dy;
    if (d2 < safe * safe && d2 < hazardD2) {
      hazardD2 = d2;
      hazardThreat = h;
    }
  }
  if (hazardThreat) {
    s.targetDir = Math.atan2(head.y - hazardThreat.y, head.x - hazardThreat.x);
    s.boosting = false;
    return;
  }

  // Hunter behavior: only chase humans who are clearly ahead (length >= 40),
  // and only boost-attack at point-blank range. Newer/smaller players are safe.
  if (s.botType === 'hunter') {
    let target = null;
    let targetSize = HUNTER_MIN_TARGET_LEN;
    for (const other of snakes.values()) {
      if (other.id === s.id || !other.alive || other.isBot) continue;
      if (other.segments.length > targetSize) {
        targetSize = other.segments.length;
        target = other;
      }
    }
    if (target) {
      const th = target.segments[0];
      const dx = th.x - head.x, dy = th.y - head.y;
      const dist = Math.hypot(dx, dy);
      const lead = Math.min(140, dist * 0.3);
      const aimX = th.x + Math.cos(target.direction) * lead;
      const aimY = th.y + Math.sin(target.direction) * lead;
      s.targetDir = Math.atan2(aimY - head.y, aimX - head.x);
      s.boosting = dist < HUNTER_BOOST_DIST && s.segments.length > MIN_BOOST_LENGTH + 4;
      return;
    }
  }

  // Snake-segment look-ahead avoidance
  const lookAhead = 110;
  const ahead = {
    x: head.x + Math.cos(s.direction) * lookAhead,
    y: head.y + Math.sin(s.direction) * lookAhead,
  };
  let danger = null;
  let dangerD2 = Infinity;
  for (const other of snakes.values()) {
    if (other.id === s.id || !other.alive) continue;
    const reach = other.segments.length * SEGMENT_SPACING + 200;
    const oh = other.segments[0];
    const ddx = oh.x - head.x, ddy = oh.y - head.y;
    if (ddx * ddx + ddy * ddy > reach * reach) continue;
    for (const seg of other.segments) {
      const dx = seg.x - ahead.x, dy = seg.y - ahead.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < 90 * 90 && d2 < dangerD2) {
        dangerD2 = d2;
        danger = seg;
      }
    }
  }
  if (danger) {
    s.targetDir = Math.atan2(head.y - danger.y, head.x - danger.x);
    s.boosting = false;
    return;
  }

  // Otherwise seek nearest food
  let nearestFood = null;
  let nearestD2 = Infinity;
  for (const f of food.values()) {
    const dx = f.x - head.x;
    if (Math.abs(dx) > 600) continue;
    const dy = f.y - head.y;
    if (Math.abs(dy) > 600) continue;
    const d2 = dx * dx + dy * dy;
    if (d2 < nearestD2) {
      nearestD2 = d2;
      nearestFood = f;
    }
  }
  s.targetDir = nearestFood
    ? Math.atan2(nearestFood.y - head.y, nearestFood.x - head.x)
    : Math.atan2(-head.y, -head.x);
  s.boosting = false;
}

// ===== Game loop =====
let lastTick = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min(0.1, (now - lastTick) / 1000);
  lastTick = now;

  for (const s of snakes.values()) if (s.isBot) botThink(s);
  for (const s of snakes.values()) moveSnake(s, dt);
  snakeFoodCollisions();
  snakeSnakeCollisions();
  updateBounty();
  refillFood();
  ensureBots();
  broadcastState();
}, TICK_MS);

// ===== Broadcast =====
function snakePayload(s) {
  const seg = new Array(s.segments.length * 2);
  for (let i = 0; i < s.segments.length; i++) {
    seg[i * 2] = Math.round(s.segments[i].x);
    seg[i * 2 + 1] = Math.round(s.segments[i].y);
  }
  return {
    id: s.id,
    name: s.name,
    hue: s.hue,
    s: seg,
    d: +s.direction.toFixed(3),
    b: s.boosting && s.segments.length > MIN_BOOST_LENGTH,
    a: s.alive,
    bot: s.isBot,
    l: s.isLeader || undefined,
    c: s.combo > 1 ? s.combo : undefined,
  };
}

function broadcastState() {
  const allSnakes = [];
  for (const s of snakes.values()) allSnakes.push(snakePayload(s));

  const lb = [...snakes.values()]
    .filter(s => s.alive)
    .sort((a, b) => b.segments.length - a.segments.length)
    .slice(0, 10)
    .map(s => ({
      id: s.id,
      name: s.name,
      score: s.segments.length,
      hue: s.hue,
      bot: s.isBot,
    }));

  const baseTime = Date.now();
  for (const [sid, client] of clients) {
    const views = [];
    for (const ssid of client.slots) {
      const me = snakes.get(ssid);
      if (me && me.alive) views.push({ x: me.segments[0].x, y: me.segments[0].y });
    }
    if (views.length === 0 && client.views) {
      for (const v of client.views) views.push({ x: v.x, y: v.y });
    }
    if (views.length === 0) views.push({ x: 0, y: 0 });

    const range = VIEWPORT_RANGE;
    const fa = [];
    for (const f of food.values()) {
      let inRange = false;
      for (const v of views) {
        if (Math.abs(f.x - v.x) > range) continue;
        if (Math.abs(f.y - v.y) > range) continue;
        inRange = true;
        break;
      }
      if (!inRange) continue;
      fa.push(f.id, Math.round(f.x), Math.round(f.y), f.hue, f.size);
    }
    client.socket.emit('state', {
      t: baseTime,
      sn: allSnakes,
      f: fa,
      lb,
      yourIds: client.slots,
      yourId: client.slots[0] || sid,
      world: WORLD_RADIUS,
      players: snakes.size,
      kills: kills.slice(-12),
    });
  }
}

// ===== Socket =====
io.on('connection', (socket) => {
  const id = socket.id;
  clients.set(id, {
    socket,
    slots: [],
    views: null,
    lastJoinAt: 0,
  });

  socket.emit('hello', {
    world: WORLD_RADIUS,
    tickRate: TICK_RATE,
    yourId: id,
    hazards: HAZARDS,
    physics: {
      turnRate: TURN_RATE,
      baseSpeed: BASE_SPEED,
      boostSpeed: BOOST_SPEED,
      segSpacing: SEGMENT_SPACING,
      minBoostLen: MIN_BOOST_LENGTH,
    },
  });

  socket.on('join', (msg) => {
    const c = clients.get(id);
    if (!c) return;
    if (Date.now() - c.lastJoinAt < 500) return;
    c.lastJoinAt = Date.now();

    let plist;
    if (msg && Array.isArray(msg.players)) {
      plist = msg.players.slice(0, 2);
    } else if (msg) {
      plist = [{ name: msg.name, hue: msg.hue }];
    } else {
      plist = [{}];
    }

    for (const sid of c.slots) snakes.delete(sid);
    c.slots = [];

    for (let i = 0; i < plist.length; i++) {
      const p = plist[i] || {};
      const sid = i === 0 ? id : id + '#' + i;
      const name = typeof p.name === 'string' ? p.name : 'snake';
      const hue = typeof p.hue === 'number' ? ((p.hue % 360) + 360) % 360 : randomHue();
      spawnSnake(sid, name, hue);
      c.slots.push(sid);
    }
  });

  socket.on('rejoin', (msg) => {
    const c = clients.get(id);
    if (!c || !msg) return;
    if (Date.now() - c.lastJoinAt < 250) return;
    c.lastJoinAt = Date.now();
    const slot = msg.slot | 0;
    if (slot < 0 || slot >= c.slots.length) return;
    const sid = c.slots[slot];
    if (snakes.has(sid)) snakes.delete(sid);
    const name = (typeof msg.name === 'string' && msg.name) ? msg.name.slice(0, 16) : 'snake';
    const hue = typeof msg.hue === 'number' ? ((msg.hue % 360) + 360) % 360 : randomHue();
    spawnSnake(sid, name, hue);
  });

  socket.on('input', (msg) => {
    const c = clients.get(id);
    if (!c || !msg) return;

    if (Array.isArray(msg.views)) {
      c.views = msg.views.map(v => ({
        x: typeof v.x === 'number' && isFinite(v.x) ? v.x : 0,
        y: typeof v.y === 'number' && isFinite(v.y) ? v.y : 0,
      }));
    } else if (typeof msg.vx === 'number' && typeof msg.vy === 'number' && isFinite(msg.vx) && isFinite(msg.vy)) {
      c.views = [{ x: msg.vx, y: msg.vy }];
    }

    let inputs;
    if (Array.isArray(msg.inputs)) {
      inputs = msg.inputs;
    } else if (msg.a !== undefined || msg.b !== undefined) {
      inputs = [{ a: msg.a, b: msg.b }];
    } else {
      return;
    }

    for (let i = 0; i < Math.min(inputs.length, c.slots.length); i++) {
      const sid = c.slots[i];
      const s = snakes.get(sid);
      if (!s || !s.alive) continue;
      const inp = inputs[i] || {};
      if (typeof inp.a === 'number' && isFinite(inp.a)) s.targetDir = inp.a;
      if (typeof inp.b === 'boolean') s.boosting = inp.b;
    }
  });

  socket.on('disconnect', () => {
    const c = clients.get(id);
    if (c) {
      for (const sid of c.slots) snakes.delete(sid);
    }
    clients.delete(id);
  });
});

function lanAddresses() {
  const out = [];
  const ifs = os.networkInterfaces() || {};
  for (const name of Object.keys(ifs)) {
    for (const i of ifs[name] || []) {
      if (i.family === 'IPv4' && !i.internal) out.push(i.address);
    }
  }
  return out;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Snakeo running at http://localhost:${PORT}`);
  for (const ip of lanAddresses()) {
    console.log(`  Phone on the same Wi-Fi: http://${ip}:${PORT}`);
  }
});
