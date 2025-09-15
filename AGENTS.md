# Repository Guidelines

## Project Structure & Module Organization
Source lives in `src/`: `worker.ts` handles `/create` and WebSocket upgrades, while `room.ts` runs the Durable Object loop and state. Static client assets sit under `public/` (`streamer.html`, `join.html`, `common.js`, `styles.css`). `wrangler.toml` wires bindings, Durable Object migrations, and static asset mounting. Keep any experimental scripts inside `old-working/` if you need scratch space.

## Build, Test, and Development Commands
Use `npx wrangler dev` to boot the Worker, Durable Objects, and static files at `http://127.0.0.1:8787`. Deploy with `npx wrangler deploy` once changes are validated. Run `npm install` before first use to hydrate `node_modules/`. If you prefer a global binary, `npm i -D wrangler` adds `wrangler dev` and `wrangler deploy` to your PATH.

## Coding Style & Naming Conventions
TypeScript modules use 2-space indentation, `camelCase` for variables/functions, and `PascalCase` for classes such as `RoomDO`. Keep imports relative (e.g., `./room`). Client files remain vanilla JS/HTML/CSS with kebab-case filenames. Avoid side effects during module load; initialize state inside handlers, constructors, or the game loop. Comment sparingly to clarify non-obvious logic.

## Testing Guidelines
No automated harness ships today. Validate via `npx wrangler dev`: create a room at `/streamer.html`, then join from `/join.html?room=XXXXXX` in a separate tab. If you introduce automated tests, place them under `src/__tests__/`, keep them fast, and prefer `vitest` or similarly lightweight runners.

## Commit & Pull Request Guidelines
Write commits with short imperative subjects scoped to the module (e.g., `room: cap zombies at 100`). Each PR should describe the change, outline manual validation steps, attach screenshots or GIFs for UI tweaks, and link relevant issues. Call out any updates to `wrangler.toml` or Durable Object bindings explicitly.

## Security & Configuration Tips
Do not commit secrets; configure them with `wrangler secret put NAME`. The Worker must expose only `/create` and `/ws/*`; serve `public/` through the configured assets route or Pages. Validate all room inputs in `room.ts` and keep tick rates conservative to protect CPU budgets.

## Architecture Overview
The Worker routes HTTP traffic and performs WebSocket upgrades, delegating room state to the Durable Object. Each room instance owns authoritative game state, broadcasting updates ~20 times per second. Clients subscribe via `/ws/:room` and render controls locally while the server adjudicates moves.
