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
  // Steering: try the straight-ahead direction first, then progressively wider
  // angles left/right so a blocked bot walks *around* a wall instead of into it.
  const STEER = [0, 22, -22, 45, -45, 70, -70, 100, -100, 135, -135];

  const rnd  = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const hyp  = (dx, dy) => Math.hypot(dx, dy);
  const norm = (dx, dy) => { const d = hyp(dx, dy) || 1; return { x: dx / d, y: dy / d }; };
  const clmp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const rot  = (v, deg) => { const a = deg * RAD, c = Math.cos(a), s = Math.sin(a);
                             return { x: v.x * c - v.y * s, y: v.x * s + v.y * c }; };

  let G, onMessage, bots = [], aiTimer = null, SOLO = null;
  // Authoritative wall/obstacle test from the engine (current map's geometry).
  const blocked = (x, y) => (SOLO && SOLO.blocked ? SOLO.blocked(x, y, BOT_R) : false);

  // ── Navigation grid + A* (so bots route around walls, not into them) ──────
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
          this.survChar = rnd(this.survChars).id;
          this.killChar = rnd(this.killChars).id;
          this.emit({ type: "pick_char", survivorChar: this.survChar, killerChar: this.killChar });
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
          (m.indices || []).forEach(i => { if (this.gens[i]) this.gens[i].done = true; }); break;
        case "stun":
          if (m.id === this.id) this.stunUntil = Date.now() + (m.duration || 1) * 1000; break;
        case "down":
          if (m.id === this.id) this.alive = false; break;
        case "lms": case "over":
          if (m.type === "over") this.playing = false; break;
      }
    }
    updateRoster(players) {
      (players || []).forEach(p => {
        this.roster.set(p.id, { role: p.role, survivorChar: p.survivorChar, killerChar: p.killerChar });
        if (p.id === this.id) this.role = p.role;
      });
    }

    myAbilities() { return this.abilities[this.role === "killer" ? this.killChar : this.survChar] || []; }
    killerStats() { return this.killChars.find(c => c.id === this.killChar) || { attackRadius: 75, attackCooldown: 1.0 }; }
    selfSnap() { return this.snap && this.snap.players.find(p => p.id === this.id); }

    move(dir, speed) {
      if (!dir.x && !dir.y) return false;
      const step = speed * DT;
      if (this.hug > 0) this.hug--;
      const tryStep = (d) => {
        const nx = clmp(this.bx + d.x * step, 20, this.map.w - 20);
        const ny = clmp(this.by + d.y * step, 20, this.map.h - 20);
        if (blocked(nx, ny)) return false;
        this.bx = nx; this.by = ny; this.facing = d; return true;
      };
      // Straight ahead is clear → take it and drop any wall-follow.
      if (tryStep(dir)) { this.hug = 0; return true; }
      // Blocked: commit to following the wall on the roomier side for a few
      // ticks (hysteresis) so we detour around it instead of oscillating.
      if (this.hug <= 0) this.hugSide = this.clearer(dir, step);
      for (const side of [this.hugSide, -this.hugSide]) {
        for (const a of [45, 70, 95, 120, 145]) {
          if (tryStep(rot(dir, side * a))) { this.hug = 10; this.hugSide = side; return true; }
        }
      }
      return false; // fully boxed in this tick
    }
    // Which turn direction (+1 / -1) has more open room ahead of a blocked path.
    clearer(dir, step) {
      const run = (side) => {
        const d = rot(dir, side * 75); let n = 0;
        for (let k = 1; k <= 5; k++) { if (blocked(this.bx + d.x * step * k, this.by + d.y * step * k)) break; n++; }
        return n;
      };
      return run(1) >= run(-1) ? 1 : -1;
    }
    // Path-follow toward (tx,ty): A* around walls, then local move() per step.
    navTo(tx, ty, speed, now) {
      if (!this.pathTgt || hyp(this.pathTgt.x - tx, this.pathTgt.y - ty) > 60 || now > this.repathAt || !this.path) {
        this.path = findPath(this.bx, this.by, tx, ty);
        this.pathI = 0; this.pathTgt = { x: tx, y: ty }; this.repathAt = now + 700;
      }
      if (!this.path || !this.path.length) { this.move(norm(tx - this.bx, ty - this.by), speed); return; }
      // Advance past waypoints we've reached or can see straight to.
      while (this.pathI < this.path.length - 1 &&
             (hyp(this.path[this.pathI].x - this.bx, this.path[this.pathI].y - this.by) < CELL * 0.8 ||
              lineOpen(this.bx, this.by, this.path[this.pathI + 1].x, this.path[this.pathI + 1].y)))
        this.pathI++;
      const wp = this.path[Math.min(this.pathI, this.path.length - 1)];
      this.move(norm(wp.x - this.bx, wp.y - this.by), speed);
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
      if (!this.playing || !this.alive || !this.snap) return;
      if (now < this.stunUntil) { this.sendPos(); return; }
      // Anti-stuck: if we've barely moved while trying to navigate, force a re-path.
      if (!this._mv || now - this._mv.at > 1500) {
        if (this._mv && hyp(this.bx - this._mv.x, this.by - this._mv.y) < 24) { this.path = null; this.repathAt = 0; this.hug = 0; }
        this._mv = { x: this.bx, y: this.by, at: now };
      }
      const role = this.role || (this.roster.get(this.id) || {}).role;
      if (role === "killer") this.thinkKiller(now); else this.thinkSurvivor(now);
      this.sendPos();
    }

    thinkKiller(now) {
      const survs = this.snap.players.filter(p => (this.roster.get(p.id) || {}).role === "survivor" && p.alive);
      if (!survs.length) return;
      let t = survs[0], best = 1e9;
      for (const s of survs) { const d = hyp(s.x - this.bx, s.y - this.by); if (d < best) { best = d; t = s; } }
      const dir = norm(t.x - this.bx, t.y - this.by);
      const ks = this.killerStats();
      this.navTo(t.x, t.y, KILL_SPEED * SPRINT, now);
      if (best <= (ks.attackRadius || 75) * 0.95 && now >= this.nextAttack) {
        this.emit({ type: "attack" });
        this.nextAttack = now + (ks.attackCooldown || 1) * 1000;
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
      let injured = null, injBest = 1e9;
      for (const a of allies) if (a.hp != null && a.hp < 70) { const d = hyp(a.x - this.bx, a.y - this.by); if (d < injBest) { injBest = d; injured = a; } }

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

  return { start };
})();
