// ─────────────────────────────────────────────────────────────────────────
// solo.js — single-player fallback for Forsaken.
// When the client can't reach a real server, this spins up the authoritative
// game (solo-engine.js = server.js in the browser) and wires in:
//   • the human as one client (SoloLink — a WebSocket look-alike), and
//   • four bots, which the ENGINE now owns and drives (see server.js). Solo
//     mode just asks for them, so it runs the exact same AI a real server does.
// Setup: 1 killer + the rest survivors, killer chosen at random (so the human
// is sometimes the killer).
// ─────────────────────────────────────────────────────────────────────────
window.ForsakenSolo = (function () {
  const SURV_SPEED = 200, KILL_SPEED = 230, SPRINT = 1.35, DT = 0.05;
  const BOT_R = 16;                 // collision radius (a touch under the human's 18)
  const RAD = Math.PI / 180;

  const rnd  = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const hyp  = (dx, dy) => Math.hypot(dx, dy);
  const norm = (dx, dy) => { const d = hyp(dx, dy) || 1; return { x: dx / d, y: dy / d }; };
  const clmp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const rot  = (v, deg) => { const a = deg * RAD, c = Math.cos(a), s = Math.sin(a);
                             return { x: v.x * c - v.y * s, y: v.x * s + v.y * c }; };

  // ── Bot chatter ─────────────────────────────────────────────────────────
  // Short status lines keyed to what the bot is actually doing, so the talk
  // matches the play. One pool per situation; a bot picks at random, and both
  // a per-bot cooldown and a shared floor stop four of them talking at once.
  const CHATTER = {
    genStart:  ["on a gen", "starting a gen", "working on one over here", "gen in progress"],
    genDone:   ["gen done!", "that's one down", "one more finished", "gen popped",
                "another one!", "keep going", "we're getting there"],
    chased:    ["he's on me!", "being chased!", "get him off me", "running, running",
                "on my tail!", "heeelp", "he found me"],
    escaped:   ["lost him", "shook him off", "that was close", "safe for now",
                "phew", "made it", "that was too close"],
    hurt:      ["i'm hurt", "taking damage", "not doing great", "low health here"],
    critical:  ["SAVE ME!!!", "need a heal badly", "i'm nearly down", "help, please",
                "one more hit and i'm out", "SAVE ME!!!", "someone come get me"],
    // Fired when the killer fumbles — stunned, or whiffs right next to us.
    killerFail:["XD", "XD", "lol", "nice try", "missed me", "too slow", "not even close", "XDDD"],
    healing:   ["patching you up", "hold still, healing", "i've got you", "on my way to help"],
    thanks:    ["thanks!", "much better", "appreciated", "back in this"],
    allyDown:  ["someone's down", "we lost one", "that's not good", "down to fewer of us"],
    lastMan:   ["i'm the last one", "all on me now", "just me left", "wish me luck"],
    idle:      ["where is everyone", "all quiet", "looking for a gen", "spreading out",
                "anyone need help?", "which gen next", "i'm bored"],
    killerNear:["he's close", "i can hear him", "he's nearby", "keeping my distance"],
    // Killer lines.
    kHunt:     ["i see you", "found one", "come here", "no hiding"],
    kHit:      ["got you", "that'll hurt", "closer now", "stay still", "nowhere to go"],
    kStunned:  ["ow", "that was cheap", "you'll pay for that", "grr", "cheap shot"],
    // Between rounds, milling about in the hub.
    lobby:     ["ready when you are", "good game", "who's killer next?", "let's go again",
                "nice round", "i'm ready", "someone press start", "gg", "rematch?",
                "i like this character", "brb stretching", "waiting..."],
    kDown:     ["down you go", "one less", "that's one", "next"],
    kLost:     ["where'd you go", "lost them", "they're quick", "hiding won't help"],
    kTaunt:    ["gens won't save you", "tick tock", "i'm coming", "nowhere to run"],
  };
  let lastChatAny = 0;                 // shared floor so they don't talk over each other

  let G, onMessage, bots = [], aiTimer = null, SOLO = null;
  // Authoritative wall/obstacle test from the engine (current map's geometry).
  const blocked = (x, y) => (SOLO && SOLO.blocked ? SOLO.blocked(x, y, BOT_R) : false);

  // ── Navigation grid + A* (so bots route around walls, not into them) ──────
  const ARRIVE = 26;       // close enough — stop rather than jitter on the spot
  const CELL = 22;         // grid resolution
  const GRID_R = BOT_R;    // build the graph with the bot's real radius so A* never
                           // plans a route through a gap the body can't fit through.
  let nav = null, navMapId = null;
  function ensureNav(mapId, mapW, mapH) {
    if (nav && navMapId === mapId) return;
    const cols = Math.ceil(mapW / CELL), rows = Math.ceil(mapH / CELL);
    const b = new Uint8Array(cols * rows);
    const solid = (x, y) => (SOLO && SOLO.blocked ? SOLO.blocked(x, y, GRID_R) : false);
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++)
      b[j * cols + i] = solid(i * CELL + CELL / 2, j * CELL + CELL / 2) ? 1 : 0;
    nav = { cols, rows, b, w: mapW, h: mapH };
    navMapId = mapId;
  }
  const cIdx = (i, j) => j * nav.cols + i;
  const cFree = (i, j) => i >= 0 && j >= 0 && i < nav.cols && j < nav.rows && !nav.b[cIdx(i, j)];
  function nearestFreeCell(i, j) {
    if (cFree(i, j)) return { i, j };
    for (let r = 1; r < 8; r++)
      for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++)
        if (Math.abs(di) === r || Math.abs(dj) === r) if (cFree(i + di, j + dj)) return { i: i + di, j: j + dj };
    return null;
  }
  const DIRS = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
  // Tiny binary min-heap so A* completes on long detours (no iteration cap).
  function Heap() { this.a = []; }
  Heap.prototype.push = function (item, pri) {
    const a = this.a; a.push({ item, pri }); let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (a[p].pri <= a[i].pri) break; const t = a[p]; a[p] = a[i]; a[i] = t; i = p; }
  };
  Heap.prototype.pop = function () {
    const a = this.a; if (!a.length) return null; const top = a[0], last = a.pop();
    if (a.length) { a[0] = last; let i = 0; const n = a.length;
      for (;;) { let l = 2 * i + 1, r = l + 1, s = i;
        if (l < n && a[l].pri < a[s].pri) s = l; if (r < n && a[r].pri < a[s].pri) s = r;
        if (s === i) break; const t = a[s]; a[s] = a[i]; a[i] = t; i = s; } }
    return top.item;
  };
  Heap.prototype.size = function () { return this.a.length; };
  function findPath(sx, sy, tx, ty) {
    if (!nav) return null;
    const clampi = (v, hi) => (v < 0 ? 0 : v >= hi ? hi - 1 : v);
    const s = nearestFreeCell(clampi(Math.floor(sx / CELL), nav.cols), clampi(Math.floor(sy / CELL), nav.rows));
    const t = nearestFreeCell(clampi(Math.floor(tx / CELL), nav.cols), clampi(Math.floor(ty / CELL), nav.rows));
    if (!s || !t) return null;
    const sk = cIdx(s.i, s.j), tk = cIdx(t.i, t.j);
    const g = new Map(), came = new Map(), closed = new Set();
    const h = (i, j) => Math.hypot(i - t.i, j - t.j);
    const open = new Heap();
    g.set(sk, 0); open.push(sk, h(s.i, s.j));
    while (open.size()) {
      const ck = open.pop();
      if (ck === tk) {
        const path = []; let k = ck;
        while (k !== undefined) { const i = k % nav.cols, j = (k - i) / nav.cols; path.push({ x: i * CELL + CELL / 2, y: j * CELL + CELL / 2 }); k = came.get(k); }
        return path.reverse();
      }
      if (closed.has(ck)) continue; closed.add(ck);
      const ci = ck % nav.cols, cj = (ck - ci) / nav.cols, cg = g.get(ck);
      for (const [di, dj] of DIRS) {
        const ni = ci + di, nj = cj + dj;
        if (!cFree(ni, nj)) continue;
        if (di && dj && (!cFree(ci + di, cj) || !cFree(ci, cj + dj))) continue; // no corner cut
        const nk = cIdx(ni, nj);
        if (closed.has(nk)) continue;
        const ng = cg + (di && dj ? 1.414 : 1);
        if (!g.has(nk) || ng < g.get(nk)) { g.set(nk, ng); came.set(nk, ck); open.push(nk, ng + h(ni, nj)); }
      }
    }
    return null;
  }
  // String-pulling. A* on a grid returns a staircase of cell centres; walking
  // those literally makes a bot weave left-right the whole way. Keep only the
  // corners you actually need by skipping ahead to the furthest waypoint still
  // in clear line of sight.
  function smoothPath(path) {
    if (!path || path.length < 3) return path;
    const out = [path[0]];
    let i = 0;
    while (i < path.length - 1) {
      let j = path.length - 1;
      while (j > i + 1 && !lineOpen(path[i].x, path[i].y, path[j].x, path[j].y)) j--;
      out.push(path[j]);
      i = j;
    }
    return out;
  }
  function lineOpen(ax, ay, bx, by) {
    const d = hyp(bx - ax, by - ay), steps = Math.ceil(d / (CELL / 2));
    for (let k = 1; k <= steps; k++) { const u = k / steps; if (blocked(ax + (bx - ax) * u, ay + (by - ay) * u)) return false; }
    return true;
  }

  // ── Human client: a stand-in for a WebSocket the game code already speaks ──
  class SoloLink {
    constructor(sw) { this.sw = sw; this.readyState = 1; }
    send(raw) { this.sw.emit("message", raw); }        // client → server
    close() { this.readyState = 3; try { this.sw.close(); } catch {} }
    addEventListener() {}                              // no-op (we call onMessage directly)
    _deliver(json) { let m; try { m = JSON.parse(json); } catch { return; } onMessage(m); } // server → client
  }



  function start(ctx) {
    if (aiTimer) return;                             // already running
    G = ctx.G; onMessage = ctx.onMessage;
    const S = window.__ForsakenSolo;
    if (!S) { return; }
    SOLO = S;
    const name = ctx.name || "Player";

    // Human joins first (becomes host).
    const hsw = S.makeConn();
    const link = new SoloLink(hsw);
    hsw.onOut = (json) => link._deliver(json);
    G.ws = link;
    link.send(JSON.stringify({ type: "join", name }));
    link.send(JSON.stringify({ type: "toggle_random_killer", enabled: true }));

    // Four bots. They're the engine's own now — the same code a real server
    // runs — so solo mode gets every fix multiplayer gets, for free.
    for (let i = 0; i < 4; i++) link.send(JSON.stringify({ type: "add_bot" }));
  }

  // Test hook: lets the movement and chatter be driven headlessly, with no
  // engine, no sockets and no rendering. Harmless in the browser.
  const __test = {
    CHATTER,
    setSolo: (s) => { SOLO = s; },
    resetNav: () => { nav = null; navMapId = null; },
    ensureNav,
    findPath,
    resetChatFloor: () => { lastChatAny = 0; },
    makeBot: () => {
      const b = Object.create(Bot.prototype);
      b.hug = 0; b.hugSide = 1; b.clearTicks = 0;
      b.stuckRuns = 0; b.panicUntil = 0; b.panicDir = { x: 1, y: 0 };
      b.nextChat = 0; b.saidOnce = {}; b.wasChased = false; b.lastHp = 100;
      b.path = null; b.pathI = 0; b.pathTgt = null; b.repathAt = 0;
      b.facing = { x: 1, y: 0 };
      b.emit = () => {};
      return b;
    },
  };

  return { start, __test };
})();
