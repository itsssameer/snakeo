# Snakeo

A multiplayer slither.io-style snake game with split-screen, hazards, gold orbs, and hunter bots.

## Run locally

```
npm install
npm start
```

Open http://localhost:3000

## Modes

- **Solo** — mouse to steer, click or **Space** to boost
- **2 Players (split-screen)** — Player 1: **A / D / W** · Player 2: **← / → / ↑**
- **Phone (touch)** — drag anywhere to steer, tap the **⚡** button to boost

Both modes share the same arena with bots and any networked players.

## Play from a phone

The same client works on a phone — drag to steer, tap **⚡** to boost. Two ways to get there:

- **Same Wi-Fi (testing):** when you start the server, it prints a `Phone on the same Wi-Fi: http://<ip>:3000` line. Open that on your phone.
- **From anywhere (cousins on cellular):** deploy to Render (instructions below) and share the public URL.

The split-screen 2P mode is keyboard-only and intended for desktop, so phones default to solo. They still play in the same arena as everyone else.

## Twists vs vanilla slither.io

- **Spinning red mines** scattered around the arena — touch and you die
- **Gold orbs** (rare) are worth 5x growth
- **Hunter bots** (red ☠) actively chase the longest player and boost when close
- **Death drops scale with size** — kill a long snake for a feast

## Play online (so your cousins can join from their phones)

The game uses Socket.IO over WebSocket for the real-time loop. **Vercel does not host persistent WebSocket servers** (their functions are stateless and end after each request), so the game can't run on Vercel alone. Use a host that supports long-running Node processes — **Render.com** has a free tier and is the simplest path.

### Deploy to Render in 2 minutes

1. Push this folder to a GitHub repo
2. Open https://render.com → **New +** → **Web Service**
3. Connect the repo. Render auto-detects Node and reads `render.yaml`
4. Click **Create Web Service**
5. ~2 minutes later, your URL is live: `https://<name>.onrender.com`
6. Share that URL — anyone on any device can join

The free tier sleeps after 15 minutes of inactivity (first request after that takes ~30 s to wake). For always-on play, upgrade the service or use Fly.io / Railway.

### Other Node hosts that work the same way

- **Railway.app** — connect GitHub, click deploy
- **Fly.io** — `fly launch && fly deploy` (always-on free tier with credit card)
- **Glitch.com** — paste/import the project, instant URL
- A `Dockerfile` is included if your host needs it

### About Vercel

If you really want Vercel: deploy the `public/` folder there as static hosting, then point the client at a Render server URL by changing the top of `public/game.js` from `const socket = io();` to `const socket = io('https://your-render-url.onrender.com');`. CORS is already enabled on the server.

## Controls cheat sheet

| Action | Solo | 2P · Player 1 | 2P · Player 2 |
|---|---|---|---|
| Steer | mouse | A / D | ← / → |
| Boost (drains length) | Space / click | W or LShift | ↑ or RShift |
| Respawn after death | Space / Enter | W | ↑ |

## Files

- `server.js` — authoritative game server (30 Hz tick, rope-drag chain physics, hazards, hunter AI)
- `public/game.js` — canvas renderer with split-screen viewports and snapshot interpolation
- `public/index.html`, `public/style.css` — menu, HUD, death overlays
- `render.yaml`, `Dockerfile` — deployment configs
