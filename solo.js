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

  const rnd  = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const hyp  = (dx, dy) => Math.hypot(dx, dy);
  const norm = (dx, dy) => { const d = hyp(dx, dy) || 1; return { x: dx / d, y: dy / d }; };

  let G, onMessage, bots = [], aiTimer = null;

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
      this.bx = Math.max(20, Math.min(this.map.w - 20, this.bx + dir.x * speed * DT));
      this.by = Math.max(20, Math.min(this.map.h - 20, this.by + dir.y * speed * DT));
      if (dir.x || dir.y) this.facing = dir;
    }
    sendPos() { this.emit({ type: "pos", x: this.bx, y: this.by, facing: this.facing }); }
    useAbility(slot, ab, now, aim) {
      if (now < this.nextUse[slot]) return false;
      if (aim) this.facing = aim;
      this.emit({ type: "ability", slot, aim: aim || this.facing });
      this.nextUse[slot] = now + (ab.cd || 5) * 1000;
      return true;
    }

    think(now) {
      if (!this.playing || !this.alive || !this.snap) return;
      if (now < this.stunUntil) { this.sendPos(); return; }
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
      this.move(dir, KILL_SPEED * SPRINT);
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
      // If an ally is hurt and safe-ish, drift toward them to lend support.
      if (injured && injBest > 120 && dK > 360) {
        this.move(norm(injured.x - this.bx, injured.y - this.by), SURV_SPEED);
        return;
      }
      const todo = this.gens.map((g, i) => ({ ...g, i })).filter(g => !g.done);
      if (!todo.length) {                            // all gens done: regroup near center
        this.move(norm(this.map.w / 2 - this.bx, this.map.h - 220 - this.by), SURV_SPEED);
        return;
      }
      todo.sort((a, b) => hyp(a.x - this.bx, a.y - this.by) - hyp(b.x - this.bx, b.y - this.by));
      const g = todo[(this.index - 1) % todo.length]; // fan bots out across gens
      const dg = hyp(g.x - this.bx, g.y - this.by);
      if (dg > 78) {
        this.move(norm(g.x - this.bx, g.y - this.by), SURV_SPEED * (dg > 320 ? SPRINT : 1));
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
