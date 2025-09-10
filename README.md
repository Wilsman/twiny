# Cloudflare Arena Shooter (Streamer vs. Chat Zombies)

Ultra-minimal top-down arena where the **streamer** moves fast and shoots; **chat** joins via a link and plays slow **zombies**. Built on **Cloudflare Workers + Durable Objects** with raw **WebSockets**. Static HTML served by Pages (or any static host).

## Features
- Rooms keyed by URL (e.g. `/ws/abcd12`) with one DO instance per room.
- Streamer: WASD + mouse aim + click to shoot.
- Chat: WASD movement as slow zombies; on touch, streamer loses 1 score.
- Server-authoritative positions; 20Hz snapshots.

## Run locally
```bash
npm create cloudflare@latest . # or `npm i -D wrangler`
wrangler dev
```
Open `http://127.0.0.1:8787/streamer.html` and click **Create Room**. Share the generated `join.html?room=XXXXXX` link.

> If serving static files from another host (e.g. Pages), ensure the Worker is reachable at the same domain (or adjust `public/*.html` to point to your Worker origin).

## Deploy
1. `wrangler deploy`
2. Host `/public` with Cloudflare Pages **or** serve them elsewhere.
3. Point your domain routes to the Worker (`/ws/*`, `/create`).

## Notes
- This is intentionally minimal: no authentication, no persistence beyond DO lifetime.
- For cost/scale, consider Durable Object WebSocket hibernation and backoff reconnects.
- Security: names are sanitized; inputs are rate-limited implicitly by tick; add explicit token bucket if you expect abuse.

## Customize
- Speeds, radii, arena size in `src/room.ts`.
- Add scoreboard UI, streamer-only control panel, zombie cosmetics, etc.

