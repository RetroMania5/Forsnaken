// Forsaken — minimal browser multiplayer server.
// One room, up to 8 players. First to connect is host.
// Authoritative for: roster, roles, generator progress, attack/escape outcomes, win condition.
// Trusts: each player reports their own position (fine for friends).

const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8080;
const TICK_MS = 50;             // 20 Hz state broadcast
const GEN_TIME = 14;            // seconds per generator (one worker)
const ATTACK_RADIUS = 70;       // pixels
const ESCAPE_RADIUS = 60;
const MAP = { w: 1800, h: 1200 };
const EXIT = { x: MAP.w / 2, y: 30 };
const GEN_POSITIONS = [
  { x: 280,           y: 200 },
  { x: MAP.w - 280,   y: 200 },
  { x: 280,           y: MAP.h - 200 },
  { x: MAP.w - 280,   y: MAP.h - 200 },
];
const SURVIVOR_COLORS = ["#6cb6ff", "#6dd96b", "#ffd84a", "#e58cd9", "#f0a35e"];
const KILLER_COLOR = "#e94560";
const RESULT_HOLD_MS = 5000;

const state = {
  phase: "lobby", // "lobby" | "playing" | "over"
  players: new Map(), // id -> player
  generators: freshGens(),
  workers: new Map(), // id -> genIdx (-1 = none)
  exitOpen: false,
  winner: null,
  resetAt: 0,
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
  if (url === "/health") {
    res.writeHead(200); res.end("ok"); return;
  }
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
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    handle(id, ws, msg);
  });
  ws.on("close", () => removePlayer(id));
  ws.on("error", () => {});
  // wait for "join" before adding to roster
});

function handle(id, ws, msg) {
  switch (msg.type) {
    case "join":   return onJoin(id, ws, msg);
    case "start":  return onStart(id);
    case "pos":    return onPos(id, msg);
    case "attack": return onAttack(id);
    case "work":   return onWork(id, msg);
    case "escape": return onEscape(id);
    case "leave":  return removePlayer(id);
  }
}

function onJoin(id, ws, msg) {
  const name = (msg.name || "Player").toString().slice(0, 16);
  const isHost = state.players.size === 0;
  const survivorCount = [...state.players.values()].filter(p => p.role !== "killer").length;
  const player = {
    id, ws, name,
    role: "unassigned",
    color: SURVIVOR_COLORS[survivorCount % SURVIVOR_COLORS.length],
    x: MAP.w / 2, y: MAP.h - 200,
    facing: { x: 1, y: 0 },
    alive: true, escaped: false,
    isHost,
    joinedAt: Date.now(),
  };
  state.players.set(id, player);
  // Send the player their id & full snapshot.
  send(ws, { type: "welcome", id, map: MAP, exit: EXIT, gens: state.generators });
  broadcastLobby();
}

function removePlayer(id) {
  const p = state.players.get(id);
  if (!p) return;
  const wasHost = p.isHost;
  state.players.delete(id);
  state.workers.delete(id);
  if (wasHost && state.players.size > 0) {
    // Promote next-oldest player.
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
  if (state.players.size < 1) return;
  startRound();
}

function onPos(id, msg) {
  const p = state.players.get(id);
  if (!p || state.phase !== "playing") return;
  if (!p.alive || p.escaped) return;
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
  let best = null, bestD = ATTACK_RADIUS;
  for (const [pid, p] of state.players) {
    if (pid === id) continue;
    if (p.role !== "survivor" || !p.alive || p.escaped) continue;
    const d = Math.hypot(p.x - a.x, p.y - a.y);
    if (d < bestD) { bestD = d; best = p; }
  }
  if (best) {
    best.alive = false;
    broadcast({ type: "down", id: best.id, by: a.id });
    checkRoundEnd();
  }
}

function onWork(id, msg) {
  if (state.phase !== "playing") return;
  const p = state.players.get(id);
  if (!p || p.role !== "survivor" || !p.alive || p.escaped) return;
  const gen = typeof msg.gen === "number" ? msg.gen : -1;
  if (gen === -1) {
    state.workers.delete(id);
  } else if (gen >= 0 && gen < state.generators.length && !state.generators[gen].done) {
    state.workers.set(id, gen);
  }
}

function onEscape(id) {
  if (state.phase !== "playing" || !state.exitOpen) return;
  const p = state.players.get(id);
  if (!p || p.role !== "survivor" || !p.alive || p.escaped) return;
  if (Math.hypot(p.x - EXIT.x, p.y - EXIT.y) > ESCAPE_RADIUS) return;
  p.escaped = true;
  broadcast({ type: "escape", id });
  checkRoundEnd();
}

function startRound() {
  state.generators = freshGens();
  state.workers.clear();
  state.exitOpen = false;
  state.winner = null;

  const ids = [...state.players.keys()];
  shuffle(ids);
  ids.forEach((pid, idx) => {
    const p = state.players.get(pid);
    if (ids.length >= 2 && idx === 0) {
      p.role = "killer";
      p.color = KILLER_COLOR;
      p.x = MAP.w / 2;
      p.y = 220;
    } else {
      p.role = "survivor";
      const survIdx = ids.length >= 2 ? idx - 1 : idx;
      p.color = SURVIVOR_COLORS[survIdx % SURVIVOR_COLORS.length];
      p.x = MAP.w / 2 + (survIdx - 1.5) * 70;
      p.y = MAP.h - 200;
    }
    p.alive = true; p.escaped = false;
    p.facing = { x: 1, y: 0 };
  });

  state.phase = "playing";
  broadcast({
    type: "start",
    players: serializePlayers(),
    gens: state.generators,
  });
}

function checkRoundEnd() {
  if (state.phase !== "playing") return;
  let anyActive = false, anyEscaped = false, anySurvivor = false;
  for (const p of state.players.values()) {
    if (p.role !== "survivor") continue;
    anySurvivor = true;
    if (p.alive && !p.escaped) anyActive = true;
    if (p.escaped) anyEscaped = true;
  }
  if (!anySurvivor) return; // edge case (only killer left)
  if (!anyActive) {
    state.phase = "over";
    state.winner = anyEscaped ? "survivors" : "killer";
    state.resetAt = Date.now() + RESULT_HOLD_MS;
    broadcast({ type: "over", winner: state.winner });
  }
}

function tick(dt) {
  if (state.phase === "playing") {
    // Generator progress.
    const doneNow = [];
    for (let i = 0; i < state.generators.length; i++) {
      const g = state.generators[i];
      if (g.done) continue;
      let workers = 0;
      for (const [pid, gidx] of state.workers) {
        if (gidx !== i) continue;
        const p = state.players.get(pid);
        if (p && p.role === "survivor" && p.alive && !p.escaped) workers++;
      }
      if (workers > 0) {
        g.progress += (dt * workers) / GEN_TIME;
        if (g.progress >= 1) {
          g.progress = 1; g.done = true; doneNow.push(i);
        }
      }
    }
    if (!state.exitOpen && state.generators.every(g => g.done)) {
      state.exitOpen = true;
      broadcast({ type: "exit_open" });
    }
    if (doneNow.length > 0) broadcast({ type: "gen_done", indices: doneNow });

    // Periodic state.
    broadcast({
      type: "state",
      players: [...state.players.values()].map(p => ({
        id: p.id, x: Math.round(p.x), y: Math.round(p.y),
        fx: +p.facing.x.toFixed(2), fy: +p.facing.y.toFixed(2),
        alive: p.alive, escaped: p.escaped,
      })),
      progress: state.generators.map(g => +g.progress.toFixed(3)),
    });
  } else if (state.phase === "over" && Date.now() >= state.resetAt) {
    state.phase = "lobby";
    state.workers.clear();
    state.generators = freshGens();
    state.exitOpen = false;
    for (const p of state.players.values()) {
      p.role = "unassigned"; p.alive = true; p.escaped = false;
    }
    broadcastLobby();
  }
}

function broadcastLobby() {
  broadcast({
    type: "lobby",
    phase: state.phase,
    players: serializePlayers(),
  });
}

function serializePlayers() {
  return [...state.players.values()].map(p => ({
    id: p.id, name: p.name, color: p.color,
    role: p.role, isHost: p.isHost,
    x: Math.round(p.x), y: Math.round(p.y),
    alive: p.alive, escaped: p.escaped,
  }));
}

function broadcast(msg) {
  const json = JSON.stringify(msg);
  for (const ws of wss.clients) {
    if (ws.readyState === 1) {
      try { ws.send(json); } catch {}
    }
  }
}

function send(ws, msg) {
  if (ws.readyState !== 1) return;
  try { ws.send(JSON.stringify(msg)); } catch {}
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

let last = Date.now();
setInterval(() => {
  const now = Date.now();
  tick((now - last) / 1000);
  last = now;
}, TICK_MS);

server.listen(PORT, () => {
  console.log(`Forsaken server listening on :${PORT}`);
});
