// Minimal top-down arena shooter: one Streamer (fast marine) vs many Chat Zombies (slow).
// Server maintains authoritative positions and scores. 20Hz tick.

declare global {
  interface WebSocket {
    accept(): void;
  }
  interface ResponseInit {
    webSocket?: WebSocket;
  }
  class WebSocketPair {
    0: WebSocket;
    1: WebSocket;
  }
  interface DurableObjectState {
    // Define properties as needed
  }
}

export interface Env {
  TARKOV_NAMES: string;
}

type Vec = { x: number; y: number };

interface Input {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  shoot: boolean;
  aimX: number;
  aimY: number;
  melee?: boolean;
}

interface Player {
  id: string;
  role: "streamer" | "zombie";
  name: string;
  pos: Vec;
  vel: Vec;
  input: Input;
  ws?: WebSocket;
  score: number; // streamer uses; zombies optional
  alive: boolean;
  lastSeen: number;
  lastShotAt?: number;
  lastMeleeAt?: number;
  hp?: number; // streamer only
  maxHp?: number; // streamer only
  boostUntil?: number; // zombies temporary speed boost timestamp
  ammo?: number; // streamer ammo
  maxAmmo?: number; // streamer max ammo
  weaponBoostUntil?: number; // streamer temporary weapon buff
  emote?: string; // short emoji shown above head
  emoteUntil?: number; // expiry timestamp (ms)
  // Streamer weapons
  weapon?: "pistol" | "smg" | "shotgun" | "bat";
  pistolAmmo?: number;
  smgAmmo?: number;
  shotgunAmmo?: number;
  meleeDirX?: number;
  meleeDirY?: number;
  // Lag compensation
  lagMs?: number;
  inputBuffer?: Array<{input: Input, timestamp: number}>;
  lastInputTime?: number;
}

interface Bullet {
  id: string;
  pos: Vec;
  vel: Vec;
  ownerId: string; // streamer only in this minimal build
  ttl: number; // ms
}

interface Rect { id: string; x: number; y: number; w: number; h: number }
type PickupType = "health" | "speed" | "ammo" | "weapon" | "shield" | "magnet" | "freeze" | "blast" | "treasure";
interface Pickup { id: string; type: PickupType; x: number; y: number }

export class RoomDO {
  state: DurableObjectState;
  env: Env;

  // Game space
  W = 960; // px
  H = 540; // px

  // Entities
  players = new Map<string, Player>();
  bullets: Bullet[] = [];
  walls: Rect[] = [];
  pickups: Pickup[] = [];

  // Loop - Different tick rates for different systems
  tickMs = 50; // 20Hz - main game loop
  uiTickMs = 200; // 5Hz - UI updates
  pickupTickMs = 500; // 2Hz - pickup spawning checks
  running = false;
  loopTimer: number | undefined;
  uiTimer: number | undefined;
  pickupTimer: number | undefined;
  FIRE_COOLDOWN_MS = 180; // streamer fire cooldown
  lastPickupSpawn = Date.now();
  pickupIntervalMs = 12000; // spawn every 12s
  mapReady = false;
  roundEndTime: number | undefined;
  roundDurationMs = 5 * 60 * 1000; // 5 minutes
    // Global effects
  zombieSlowUntil: number | undefined;
  chatEnabled = true;

  // Metadata
  createdAt = Date.now();

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(req: Request) {
    if (req.headers.get("Upgrade") !== "websocket") return new Response("Expected WebSocket", { status: 426 });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    server.accept();

    // Assign a temporary id; role determined on join message
    const pid = crypto.randomUUID().slice(0, 8);

    // Track WS
    server.addEventListener("message", (ev) => this.onMessage(server, pid, ev));
    server.addEventListener("close", () => this.onClose(pid));

    // Kick off ping
    const pingIv = setInterval(() => {
      try { server.send(JSON.stringify({ type: "ping" })); } catch {}
    }, 15000);
    server.addEventListener("close", () => clearInterval(pingIv));

    // Start loop on demand
    if (!this.running) this.startLoop();
    if (!this.mapReady) this.generateMap();

    return new Response(null, { status: 101, webSocket: client });
  }

  startLoop() {
    this.running = true;
    if (!this.roundEndTime) this.roundEndTime = Date.now() + this.roundDurationMs;
    
    // Main game loop - 20Hz (includes state broadcast for responsiveness)
    const step = () => {
      this.update();
      this.broadcastState();
      this.loopTimer = setTimeout(step, this.tickMs) as unknown as number;
    };
    this.loopTimer = setTimeout(step, this.tickMs) as unknown as number;
    
    // Pickup spawning - 2Hz (non-critical)
    const pickupStep = () => {
      this.checkPickupSpawning();
      this.pickupTimer = setTimeout(pickupStep, this.pickupTickMs) as unknown as number;
    };
    this.pickupTimer = setTimeout(pickupStep, this.pickupTickMs) as unknown as number;
  }

  stopLoop() {
    if (this.loopTimer) clearTimeout(this.loopTimer as unknown as number);
    if (this.pickupTimer) clearTimeout(this.pickupTimer as unknown as number);
    this.running = false;
  }

  // Separate pickup spawning logic for reduced tick rate
  checkPickupSpawning() {
    const now = Date.now();
    if (now - this.lastPickupSpawn > this.pickupIntervalMs) {
      this.lastPickupSpawn = now;
      const totalCap = 12;
      if (this.pickups.length < totalCap) {
        const caps = { health: 3, speed: 3, ammo: 3, weapon: 2, shield: 2, magnet: 2, freeze: 1, blast: 2, treasure: 3 } as Record<PickupType, number>;
        const counts = { health:0, speed:0, ammo:0, weapon:0, shield:0, magnet:0, freeze:0, blast:0, treasure:0 } as Record<PickupType, number>;
        for (const pk of this.pickups) counts[pk.type]++;
        const types: PickupType[] = ["health","speed","ammo","weapon","shield","magnet","freeze","blast","treasure"]; 
        // Weighted pick: prefer under-cap types
        const options: PickupType[] = [];
        for (const t of types){
          const room = Math.max(0, caps[t]-counts[t]);
          for (let i=0;i<room;i++) options.push(t);
        }
        if (options.length > 0) {
          const type = options[Math.floor(Math.random()*options.length)];
          const pos = this.randomFreePos(28);
          if (pos && this.okDistanceFromPickups(pos.x, pos.y, 48)) {
            this.pickups.push({ id: crypto.randomUUID().slice(0,6), type, x: pos.x, y: pos.y });
          }
        }
      }
    }
  }

  onMessage(ws: WebSocket, pid: string, ev: MessageEvent) {
    try {
      const msg = JSON.parse(String(ev.data));
      if (!msg || typeof msg !== "object") return;
      switch (msg.type) {
        case "join_room": {
          let role: "streamer" | "zombie" = msg.role === "streamer" ? "streamer" : "zombie";
          const name = this.sanitizeName(msg.name) || this.randomName();

          // Spawn positions
          const pos = role === "streamer" ? { x: this.W / 2, y: this.H / 2 } : this.spawnZombiePos();

        const p: Player = {
          id: pid,
          role,
          name,
          pos,
          vel: { x: 0, y: 0 },
          input: { up: false, down: false, left: false, right: false, shoot: false, aimX: 0, aimY: 0, melee: false },
          ws,
          score: 0,
          alive: true,
          lastSeen: Date.now(),
          hp: role === "streamer" ? 100 : undefined,
          maxHp: role === "streamer" ? 100 : undefined,
          weapon: role === "streamer" ? "pistol" : undefined,
          pistolAmmo: role === "streamer" ? 60 : undefined,
          smgAmmo: role === "streamer" ? 120 : undefined,
          shotgunAmmo: role === "streamer" ? 24 : undefined,
        };
        // Enforce single-streamer per room. Downgrade to zombie if already present.
        if (role === "streamer") {
          const hasStreamer = [...this.players.values()].some(pl => pl.role === "streamer");
          if (hasStreamer) {
            role = "zombie";
            p.role = "zombie";
            p.hp = undefined; p.maxHp = undefined; p.ammo = undefined; p.maxAmmo = undefined; p.weaponBoostUntil = undefined;
            p.weapon = undefined; p.pistolAmmo = undefined; p.smgAmmo = undefined; p.shotgunAmmo = undefined;
            p.pos = this.spawnZombiePos();
            try { ws.send(JSON.stringify({ type: "notice", message: "Streamer already active. You joined as a zombie." })); } catch {}
          }
        }
        this.players.set(pid, p);

          ws.send(JSON.stringify({ type: "joined", playerId: pid, name, role, arena: { w: this.W, h: this.H } }));
          this.broadcast("players_update", { players: [...this.players.values()].map(this.publicPlayer) });
          break;
        }
        case "input": {
          const p = this.players.get(pid);
          if (!p) return;
          const now = Date.now();
          
          // Process input with lag compensation
          this.processInputWithLagCompensation(p, {
            up: !!msg.up,
            down: !!msg.down,
            left: !!msg.left,
            right: !!msg.right,
            shoot: !!msg.shoot,
            aimX: Number(msg.aimX) || 0,
            aimY: Number(msg.aimY) || 0,
            melee: !!msg.melee,
          }, msg.timestamp || now);
          
          p.lastSeen = now;
          break;
        }
        case "ping": {
          const p = this.players.get(pid);
          if (!p) return;
          // Echo back ping for RTT measurement
          try {
            p.ws?.send(JSON.stringify({ type: 'pong', timestamp: msg.timestamp }));
          } catch {}
          break;
        }
        case "toggle_chat": {
          const p = this.players.get(pid);
          if (!p || p.role !== "streamer") return;
          // allow explicit boolean or toggle if omitted
          const desired = typeof msg.disabled === 'boolean' ? !msg.disabled : !this.chatEnabled;
          this.chatEnabled = desired;
          this.broadcast("notice", { message: this.chatEnabled ? "Chat enabled by streamer" : "Chat disabled by streamer" });
          break;
        }
        case "pong": {
          const p = this.players.get(pid); if (p) p.lastSeen = Date.now();
          break;
        }
        case "chat": {
          const p = this.players.get(pid);
          if (!p) return;
          if (!this.chatEnabled && p.role !== "streamer") return;
          this.broadcast("chat", { from: p.name, message: msg.message });
          break;
        }
        case "emote": {
          const p = this.players.get(pid);
          if (!p || p.role !== "zombie") return;
          const symbol = typeof msg.symbol === 'string' ? msg.symbol : '';
          // Allow only a small curated set of emojis
          const allowed = new Set(["🧟","💀","🔥","😂","❤️","💢"]);
          if (!allowed.has(symbol)) return;
          const now = Date.now();
          p.emote = symbol;
          p.emoteUntil = now + 5000; // 5 seconds
          break;
        }
        case "switch_weapon": {
          const p = this.players.get(pid);
          if (!p || p.role !== "streamer") return;
          const w = String(msg.weapon || "");
          if (w === "pistol" || w === "smg" || w === "shotgun" || w === "bat") {
            p.weapon = w;
          }
          break;
        }
      }
    } catch {}
  }

  onClose(pid: string) {
    const p = this.players.get(pid);
    if (!p) return;
    this.players.delete(pid);
    this.broadcast("players_update", { players: [...this.players.values()].map(this.publicPlayer) });
  }

  update() {
    const now = Date.now();

    // Drop stale sockets (missed heartbeats for 40s)
    for (const [id, p] of this.players) {
      if (now - p.lastSeen > 40000) {
        this.players.delete(id);
      }
    }

    // Integrate movement
    const dt = this.tickMs / 1000;
    for (const p of this.players.values()) {
      let baseSpeed = p.role === "streamer" ? 140 : 65; // px/s
      if (p.role === "zombie" && (this.zombieSlowUntil || 0) > now) baseSpeed *= 0.55; // global slow
      const boosted = p.role === "zombie" && (p.boostUntil || 0) > now;
      const speed = boosted ? baseSpeed * 1.75 : baseSpeed;
      let vx = 0, vy = 0;
      if (p.input.up) vy -= 1;
      if (p.input.down) vy += 1;
      if (p.input.left) vx -= 1;
      if (p.input.right) vx += 1;
      const len = Math.hypot(vx, vy) || 1;
      p.vel.x = (vx / len) * speed;
      p.vel.y = (vy / len) * speed;
      p.pos.x = Math.max(0, Math.min(this.W, p.pos.x + p.vel.x * dt));
      p.pos.y = Math.max(0, Math.min(this.H, p.pos.y + p.vel.y * dt));

      // Resolve collisions with walls (circle vs axis-aligned rectangles)
      const pr = p.role === "streamer" ? 10 : 12;
      for (const rct of this.walls) {
        const nearestX = Math.max(rct.x, Math.min(p.pos.x, rct.x + rct.w));
        const nearestY = Math.max(rct.y, Math.min(p.pos.y, rct.y + rct.h));
        let dx = p.pos.x - nearestX; let dy = p.pos.y - nearestY; let dist = Math.hypot(dx, dy);
        if (dist < pr) {
          if (dist === 0) {
            // Center is inside rectangle; push out along smallest penetration axis
            const left = Math.abs(p.pos.x - rct.x);
            const right = Math.abs(rct.x + rct.w - p.pos.x);
            const top = Math.abs(p.pos.y - rct.y);
            const bottom = Math.abs(rct.y + rct.h - p.pos.y);
            const m = Math.min(left, right, top, bottom);
            if (m === left) p.pos.x = rct.x - pr;
            else if (m === right) p.pos.x = rct.x + rct.w + pr;
            else if (m === top) p.pos.y = rct.y - pr;
            else p.pos.y = rct.y + rct.h + pr;
          } else {
            const nx = dx / dist, ny = dy / dist;
            const push = (pr - dist) + 0.5;
            p.pos.x += nx * push; p.pos.y += ny * push;
          }
        }
      }

      // Shooting / attacking (streamer only)
      if (p.role === "streamer" && p.input.shoot) {
        const nowMs = Date.now();
        const boostedW = (p.weaponBoostUntil || 0) > nowMs;
        const weapon = p.weapon || "pistol";
        const dirx = p.input.aimX - p.pos.x;
        const diry = p.input.aimY - p.pos.y;
        const d = Math.hypot(dirx, diry) || 1;
        const nx = dirx / d, ny = diry / d;
        const since = nowMs - (p.lastShotAt || 0);
        if (weapon === "pistol") {
          // Single-click slow shot: fire once per mouse press
          const cd = boostedW ? 200 : 320;
          // Latch: only fire once until shoot is released
          (p as any)._pistolLatched = (p as any)._pistolLatched || false;
          if (since >= cd && (p.pistolAmmo ?? 0) > 0 && !(p as any)._pistolLatched) {
            const speedB = boostedW ? 420 : 360;
            this.bullets.push({ id: crypto.randomUUID().slice(0,6), pos:{x:p.pos.x,y:p.pos.y}, vel:{x:nx*speedB,y:ny*speedB}, ownerId:p.id, ttl: 1200 });
            p.pistolAmmo = Math.max(0, (p.pistolAmmo ?? 0) - 1);
            p.lastShotAt = nowMs;
            (p as any)._pistolLatched = true;
          }
        } else if (weapon === "smg") {
          const cd = boostedW ? 60 : 90;
          if (since >= cd && (p.smgAmmo ?? 0) > 0) {
            const speedB = boostedW ? 400 : 340;
            const spread = (Math.random()-0.5) * 0.12; // radians
            const cs = Math.cos(spread), sn = Math.sin(spread);
            const vx = nx * cs - ny * sn; const vy = nx * sn + ny * cs;
            this.bullets.push({ id: crypto.randomUUID().slice(0,6), pos:{x:p.pos.x,y:p.pos.y}, vel:{x:vx*speedB,y:vy*speedB}, ownerId:p.id, ttl: 900 });
            p.smgAmmo = Math.max(0, (p.smgAmmo ?? 0) - 1);
            p.lastShotAt = nowMs;
          }
        } else if (weapon === "shotgun") {
          const cd = boostedW ? 550 : 800; // slower burst
          if (since >= cd && (p.shotgunAmmo ?? 0) > 0) {
            const speedB = boostedW ? 360 : 300;
            const pellets = 6;
            for (let i=0;i<pellets;i++){
              const spread = (Math.random()-0.5) * 0.45; // radians
              const cs = Math.cos(spread), sn = Math.sin(spread);
              const vx = nx * cs - ny * sn; const vy = nx * sn + ny * cs;
              this.bullets.push({ id: crypto.randomUUID().slice(0,6), pos:{x:p.pos.x,y:p.pos.y}, vel:{x:vx*speedB,y:vy*speedB}, ownerId:p.id, ttl: 600 });
            }
            p.shotgunAmmo = Math.max(0, (p.shotgunAmmo ?? 0) - 1);
            p.lastShotAt = nowMs;
          }
        }
      }
      // Always-available bat (melee) on separate input
      if (p.role === "streamer" && p.input.melee) {
        const nowMs = Date.now();
        const since = nowMs - (p.lastMeleeAt || 0);
        const cd = 500;
        if (since >= cd) {
          const dirx = p.input.aimX - p.pos.x;
          const diry = p.input.aimY - p.pos.y;
          const d = Math.hypot(dirx, diry) || 1;
          const nx = dirx / d, ny = diry / d;
          p.meleeDirX = nx; p.meleeDirY = ny;
          const reach = 28; // px
          for (const z of this.players.values()){
            if (z.role !== "zombie" || !z.alive) continue;
            const dx = z.pos.x - p.pos.x; const dy = z.pos.y - p.pos.y;
            const dist = Math.hypot(dx,dy);
            if (dist > reach) continue;
            const dot = (dx/dist||0)*nx + (dy/dist||0)*ny;
            if (dot > Math.cos(Math.PI/1.8)) {
              z.alive = false;
              const id = z.id;
              setTimeout(() => { const zp = this.players.get(id); if (zp) { zp.pos = this.spawnZombiePos(); zp.alive = true; } }, 800);
              p.score += 1;
            }
          }
          p.lastMeleeAt = nowMs;
        }
      }
      // Reset pistol latch when trigger released
      if (p.role === "streamer" && !p.input.shoot) {
        if ((p as any)._pistolLatched) (p as any)._pistolLatched = false;
      }
    }

    // Update bullets
    const aliveBullets: Bullet[] = [];
    for (const b of this.bullets) {
      b.ttl -= this.tickMs;
      b.pos.x += b.vel.x * dt;
      b.pos.y += b.vel.y * dt;
      if (b.ttl <= 0) continue;
      if (b.pos.x < 0 || b.pos.x > this.W || b.pos.y < 0 || b.pos.y > this.H) continue;

      // Collision with walls: stop bullet if inside rect (with small margin)
      let blocked = false;
      for (const rct of this.walls) {
        const m = 2; // bullet radius margin
        if (b.pos.x > rct.x - m && b.pos.x < rct.x + rct.w + m && b.pos.y > rct.y - m && b.pos.y < rct.y + rct.h + m) { blocked = true; break; }
      }
      if (blocked) continue;

      // Collision with zombies
      let hit = false;
      for (const p of this.players.values()) {
        if (p.role !== "zombie" || !p.alive) continue;
        const r = 14; // zombie radius
        if (Math.hypot(p.pos.x - b.pos.x, p.pos.y - b.pos.y) < r) {
          p.alive = false;
          // Respawn after short delay
          const id = p.id;
          setTimeout(() => { const zp = this.players.get(id); if (zp) { zp.pos = this.spawnZombiePos(); zp.alive = true; } }, 800);
          // Reward streamer
          const s = [...this.players.values()].find(q => q.id === b.ownerId);
          if (s) s.score += 1;
          hit = true; break;
        }
      }
      if (!hit) aliveBullets.push(b);
    }
    this.bullets = aliveBullets;

    // Zombie damage to streamer
    const streamer = [...this.players.values()].find(p => p.role === "streamer");
    if (streamer) {
      for (const z of this.players.values()) {
        if (z.role !== "zombie" || !z.alive) continue;
        const dist = Math.hypot(z.pos.x - streamer.pos.x, z.pos.y - streamer.pos.y);
        if (dist < 16) {
          const shielded = ((streamer as any).shieldUntil || 0) > now;
          if (!shielded) {
            if ((streamer.hp ?? 100) > 0) {
              streamer.hp = Math.max(0, (streamer.hp ?? 100) - 10);
            }
            if ((streamer.hp ?? 0) <= 0) {
              // Respawn streamer with penalty
              streamer.pos = { x: this.W / 2, y: this.H / 2 };
              streamer.hp = streamer.maxHp ?? 100;
              streamer.score = Math.max(0, streamer.score - 2);
            }
          }// Knockback streamer slightly
          const dx = streamer.pos.x - z.pos.x; const dy = streamer.pos.y - z.pos.y; const d = Math.hypot(dx, dy) || 1;
          streamer.pos.x = Math.max(0, Math.min(this.W, streamer.pos.x + (dx / d) * 12));
          streamer.pos.y = Math.max(0, Math.min(this.H, streamer.pos.y + (dy / d) * 12));
          // Teleport zombie to edge to avoid instant re-hit
          z.pos = this.spawnZombiePos();
        }
      }
    }

    // Pickups: spawn periodically up to a soft cap
    if (now - this.lastPickupSpawn > this.pickupIntervalMs) {
      this.lastPickupSpawn = now;
      const totalCap = 12;
      if (this.pickups.length < totalCap) {
        const caps = { health: 3, speed: 3, ammo: 3, weapon: 2, shield: 2, magnet: 2, freeze: 1, blast: 2, treasure: 3 } as Record<PickupType, number>;
        const counts = { health:0, speed:0, ammo:0, weapon:0, shield:0, magnet:0, freeze:0, blast:0, treasure:0 } as Record<PickupType, number>;
        for (const pk of this.pickups) counts[pk.type]++;
        const types: PickupType[] = ["health","speed","ammo","weapon","shield","magnet","freeze","blast","treasure"]; 
        // Weighted pick: prefer under-cap types
        const options: PickupType[] = [];
        for (const t of types){
          const room = Math.max(0, caps[t]-counts[t]);
          for (let i=0;i<room;i++) options.push(t);
        }
        if (options.length === 0) return;
        const type = options[Math.floor(Math.random()*options.length)];
        const pos = this.randomFreePos(28);
        if (pos && this.okDistanceFromPickups(pos.x, pos.y, 48)) {
          this.pickups.push({ id: crypto.randomUUID().slice(0,6), type, x: pos.x, y: pos.y });
        }
      }
    }

    // Pickup collection
    const remaining: Pickup[] = [];
    for (const p of this.pickups) {
      let taken = false;
      for (const pl of this.players.values()) {
        const pr = pl.role === "streamer" ? 10 : 12;
        const pickupR = (pl.role === "streamer" && (((pl as any).magnetUntil || 0) > now)) ? 26 : 10;
        if (Math.hypot(pl.pos.x - p.x, pl.pos.y - p.y) < pr + pickupR) { // pickup radius
          if (p.type === "health" && pl.role === "streamer") {
            pl.hp = Math.min(pl.maxHp ?? 100, (pl.hp ?? 100) + 20);
            taken = true; break;
          }
          if (p.type === "speed" && pl.role === "zombie") {
            pl.boostUntil = now + 7000; // longer 7s speed boost
            taken = true; break;
          }
          if (p.type === "ammo" && pl.role === "streamer") {
            pl.pistolAmmo = Math.min((pl.pistolAmmo ?? 0) + 15, 120);
            pl.smgAmmo = Math.min((pl.smgAmmo ?? 0) + 30, 240);
            pl.shotgunAmmo = Math.min((pl.shotgunAmmo ?? 0) + 6, 48);
            taken = true; break;
          }
          if (p.type === "weapon" && pl.role === "streamer") {
            pl.weaponBoostUntil = now + 8000; // 8s better weapon
            taken = true; break;
          }
          if (p.type === "shield" && pl.role === "streamer") {
            (pl as any).shieldUntil = now + 6000; // 6s shield
            taken = true; break;
          }
          if (p.type === "magnet" && pl.role === "streamer") {
            (pl as any).magnetUntil = now + 8000; // 8s big pickup radius
            taken = true; break;
          }
          if (p.type === "freeze" && pl.role === "streamer") {
            this.zombieSlowUntil = now + 6000; // slow zombies globally for 6s
            taken = true; break;
          }
          if (p.type === "blast" && pl.role === "streamer") {
            // Clear nearby zombies and score for each
            const radius = 90;
            for (const z of this.players.values()){
              if (z.role !== "zombie" || !z.alive) continue;
              if (Math.hypot(z.pos.x - pl.pos.x, z.pos.y - pl.pos.y) <= radius){
                z.alive = false;
                const id = z.id;
                setTimeout(() => { const zp = this.players.get(id); if (zp) { zp.pos = this.spawnZombiePos(); zp.alive = true; } }, 800);
                if (pl.role === "streamer") pl.score += 1;
              }
            }
            taken = true; break;
          }
          if (p.type === "treasure" && pl.role === "streamer") {
            pl.score += 3;
            taken = true; break;
          }
        }
      }
      if (!taken) remaining.push(p);
    }
    this.pickups = remaining;

    // Round timer: reset when time elapses
    if ((this.roundEndTime || 0) > 0 && now >= (this.roundEndTime as number)) {
      this.roundEndTime = now + this.roundDurationMs;
      this.bullets = [];
      this.pickups = [];
      for (const p of this.players.values()) {
        if (p.role === "streamer") {
          p.pos = { x: this.W / 2, y: this.H / 2 };
          p.score = 0;
          p.alive = true;
          p.hp = p.maxHp ?? 100;
          p.weapon = "pistol";
          p.pistolAmmo = 60;
          p.smgAmmo = 120;
          p.shotgunAmmo = 24;
        } else {
          p.pos = this.spawnZombiePos();
          p.alive = true;
          p.boostUntil = undefined;
        }
      }
      // Let clients know a new round started
      this.broadcast("notice", { message: "New round!" });
    }
  }

  broadcastState() {
    const snapshot = {
      type: "state",
      t: Date.now(),
      players: [...this.players.values()].map(this.publicPlayer),
      bullets: this.bullets.map(b => ({ id: b.id, x: b.pos.x, y: b.pos.y, ownerId: b.ownerId })),
      walls: this.walls.map(o => ({ id: o.id, x: o.x, y: o.y, w: o.w, h: o.h })),
      pickups: this.pickups.map(pk => ({ id: pk.id, type: pk.type, x: pk.x, y: pk.y })),
      arena: { w: this.W, h: this.H },
      remainingTime: Math.max(0, Math.floor(((this.roundEndTime || Date.now()) - Date.now()) / 1000)),
      chatEnabled: this.chatEnabled,
    };
    const msg = JSON.stringify(snapshot);
    for (const p of this.players.values()) {
      if (!p.ws) continue;
      try { p.ws.send(msg); } catch {}
    }
  }

  broadcast(type: string, payload: unknown) {
    const msg = JSON.stringify({ type, ...payload as any });
    for (const p of this.players.values()) {
      if (!p.ws) continue;
      try { p.ws.send(msg); } catch {}
    }
  }

  publicPlayer = (p: Player) => ({
    id: p.id,
    name: p.name,
    role: p.role,
    x: p.pos.x,
    y: p.pos.y,
    alive: p.alive,
    score: p.score,
    hp: p.hp ?? 0,
    boosted: (p.boostUntil || 0) > Date.now(),
    ammo: p.ammo ?? 0,
    weaponed: (p.weaponBoostUntil || 0) > Date.now(),
    emote: p.emote || "",
    emoteUntil: p.emoteUntil || 0,
    weapon: p.weapon,
    pistolAmmo: p.pistolAmmo,
    smgAmmo: p.smgAmmo,
    shotgunAmmo: p.shotgunAmmo,
    meleeAt: p.lastMeleeAt || 0,
    meleeDirX: p.meleeDirX || 0,
    meleeDirY: p.meleeDirY || 0,
    // lightweight booleans for some visual hints (optional for clients)
    shielded: ((p as any).shieldUntil || 0) > Date.now(),
    magneted: ((p as any).magnetUntil || 0) > Date.now(),
  });

  sanitizeName(n: string) {
    if (!n) return "";
    const ok = n.replace(/[^a-zA-Z0-9 _-]/g, "").slice(0, 20);
    return ok.trim();
  }

  randomName() {
    const list = (this.env.TARKOV_NAMES || "").split(",").map(s => s.trim()).filter(Boolean);
    return list[Math.floor(Math.random() * list.length)] || "FactoryGhost";
  }

  spawnZombiePos(): Vec {
    // Spawn along edges
    const edge = Math.floor(Math.random() * 4);
    let pos: Vec = { x: 0, y: 0 };
    if (edge === 0) pos = { x: Math.random() * this.W, y: 0 };
    else if (edge === 1) pos = { x: this.W, y: Math.random() * this.H };
    else if (edge === 2) pos = { x: Math.random() * this.W, y: this.H };
    else pos = { x: 0, y: Math.random() * this.H };
    // Nudge inward until free of walls
    for (let i=0;i<20;i++){
      if (!this.circleIntersectsAnyWall(pos.x, pos.y, 12)) break;
      pos.x = Math.min(this.W-12, Math.max(12, pos.x + (pos.x < this.W/2? 5 : -5)));
      pos.y = Math.min(this.H-12, Math.max(12, pos.y + (pos.y < this.H/2? 5 : -5)));
    }
    return pos;
  }

  // Map generation and helpers
  generateMap() {
    // Rectangular rooms and corridors using recursive division
    this.mapReady = true;
    const T = 10; // wall thickness
    // Border walls
    this.walls.push({ id: crypto.randomUUID().slice(0,6), x: 0, y: 0, w: this.W, h: T });
    this.walls.push({ id: crypto.randomUUID().slice(0,6), x: 0, y: this.H - T, w: this.W, h: T });
    this.walls.push({ id: crypto.randomUUID().slice(0,6), x: 0, y: 0, w: T, h: this.H });
    this.walls.push({ id: crypto.randomUUID().slice(0,6), x: this.W - T, y: 0, w: T, h: this.H });

    const minW = 140, minH = 110, door = 40;
    const rnd = (a:number,b:number)=>Math.floor(a + Math.random()*(b-a+1));

    const divide = (x:number,y:number,w:number,h:number,depth:number)=>{
      if (w < minW*2 || h < minH*2 || depth>4) return;
      const horizontal = w < h ? true : w > h ? false : Math.random() < 0.5;
      if (horizontal){
        const wy = rnd(y+minH, y+h-minH);
        // Create wall across with a doorway gap
        const gapX = rnd(x+T+door, x+w-T-door);
        // left segment
        this.walls.push({ id: crypto.randomUUID().slice(0,6), x, y: wy - T/2, w: gapX - x - door/2, h: T });
        // right segment
        const rightX = gapX + door/2;
        this.walls.push({ id: crypto.randomUUID().slice(0,6), x: rightX, y: wy - T/2, w: x+w - rightX, h: T });
        divide(x,y,w,wy-y,depth+1);
        divide(x,wy,w,y+h-wy,depth+1);
      } else {
        const wx = rnd(x+minW, x+w-minW);
        const gapY = rnd(y+T+door, y+h-T-door);
        // top segment
        this.walls.push({ id: crypto.randomUUID().slice(0,6), x: wx - T/2, y, w: T, h: gapY - y - door/2 });
        // bottom segment
        const bottomY = gapY + door/2;
        this.walls.push({ id: crypto.randomUUID().slice(0,6), x: wx - T/2, y: bottomY, w: T, h: y+h - bottomY });
        divide(x,y,wx-x,h,depth+1);
        divide(wx,y,x+w-wx,h,depth+1);
      }
    };
    divide(T,T,this.W-2*T,this.H-2*T,0);
  }

  randomFreePos(buffer = 24): Vec | null {
    for (let tries = 0; tries < 40; tries++) {
      const x = buffer + Math.random() * (this.W - buffer * 2);
      const y = buffer + Math.random() * (this.H - buffer * 2);
      // Not too close to center spawn
      if (Math.hypot(x - this.W/2, y - this.H/2) < 60) continue;
      let ok = true;
      for (const rct of this.walls) {
        const margin = 18;
        if (x > rct.x - margin && x < rct.x + rct.w + margin && y > rct.y - margin && y < rct.y + rct.h + margin) { ok = false; break; }
      }
      if (!ok) continue;
      return { x, y };
    }
    return null;
  }

  // Lag compensation method
  processInputWithLagCompensation(player: Player, input: Input, timestamp: number) {
    const now = Date.now();
    
    // Calculate lag
    if (player.lastInputTime) {
      const timeDiff = now - player.lastInputTime;
      player.lagMs = Math.max(0, Math.min(500, timeDiff)); // Cap at 500ms
    }
    
    // Store input in buffer for potential rollback
    if (!player.inputBuffer) player.inputBuffer = [];
    player.inputBuffer.push({ input: { ...input }, timestamp });
    
    // Keep only recent inputs (1 second)
    const cutoff = now - 1000;
    player.inputBuffer = player.inputBuffer.filter(i => i.timestamp > cutoff);
    
    // Apply input immediately (server authoritative)
    player.input = input;
    player.lastInputTime = now;
  }

  circleIntersectsAnyWall(x:number,y:number,r:number){
    for (const w of this.walls){
      const nx = Math.max(w.x, Math.min(x, w.x+w.w));
      const ny = Math.max(w.y, Math.min(y, w.y+w.h));
      if (Math.hypot(x-nx,y-ny) < r) return true;
    }
    return false;
  }

  okDistanceFromPickups(x:number,y:number,minD:number){
    for (const p of this.pickups){ if (Math.hypot(x-p.x,y-p.y) < minD) return false; }
    return true;
  }
}
