// ─────────────────────────────────────────────────────────────────────────
// solo.js — single-player fallback for Forsaken.
// When the client can't reach a real server, this spins up the authoritative
// game (solo-engine.js = server.js in the browser) and wires in:
//   • the human as one client (SoloLink — a WebSocket look-alike), and
//   • 4 AI bots as ordinary clients that read state snapshots and send inputs.
// Setup: 1 killer + the rest survivors, killer chosen at random (so the human
// is sometimes the killer). Bots pick random characters and use their
// abilities; survivor bots cooperate (heal/burger/rally + CC the killer that's
// chasing an ally).
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

  // ── AI bot: an ordinary client driven by policy ───────────────────────────
  class Bot {
    constructor(sw, name, index) {
      this.sw = sw; this.name = name; this.index = index;
      this.id = null; this.role = null;
      this.map = { w: 2400, h: 1600 };
      this.survChars = []; this.killChars = []; this.abilities = {};
      this.survChar = "scout"; this.killChar = "slasher";
      this.roster = new Map();      // id -> { role, survivorChar, killerChar }
      this.snap = null;             // last "state" message
      this.gens = [];               // [{x,y,done}]
      this.bx = 0; this.by = 0; this.facing = { x: 1, y: 0 };
      this.alive = true; this.playing = false;
      this.hug = 0; this.hugSide = 1;   // wall-following commitment
      this.clearTicks = 0;              // consecutive ticks with a clear path ahead
      this.stuckRuns = 0; this.panicUntil = 0; this.panicDir = { x: 1, y: 0 };
      this.nextChat = 0; this.saidOnce = {}; this.wasChased = false; this.lastHp = 100;
      this.path = null; this.pathI = 0; this.pathTgt = null; this.repathAt = 0;
      this.stunUntil = 0; this.nextUse = [0, 0, 0];
      this.nextSkill = 0; this.nextAttack = 0;
      sw.onOut = (json) => this.onServer(json);
      this.emit({ type: "join", name });
    }
    emit(o) { this.sw.emit("message", JSON.stringify(o)); }
    onServer(json) { let m; try { m = JSON.parse(json); } catch { return; } this.handle(m); }

    handle(m) {
      switch (m.type) {
        case "welcome":
          this.id = m.id; this.map = m.map || this.map;
          this.survChars = m.survivorChars || []; this.killChars = m.killerChars || [];
          this.abilities = m.abilities || {};
          this.rerollChars();
          if (m.gens) this.gens = m.gens.map(g => ({ x: g.x, y: g.y, done: !!g.done }));
          break;
        case "lobby":
          this.updateRoster(m.players); break;
        case "start":
          this.updateRoster(m.players);
          if (m.gens) this.gens = m.gens.map(g => ({ x: g.x, y: g.y, done: !!g.done }));
          const me = (m.players || []).find(p => p.id === this.id);
          if (me) { this.bx = me.x; this.by = me.y; this.role = me.role; this.alive = true; }
          this.stunUntil = 0; this.nextUse = [0, 0, 0]; this.playing = true;
          this.path = null; this.pathTgt = null;
          ensureNav(m.mapId || "circus", this.map.w || 2400, this.map.h || 1600);
          break;
        case "state":
          this.snap = m;
          if (m.progress) for (let i = 0; i < this.gens.length; i++) if (m.progress[i] >= 1) this.gens[i].done = true;
          const meS = (m.players || []).find(p => p.id === this.id);
          if (meS) this.alive = meS.alive;
          break;
        case "gen_done":
          (m.indices || []).forEach(i => { if (this.gens[i]) this.gens[i].done = true; });
          if (this.role !== "killer") this.say("genDone", Date.now(), { gap: 10000 });
          break;
        case "stun": {
          const t = Date.now();
          if (m.id === this.id) {
            this.stunUntil = t + (m.duration || 1) * 1000;
            if (this.role === "killer") this.say("kStunned", t, { gap: 9000 });
          } else if (this.role !== "killer" && (this.roster.get(m.id) || {}).role === "killer") {
            // The killer just ate a stun — that's the moment to laugh.
            this.say("killerFail", t, { gap: 7000 });
          }
          break;
        }
        case "down":
          if (m.id === this.id) this.alive = false; break;
        case "lms": case "over":
          if (m.type === "over") { this.playing = false; this._rejVoted = false; } break;
        case "lobby":
          // Back between rounds — new characters, and clear the round's
          // one-shot chat flags so lines can fire again next game.
          this.rerollChars();
          this.saidOnce = {};
          this.wasChased = false; this.wasHunting = false;
          this.lastHp = 100; this.lastAllies = undefined; this.lastSurvs = undefined;
          break;
        case "rejoin_status":
          // Follow the human: once anyone votes to rejoin, the bots vote too so
          // a solo player can send everyone back to the lobby with one click.
          if (!this._rejVoted && m.votes >= 1) { this._rejVoted = true; this.emit({ type: "rejoin" }); }
          break;
      }
    }
    updateRoster(players) {
      (players || []).forEach(p => {
        this.roster.set(p.id, { role: p.role, survivorChar: p.survivorChar, killerChar: p.killerChar });
        if (p.id === this.id) this.role = p.role;
      });
    }

    // Pick a fresh pair of characters. Called on join and again in the lobby
    // between rounds, so the bots don't play the same four every game. Avoids
    // repeating the character we just used where there's more than one option.
    rerollChars() {
      if (!this.survChars.length || !this.killChars.length) return;
      const pick = (pool, avoid) => {
        const opts = pool.length > 1 ? pool.filter(c => c.id !== avoid) : pool;
        return rnd(opts).id;
      };
      this.survChar = pick(this.survChars, this.survChar);
      this.killChar = pick(this.killChars, this.killChar);
      this.emit({ type: "pick_char", survivorChar: this.survChar, killerChar: this.killChar });
    }
    myAbilities() { return this.abilities[this.role === "killer" ? this.killChar : this.survChar] || []; }
    killerStats() { return this.killChars.find(c => c.id === this.killChar) || { attackRadius: 75, attackCooldown: 1.0 }; }
    selfSnap() { return this.snap && this.snap.players.find(p => p.id === this.id); }

    move(dir, speed) {
      if (!dir.x && !dir.y) return false;
      const step = speed * DT;
      const tryStep = (d) => {
        const nx = clmp(this.bx + d.x * step, 20, this.map.w - 20);
        const ny = clmp(this.by + d.y * step, 20, this.map.h - 20);
        if (blocked(nx, ny)) return false;
        this.bx = nx; this.by = ny; this.facing = d; return true;
      };
      // Shoved inside geometry (a push, a teleport, a spawn on a wall)? Climb
      // out before trying to steer, or every direction reads as blocked.
      if (blocked(this.bx, this.by)) { this.unstick(step); return true; }

      // Already detouring: stay committed to the side we chose. Straight ahead
      // is tried LAST and only releases the detour after several clear ticks —
      // without that, a concave corner alternates blocked/clear every tick and
      // the bot visibly shivers left and right instead of walking out.
      if (this.hug > 0) {
        this.hug--;
        for (const a of [30, 55, 85, 115, 145]) {
          if (tryStep(rot(dir, this.hugSide * a))) { this.clearTicks = 0; return true; }
        }
        if (tryStep(dir)) {
          this.clearTicks = (this.clearTicks || 0) + 1;
          if (this.clearTicks >= 4) { this.hug = 0; this.clearTicks = 0; }
          return true;
        }
        this.hug = 0;                 // that side is a dead end — re-pick below
      }

      if (tryStep(dir)) { this.clearTicks = 0; return true; }

      // Newly blocked: commit to the roomier side for a good while.
      this.hugSide = this.clearer(dir, step);
      this.hug = 26;
      this.clearTicks = 0;
      for (const a of [40, 65, 95, 125, 155]) {
        if (tryStep(rot(dir, this.hugSide * a))) return true;
      }
      for (const a of [40, 65, 95, 125, 155, 180]) {
        if (tryStep(rot(dir, -this.hugSide * a))) return true;
      }
      return false;                   // genuinely boxed in this tick
    }
    // Which turn direction (+1 / -1) has more open room ahead of a blocked
    // path. Looks further than it used to, so the side we commit to is the one
    // that actually leads somewhere rather than the one that's clear for a step.
    clearer(dir, step) {
      const run = (side) => {
        const d = rot(dir, side * 75); let n = 0;
        for (let k = 1; k <= 10; k++) { if (blocked(this.bx + d.x * step * k, this.by + d.y * step * k)) break; n++; }
        return n;
      };
      return run(1) >= run(-1) ? 1 : -1;
    }
    // Walk out of a wall we're standing inside, towards open ground.
    unstick(step) {
      let best = null, bestD = Infinity;
      for (let a = 0; a < 360; a += 30) {
        const d = rot({ x: 1, y: 0 }, a);
        for (let k = 1; k <= 6; k++) {
          const nx = this.bx + d.x * step * k, ny = this.by + d.y * step * k;
          if (!blocked(nx, ny)) { if (k < bestD) { bestD = k; best = { nx, ny, d }; } break; }
        }
      }
      if (best) { this.bx = best.nx; this.by = best.ny; this.facing = best.d; }
      this.path = null; this.repathAt = 0; this.hug = 0;
    }
    // Path-follow toward (tx,ty): A* around walls, then local move() per step.
    navTo(tx, ty, speed, now) {
      // Arrival deadband. Without this a bot that has reached its destination
      // keeps asking to move a fraction of a pixel and twitches on the spot —
      // which reads as the bot vibrating left and right forever.
      const dTgt = hyp(tx - this.bx, ty - this.by);
      if (dTgt < ARRIVE) { this.path = null; this.hug = 0; return; }
      if (!this.pathTgt || hyp(this.pathTgt.x - tx, this.pathTgt.y - ty) > 60 || now > this.repathAt || !this.path) {
        this.path = smoothPath(findPath(this.bx, this.by, tx, ty));
        this.pathI = 0; this.pathTgt = { x: tx, y: ty }; this.repathAt = now + 700;
      }
      if (!this.path || !this.path.length) {
        // No route (target walled in, or we're off the graph). Head roughly
        // that way but let the wall-follow do the work, and retry sooner —
        // beelining here is what used to bury bots in corners.
        this.repathAt = Math.min(this.repathAt, now + 250);
        this.move(norm(tx - this.bx, ty - this.by), speed);
        return;
      }
      // Advance past waypoints we've reached or can see straight to.
      while (this.pathI < this.path.length - 1 &&
             (hyp(this.path[this.pathI].x - this.bx, this.path[this.pathI].y - this.by) < CELL * 0.8 ||
              lineOpen(this.bx, this.by, this.path[this.pathI + 1].x, this.path[this.pathI + 1].y)))
        this.pathI++;
      const wp = this.path[Math.min(this.pathI, this.path.length - 1)];
      this.move(norm(wp.x - this.bx, wp.y - this.by), speed);
    }
    // `once` keys a line to a one-off event so it isn't repeated all round.
    say(pool, now, opts) {
      const o = opts || {};
      if (now < this.nextChat) return false;
      if (now - lastChatAny < 1800) return false;      // let the last line breathe
      if (o.once) { if (this.saidOnce[o.once]) return false; this.saidOnce[o.once] = 1; }
      const lines = CHATTER[pool];
      if (!lines || !lines.length) return false;
      this.emit({ type: "chat", text: rnd(lines) });
      this.nextChat = now + (o.gap || 9000) + Math.random() * 5000;
      lastChatAny = now;
      return true;
    }
    speedNow() {
      const base = this.role === "killer" ? KILL_SPEED : SURV_SPEED;
      return base * SPRINT;
    }
    sendPos() { this.emit({ type: "pos", x: this.bx, y: this.by, facing: this.facing }); }
    useAbility(slot, ab, now, aim) {
      if (now < this.nextUse[slot]) return false;
      // Orient toward the aim first (a pos msg) so facing-based abilities aim right.
      if (aim) { this.facing = aim; this.emit({ type: "pos", x: this.bx, y: this.by, facing: aim }); }
      this.emit({ type: "ability", slot, aim: aim || this.facing });
      this.nextUse[slot] = now + (ab.cd || 5) * 1000;
      return true;
    }

    think(now) {
      if (!this.playing) { this.thinkLobby(now); return; }
      if (!this.alive || !this.snap) return;
      if (now < this.stunUntil) { this.sendPos(); return; }
      // Anti-stuck: if we've barely moved while trying to navigate, force a re-path.
      if (now < (this.panicUntil || 0)) {
        // Thoroughly wedged: barge off in one committed direction for a moment
        // rather than re-deciding every tick against the same wall.
        this.move(this.panicDir, this.speedNow());
        this.sendPos();
        return;
      }
      if (!this._mv || now - this._mv.at > 700) {
        const moved = this._mv ? hyp(this.bx - this._mv.x, this.by - this._mv.y) : 999;
        if (moved < 18) {
          this.stuckRuns = (this.stuckRuns || 0) + 1;
          this.path = null; this.repathAt = 0; this.hug = 0;
          if (this.stuckRuns >= 3) {           // re-pathing isn't working
            this.panicDir = rot({ x: 1, y: 0 }, Math.random() * 360);
            this.panicUntil = now + 700;
            this.stuckRuns = 0;
          }
        } else this.stuckRuns = 0;
        this._mv = { x: this.bx, y: this.by, at: now };
      }
      const role = this.role || (this.roster.get(this.id) || {}).role;
      if (role === "killer") this.thinkKiller(now); else this.thinkSurvivor(now);
      this.sendPos();
    }

    // Between rounds the bots mill around the hub and chat, so the lobby isn't
    // four statues. Uses the same pos messages the hub already syncs.
    thinkLobby(now) {
      if (!this.lobbyTgt || now > this.lobbyTgtAt ||
          hyp(this.lobbyTgt.x - this.bx, this.lobbyTgt.y - this.by) < 40) {
        // The hub is its own small room, not the match map.
        this.lobbyTgt = { x: 180 + Math.random() * 920, y: 160 + Math.random() * 420 };
        this.lobbyTgtAt = now + 3000 + Math.random() * 4000;
      }
      const d = norm(this.lobbyTgt.x - this.bx, this.lobbyTgt.y - this.by);
      const step = 120 * DT;
      this.bx = clmp(this.bx + d.x * step, 40, 1240);
      this.by = clmp(this.by + d.y * step, 90, 690);
      this.facing = d;
      this.sendPos();
      this.say("lobby", now, { gap: 16000 });
    }

    thinkKiller(now) {
      const survs = this.snap.players.filter(p => (this.roster.get(p.id) || {}).role === "survivor" && p.alive);
      if (!survs.length) return;
      let t = survs[0], best = 1e9;
      for (const s of survs) { const d = hyp(s.x - this.bx, s.y - this.by); if (d < best) { best = d; t = s; } }
      const dir = norm(t.x - this.bx, t.y - this.by);
      const ks = this.killerStats();

      // ── Talk about the hunt ────────────────────────────────────────────
      const onTrail = best < 420;
      if (onTrail && !this.wasHunting) this.say("kHunt", now, { gap: 9000 });
      else if (!onTrail && this.wasHunting && best > 800) this.say("kLost", now, { gap: 12000 });
      else if (!onTrail) this.say("kTaunt", now, { gap: 20000 });
      if (survs.length < (this.lastSurvs == null ? survs.length : this.lastSurvs)) {
        this.say("kDown", now, { gap: 8000 });
      }
      this.wasHunting = onTrail;
      this.lastSurvs = survs.length;

      this.navTo(t.x, t.y, KILL_SPEED * SPRINT, now);
      if (best <= (ks.attackRadius || 75) * 0.95 && now >= this.nextAttack) {
        this.emit({ type: "attack" });
        this.nextAttack = now + (ks.attackCooldown || 1) * 1000;
        this.say("kHit", now, { gap: 11000 });
      }
      const list = this.myAbilities();
      list.forEach((ab, slot) => {
        switch (ab.type) {
          case "speed_self":   if (best > 240) this.useAbility(slot, ab, now, dir); break;
          case "teleport":     if (best > 160 && best < 460) this.useAbility(slot, ab, now, dir); break;
          case "buff_attack":  if (best < 220) this.useAbility(slot, ab, now, dir); break;
          case "projectile":   if (best < 650) this.useAbility(slot, ab, now, dir); break;
          case "dash_strike":  if (best > 150 && best < 520) this.useAbility(slot, ab, now, dir); break;
          case "transform":    if (best < 500) this.useAbility(slot, ab, now, dir); break;
          case "trap_fire":    if (best < 260) this.useAbility(slot, ab, now, dir); break;
          case "build_portal": if (best < 400) this.useAbility(slot, ab, now, dir); break;
          default: break;
        }
      });
    }

    thinkSurvivor(now) {
      const players = this.snap.players;
      const killer = players.find(p => (this.roster.get(p.id) || {}).role === "killer");
      const me = this.selfSnap();
      const myHp = (me && me.hp != null) ? me.hp : 100;
      const dK = killer ? hyp(killer.x - this.bx, killer.y - this.by) : 1e9;
      const dirFromK = killer ? norm(this.bx - killer.x, this.by - killer.y) : { x: 0, y: -1 };
      const dirToK   = killer ? norm(killer.x - this.bx, killer.y - this.by) : { x: 1, y: 0 };
      const allies = players.filter(p => p.id !== this.id && (this.roster.get(p.id) || {}).role === "survivor" && p.alive);

      // ── Talk about it ──────────────────────────────────────────────────
      const chased = dK < 320;
      if (myHp <= 30) this.say("critical", now, { gap: 7000 });
      else if (myHp < 70 && myHp < this.lastHp) this.say("hurt", now, { gap: 12000 });
      if (chased && !this.wasChased) this.say("chased", now, { gap: 8000 });
      else if (!chased && this.wasChased && dK > 700) this.say("escaped", now, { gap: 12000 });
      else if (chased && dK < 560) this.say("killerNear", now, { gap: 14000 });
      if (allies.length === 0 && this.alive) this.say("lastMan", now, { once: "lms", gap: 5000 });
      else if (allies.length < this.lastAllies) this.say("allyDown", now, { gap: 10000 });
      this.wasChased = chased;
      this.lastHp = myHp;
      this.lastAllies = allies.length;
      // Who needs help? The human counts for more than a fellow bot — being
      // left to die by four AI team-mates is the least fun way to lose.
      const humanId = G && G.myId;
      let injured = null, injBest = 1e9;
      for (const a of allies) {
        if (a.hp == null || a.hp >= 70) continue;
        let d = hyp(a.x - this.bx, a.y - this.by);
        if (a.id === humanId) d *= 0.45;           // weighted, not forced
        if (d < injBest) { injBest = d; injured = a; }
      }
      // Is the human in trouble right now? If so, and we're not the one being
      // chased, go and make a nuisance of ourselves.
      const human = humanId ? players.find(p => p.id === humanId && p.alive) : null;
      const humanChased = human && killer &&
        hyp(killer.x - human.x, killer.y - human.y) < 260 &&
        hyp(killer.x - this.bx, killer.y - this.by) > 200;

      if (injured && injBest < 260) this.say("healing", now, { gap: 15000 });

      // Abilities (cooperative): CC the killer, heal/support allies, self-preserve.
      const list = this.myAbilities();
      list.forEach((ab, slot) => {
        const range = ab.range || ab.radius || 180;
        switch (ab.type) {
          case "heal_self": case "heal_self_instant": if (myHp < 45) this.useAbility(slot, ab, now); break;
          case "reload_sniper": if (me && (me.am || 0) === 0) this.useAbility(slot, ab, now); break;
          case "shoot_sniper": if (killer && dK < 850 && me && (me.am || 0) > 0) this.useAbility(slot, ab, now, dirToK); break;
          case "speed_self": if (dK < 240) this.useAbility(slot, ab, now, dirFromK); break;
          case "smoke": case "sneak": case "duck": case "shield": if (dK < 220) this.useAbility(slot, ab, now); break;
          case "stun_burst": if (killer && dK < (ab.radius || 180)) this.useAbility(slot, ab, now, dirToK); break;
          case "slow_field": if (killer && dK < 280) this.useAbility(slot, ab, now); break;
          case "slash_stun": case "stab": if (killer && dK < (ab.range || 80) + 20) this.useAbility(slot, ab, now, dirToK); break;
          case "meow": if ((killer && dK < 600) || injured) this.useAbility(slot, ab, now); break;
          case "throw_burger": if (injured) this.useAbility(slot, ab, now, norm(injured.x - this.bx, injured.y - this.by)); break;
          case "projectile": if (killer && dK < 620) this.useAbility(slot, ab, now, dirToK); break;
          case "spawn_robot": if (killer && dK < 500) this.useAbility(slot, ab, now); break;
          case "build_station":
            if (ab.stationKind === "heal" && (injured || myHp < 60)) this.useAbility(slot, ab, now);
            else if (ab.stationKind === "defence" && killer && dK < 320 && allies.length) this.useAbility(slot, ab, now);
            break;
          case "speed_team": if (allies.some(a => hyp(a.x - this.bx, a.y - this.by) < (ab.radius || 200)) && dK < 320) this.useAbility(slot, ab, now); break;
          case "reveal": this.useAbility(slot, ab, now); break;
          case "spawn_pad": this.useAbility(slot, ab, now); break;
          default: break;
        }
      });

      // A team-mate in danger comes before a generator: close in on the killer
      // to draw attention and get our stuns in range.
      if (humanChased && hyp(human.x - this.bx, human.y - this.by) < 900) {
        this.say("healing", now, { gap: 14000 });
        this.navTo(killer.x, killer.y, SURV_SPEED * SPRINT, now);
        return;
      }
      // Movement: flee a close killer, otherwise go work a generator.
      if (killer && dK < 240) {
        this.facing = dirToK;                        // face the killer (for CC) while backpedaling
        this.move(dirFromK, SURV_SPEED * SPRINT);
        return;
      }
      // If an ally is hurt and safe-ish, path toward them to lend support.
      if (injured && injBest > 120 && dK > 360) {
        this.navTo(injured.x, injured.y, SURV_SPEED, now);
        return;
      }
      const todo = this.gens.map((g, i) => ({ ...g, i })).filter(g => !g.done);
      if (!todo.length) {                            // all gens done: regroup near center
        this.navTo(this.map.w / 2, this.map.h - 220, SURV_SPEED, now);
        return;
      }
      todo.sort((a, b) => hyp(a.x - this.bx, a.y - this.by) - hyp(b.x - this.bx, b.y - this.by));
      const g = todo[(this.index - 1) % todo.length]; // fan bots out across gens
      const dg = hyp(g.x - this.bx, g.y - this.by);
      if (dg > 78) {
        this.navTo(g.x, g.y, SURV_SPEED * (dg > 320 ? SPRINT : 1), now);
      } else if (now >= this.nextSkill) {            // at the gen: run skill checks
        this.emit({ type: "skill", gen: g.i, result: "green" });
        this.nextSkill = now + 520;
      }
    }
  }

  function aiTick() { const now = Date.now(); for (const b of bots) b.think(now); }

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

    // Four bots join.
    bots = [];
    for (let i = 1; i <= 4; i++) bots.push(new Bot(S.makeConn(), "Bot " + i, i));

    aiTimer = setInterval(aiTick, 50);
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
