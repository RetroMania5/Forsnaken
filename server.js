// Forsaken — browser multiplayer server (Forsaken-style timer + skill checks).
// One room, up to 8 players. First to connect is host.
// Authoritative for: roster, roles, generator progress, attack outcomes, round timer, win condition.
// Trusts: each player reports their own position; each player classifies their own skill check.

const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8080;
const TICK_MS = 50;

const MAP = { w: 1800, h: 1200 };
const GEN_POSITIONS = [
  { x: 280,         y: 200 },
  { x: MAP.w - 280, y: 200 },
  { x: 280,         y: MAP.h - 200 },
  { x: MAP.w - 280, y: MAP.h - 200 },
];

// ---- Characters ----
const SURVIVOR_CHARS = [
  { id: "runner",   name: "Runner",   color: "#ff80c0", speedMult: 1.10, repairMult: 1.00, blurb: "+10% speed" },
  { id: "engineer", name: "Engineer", color: "#ffd84a", speedMult: 1.00, repairMult: 1.30, blurb: "+30% repair" },
  { id: "scout",    name: "Scout",    color: "#6cb6ff", speedMult: 1.05, repairMult: 1.05, blurb: "balanced" },
];
const KILLER_CHARS = [
  { id: "slasher",  name: "Slasher",  color: "#e94560", speedMult: 1.00, attackRadius: 70,  blurb: "balanced reach" },
  { id: "stalker",  name: "Stalker",  color: "#7a2030", speedMult: 0.92, attackRadius: 110, blurb: "long reach, slower" },
];

// ---- Round mechanics ----
const ROUND_DURATION = 180;     // seconds at start
const TIME_PER_GEN = -30;       // generator completed: survivors gain "win progress"
const TIME_PER_DOWN = +25;      // survivor downed: killer gains "hunt time"
const RESULT_HOLD_MS = 5000;

// ---- Skill check ----
const SKILL_PROGRESS = { green: 0.22, yellow: 0.10, red: -0.12 };
const SKILL_NEAR_RADIUS = 90;
const SKILL_COOLDOWN_MS = 400; // server-side rate limit per player

const state = {
  phase: "lobby",
  players: new Map(),
  generators: freshGens(),
  designatedKillerId: null,
  roundTimer: ROUND_DURATION,
  winner: null,
  resetAt: 0,
  lastSkill: new Map(), // playerId -> ts
};

function freshGens() {
  return GEN_POSITIONS.map(p => ({ x: p.x, y: p.y, progress: 0, done: false }));
}

// ---------- HTTP ----------
const server = http.createServer((req, res) => {
  const url = req.url.split("?")[0];
  if (url === "/" || url === "/index.html") {
    return sendFile(res, "index.html", "text/html; charset=utf-8");
  }
  if (url === "/health") { res.writeHead(200); res.end("ok"); return; }
  res.writeHead(404); res.end("not found");
});
function sendFile(res, name, type) {
  fs.readFile(path.join(__dirname, name), (err, data) => {
    if (err) { res.writeHead(500); res.end(); return; }
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
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
    isHost,
    joinedAt: Date.now(),
  };
  state.players.set(id, player);
  send(ws, {
    type: "welcome",
    id, map: MAP,
    gens: state.generators,
    survivorChars: SURVIVOR_CHARS,
    killerChars: KILLER_CHARS,
    roundDuration: ROUND_DURATION,
  });
  broadcastLobby();
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
  // lobby-only: update visible color to chosen survivor color (visual preview)
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
  let best = null, bestD = kch.attackRadius;
  for (const [pid, p] of state.players) {
    if (pid === id) continue;
    if (p.role !== "survivor" || !p.alive) continue;
    const d = Math.hypot(p.x - a.x, p.y - a.y);
    if (d < bestD) { bestD = d; best = p; }
  }
  if (best) {
    best.alive = false;
    state.roundTimer += TIME_PER_DOWN;
    broadcast({ type: "down", id: best.id, by: a.id, timer: state.roundTimer });
    checkRoundEnd();
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
  // Distance check.
  if (Math.hypot(p.x - g.x, p.y - g.y) > SKILL_NEAR_RADIUS) return;
  // Rate limit.
  const now = Date.now();
  const last = state.lastSkill.get(id) || 0;
  if (now - last < SKILL_COOLDOWN_MS) return;
  state.lastSkill.set(id, now);
  // Apply.
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
    // Timer could hit 0 from a gen completion -> survivors win.
    if (state.roundTimer <= 0) endRound("survivors");
  }
}

function startRound() {
  state.generators = freshGens();
  state.roundTimer = ROUND_DURATION;
  state.winner = null;
  state.lastSkill.clear();

  const killerId = state.designatedKillerId;
  const survIds = [...state.players.keys()].filter(pid => pid !== killerId);

  const killer = state.players.get(killerId);
  const kch = killerCharOf(killer);
  killer.role = "killer";
  killer.color = kch.color;
  killer.x = MAP.w / 2;
  killer.y = 220;
  killer.alive = true;
  killer.facing = { x: 1, y: 0 };

  survIds.forEach((sid, idx) => {
    const p = state.players.get(sid);
    const sch = survivorCharOf(p);
    p.role = "survivor";
    p.color = sch.color;
    p.x = MAP.w / 2 + (idx - (survIds.length - 1) / 2) * 80;
    p.y = MAP.h - 220;
    p.alive = true;
    p.facing = { x: 1, y: 0 };
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
        })),
        progress: state.generators.map(g => +g.progress.toFixed(3)),
      });
    }
  } else if (state.phase === "over" && now >= state.resetAt) {
    state.phase = "lobby";
    state.generators = freshGens();
    state.roundTimer = ROUND_DURATION;
    for (const p of state.players.values()) {
      p.role = "unassigned";
      p.alive = true;
      // re-apply lobby visual to survivor pick
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
