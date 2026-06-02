// Forsaken — browser multiplayer server.
// Authoritative: roster, roles, generator progress, HP, ability cooldowns,
//                projectile motion, attack outcomes, round timer, win condition.
// Trusts: client positions (and client classification of its own skill check).
// Stamina is client-side state — used only as a gate on sprint speed locally.

const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8080;
const TICK_MS = 50;

const MAP = { w: 2400, h: 1600 };
const WALL_T = 30;
// Gens are picked from this pool each round — only GENS_PER_ROUND spawn.
const GEN_SPAWN_POOL = [
  { x: MAP.w * 0.12, y: MAP.h * 0.15 },
  { x: MAP.w * 0.88, y: MAP.h * 0.15 },
  { x: MAP.w * 0.12, y: MAP.h * 0.85 },
  { x: MAP.w * 0.88, y: MAP.h * 0.85 },
  { x: MAP.w * 0.50, y: MAP.h * 0.13 },
  { x: MAP.w * 0.50, y: MAP.h * 0.87 },
  { x: MAP.w * 0.10, y: MAP.h * 0.50 },
  { x: MAP.w * 0.90, y: MAP.h * 0.50 },
  { x: MAP.w * 0.28, y: MAP.h * 0.32 },
  { x: MAP.w * 0.72, y: MAP.h * 0.32 },
  { x: MAP.w * 0.28, y: MAP.h * 0.71 },
  { x: MAP.w * 0.72, y: MAP.h * 0.71 },
  { x: MAP.w * 0.40, y: MAP.h * 0.42 },
  { x: MAP.w * 0.60, y: MAP.h * 0.42 },
  { x: MAP.w * 0.40, y: MAP.h * 0.58 },
  { x: MAP.w * 0.60, y: MAP.h * 0.58 },
];
const GENS_PER_ROUND = 5;

// Walls and obstacles — duplicated from client so the server can resolve
// sniper-projectile collisions authoritatively. Must stay in sync with
// the client's WALLS / OBSTACLES arrays.
const WALLS = [
  { x: MAP.w / 2, y: WALL_T / 2, w: MAP.w, h: WALL_T },
  { x: MAP.w / 2, y: MAP.h - WALL_T / 2, w: MAP.w, h: WALL_T },
  { x: WALL_T / 2, y: MAP.h / 2, w: WALL_T, h: MAP.h },
  { x: MAP.w - WALL_T / 2, y: MAP.h / 2, w: WALL_T, h: MAP.h },
  { x: MAP.w / 2, y: MAP.h * 0.25, w: MAP.w * 0.55, h: WALL_T },
  { x: MAP.w / 2, y: MAP.h * 0.75, w: MAP.w * 0.55, h: WALL_T },
  { x: MAP.w / 3,     y: MAP.h / 2, w: WALL_T, h: MAP.h * 0.33 },
  { x: 2 * MAP.w / 3, y: MAP.h / 2, w: WALL_T, h: MAP.h * 0.33 },
  // Maze interior — symmetric about both axes.
  { x: 550,  y: 250,  w: WALL_T, h: 280 },
  { x: 1850, y: 250,  w: WALL_T, h: 280 },
  { x: 550,  y: 1350, w: WALL_T, h: 280 },
  { x: 1850, y: 1350, w: WALL_T, h: 280 },
  { x: 950,  y: 230,  w: WALL_T, h: 320 },
  { x: 1450, y: 230,  w: WALL_T, h: 320 },
  { x: 950,  y: 1370, w: WALL_T, h: 320 },
  { x: 1450, y: 1370, w: WALL_T, h: 320 },
  { x: 700,  y: 600,  w: 280,    h: WALL_T },
  { x: 1700, y: 600,  w: 280,    h: WALL_T },
  { x: 700,  y: 1000, w: 280,    h: WALL_T },
  { x: 1700, y: 1000, w: 280,    h: WALL_T },
];
const OBSTACLES = [
  { x: 300,  y: 360,  w: 50, h: 50 },
  { x: 560,  y: 300,  w: 50, h: 50 },
  { x: 200,  y: 180,  w: 36, h: 36 },
  { x: 700,  y: 200,  w: 32, h: 70 },
  { x: MAP.w - 300, y: 360, w: 50, h: 50 },
  { x: MAP.w - 560, y: 300, w: 50, h: 50 },
  { x: MAP.w - 200, y: 180, w: 36, h: 36 },
  { x: MAP.w - 700, y: 200, w: 32, h: 70 },
  { x: 300,  y: MAP.h - 360, w: 50, h: 50 },
  { x: 560,  y: MAP.h - 300, w: 50, h: 50 },
  { x: 200,  y: MAP.h - 180, w: 36, h: 36 },
  { x: 700,  y: MAP.h - 200, w: 32, h: 70 },
  { x: MAP.w - 300, y: MAP.h - 360, w: 50, h: 50 },
  { x: MAP.w - 560, y: MAP.h - 300, w: 50, h: 50 },
  { x: MAP.w - 200, y: MAP.h - 180, w: 36, h: 36 },
  { x: MAP.w - 700, y: MAP.h - 200, w: 32, h: 70 },
  { x: MAP.w / 2,    y: MAP.h * 0.38, w: 50, h: 50 },
  { x: MAP.w / 2,    y: MAP.h * 0.62, w: 50, h: 50 },
  { x: MAP.w * 0.42, y: MAP.h / 2,    w: 50, h: 50 },
  { x: MAP.w * 0.58, y: MAP.h / 2,    w: 50, h: 50 },
  { x: MAP.w * 0.3,  y: MAP.h / 2,    w: 36, h: 36 },
  { x: MAP.w * 0.7,  y: MAP.h / 2,    w: 36, h: 36 },
];

function pointInRect(x, y, r) {
  return x >= r.x - r.w / 2 && x <= r.x + r.w / 2 &&
         y >= r.y - r.h / 2 && y <= r.y + r.h / 2;
}
// True if a circle of radius r centered at (cx, cy) overlaps the rect.
function circleRectOverlap(cx, cy, r, rect) {
  const left = rect.x - rect.w / 2, right = rect.x + rect.w / 2;
  const top = rect.y - rect.h / 2, bottom = rect.y + rect.h / 2;
  const px = cx < left ? left : (cx > right ? right : cx);
  const py = cy < top ? top : (cy > bottom ? bottom : cy);
  const dx = cx - px, dy = cy - py;
  return (dx * dx + dy * dy) < r * r;
}
function positionBlocked(x, y, r) {
  for (const w of WALLS) if (circleRectOverlap(x, y, r, w)) return true;
  for (const o of OBSTACLES) if (circleRectOverlap(x, y, r, o)) return true;
  return false;
}

// ---- Characters ----
const SURVIVOR_CHARS = [
  { id: "runner",   name: "Runner",   color: "#ff80c0", speedMult: 1.10, repairMult: 1.00, blurb: "+10% speed" },
  { id: "engineer", name: "Engineer", color: "#ffd84a", speedMult: 1.00, repairMult: 1.30, blurb: "+30% repair" },
  { id: "scout",    name: "Scout",    color: "#6cb6ff", speedMult: 1.05, repairMult: 1.05, blurb: "balanced" },
  { id: "sentinel", name: "Sentinel", color: "#4ad0c0", speedMult: 1.00, repairMult: 0.95, blurb: "slows the killer" },
  { id: "sniper",   name: "Sniper",   color: "#a070f0", speedMult: 0.98, repairMult: 0.95, blurb: "stuns the killer" },
];
const KILLER_CHARS = [
  { id: "slasher", name: "Slasher", color: "#e94560", speedMult: 1.00, attackRadius: 70,  attackDamage: 17, attackName: "Knife Slash",  attackCooldown: 1.0, blurb: "balanced reach" },
  { id: "stalker", name: "Stalker", color: "#7a2030", speedMult: 0.92, attackRadius: 110, attackDamage: 13, attackName: "Claw Strike", attackCooldown: 1.3, blurb: "long reach, slower, lower dmg" },
];

// ---- HP ----
const SURVIVOR_HP_MAX = 100;

// ---- Abilities ----
// type drives applyAbility's switch. cd is in seconds.
const ABILITIES = {
  runner: [
    { id: "dash",  name: "Dash",       cd: 8,  type: "speed_self",  mult: 2.5,   duration: 0.8 },
    { id: "smoke", name: "Smoke Bomb", cd: 20, type: "smoke",       radius: 260, duration: 3.5 },
  ],
  sentinel: [
    { id: "burst", name: "Stun Burst", cd: 12, type: "stun_burst",  radius: 180, slowMult: 0.50, duration: 10.0 },
    // Slow Field persists until the killer attacks it (or the round ends).
    // Capped at maxFields per Sentinel — placing a new one pops the oldest.
    // channelDuration is the summoning channel before the field drops.
    { id: "field", name: "Slow Field", cd: 18, type: "slow_field",  radius: 220, slowMult: 0.60, duration: 9999, channelDuration: 0.7, maxFields: 3 },
  ],
  sniper: [
    // Shoot: must be aimed by the client and consumes 1 ammo. Projectile
    // travels in the supplied aim direction, breaks on the first wall or
    // obstacle, and stuns the killer for stunDuration seconds on hit.
    // range is effectively unlimited — the bullet only stops on a wall,
    // obstacle, or the outer map boundary (handled in the tick loop).
    { id: "shoot",  name: "Shoot",  cd: 25, type: "shoot_sniper", speed: 1100, range: 99999, stunDuration: 10, hitRadius: 30 },
    // Reload: 5s channel before ammo refills. Only usable at 0 ammo.
    { id: "reload", name: "Reload", cd: 20, type: "reload_sniper", reloadDuration: 5.0 },
    // Sneak: turns the Sniper mostly invisible to everyone for a few seconds.
    { id: "sneak",  name: "Sneak",  cd: 20, type: "sneak", duration: 6.0 },
  ],
  engineer: [
    { id: "overcharge", name: "Overcharge", cd: 15, type: "gen_boost", amount: 0.30, range: 90 },
    { id: "mend",       name: "Mend",       cd: 20, type: "heal_self", amount: 50,   duration: 2.0 },
  ],
  scout: [
    { id: "rally", name: "Rally", cd: 14, type: "speed_team", mult: 1.25, radius: 200, duration: 4.0 },
    { id: "scan",  name: "Scan",  cd: 12, type: "reveal",     duration: 2.0 },
  ],
  slasher: [
    { id: "throw",  name: "Throw Knife", cd: 5,  type: "projectile", damage: 12, speed: 700, range: 700 },
    { id: "frenzy", name: "Frenzy",      cd: 14, type: "speed_self", mult: 1.30, duration: 4.0 },
  ],
  stalker: [
    { id: "step",  name: "Shadow Step", cd: 6,  type: "teleport",    distance: 220 },
    { id: "stalk", name: "Stalk",       cd: 15, type: "buff_attack", multiplier: 2, duration: 4.0 },
  ],
};

// ---- Round ----
const ROUND_DURATION = 360;   // 6 minutes
const TIME_PER_GEN = -20;
const TIME_PER_DOWN = +25;
const RESULT_HOLD_MS = 5000;

// ---- Skill check ----
const SKILL_PROGRESS = { green: 0.22, yellow: 0.10, red: -0.12 };
const SKILL_NEAR_RADIUS = 90;
const SKILL_COOLDOWN_MS = 400;

const state = {
  phase: "lobby",
  players: new Map(),
  generators: freshGens(),
  designatedKillerId: null,
  roundTimer: ROUND_DURATION,
  winner: null,
  resetAt: 0,
  lastSkill: new Map(),
  projectiles: [],
  smokes: [],
  slowFields: [],
  nextEntityId: 1,
};

function freshGens() {
  // Fisher–Yates shuffle the pool, then take the first GENS_PER_ROUND entries.
  const idx = GEN_SPAWN_POOL.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx.slice(0, GENS_PER_ROUND).map(k => {
    const p = GEN_SPAWN_POOL[k];
    return { x: p.x, y: p.y, progress: 0, done: false };
  });
}

// ---------- HTTP ----------
const server = http.createServer((req, res) => {
  const url = req.url.split("?")[0];
  if (url === "/" || url === "/index.html") {
    return sendFile(res, "index.html", "text/html; charset=utf-8");
  }
  if (url === "/health") { res.writeHead(200); res.end("ok"); return; }
  if (url.startsWith("/music/")) {
    const file = url.slice("/music/".length);
    if (!/^[a-zA-Z0-9_]+\.mp3$/.test(file)) {
      res.writeHead(400); res.end("bad name"); return;
    }
    return sendFile(res, path.join("music", file), "audio/mpeg", "public, max-age=86400");
  }
  if (url === "/chars") {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({
      survivorChars: SURVIVOR_CHARS,
      killerChars: KILLER_CHARS,
      abilities: ABILITIES,
      survivorHpMax: SURVIVOR_HP_MAX,
      roundDuration: ROUND_DURATION,
    }));
    return;
  }
  res.writeHead(404); res.end("not found");
});
function sendFile(res, name, type, cache) {
  fs.readFile(path.join(__dirname, name), (err, data) => {
    if (err) { res.writeHead(err.code === "ENOENT" ? 404 : 500); res.end(); return; }
    res.writeHead(200, {
      "Content-Type": type,
      "Cache-Control": cache || "no-store",
      "Content-Length": data.length,
    });
    res.end(data);
  });
}

// ---------- WS ----------
const wss = new WebSocketServer({ server });
let nextId = 1;

wss.on("connection", (ws) => {
  const id = nextId++;
  ws.playerId = id;
  ws.on("message", (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    handle(id, ws, msg);
  });
  ws.on("close", () => removePlayer(id));
  ws.on("error", () => {});
});

function handle(id, ws, msg) {
  switch (msg.type) {
    case "join":      return onJoin(id, ws, msg);
    case "pick_char": return onPickChar(id, msg);
    case "designate": return onDesignate(id, msg);
    case "start":     return onStart(id);
    case "pos":       return onPos(id, msg);
    case "attack":    return onAttack(id);
    case "ability":   return onAbility(id, msg);
    case "skill":     return onSkill(id, msg);
    case "leave":     return removePlayer(id);
  }
}

function onJoin(id, ws, msg) {
  const name = (msg.name || "Player").toString().slice(0, 16);
  const isHost = state.players.size === 0;
  const player = {
    id, ws, name,
    role: "unassigned",
    survivorChar: "scout",
    killerChar: "slasher",
    color: SURVIVOR_CHARS.find(c => c.id === "scout").color,
    x: MAP.w / 2, y: MAP.h - 200,
    facing: { x: 1, y: 0 },
    alive: true,
    hp: SURVIVOR_HP_MAX,
    cooldowns: [0, 0, 0],     // ms epoch when ability slot becomes ready
    mainAttackCdUntil: 0,
    ammo: 1,                  // sniper-specific; harmless on other chars
    reloadUntil: 0,
    effects: freshEffects(),
    isHost,
    joinedAt: Date.now(),
  };
  state.players.set(id, player);
  send(ws, {
    type: "welcome",
    id, map: MAP, gens: state.generators,
    survivorChars: SURVIVOR_CHARS,
    killerChars: KILLER_CHARS,
    abilities: ABILITIES,
    roundDuration: ROUND_DURATION,
    survivorHpMax: SURVIVOR_HP_MAX,
  });
  broadcastLobby();
}

function freshEffects() {
  return {
    speedMult: 1, speedUntil: 0,
    healUntil: 0, healRate: 0,
    stalkUntil: 0,
    revealedUntil: 0,
    slowMult: 1, slowUntil: 0,
    sneakUntil: 0,
  };
}

function onPickChar(id, msg) {
  const p = state.players.get(id);
  if (!p) return;
  if (msg.survivorChar && SURVIVOR_CHARS.some(c => c.id === msg.survivorChar)) {
    p.survivorChar = msg.survivorChar;
  }
  if (msg.killerChar && KILLER_CHARS.some(c => c.id === msg.killerChar)) {
    p.killerChar = msg.killerChar;
  }
  if (state.phase === "lobby") {
    const sc = SURVIVOR_CHARS.find(c => c.id === p.survivorChar);
    p.color = sc.color;
  }
  broadcastLobby();
}

function onDesignate(id, msg) {
  const host = state.players.get(id);
  if (!host || !host.isHost) return;
  if (state.phase !== "lobby") return;
  if (msg.id === null || msg.id === 0) {
    state.designatedKillerId = null;
    broadcastLobby();
    return;
  }
  if (!state.players.has(msg.id)) return;
  state.designatedKillerId = msg.id;
  broadcastLobby();
}

function removePlayer(id) {
  const p = state.players.get(id);
  if (!p) return;
  const wasHost = p.isHost;
  state.players.delete(id);
  state.lastSkill.delete(id);
  state.projectiles = state.projectiles.filter(pr => pr.ownerId !== id);
  if (state.designatedKillerId === id) state.designatedKillerId = null;
  if (wasHost && state.players.size > 0) {
    const next = [...state.players.values()].sort((a, b) => a.joinedAt - b.joinedAt)[0];
    next.isHost = true;
  }
  if (state.phase === "playing") checkRoundEnd();
  broadcastLobby();
}

function onStart(id) {
  if (state.phase !== "lobby") return;
  const p = state.players.get(id);
  if (!p || !p.isHost) return;
  if (state.designatedKillerId === null) return;
  if (!state.players.has(state.designatedKillerId)) return;
  if (state.players.size < 2) return;
  startRound();
}

function onPos(id, msg) {
  const p = state.players.get(id);
  if (!p || state.phase !== "playing") return;
  if (!p.alive) return;
  if (typeof msg.x !== "number" || typeof msg.y !== "number") return;
  p.x = clamp(msg.x, 20, MAP.w - 20);
  p.y = clamp(msg.y, 20, MAP.h - 20);
  if (msg.facing && typeof msg.facing.x === "number") {
    p.facing = { x: msg.facing.x, y: msg.facing.y };
  }
}

function onAttack(id) {
  if (state.phase !== "playing") return;
  const a = state.players.get(id);
  if (!a || a.role !== "killer" || !a.alive) return;
  const kch = killerCharOf(a);
  const now = Date.now();
  if (now < (a.mainAttackCdUntil || 0)) return;
  a.mainAttackCdUntil = now + (kch.attackCooldown || 1.0) * 1000;
  let best = null, bestD = kch.attackRadius;
  for (const [pid, p] of state.players) {
    if (pid === id) continue;
    if (p.role !== "survivor" || !p.alive) continue;
    const d = Math.hypot(p.x - a.x, p.y - a.y);
    if (d < bestD) { bestD = d; best = p; }
  }
  if (best) {
    let dmg = kch.attackDamage;
    if (now < a.effects.stalkUntil) {
      dmg *= 2;
      a.effects.stalkUntil = 0; // consume
    }
    applyDamage(best, dmg, a);
  }
  // Killer's basic attack also shatters any slow field whose center
  // is within their attack reach.
  const brokenFields = [];
  state.slowFields = state.slowFields.filter(f => {
    if (Math.hypot(a.x - f.x, a.y - f.y) <= kch.attackRadius) {
      brokenFields.push({ id: f.id, x: f.x, y: f.y, radius: f.radius });
      return false;
    }
    return true;
  });
  if (brokenFields.length > 0) {
    broadcast({ type: "field_break", fields: brokenFields, by: a.id });
  }
}

function applyDamage(target, amount, attacker) {
  if (!target.alive) return;
  target.hp = Math.max(0, target.hp - amount);
  broadcast({
    type: "damage",
    id: target.id,
    hp: Math.round(target.hp),
    by: attacker.id,
    amount,
  });
  if (target.hp <= 0) {
    target.alive = false;
    state.roundTimer += TIME_PER_DOWN;
    broadcast({ type: "down", id: target.id, by: attacker.id, timer: state.roundTimer });
    checkRoundEnd();
  }
}

function onAbility(id, msg) {
  if (state.phase !== "playing") return;
  const p = state.players.get(id);
  if (!p || !p.alive) return;
  const slot = msg.slot | 0;
  if (slot < 0 || slot > 2) return;
  const charId = p.role === "killer" ? p.killerChar : p.survivorChar;
  const list = ABILITIES[charId];
  if (!list || !list[slot]) return;
  const ab = list[slot];
  const now = Date.now();
  if (now < p.cooldowns[slot]) return;
  // Pre-validate sniper-specific resource gates BEFORE consuming the CD.
  if (ab.type === "shoot_sniper" && (p.ammo || 0) <= 0) return;
  if (ab.type === "reload_sniper") {
    if ((p.ammo || 0) >= 1) return;            // already loaded
    if (now < (p.reloadUntil || 0)) return;    // already reloading
  }
  p.cooldowns[slot] = now + ab.cd * 1000;
  applyAbility(p, ab, slot, msg);
}

function applyAbility(p, ab, slot, msg) {
  const now = Date.now();
  switch (ab.type) {
    case "speed_self":
      p.effects.speedMult = ab.mult;
      p.effects.speedUntil = now + ab.duration * 1000;
      broadcast({ type: "ability", id: p.id, slot, abilityId: ab.id, abilityType: ab.type, mult: ab.mult, duration: ab.duration });
      break;
    case "smoke":
      state.smokes.push({
        id: state.nextEntityId++,
        x: p.x, y: p.y,
        radius: ab.radius,
        ttl: ab.duration,
        ownerId: p.id,
      });
      broadcast({ type: "ability", id: p.id, slot, abilityId: ab.id, abilityType: ab.type, x: p.x, y: p.y });
      break;
    case "gen_boost": {
      let bestIdx = -1, bestD = ab.range;
      for (let i = 0; i < state.generators.length; i++) {
        const g = state.generators[i];
        if (g.done) continue;
        const d = Math.hypot(g.x - p.x, g.y - p.y);
        if (d < bestD) { bestD = d; bestIdx = i; }
      }
      if (bestIdx >= 0) {
        const g = state.generators[bestIdx];
        g.progress = Math.min(1, g.progress + ab.amount);
        if (g.progress >= 1) {
          g.progress = 1; g.done = true;
          state.roundTimer = Math.max(0, state.roundTimer + TIME_PER_GEN);
          broadcast({ type: "gen_done", indices: [bestIdx], timer: state.roundTimer });
          if (state.roundTimer <= 0) endRound("survivors");
        }
      }
      broadcast({ type: "ability", id: p.id, slot, abilityId: ab.id, abilityType: ab.type });
      break;
    }
    case "heal_self":
      p.effects.healUntil = now + ab.duration * 1000;
      p.effects.healRate = ab.amount / ab.duration;
      broadcast({ type: "ability", id: p.id, slot, abilityId: ab.id, abilityType: ab.type, duration: ab.duration });
      break;
    case "speed_team": {
      const affected = [];
      for (const other of state.players.values()) {
        if (other.role !== "survivor" || !other.alive) continue;
        if (Math.hypot(other.x - p.x, other.y - p.y) <= ab.radius) {
          other.effects.speedMult = ab.mult;
          other.effects.speedUntil = now + ab.duration * 1000;
          affected.push(other.id);
        }
      }
      broadcast({ type: "ability", id: p.id, slot, abilityId: ab.id, abilityType: ab.type, x: p.x, y: p.y, radius: ab.radius, affected });
      break;
    }
    case "reveal":
      for (const other of state.players.values()) {
        if (other.role === "killer") {
          other.effects.revealedUntil = now + ab.duration * 1000;
        }
      }
      broadcast({ type: "ability", id: p.id, slot, abilityId: ab.id, abilityType: ab.type, duration: ab.duration });
      break;
    case "projectile": {
      const f = p.facing;
      const norm = Math.hypot(f.x, f.y) || 1;
      const fxn = f.x / norm, fyn = f.y / norm;
      state.projectiles.push({
        id: state.nextEntityId++,
        x: p.x + fxn * 25,
        y: p.y + fyn * 25,
        vx: fxn * ab.speed,
        vy: fyn * ab.speed,
        ownerId: p.id,
        damage: ab.damage,
        range: ab.range,
        dist: 0,
      });
      broadcast({ type: "ability", id: p.id, slot, abilityId: ab.id, abilityType: ab.type, fx: fxn, fy: fyn });
      break;
    }
    case "teleport": {
      const f = p.facing;
      const norm = Math.hypot(f.x, f.y) || 1;
      const fxn = f.x / norm, fyn = f.y / norm;
      const fromX = p.x, fromY = p.y;
      // Sub-step the teleport so it stops at the first wall/obstacle hit
      // instead of landing inside one.
      const STEPS = 16;
      const PLAYER_R = 18;
      let tx = p.x, ty = p.y;
      for (let i = 1; i <= STEPS; i++) {
        const nx = p.x + fxn * ab.distance * (i / STEPS);
        const ny = p.y + fyn * ab.distance * (i / STEPS);
        if (positionBlocked(nx, ny, PLAYER_R)) break;
        tx = nx; ty = ny;
      }
      p.x = clamp(tx, 30, MAP.w - 30);
      p.y = clamp(ty, 30, MAP.h - 30);
      broadcast({ type: "ability", id: p.id, slot, abilityId: ab.id, abilityType: ab.type, fromX, fromY, x: p.x, y: p.y });
      break;
    }
    case "buff_attack":
      p.effects.stalkUntil = now + ab.duration * 1000;
      broadcast({ type: "ability", id: p.id, slot, abilityId: ab.id, abilityType: ab.type, duration: ab.duration });
      break;
    case "stun_burst": {
      // Instant AOE: slow any killer within radius.
      const affected = [];
      for (const k of state.players.values()) {
        if (k.role !== "killer" || !k.alive) continue;
        if (Math.hypot(k.x - p.x, k.y - p.y) <= ab.radius) {
          k.effects.slowMult = Math.min(k.effects.slowMult || 1, ab.slowMult);
          k.effects.slowUntil = Math.max(k.effects.slowUntil || 0, now + ab.duration * 1000);
          affected.push(k.id);
        }
      }
      broadcast({ type: "ability", id: p.id, slot, abilityId: ab.id, abilityType: ab.type, x: p.x, y: p.y, radius: ab.radius, affected });
      break;
    }
    case "slow_field": {
      // Sentinel "summons" the field over channelDuration before it drops.
      // The location is captured at channel-end so the player can be repositioned.
      const channelMs = (ab.channelDuration || 0) * 1000;
      const ownerId = p.id;
      broadcast({ type: "ability_channel", id: ownerId, slot, abilityId: ab.id, abilityType: ab.type, duration: ab.channelDuration || 0 });
      setTimeout(() => {
        if (state.phase !== "playing") return;
        const owner = state.players.get(ownerId);
        if (!owner || !owner.alive) return;
        // Cap fields per Sentinel — pop the oldest if at the limit.
        const max = ab.maxFields || Infinity;
        const mine = state.slowFields.filter(f => f.ownerId === ownerId);
        if (mine.length >= max) {
          const oldest = mine[0];
          state.slowFields = state.slowFields.filter(f => f.id !== oldest.id);
          broadcast({ type: "field_break", fields: [{ id: oldest.id, x: oldest.x, y: oldest.y, radius: oldest.radius }], by: ownerId });
        }
        state.slowFields.push({
          id: state.nextEntityId++,
          x: owner.x, y: owner.y,
          radius: ab.radius,
          slowMult: ab.slowMult,
          ttl: ab.duration,
          ownerId,
        });
        broadcast({ type: "ability", id: ownerId, slot, abilityId: ab.id, abilityType: ab.type, x: owner.x, y: owner.y, radius: ab.radius });
      }, channelMs);
      break;
    }
    case "shoot_sniper": {
      // Consume 1 ammo. Spawn a projectile in the client-supplied aim direction.
      p.ammo = Math.max(0, (p.ammo || 0) - 1);
      const aim = (msg && msg.aim && typeof msg.aim.x === "number") ? msg.aim : p.facing;
      const aimNorm = Math.hypot(aim.x, aim.y) || 1;
      const fxn = aim.x / aimNorm, fyn = aim.y / aimNorm;
      state.projectiles.push({
        id: state.nextEntityId++,
        x: p.x + fxn * 22,
        y: p.y + fyn * 22,
        vx: fxn * ab.speed,
        vy: fyn * ab.speed,
        ownerId: p.id,
        range: ab.range,
        dist: 0,
        kind: "sniper",
        stunDuration: ab.stunDuration,
        hitRadius: ab.hitRadius || 22,
      });
      broadcast({ type: "ability", id: p.id, slot, abilityId: ab.id, abilityType: ab.type, fx: fxn, fy: fyn });
      break;
    }
    case "sneak":
      p.effects.sneakUntil = now + ab.duration * 1000;
      broadcast({ type: "ability", id: p.id, slot, abilityId: ab.id, abilityType: ab.type, duration: ab.duration });
      break;
    case "reload_sniper":
      p.reloadUntil = now + ab.reloadDuration * 1000;
      broadcast({ type: "ability", id: p.id, slot, abilityId: ab.id, abilityType: ab.type, duration: ab.reloadDuration });
      break;
  }
}

function onSkill(id, msg) {
  if (state.phase !== "playing") return;
  const p = state.players.get(id);
  if (!p || p.role !== "survivor" || !p.alive) return;
  const idx = msg.gen;
  if (typeof idx !== "number" || idx < 0 || idx >= state.generators.length) return;
  const g = state.generators[idx];
  if (g.done) return;
  if (Math.hypot(p.x - g.x, p.y - g.y) > SKILL_NEAR_RADIUS) return;
  const now = Date.now();
  const last = state.lastSkill.get(id) || 0;
  if (now - last < SKILL_COOLDOWN_MS) return;
  state.lastSkill.set(id, now);
  const result = msg.result === "green" || msg.result === "yellow" ? msg.result : "red";
  let delta = SKILL_PROGRESS[result];
  if (delta > 0) {
    const sc = survivorCharOf(p);
    delta *= sc.repairMult;
  }
  g.progress = Math.max(0, Math.min(1, g.progress + delta));
  if (g.progress >= 1) {
    g.progress = 1; g.done = true;
    state.roundTimer = Math.max(0, state.roundTimer + TIME_PER_GEN);
    broadcast({ type: "gen_done", indices: [idx], timer: state.roundTimer });
    if (state.roundTimer <= 0) endRound("survivors");
  }
}

function startRound() {
  state.generators = freshGens();
  state.roundTimer = ROUND_DURATION;
  state.winner = null;
  state.lastSkill.clear();
  state.projectiles = [];
  state.smokes = [];
  state.slowFields = [];

  const killerId = state.designatedKillerId;
  const survIds = [...state.players.keys()].filter(pid => pid !== killerId);

  const killer = state.players.get(killerId);
  const kch = killerCharOf(killer);
  killer.role = "killer";
  killer.color = kch.color;
  killer.x = MAP.w / 2;
  killer.y = 220;
  killer.alive = true;
  killer.hp = SURVIVOR_HP_MAX; // unused for killer
  killer.facing = { x: 1, y: 0 };
  killer.cooldowns = [0, 0, 0];
  killer.mainAttackCdUntil = 0;
  killer.ammo = 1; killer.reloadUntil = 0;
  killer.effects = freshEffects();

  survIds.forEach((sid, idx) => {
    const p = state.players.get(sid);
    const sch = survivorCharOf(p);
    p.role = "survivor";
    p.color = sch.color;
    p.x = MAP.w / 2 + (idx - (survIds.length - 1) / 2) * 80;
    p.y = MAP.h - 220;
    p.alive = true;
    p.hp = SURVIVOR_HP_MAX;
    p.facing = { x: 1, y: 0 };
    p.cooldowns = [0, 0, 0];
    p.mainAttackCdUntil = 0;
    p.ammo = 1; p.reloadUntil = 0;
    p.effects = freshEffects();
  });

  state.phase = "playing";
  broadcast({
    type: "start",
    players: serializePlayers(),
    gens: state.generators,
    roundDuration: ROUND_DURATION,
    timer: state.roundTimer,
  });
}

function checkRoundEnd() {
  if (state.phase !== "playing") return;
  let anyActive = false, anySurv = false;
  for (const p of state.players.values()) {
    if (p.role !== "survivor") continue;
    anySurv = true;
    if (p.alive) anyActive = true;
  }
  if (!anySurv) return;
  if (!anyActive) endRound("killer");
}

function endRound(winner) {
  if (state.phase !== "playing") return;
  state.phase = "over";
  state.winner = winner;
  state.resetAt = Date.now() + RESULT_HOLD_MS;
  broadcast({ type: "over", winner });
}

let lastTickTime = Date.now();
function tick() {
  const now = Date.now();
  const dt = (now - lastTickTime) / 1000;
  lastTickTime = now;

  if (state.phase === "playing") {
    state.roundTimer = Math.max(0, state.roundTimer - dt);

    // Heal ticks
    for (const p of state.players.values()) {
      if (p.role !== "survivor" || !p.alive) continue;
      if (now < p.effects.healUntil) {
        p.hp = Math.min(SURVIVOR_HP_MAX, p.hp + p.effects.healRate * dt);
      }
    }

    // Slow-field sustained effect on killers standing in a field.
    for (const k of state.players.values()) {
      if (k.role !== "killer" || !k.alive) continue;
      // Reset stale slow first — previous stun_burst values shouldn't
      // bleed forward and clobber a weaker field slow.
      if (now >= k.effects.slowUntil) k.effects.slowMult = 1;
      let bestSlow = 1;
      for (const f of state.slowFields) {
        if (Math.hypot(k.x - f.x, k.y - f.y) <= f.radius) {
          if (f.slowMult < bestSlow) bestSlow = f.slowMult;
        }
      }
      if (bestSlow < 1) {
        k.effects.slowMult = Math.min(k.effects.slowMult, bestSlow);
        // Slow lingers ~5s after leaving the field.
        k.effects.slowUntil = Math.max(k.effects.slowUntil, now + 5000);
      }
    }

    // Smoke conceals survivors from the killer.
    for (const p of state.players.values()) {
      if (p.role !== "survivor") { p.hiddenInSmoke = false; continue; }
      p.hiddenInSmoke = false;
      for (const sm of state.smokes) {
        if (Math.hypot(p.x - sm.x, p.y - sm.y) <= sm.radius) {
          p.hiddenInSmoke = true;
          break;
        }
      }
    }

    // Decay slow fields
    for (const f of state.slowFields) f.ttl -= dt;
    state.slowFields = state.slowFields.filter(f => f.ttl > 0);

    // Projectiles. Sub-step so fast bullets don't tunnel through 30px walls.
    const survivors = [...state.players.values()].filter(p => p.role === "survivor" && p.alive);
    const killers   = [...state.players.values()].filter(p => p.role === "killer"   && p.alive);
    const projHits = [];
    const broken = [];
    const STEPS = 5;
    state.projectiles = state.projectiles.filter(pr => {
      const sx = pr.vx * dt / STEPS;
      const sy = pr.vy * dt / STEPS;
      const stepLen = Math.hypot(sx, sy);
      for (let i = 0; i < STEPS; i++) {
        pr.x += sx; pr.y += sy; pr.dist += stepLen;
        if (pr.dist > pr.range) return false;
        if (pr.x < 0 || pr.x > MAP.w || pr.y < 0 || pr.y > MAP.h) return false;
        if (pr.kind === "sniper") {
          // Bullet breaks on the first wall or obstacle.
          for (const w of WALLS) {
            if (pointInRect(pr.x, pr.y, w)) {
              broken.push({ id: pr.id, x: pr.x, y: pr.y });
              return false;
            }
          }
          for (const o of OBSTACLES) {
            if (pointInRect(pr.x, pr.y, o)) {
              broken.push({ id: pr.id, x: pr.x, y: pr.y });
              return false;
            }
          }
          // Stun the killer on hit (no damage).
          const HIT = pr.hitRadius || 22;
          for (const k of killers) {
            if (Math.hypot(k.x - pr.x, k.y - pr.y) < HIT) {
              k.effects.slowMult = 0.05;
              k.effects.slowUntil = Math.max(k.effects.slowUntil || 0, Date.now() + pr.stunDuration * 1000);
              broadcast({ type: "stun", id: k.id, by: pr.ownerId, duration: pr.stunDuration });
              return false;
            }
          }
        } else {
          // Throw Knife (Slasher): hits survivors.
          for (const s of survivors) {
            if (Math.hypot(s.x - pr.x, s.y - pr.y) < 22) {
              const att = state.players.get(pr.ownerId);
              if (att) projHits.push({ s, dmg: pr.damage, att });
              return false;
            }
          }
        }
      }
      return true;
    });
    for (const h of projHits) applyDamage(h.s, h.dmg, h.att);
    if (broken.length > 0) broadcast({ type: "projectile_break", projectiles: broken });

    // Reload completion (sniper).
    for (const p of state.players.values()) {
      if (p.reloadUntil && now >= p.reloadUntil) {
        p.ammo = 1;
        p.reloadUntil = 0;
      }
    }

    // Smokes
    for (const sm of state.smokes) sm.ttl -= dt;
    state.smokes = state.smokes.filter(sm => sm.ttl > 0);

    if (state.roundTimer <= 0) {
      endRound("survivors");
    } else {
      broadcast({
        type: "state",
        timer: +state.roundTimer.toFixed(2),
        players: [...state.players.values()].map(p => ({
          id: p.id, x: Math.round(p.x), y: Math.round(p.y),
          fx: +p.facing.x.toFixed(2), fy: +p.facing.y.toFixed(2),
          alive: p.alive,
          hp: p.role === "survivor" ? Math.round(p.hp) : null,
          se: now < p.effects.speedUntil ? 1 : 0,
          st: now < p.effects.stalkUntil ? 1 : 0,
          re: now < p.effects.revealedUntil ? 1 : 0,
          sn: now < (p.effects.sneakUntil || 0) ? 1 : 0,
          hd: p.role === "survivor" && p.hiddenInSmoke ? 1 : 0,
          sm: (p.role === "killer" && now < p.effects.slowUntil) ? +p.effects.slowMult.toFixed(2) : 1,
          am: p.ammo || 0,
          rl: p.reloadUntil || 0,
        })),
        progress: state.generators.map(g => +g.progress.toFixed(3)),
        projectiles: state.projectiles.map(pr => ({
          id: pr.id, x: Math.round(pr.x), y: Math.round(pr.y),
          vx: +pr.vx.toFixed(1), vy: +pr.vy.toFixed(1),
          k: pr.kind || null,
        })),
        smokes: state.smokes.map(sm => ({
          id: sm.id, x: sm.x, y: sm.y, radius: sm.radius, ttl: +sm.ttl.toFixed(2),
        })),
        slowFields: state.slowFields.map(f => ({
          id: f.id, x: f.x, y: f.y, radius: f.radius, ttl: +f.ttl.toFixed(2),
        })),
      });
    }
  } else if (state.phase === "over" && now >= state.resetAt) {
    state.phase = "lobby";
    state.generators = freshGens();
    state.roundTimer = ROUND_DURATION;
    state.projectiles = [];
    state.smokes = [];
    state.slowFields = [];
    for (const p of state.players.values()) {
      p.role = "unassigned";
      p.alive = true;
      p.hp = SURVIVOR_HP_MAX;
      p.cooldowns = [0, 0, 0];
      p.effects = freshEffects();
      const sc = SURVIVOR_CHARS.find(c => c.id === p.survivorChar);
      if (sc) p.color = sc.color;
    }
    broadcastLobby();
  }
}

function broadcastLobby() {
  broadcast({
    type: "lobby",
    phase: state.phase,
    players: serializePlayers(),
    designatedKillerId: state.designatedKillerId,
  });
}

function serializePlayers() {
  return [...state.players.values()].map(p => ({
    id: p.id, name: p.name, color: p.color,
    role: p.role, isHost: p.isHost,
    x: Math.round(p.x), y: Math.round(p.y),
    alive: p.alive,
    hp: p.role === "survivor" ? Math.round(p.hp) : null,
    survivorChar: p.survivorChar,
    killerChar: p.killerChar,
  }));
}

function broadcast(msg) {
  const json = JSON.stringify(msg);
  for (const ws of wss.clients) {
    if (ws.readyState === 1) { try { ws.send(json); } catch {} }
  }
}
function send(ws, msg) {
  if (ws.readyState !== 1) return;
  try { ws.send(JSON.stringify(msg)); } catch {}
}
function survivorCharOf(p) {
  return SURVIVOR_CHARS.find(c => c.id === p.survivorChar) || SURVIVOR_CHARS[0];
}
function killerCharOf(p) {
  return KILLER_CHARS.find(c => c.id === p.killerChar) || KILLER_CHARS[0];
}
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

setInterval(tick, TICK_MS);
server.listen(PORT, () => {
  console.log(`Forsaken server listening on :${PORT}`);
});
