// anim-fx.js — SNAPSHOT of Forsnaken's sprite-animation FX, extracted verbatim
// from index.html so the art tool's Test preview animates exactly like the game.
// Contains the timing constants, the ABILITY_FX registry (per-ability squash/
// stretch transforms + pre/post particle effects), and the default action
// transform. If the game's animations change, re-extract this file.
(function () {
  const WALK_FRAME_MS = 180, ACTION_HOLD_MS = 320, SPRITE_SIZE = 44;

const ABILITY_FX = {
  // -------- Survivor abilities --------
  "runner:dash": {
    transform: (t) => ({ actScaleX: 1.15, actScaleY: 0.90, leanPx: 8 * t }),
    pre: (ctx, p, t, dir) => {
      const fade = 1 - t;
      for (let i = 0; i < 5; i++) {
        const off = -10 * dir - i * 8 * dir;
        ctx.fillStyle = `rgba(255,128,180,${(fade * (1 - i * 0.18)).toFixed(2)})`;
        ctx.fillRect(p.x + off, p.y - 8 + i, 6, 2);
        ctx.fillRect(p.x + off, p.y + 4 - i, 6, 2);
      }
    },
  },
  "runner:smoke": {
    transform: (t) => ({ actScaleX: 1.05, leanPx: 4 * t }),
    post: (ctx, p, t, dir) => {
      // Hand-thrown canister flying forward.
      const cx = p.x + dir * (12 + 30 * t);
      const cy = p.y - 8 - 6 * Math.sin(t * Math.PI);
      ctx.fillStyle = "#a0a0b4"; ctx.fillRect(cx - 3, cy - 2, 6, 4);
      ctx.fillStyle = "#5a5a6a"; ctx.fillRect(cx - 3, cy + 1, 6, 1);
      ctx.fillStyle = `rgba(220,220,230,${(0.6 * (1 - t)).toFixed(2)})`;
      ctx.fillRect(cx - dir * 6, cy - 1, 4, 3);
    },
  },
  "engineer:shield": {
    transform: () => ({}),
    post: (ctx, p, t, dir) => {
      // Hex-shape cyan shield bubble pulses around the body.
      const r = 26 + Math.sin(t * Math.PI * 3) * 1.5;
      ctx.save();
      ctx.strokeStyle = `rgba(120,220,255,${(0.85 * (1 - t * 0.4)).toFixed(2)})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let i = 0; i <= 6; i++) {
        const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
        const x = p.x + Math.cos(a) * r;
        const y = p.y + Math.sin(a) * r;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.fillStyle = `rgba(120,220,255,${(0.12 * (1 - t)).toFixed(2)})`;
      ctx.fill();
      ctx.restore();
    },
  },
  "engineer:robot": {
    // Bent-over build pose during the channel intro.
    transform: () => ({ actScaleX: 1.08, actScaleY: 0.82, leanPx: 0, bobPx: 3 }),
    post: (ctx, p, t, dir) => {
      // Yellow welding sparks at the hand position.
      const hx = p.x + dir * 12, hy = p.y + 6;
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI - Math.PI / 2;
        const r = 4 + (i % 2) * 4 + Math.sin(t * 12 + i) * 2;
        ctx.fillStyle = (i % 2) ? "#fff7a0" : "#ffb060";
        ctx.fillRect(hx + Math.cos(a) * r - 1, hy + Math.sin(a) * r - 1, 2, 2);
      }
      ctx.fillStyle = `rgba(255,200,80,${(0.9 - t).toFixed(2)})`;
      ctx.fillRect(hx - 2, hy - 2, 4, 4);
    },
  },
  "scout:rally": {
    transform: (t) => ({ actScaleY: 1 + 0.06 * Math.sin(t * Math.PI * 2), leanPx: 0 }),
    pre: (ctx, p, t) => {
      const r = 8 + t * 60;
      ctx.strokeStyle = `rgba(255,210,90,${(1 - t).toFixed(2)})`;
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(p.x, p.y + 6, r, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = `rgba(255,160,40,${(0.6 * (1 - t)).toFixed(2)})`;
      ctx.beginPath(); ctx.arc(p.x, p.y + 6, r * 0.55, 0, Math.PI * 2); ctx.stroke();
    },
  },
  "scout:scan": {
    transform: () => ({}),
    post: (ctx, p, t) => {
      // Blue radar ping concentric pulses.
      for (let i = 0; i < 3; i++) {
        const tt = (t + i * 0.33) % 1;
        ctx.strokeStyle = `rgba(120,200,255,${(1 - tt).toFixed(2)})`;
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(p.x, p.y, 8 + tt * 40, 0, Math.PI * 2); ctx.stroke();
      }
    },
  },
  "sentinel:burst": {
    transform: (t) => ({ actScaleX: 1 - 0.1 * Math.sin(t * Math.PI) }),
    pre: (ctx, p, t) => {
      // Frost shards exploding outward.
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        const r = 10 + t * 60;
        const fx = p.x + Math.cos(a) * r;
        const fy = p.y + Math.sin(a) * r;
        ctx.fillStyle = `rgba(180,230,255,${(1 - t).toFixed(2)})`;
        ctx.fillRect(fx - 2, fy - 2, 4, 4);
        ctx.fillStyle = `rgba(220,240,255,${(0.7 * (1 - t)).toFixed(2)})`;
        ctx.fillRect(fx - 1, fy - 1, 2, 2);
      }
    },
  },
  "sentinel:field": {
    transform: () => ({ actScaleY: 0.96 }),
    pre: (ctx, p, t) => {
      // Ice mist swirling around the feet.
      for (let i = 0; i < 5; i++) {
        const a = t * Math.PI * 2 + i * (Math.PI * 2 / 5);
        const fx = p.x + Math.cos(a) * 14;
        const fy = p.y + 12 + Math.sin(a) * 4;
        ctx.fillStyle = `rgba(170,220,250,${(0.65 - t * 0.4).toFixed(2)})`;
        ctx.fillRect(fx - 2, fy - 2, 4, 4);
      }
    },
  },
  "fencer:slash": {
    transform: (t) => ({ actScaleX: 1 + 0.20 * Math.sin(t * Math.PI), leanPx: 8 * Math.sin(t * Math.PI) }),
    post: (ctx, p, t, dir) => {
      // Long white slash arc in the facing direction.
      const cx = p.x + dir * 20, cy = p.y - 4;
      ctx.save();
      ctx.strokeStyle = `rgba(255,255,255,${(1 - t).toFixed(2)})`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(cx, cy, 24, -Math.PI * 0.4 - t * 0.4, Math.PI * 0.4 + t * 0.4);
      ctx.stroke();
      ctx.restore();
    },
  },
  "kacey:burger": {
    transform: (t) => ({ leanPx: 4 * Math.sin(t * Math.PI) }),
    post: (ctx, p, t, dir) => {
      // Trail of crumbs flying forward.
      for (let i = 0; i < 4; i++) {
        const off = dir * (15 + i * 8 + t * 16);
        ctx.fillStyle = `rgba(255,200,120,${(0.9 - i * 0.18 - t).toFixed(2)})`;
        ctx.fillRect(p.x + off, p.y - 6 + (i % 2) * 4, 3, 3);
      }
    },
  },
  "sniper:shoot": {
    transform: (t) => ({ actScaleX: 0.94, leanPx: -3 + 8 * t }),
    post: (ctx, p, t, dir) => {
      // Bright muzzle flash + smoke at the rifle tip.
      const mx = p.x + dir * 22, my = p.y - 2;
      const flash = 1 - t;
      ctx.fillStyle = `rgba(255,240,160,${flash.toFixed(2)})`;
      ctx.fillRect(mx - 2, my - 4, 4, 8);
      ctx.fillRect(mx + dir * 2, my - 2, 6, 4);
      ctx.fillStyle = `rgba(255,180,80,${(flash * 0.8).toFixed(2)})`;
      ctx.fillRect(mx + dir * 4, my - 1, 4, 2);
      ctx.fillStyle = `rgba(220,220,220,${(t * 0.6).toFixed(2)})`;
      ctx.fillRect(mx + dir * (6 + t * 8), my - 2, 4, 4);
    },
  },
  "sniper:sneak": {
    transform: () => ({}),
    post: (ctx, p, t) => {
      // Purple ghost ripple radiating out.
      const r = 8 + t * 24;
      ctx.strokeStyle = `rgba(160,80,220,${(1 - t).toFixed(2)})`;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.stroke();
    },
  },
  "pollen:breathe": {
    transform: (t) => ({ actScaleY: 1 + 0.08 * Math.sin(t * Math.PI), actScaleX: 1 - 0.04 * Math.sin(t * Math.PI) }),
    post: (ctx, p, t) => {
      // Green leaf-puff curling up around Pollen as she breathes in.
      for (let i = 0; i < 8; i++) {
        const a = t * Math.PI * 2 + i * (Math.PI / 4);
        const r = 12 + t * 14;
        const fx = p.x + Math.cos(a) * r;
        const fy = p.y - 4 + Math.sin(a) * r * 0.7;
        ctx.fillStyle = `rgba(122,192,80,${(0.9 - t).toFixed(2)})`;
        ctx.fillRect(fx - 2, fy - 2, 4, 4);
        ctx.fillStyle = `rgba(220,240,180,${(0.7 - t).toFixed(2)})`;
        ctx.fillRect(fx - 1, fy - 1, 2, 2);
      }
    },
  },
  "pollen:heal_station": {
    // Arms wide open, head tilted up — handled visually by the channel
    // overlay below + the custom action sprite. Here we just keep the
    // sprite still and let the overlay carry the moment.
    transform: () => ({ actScaleX: 1, actScaleY: 1, leanPx: 0, bobPx: 0 }),
    post: (ctx, p, t) => {
      // Blood drops rising from Pollen's body up into the sky.
      for (let i = 0; i < 6; i++) {
        const phase = ((t * 1.5) + i / 6) % 1;
        const rise = phase * 40;
        const dx = Math.sin(phase * Math.PI * 2 + i) * 6;
        ctx.fillStyle = `rgba(180,30,40,${(1 - phase).toFixed(2)})`;
        ctx.fillRect(p.x + dx - 1, p.y - rise, 2, 3);
        ctx.fillStyle = `rgba(255,120,120,${(0.6 - phase * 0.6).toFixed(2)})`;
        ctx.fillRect(p.x + dx, p.y - rise, 1, 2);
      }
      // Green-magic motes circling overhead near the end of the channel.
      const overheadFade = Math.max(0, t - 0.3) / 0.7;
      for (let i = 0; i < 5; i++) {
        const a = t * Math.PI * 4 + i * (Math.PI * 2 / 5);
        const fx = p.x + Math.cos(a) * 14;
        const fy = p.y - 22 + Math.sin(a) * 6;
        ctx.fillStyle = `rgba(122,192,80,${(overheadFade * 0.9).toFixed(2)})`;
        ctx.fillRect(fx - 1, fy - 1, 2, 2);
      }
    },
  },
  "pollen:defence_station": {
    transform: () => ({ actScaleX: 1, actScaleY: 1, leanPx: 0, bobPx: 0 }),
    post: (ctx, p, t) => {
      // Same blood-rising sacrifice motif but blue motes overhead.
      for (let i = 0; i < 6; i++) {
        const phase = ((t * 1.5) + i / 6) % 1;
        const rise = phase * 40;
        const dx = Math.sin(phase * Math.PI * 2 + i) * 6;
        ctx.fillStyle = `rgba(180,30,40,${(1 - phase).toFixed(2)})`;
        ctx.fillRect(p.x + dx - 1, p.y - rise, 2, 3);
      }
      const overheadFade = Math.max(0, t - 0.3) / 0.7;
      for (let i = 0; i < 5; i++) {
        const a = t * Math.PI * 4 + i * (Math.PI * 2 / 5);
        const fx = p.x + Math.cos(a) * 14;
        const fy = p.y - 22 + Math.sin(a) * 6;
        ctx.fillStyle = `rgba(120,180,255,${(overheadFade * 0.9).toFixed(2)})`;
        ctx.fillRect(fx - 1, fy - 1, 2, 2);
      }
    },
  },
  "angel:stab": {
    // Forward lunge + extended dagger thrust.
    transform: (t) => ({ actScaleX: 1.25, actScaleY: 0.88, leanPx: 12 * Math.sin(t * Math.PI) }),
    post: (ctx, p, t, dir) => {
      const ext = 14 + 16 * Math.sin(t * Math.PI);
      const dx = p.x + dir * ext, dy = p.y - 2;
      ctx.fillStyle = "#cccccc"; ctx.fillRect(dx - 2, dy - 1, 4, 3);
      ctx.fillStyle = "#ffffff"; ctx.fillRect(dx - 2, dy - 1, 4, 1);
      // Trailing motion streak.
      ctx.fillStyle = `rgba(176,112,255,${(0.7 * (1 - t)).toFixed(2)})`;
      ctx.fillRect(p.x + dir * 8, dy, dir * (ext - 8), 1);
    },
  },
  "angel:spawner": {
    transform: () => ({ actScaleY: 0.85, bobPx: 4 }),
    pre: (ctx, p, t) => {
      const r = 6 + t * 22;
      ctx.fillStyle = `rgba(176,112,255,${(0.6 * (1 - t)).toFixed(2)})`;
      ctx.beginPath(); ctx.arc(p.x, p.y + 14, r, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = `rgba(224,200,255,${(1 - t).toFixed(2)})`;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(p.x, p.y + 14, r, 0, Math.PI * 2); ctx.stroke();
    },
  },
  // -------- Killer abilities --------
  "slasher:throw": {
    transform: (t) => ({ leanPx: 6 * Math.sin(t * Math.PI), actScaleX: 1.1 }),
    post: (ctx, p, t, dir) => {
      // Spinning knife forward.
      const ox = p.x + dir * (16 + 24 * t);
      ctx.save();
      ctx.translate(ox, p.y - 4);
      ctx.rotate(t * Math.PI * 4 * dir);
      ctx.fillStyle = "#dddddd"; ctx.fillRect(-1, -6, 2, 8);
      ctx.fillStyle = "#7a5524"; ctx.fillRect(-2, 2, 4, 2);
      ctx.restore();
    },
  },
  "slasher:frenzy": {
    transform: (t) => ({ actScaleX: 1.06, leanPx: 4 }),
    pre: (ctx, p, t) => {
      // Red speed aura.
      const r = 22 + Math.sin(t * 12) * 3;
      ctx.fillStyle = `rgba(233,69,96,${(0.35 * (1 - t * 0.5)).toFixed(2)})`;
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill();
    },
  },
  "stalker:step": {
    transform: () => ({}),
    pre: (ctx, p, t, dir) => {
      // Black ghost trail behind.
      for (let i = 0; i < 4; i++) {
        const ox = -dir * (8 + i * 10);
        ctx.fillStyle = `rgba(20,10,30,${(0.6 * (1 - i * 0.22) * (1 - t)).toFixed(2)})`;
        ctx.fillRect(p.x + ox - 6, p.y - 14, 12, 28);
      }
    },
  },
  "stalker:stalk": {
    transform: () => ({}),
    pre: (ctx, p, t) => {
      // Dark purple aura buildup around the killer.
      const r = 18 + t * 14;
      ctx.fillStyle = `rgba(80,20,120,${(0.45 * (1 - t)).toFixed(2)})`;
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = `rgba(180,80,220,${(0.8 * (1 - t)).toFixed(2)})`;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.stroke();
    },
  },
  "lunar:build_portal": {
    transform: () => ({ actScaleY: 0.94, bobPx: 2 }),
    post: (ctx, p, t) => {
      // Two counter-rotating purple swirls above the killer.
      for (let s = 0; s < 2; s++) {
        const dirS = s ? 1 : -1;
        for (let i = 0; i < 6; i++) {
          const a = t * Math.PI * 4 * dirS + i * (Math.PI / 3);
          const r = 14 + i * 1.5;
          const fx = p.x + Math.cos(a) * r;
          const fy = p.y - 14 + Math.sin(a) * r * 0.6;
          ctx.fillStyle = `rgba(160,100,240,${(0.8 - i * 0.1).toFixed(2)})`;
          ctx.fillRect(fx - 1, fy - 1, 2, 2);
        }
      }
    },
  },
  "lunar:dash": {
    transform: (t) => ({ actScaleX: 1.15, leanPx: 10 * t }),
    pre: (ctx, p, t, dir) => {
      for (let i = 0; i < 5; i++) {
        const off = -dir * (10 + i * 10);
        ctx.fillStyle = `rgba(160,100,240,${(0.85 * (1 - t) * (1 - i * 0.18)).toFixed(2)})`;
        ctx.fillRect(p.x + off, p.y - 6 + i * 2, 8, 2);
      }
    },
  },
  "sly:transform": {
    transform: (t) => ({ actScaleX: 1 + 0.15 * Math.sin(t * Math.PI * 4),
                          actScaleY: 1 + 0.15 * Math.sin(t * Math.PI * 4 + 1) }),
    post: (ctx, p, t) => {
      // Bright pulsing transformation aura.
      const r = 12 + Math.sin(t * Math.PI * 6) * 6 + t * 16;
      ctx.fillStyle = `rgba(120,255,140,${(0.55 * (1 - t)).toFixed(2)})`;
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = `rgba(220,255,200,${(1 - t).toFixed(2)})`;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.stroke();
    },
  },
  // -------- Killer basic attacks --------
  "slasher:attack": {
    transform: (t) => ({ actScaleX: 1.1, leanPx: 6 * Math.sin(t * Math.PI) }),
    post: (ctx, p, t, dir) => {
      // White slash arc.
      ctx.save();
      ctx.strokeStyle = `rgba(255,255,255,${(1 - t).toFixed(2)})`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(p.x + dir * 14, p.y - 2, 16, -Math.PI * 0.5, Math.PI * 0.5);
      ctx.stroke();
      ctx.restore();
    },
  },
  "stalker:attack": {
    transform: (t) => ({ actScaleX: 1.1, leanPx: 6 * Math.sin(t * Math.PI) }),
    post: (ctx, p, t, dir) => {
      // Three claw rake marks in red.
      for (let i = 0; i < 3; i++) {
        const off = -8 + i * 8;
        ctx.fillStyle = `rgba(233,69,96,${(0.9 - i * 0.1 - t).toFixed(2)})`;
        ctx.fillRect(p.x + dir * (16 + i * 4), p.y + off, dir * 14, 2);
      }
    },
  },
  "lunar:attack": {
    transform: (t) => ({ actScaleX: 1.12, leanPx: 8 * Math.sin(t * Math.PI) }),
    post: (ctx, p, t, dir) => {
      // Purple punch shockwave.
      const fx = p.x + dir * 22, fy = p.y - 2;
      const r = 8 + t * 12;
      ctx.fillStyle = `rgba(160,100,240,${(0.7 * (1 - t)).toFixed(2)})`;
      ctx.beginPath(); ctx.arc(fx, fy, r, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = `rgba(220,180,255,${(1 - t).toFixed(2)})`;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(fx, fy, r, 0, Math.PI * 2); ctx.stroke();
    },
  },
  "sly_dino:attack": {
    transform: (t) => ({ actScaleX: 1.18, actScaleY: 0.9, leanPx: 14 * Math.sin(t * Math.PI) }),
    post: (ctx, p, t, dir) => {
      // Big chomp jaws — pair of triangular flashes.
      const fx = p.x + dir * 40, fy = p.y - 10;
      const open = Math.sin(t * Math.PI) * 16;
      ctx.fillStyle = `rgba(255,255,255,${(1 - t * 0.4).toFixed(2)})`;
      ctx.fillRect(fx, fy - open / 2, 18, 3);
      ctx.fillRect(fx, fy + open / 2, 18, 3);
    },
  },
};

  function fxFor(charId, actionAb) { return ABILITY_FX[charId + ":" + actionAb] || null; }

  // Default 3-phase squash/stretch (verbatim from drawPlayer's default branch).
  function defaultTransform(t) {
    let actScaleX = 1, actScaleY = 1, leanPx = 0;
    if (t < 0.22) {
      const k = t / 0.22;
      actScaleX = 1 - 0.10 * k; actScaleY = 1 + 0.08 * k; leanPx = -3 * k;
    } else if (t < 0.60) {
      const k = (t - 0.22) / 0.38; const ease = 1 - Math.pow(1 - k, 2);
      actScaleX = 0.90 + 0.30 * ease; actScaleY = 1.08 - 0.20 * ease; leanPx = -3 + 8 * ease;
    } else {
      const k = (t - 0.60) / 0.40; const ease = 1 - Math.pow(1 - k, 3);
      actScaleX = 1.20 - 0.20 * ease; actScaleY = 0.88 + 0.12 * ease; leanPx = 5 - 5 * ease;
    }
    return { actScaleX, actScaleY, leanPx, bobPx: 0, swayRad: 0 };
  }

  window.ForsakenAnim = { WALK_FRAME_MS, ACTION_HOLD_MS, SPRITE_SIZE, ABILITY_FX, fxFor, defaultTransform };
})();
