# Repository Guidelines

This project is a minimal Cloudflare Worker + Durable Objects backend with static client files for a “Streamer vs. Chat Zombies” arena. Use this guide to navigate, develop, and contribute efficiently.

## Project Structure & Module Organization
- `src/worker.ts` — Worker entry (routes `/create`, `/ws/:room`).
- `src/room.ts` — Durable Object logic and game loop.
- `public/` — Static client: `streamer.html`, `join.html`, `common.js`, `styles.css`.
- `wrangler.toml` — Worker config, DO binding, migrations, assets.
- `README.md` — Run and deploy notes.

## Build, Test, and Development Commands
- `npx wrangler dev` — Run local dev server with DO and assets.
- `npx wrangler deploy` — Deploy to Cloudflare.
- Optional: `npm i -D wrangler` then `wrangler dev/deploy` via PATH.

## Coding Style & Naming Conventions
- Language: TypeScript for Worker/DO; plain JS/HTML/CSS for `public`.
- Indentation: 2 spaces; keep lines concise and explicit.
- Naming: TypeScript uses `camelCase` for vars/functions, `PascalCase` for classes (e.g., `RoomDO`). Static files use kebab-case (e.g., `streamer.html`).
- Imports: prefer relative module paths within `src`.
- Keep Worker code side-effect–free on import; initialize within handlers/constructors.

## Testing Guidelines
- No formal test harness included. Validate via `wrangler dev` and manual flows:
  - Open `http://127.0.0.1:8787/streamer.html` ? Create Room.
  - Join with `public/join.html?room=XXXXXX` in another tab.
- If adding tests, colocate under `src/__tests__/` and use a lightweight runner (e.g., `vitest`) without changing runtime behavior.

## Commit & Pull Request Guidelines
- Commits: concise imperative subject, scoped changes (e.g., `room: cap zombies at 100`).
- PRs: include purpose, screenshots/GIFs for UI changes, and steps to validate with `wrangler dev`. Link related issues and note any config changes in `wrangler.toml`.

## Security & Configuration Tips
- `wrangler.toml` contains `ROOMS` Durable Object binding and `TARKOV_NAMES` sample names. Add secrets via `wrangler secret put NAME` (do not commit secrets).
- Expose only `/create` and `/ws/*` from the Worker; serve `public/` via Pages or Worker assets.
- Sanitize/validate inputs in `room.ts`; keep server authoritative state and tick rate conservative.

## Architecture Overview
- Worker handles HTTP routes and WebSocket upgrades; a Room Durable Object instance owns room state and broadcasts at ~20Hz. Static pages connect to `/ws/:room` and render client controls.