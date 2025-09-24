# Cloudflare Arena Shooter

Ultra-minimal top-down arena where the **streamer** moves fast and shoots while waves of slow **zombies** pour in. Built on **Cloudflare Workers + Durable Objects** with raw **WebSockets**. Static HTML served by Pages (or any static host).

## Features

- Rooms keyed by URL (e.g. `/ws/abcd12`) with one DO instance per room.
- Streamer: WASD + mouse aim + click to shoot.
- Server-authoritative positions; 20Hz snapshots.

## Run locally

```bash
npm create cloudflare@latest . # or `npm i -D wrangler`
npx wrangler dev
```

## Deploy

```bash
npx wrangler deploy
```

## Notes

- This is intentionally minimal: no authentication, no persistence beyond DO lifetime.
- For cost/scale, consider Durable Object WebSocket hibernation and backoff reconnects.
- Security: names are sanitized; inputs are rate-limited implicitly by tick; add explicit token bucket if you expect abuse.

## Customize

- Speeds, radii, arena size in `src/room.ts`.
- Add scoreboard UI, streamer-only control panel, zombie cosmetics, etc.
