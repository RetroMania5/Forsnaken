# Forsaken — browser edition

1-killer-vs-survivors party game. Top-down 2D, plays on **desktop and phones**, friends just open a link — no installs.

- **WASD** + **Shift** + **E** (interact) + **Q** (attack) on desktop
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

Open `http://localhost:8080`. First person to join becomes host; everyone who joins after lands in the same lobby. Host clicks **Start Round**.

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
1. Push this folder to a GitHub repo (or use Render's "Public Git Repository" option).
2. Sign up at **render.com** (free).
3. **New → Web Service**.
4. Build command: `npm install`
5. Start command: `npm start`
6. Instance type: **Free**.
7. Render gives you a `https://<name>.onrender.com` URL. Share that.
8. Free tier sleeps after ~15 min of no traffic; first visitor waits ~30s to wake it. Fine for friend hangouts.

Glitch (glitch.com) and Railway work similarly.

## How a round goes

- Host clicks Start. Roles are randomized: **1 killer, the rest survivors**.
- **Survivors:** repair all 4 generators by standing near one and holding the interact (E or hold the button). Multiple survivors on one gen = faster.
- All 4 generators done → **exit unlocks** (top of map). Walk into it and press interact/escape to win.
- **Killer:** chase survivors, attack with Q (or tap the red button) when within ~70 px. Downed survivors are out for the round.
- Round ends when every survivor is either escaped or down. Lobby returns automatically after 5 seconds.

## Project layout

```
forsaken-web/
├── server.js     # Node + ws. Authoritative state, 20 Hz broadcast.
├── index.html    # Single-file client: canvas render, input, UI, WS.
├── package.json
└── README.md
```

Both files are short and meant to be hacked on.

## Tweak it

In `server.js`:
- `GEN_TIME` — seconds per generator (one worker)
- `ATTACK_RADIUS`, `ESCAPE_RADIUS`
- `MAP`, `EXIT`, `GEN_POSITIONS` — geometry. If you change these, also change them in `index.html` so the visual matches.

In `index.html`:
- `SURV_SPEED`, `KILL_SPEED`, `SPRINT` — feel.
- `WALLS` — layout. Must stay roughly in sync with the visual on server (server doesn't simulate walls; it just clamps you to map bounds).

## Limits & honest caveats

- **Movement is client-authoritative.** Each player tells the server where they are. Fine for friends; would need server-side movement simulation to be tamper-proof.
- Attack / escape / generator completion **are server-authoritative**, so the worst a cheater can do is teleport themselves.
- One room only (the whole server is one game). Adding room codes is a few hours of work.
- Up to ~8 players is comfortable.

Have fun.
