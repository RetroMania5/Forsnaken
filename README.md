# Forsaken — browser edition

1-killer-vs-survivors party game inspired by Forsaken. Top-down 2D, plays on **desktop and phones**, friends just open a link — no installs.

- **WASD** + **Shift** (sprint) + **E** (skill check) + **Q** (attack — killer) on desktop
- **Virtual joystick** + **context button** on mobile (auto-sprint when moving)

## One-time setup: install Node.js

The server is Node.js. If you don't have it:

- **macOS (Homebrew):** `brew install node`
- **Or download:** https://nodejs.org/ (pick LTS, ~30 MB installer)

Verify: `node --version` should print v18 or higher.

## Run it locally

```bash
cd forsaken-web
npm install
npm start
```

Open `http://localhost:8080`. First person to join becomes host; everyone who joins after lands in the same lobby. Host designates a killer, then clicks **Start Round**.

To play with friends on the same machine for testing, open multiple browser windows / incognito tabs.

## Play with friends — three free options

### 1) Local network only (same WiFi, $0)
1. Run `npm start` on your computer.
2. Find your local IP (`ipconfig getifaddr en0` on macOS).
3. Friends on the same WiFi open `http://<your-ip>:8080`.

### 2) Cloudflare Tunnel (over the internet, $0, no signup needed)
1. Run `npm start`.
2. Install: `brew install cloudflared`
3. Run: `cloudflared tunnel --url http://localhost:8080`
4. Cloudflare prints a temporary `https://<random>.trycloudflare.com` URL. Share that.
5. Tunnel works as long as your computer is running. Free, no account.

### 3) Deploy to Render (always-on-ish, $0, no credit card)
1. Push this folder to a GitHub repo.
2. Sign up at **render.com** (free).
3. **New → Web Service**, pick the repo.
4. Build command: `npm install`
5. Start command: `npm start`
6. Instance type: **Free**.
7. Render gives you a `https://<name>.onrender.com` URL. Share that.
8. Free tier sleeps after ~15 min of no traffic; first visitor waits ~30s to wake it. Fine for friend hangouts.

Pushing a new commit to GitHub triggers an auto-redeploy (~2 min).

Glitch (glitch.com) and Railway work similarly.

## How a round goes

### Lobby
- Each player picks a **survivor character** and a **killer character**. Stats:
  - **Runner** — +10% speed
  - **Engineer** — +30% repair contribution
  - **Scout** — balanced (small bonuses to both)
  - **Slasher** — balanced reach (70 px attack)
  - **Stalker** — long reach (110 px), 8% slower
- The host **taps on a player's row** to designate them as the killer. Tap again to un-designate. The chosen killer plays as their picked killer character; everyone else plays as their picked survivor.
- Start Round is greyed out until a killer is set **and** there are 2+ players.

### Match
- A countdown timer starts at **3:00**. Reaching 0:00 = **survivors win** (they outlasted).
- **Survivors:** stand near a generator → a rotating-arrow **skill check dial** appears at the bottom of the screen. **Press E (or tap FIX)** when the pointer is in the green wedge.
  - **Green hit:** +22% progress (× the Engineer bonus if you're playing one).
  - **Yellow hit:** +10% progress, no penalty.
  - **Red hit:** −12% progress and a brief cooldown.
  - ~5 well-timed greens to finish one generator.
  - Multiple survivors on the same gen each get their own dial — more workers = faster.
- **Each generator completed subtracts 30 seconds from the timer** (rushes the survivor win).
- **Killer:** chase survivors. **Press Q (or tap ATK)** when within attack radius to down them. Downed survivors are out for the round.
- **Each downed survivor adds 25 seconds to the timer** (gives the killer more hunt time).
- **All survivors downed → killer wins immediately**, regardless of the timer.

### End of round
- Win banner shows for 5 seconds, then everyone returns to the lobby with their character picks intact. Host re-designates a killer for the next round.

## Project layout

```
forsaken-web/
├── server.js     # Node + ws. Authoritative for state, timer, generators, attacks.
├── index.html    # Single-file client: canvas render, input, UI, WS.
├── package.json
└── README.md
```

Both files are short and meant to be hacked on.

## Tweak it

All in `server.js` near the top:

| Constant | Default | Effect |
|---|---|---|
| `ROUND_DURATION` | `180` | Starting timer in seconds. |
| `TIME_PER_GEN` | `-30` | Time delta when a generator is completed. Negative = subtracts (helps survivors). |
| `TIME_PER_DOWN` | `+25` | Time delta when a survivor is downed. Positive = adds (helps killer). |
| `SKILL_PROGRESS` | `{green:0.22, yellow:0.10, red:-0.12}` | Per-skill-check progress. |
| `SKILL_NEAR_RADIUS` | `90` | How close to a gen you need to be to attempt a check. |
| `SKILL_COOLDOWN_MS` | `400` | Server-side anti-spam rate limit. |
| `SURVIVOR_CHARS` / `KILLER_CHARS` | — | Add or rebalance characters. Each has `speedMult`, plus survivor `repairMult` or killer `attackRadius`. |
| `MAP`, `GEN_POSITIONS` | — | Geometry. If you change these, update the matching `WALLS` array in `index.html` so the visual matches. |

In `index.html`:
- `BASE_SURV_SPEED`, `BASE_KILL_SPEED`, `SPRINT_MULT` — movement feel.
- `WALLS` — interior layout. Server doesn't simulate walls; it just clamps you to map bounds, so clients are the source of truth here.
- `DIAL_GREEN`, `DIAL_YELLOW`, `DIAL_SPEED` — skill-check difficulty.

## Limits & honest caveats

- **Movement is client-authoritative.** Each player tells the server where they are. Fine for friends; would need server-side movement simulation to be tamper-proof.
- **Skill check classification is client-side.** The server validates that you're near a gen and rate-limits attempts, but it trusts your "green/yellow/red" result. A cheater could always claim green. Fine among friends; tightening this would mean putting the dial state on the server.
- Attack outcomes, generator completion, and the round timer **are server-authoritative**.
- One room only (the whole server is one game). Adding room codes is a few hours of work.
- Up to ~8 players is comfortable.

Have fun.
