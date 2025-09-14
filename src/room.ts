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
  dash?: boolean;
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
  banked?: number; // M1: extracted/banked score (streamer)
  alive: boolean;
  lastSeen: number;
  lastShotAt?: number;
  lastMeleeAt?: number;
  lastDashAt?: number;
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
  dashUntil?: number;
  // Lag compensation
  lagMs?: number;
  inputBuffer?: Array<{input: Input, timestamp: number}>;
  lastInputTime?: number;
  // Zombie class fields
  zClass?: "runner" | "brute" | "spitter";
  zHp?: number;
  zMaxHp?: number;
  nextSpitAt?: number;
  lastAbilityAt?: number;
  chargeUntil?: number;
  chargeDirX?: number;
  chargeDirY?: number;
}

interface Bullet {
  id: string;
  pos: Vec;
  vel: Vec;
  ownerId: string; // streamer only in this minimal build
  ttl: number; // ms
}

interface Rect { id: string; x: number; y: number; w: number; h: number }
// M1: Extractions
interface Extraction { id: string; x: number; y: number; r: number; activeUntil?: number }
type PickupType = "health" | "speed" | "ammo" | "weapon" | "shield" | "magnet" | "freeze" | "blast" | "treasure" | "key" | "coin" | "gem" | "relic" | "artifact" | "crystal" | "orb" | "medallion" | "scroll" | "crown";
interface Pickup { id: string; type: PickupType; x: number; y: number }

// AI Zombie interface
interface AIZombie {
  id: string;
  pos: Vec;
  vel: Vec;
  hp: number;
  maxHp: number;
  zClass: "runner" | "brute" | "spitter";
  state: "idle" | "chasing" | "attacking";
  targetId?: string;
  lastSeen: number;
  lastAttack: number;
  detectionRange: number;
  chaseRange: number;
  roomId?: string;
  pathfindingCooldown: number;
  nextPathUpdate: number;
}

import { CONFIG, TileId, type GameConfig } from './config';

export class RoomDO {
  state: DurableObjectState;
  env: Env;

  // Config (per-room, overridable)
  cfg: GameConfig = JSON.parse(JSON.stringify(CONFIG));

  // Game space
  W = CONFIG.arena.width; // px (updated when cfg changes)
  H = CONFIG.arena.height; // px (updated when cfg changes)

  // Entities
  players = new Map<string, Player>();
  bullets: Bullet[] = [];
  // Spitter globs (enemy projectiles)
  spittles: Array<{ id: string; pos: Vec; vel: Vec; ttl: number } > = [];
  walls: Rect[] = [];
  pickups: Pickup[] = [];
  // M1: extractions and optional future zones
  extractions: Extraction[] = [];
  midSafeZones: Rect[] = [];
  // AI Zombie properties
  aiZombies: AIZombie[] = [];
  maxAIZombies = CONFIG.aiZombies.maxCount;
  aiZombieSpawnCooldown = CONFIG.aiZombies.spawnCooldownMs;
  lastAIZombieSpawn = 0;
  // Tilemap state
  map: { w:number; h:number; size:number; theme: 'dungeon'|'cave'|'lab'; tiles: Uint8Array; lights: {x:number;y:number;r:number;a:number}[]; props:{x:number;y:number;type:'crate'|'pillar'|'bonepile'}[]; rooms:{x:number;y:number;w:number;h:number}[] } | null = null;

  // Loop - Different tick rates for different systems
  tickMs = CONFIG.ticks.mainMs; // updated when cfg changes
  uiTickMs = 200; // 5Hz - UI updates
  pickupTickMs = CONFIG.ticks.pickupMs; // updated when cfg changes
  running = false;
  loopTimer: number | undefined;
  uiTimer: number | undefined;
  pickupTimer: number | undefined;
  FIRE_COOLDOWN_MS = 180; // legacy; specific cooldowns in CONFIG
  lastPickupSpawn = Date.now();
  pickupIntervalMs = CONFIG.pickups.spawnIntervalMs; // updated when cfg changes
  mapReady = false;
  roundEndTime: number | undefined;
  roundDurationMs = CONFIG.round.durationMs; // updated when cfg changes
    // Global effects
  zombieSlowUntil: number | undefined;
  chatEnabled = true;
  // Extraction rotation pacing from config

  // Metadata
  createdAt = Date.now();

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(req: Request) {
    // Handle setup for per-room overrides before any WS connections
    if (req.headers.get("Upgrade") !== "websocket") {
      try {
        const url = new URL(req.url);
        if (req.method === 'POST' && url.pathname.includes('/setup')) {
          const body = await req.json().catch(() => ({}));
          const overrides = body?.overrides || body?.config || body || {};
          if (overrides && typeof overrides === 'object') {
            this.applyOverrides(overrides);
            // Persist to storage if available
            try { (this.state as any).storage?.put('config', JSON.stringify(this.cfg)); } catch {}
            return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
          }
          return new Response(JSON.stringify({ ok: false, error: 'invalid overrides' }), { status: 400, headers: { 'content-type': 'application/json' } });
        }
      } catch {}
      return new Response("Expected WebSocket", { status: 426 });
    }

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
    if (!this.mapReady) this.generateTileMapAndWalls();

    return new Response(null, { status: 101, webSocket: client });
  }

  applyOverrides(partial: any) {
    const deepMerge = (t: any, s: any) => {
      if (!s || typeof s !== 'object') return t;
      for (const k of Object.keys(s)) {
        const sv = s[k];
        if (sv && typeof sv === 'object' && !Array.isArray(sv)) {
          t[k] = deepMerge(t[k] ?? {}, sv);
        } else {
          t[k] = sv;
        }
      }
      return t;
    };
    this.cfg = deepMerge(JSON.parse(JSON.stringify(this.cfg)), partial);
    // Update derived fields used elsewhere
    this.W = this.cfg.arena.width;
    this.H = this.cfg.arena.height;
    this.tickMs = this.cfg.ticks.mainMs;
    this.pickupTickMs = this.cfg.ticks.pickupMs;
    this.pickupIntervalMs = this.cfg.pickups.spawnIntervalMs;
    this.roundDurationMs = this.cfg.round.durationMs;
    this.maxAIZombies = this.cfg.aiZombies.maxCount;
    this.aiZombieSpawnCooldown = this.cfg.aiZombies.spawnCooldownMs;
    // Force map regeneration on next loop if tiles changed
    this.mapReady = false;
  }

  startLoop() {
    this.running = true;
    if (!this.roundEndTime) this.roundEndTime = Date.now() + this.roundDurationMs;
    // Initial extraction spawn for the run
    if (this.extractions.length === 0) {
      this.spawnExtractions();
      this.rotateExtractionIfNeeded(Date.now());
    }
    
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
      const totalCap = this.cfg.pickups.totalCap;
      if (this.pickups.length < totalCap) {
        const caps = this.cfg.pickups.caps as Record<PickupType, number>;
        const counts = { health:0, speed:0, ammo:0, weapon:0, shield:0, magnet:0, freeze:0, blast:0, treasure:0 } as Record<PickupType, number>;
        for (const pk of this.pickups) counts[pk.type]++;
        const types: PickupType[] = ["health","speed","ammo","weapon","shield","magnet","freeze","blast","treasure"]; 
        // Weighted pick: prefer under-cap types
        const options: PickupType[] = [];
        for (const t of types){
          const room = Math.max(0, (caps[t]||0)-counts[t]);
          for (let i=0;i<room;i++) options.push(t);
        }
        if (options.length > 0) {
          const type = options[Math.floor(Math.random()*options.length)];
          const pos = this.randomFreePos(28);
          if (pos && this.okDistanceFromPickups(pos.x, pos.y, this.cfg.pickups.minDistance)) {
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
          const pos = role === "streamer" ? this.spawnInRandomRoom() : this.spawnZombiePos();

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
          hp: role === "streamer" ? this.cfg.streamer.maxHp : undefined,
          maxHp: role === "streamer" ? this.cfg.streamer.maxHp : undefined,
          weapon: role === "streamer" ? "pistol" : undefined,
          pistolAmmo: role === "streamer" ? this.cfg.weapons.ammo.initial.pistol : undefined,
          smgAmmo: role === "streamer" ? 0 : undefined,
          shotgunAmmo: role === "streamer" ? 0 : undefined,
          banked: role === "streamer" ? 0 : undefined,
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
        // Assign class stats if zombie after potential downgrade
        if (p.role === 'zombie') {
          const zc = this.pickZombieClass();
          p.zClass = zc;
          const base = this.cfg.zombies.baseHp;
          p.zMaxHp = Math.max(1, Math.round(base * this.cfg.zombies.hpMul[zc]));
          p.zHp = p.zMaxHp;
          if (zc === 'spitter') {
            p.nextSpitAt = Date.now() + this.randRange(this.cfg.zombies.spitter.cooldownMsMin, this.cfg.zombies.spitter.cooldownMsMax);
          }
        }

        this.players.set(pid, p);

          ws.send(JSON.stringify({ type: "joined", playerId: pid, name, role, arena: { w: this.W, h: this.H } }));
          // Send map payload to the new client
          try {
            if (!this.map) this.generateTileMapAndWalls();
            if (this.map) {
              const base64 = this.u8ToBase64(this.map.tiles);
              ws.send(JSON.stringify({ type: 'map', map: { w: this.map.w, h: this.map.h, size: this.map.size, theme: this.map.theme, tilesBase64: base64, props: this.map.props, lights: this.map.lights } }));
            }
          } catch {}
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
            dash: !!msg.dash,
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
        case "buy": {
          const p = this.players.get(pid);
          if (!p || p.role !== 'streamer') return;
          const item = String(msg.item||'');
          const cost = 300;
          const bank = p.banked || 0;
          if (item === 'shotgun') {
            if (bank >= cost) {
              p.banked = bank - cost;
              p.weapon = 'shotgun';
              p.shotgunAmmo = Math.max(p.shotgunAmmo||0, this.cfg.weapons.ammo.initial.shotgun);
              this.broadcast('notice', { message: `${p.name} purchased Shotgun! (-${cost} banked)` });
            } else {
              try { p.ws?.send(JSON.stringify({ type:'notice', message:`Not enough banked (need ${cost})` })); } catch {}
            }
          } else if (item === 'smg') {
            if (bank >= cost) {
              p.banked = bank - cost;
              p.weapon = 'smg';
              p.smgAmmo = Math.max(p.smgAmmo||0, this.cfg.weapons.ammo.initial.smg);
              this.broadcast('notice', { message: `${p.name} purchased SMG! (-${cost} banked)` });
            } else {
              try { p.ws?.send(JSON.stringify({ type:'notice', message:`Not enough banked (need ${cost})` })); } catch {}
            }
          }
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
        case "attempt_extract": {
          const p = this.players.get(pid);
          if (!p || p.role !== "streamer") return;
          const now = Date.now();
          const active = this.extractions.find(e => (e.activeUntil || 0) > now);
          if (!active) return;
          const d = Math.hypot(p.pos.x - active.x, p.pos.y - active.y);
          if (d <= active.r) {
            p.banked = (p.banked || 0) + (p.score || 0);
            p.score = 0;
            this.broadcast("notice", { message: "Extraction successful!" });
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

    // Ensure extraction rotation
    this.rotateExtractionIfNeeded(now);

    // Update AI Zombies
    this.updateAIZombies(now);

    // Spawn AI Zombies if needed
    this.spawnAIZombiesIfNeeded(now);

    // Integrate movement
    const dt = this.tickMs / 1000;
    for (const p of this.players.values()) {
      let baseSpeed = p.role === "streamer" ? this.cfg.speeds.streamer : this.cfg.speeds.zombie; // px/s
      if (p.role === 'zombie' && p.zClass) baseSpeed *= this.cfg.zombies.speedMul[p.zClass];
      if (p.role === "zombie" && (this.zombieSlowUntil || 0) > now) baseSpeed *= this.cfg.speeds.zombieSlowMultiplier; // global slow
      if (p.role === 'streamer' && ((p as any).gooSlowUntil || 0) > now) baseSpeed *= this.cfg.zombies.spitter.streamerSlowMul;
      const boosted = p.role === "zombie" && (p.boostUntil || 0) > now;
      let speed = boosted ? baseSpeed * this.cfg.speeds.zombieBoostMultiplier : baseSpeed;
      let vx = 0, vy = 0;
      if (p.input.up) vy -= 1;
      if (p.input.down) vy += 1;
      if (p.input.left) vx -= 1;
      if (p.input.right) vx += 1;
      // Zombie active abilities on left-click
      let useCharge = false; let chargeSpeed = 0;
      if (p.role === 'zombie' && p.zClass) {
        const nowMs = now;
        const since = nowMs - (p.lastAbilityAt || 0);
        if (p.zClass === 'runner') {
          if (p.input.shoot && since >= this.cfg.zombies.runnerAbility.cooldownMs) {
            p.boostUntil = nowMs + this.cfg.zombies.runnerAbility.durationMs;
            p.lastAbilityAt = nowMs;
          }
        } else if (p.zClass === 'brute') {
          if (p.input.shoot && since >= this.cfg.zombies.bruteAbility.cooldownMs) {
            const dirx = (p.input.aimX || p.pos.x) - p.pos.x;
            const diry = (p.input.aimY || p.pos.y) - p.pos.y;
            const d = Math.hypot(dirx, diry) || 1;
            p.chargeDirX = dirx / d; p.chargeDirY = diry / d;
            p.chargeUntil = nowMs + this.cfg.zombies.bruteAbility.durationMs;
            p.lastAbilityAt = nowMs;
          }
          if ((p.chargeUntil || 0) > nowMs) {
            useCharge = true; chargeSpeed = this.cfg.zombies.bruteAbility.speed;
            vx = p.chargeDirX || 0; vy = p.chargeDirY || 0;
          }
        } else if (p.zClass === 'spitter') {
          if (p.input.shoot && since >= this.cfg.zombies.spitter.manualCooldownMs) {
            const dx = (p.input.aimX || p.pos.x) - p.pos.x;
            const dy = (p.input.aimY || p.pos.y) - p.pos.y;
            const d = Math.hypot(dx, dy) || 1;
            const s = this.cfg.zombies.spitter.projectileSpeed;
            this.spittles.push({ id: crypto.randomUUID().slice(0,6), pos: { x: p.pos.x, y: p.pos.y }, vel: { x: (dx/d)*s, y: (dy/d)*s }, ttl: this.cfg.zombies.spitter.projectileTtl });
            p.lastAbilityAt = nowMs;
          }
        }
      }
      const len = Math.hypot(vx, vy) || 1;
      // Handle dash (streamer only)
      if (p.role === 'streamer') {
        // Trigger dash on key press if off cooldown
        const nowMs = Date.now();
        (p as any)._dashLatched = (p as any)._dashLatched || false;
        const ready = (nowMs - (p.lastDashAt || 0)) >= this.cfg.dash.cooldownMs;
        if (p.input.dash && ready && !(p as any)._dashLatched) {
          p.dashUntil = nowMs + this.cfg.dash.durationMs;
          p.lastDashAt = nowMs;
          (p as any)._dashLatched = true;
        }
        if (!p.input.dash && (p as any)._dashLatched) (p as any)._dashLatched = false;
        // Apply dash speed multiplier if active
        if ((p.dashUntil || 0) > nowMs) {
          speed *= this.cfg.dash.speedMultiplier;
        }
      }
      const moveSpeed = useCharge ? chargeSpeed : speed;
      p.vel.x = (vx / len) * moveSpeed;
      p.vel.y = (vy / len) * moveSpeed;
      // Intended new position
      let nx = p.pos.x + p.vel.x * dt;
      let ny = p.pos.y + p.vel.y * dt;
      // Tile semantics: solid, door, pit, slow
      if (this.map) {
        const sz = this.map.size;
        const ix = Math.max(0, Math.min(this.map.w-1, Math.floor(nx / sz)));
        const iy = Math.max(0, Math.min(this.map.h-1, Math.floor(ny / sz)));
        const t = this.map.tiles[iy*this.map.w + ix] as TileId;
        const isSolid = (tt:TileId)=> tt===1 || tt===4; // wall or doorClosed
        const isLethal = (tt:TileId)=> tt===2; // pit
        const isSlow = (tt:TileId)=> tt===3; // water/sludge
        
        // Door interaction feedback for streamer
        if (p.role === 'streamer' && t === 4) {
          const lastDoorToast = (p as any).lastDoorToast || 0;
          if (now - lastDoorToast > 3000) { // Throttle to every 3 seconds
            this.broadcast("notice", { message: "🚪 Closed door! Find a KEY pickup to open all doors" });
            (p as any).lastDoorToast = now;
          }
        }
        
        if (isSlow(t)) { 
          nx = p.pos.x + (p.vel.x * 0.6) * dt; 
          ny = p.pos.y + (p.vel.y * 0.6) * dt;
          // Water/sludge feedback for streamer
          if (p.role === 'streamer') {
            const lastSlowToast = (p as any).lastSlowToast || 0;
            if (now - lastSlowToast > 4000) {
              this.broadcast("notice", { message: "💧 Moving through water - slowed down!" });
              (p as any).lastSlowToast = now;
            }
          }
        }
        if (isSolid(t)) { nx = p.pos.x; ny = p.pos.y; }
        if (isLethal(t)) {
          if (p.role === 'streamer') {
            this.broadcast("notice", { message: "💀 Fell into a pit! Respawning..." });
            p.hp = 0;
            // simple respawn
            p.pos = this.spawnInRandomRoom();
            p.hp = p.maxHp ?? this.cfg.streamer.maxHp;
            nx = p.pos.x; ny = p.pos.y;
          } else {
            p.alive = false; const id=p.id; setTimeout(()=>{ const zp=this.players.get(id); if (zp) { zp.pos=this.spawnZombiePos(); zp.alive=true; } }, this.cfg.combat.respawnMs);
          }
        }
      }
      p.pos.x = Math.max(0, Math.min(this.W, nx));
      p.pos.y = Math.max(0, Math.min(this.H, ny));

      // Resolve collisions with walls (circle vs axis-aligned rectangles)
      const pr = p.role === "streamer" ? this.cfg.radii.streamer : this.cfg.radii.zombie;
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
          const cd = boostedW ? this.cfg.weapons.cooldownMs.pistol.boosted : this.cfg.weapons.cooldownMs.pistol.base;
          // Latch: only fire once until shoot is released
          (p as any)._pistolLatched = (p as any)._pistolLatched || false;
          if (since >= cd && (p.pistolAmmo ?? 0) > 0 && !(p as any)._pistolLatched) {
            const speedB = boostedW ? this.cfg.weapons.projectile.pistol.speed * 1.166 : this.cfg.weapons.projectile.pistol.speed;
            this.bullets.push({ id: crypto.randomUUID().slice(0,6), pos:{x:p.pos.x,y:p.pos.y}, vel:{x:nx*speedB,y:ny*speedB}, ownerId:p.id, ttl: this.cfg.weapons.projectile.pistol.ttl });
            p.pistolAmmo = Math.max(0, (p.pistolAmmo ?? 0) - 1);
            p.lastShotAt = nowMs;
            (p as any)._pistolLatched = true;
          }
        } else if (weapon === "smg") {
          const cd = boostedW ? this.cfg.weapons.cooldownMs.smg.boosted : this.cfg.weapons.cooldownMs.smg.base;
          if (since >= cd && (p.smgAmmo ?? 0) > 0) {
            const speedB = boostedW ? this.cfg.weapons.projectile.smg.speed * 1.176 : this.cfg.weapons.projectile.smg.speed;
            const spread = (Math.random()-0.5) * 0.12; // radians
            const cs = Math.cos(spread), sn = Math.sin(spread);
            const vx = nx * cs - ny * sn; const vy = nx * sn + ny * cs;
            this.bullets.push({ id: crypto.randomUUID().slice(0,6), pos:{x:p.pos.x,y:p.pos.y}, vel:{x:vx*speedB,y:vy*speedB}, ownerId:p.id, ttl: this.cfg.weapons.projectile.smg.ttl });
            p.smgAmmo = Math.max(0, (p.smgAmmo ?? 0) - 1);
            p.lastShotAt = nowMs;
          }
        } else if (weapon === "shotgun") {
          const cd = boostedW ? this.cfg.weapons.cooldownMs.shotgun.boosted : this.cfg.weapons.cooldownMs.shotgun.base; // slower burst
          if (since >= cd && (p.shotgunAmmo ?? 0) > 0) {
            const speedB = boostedW ? this.cfg.weapons.projectile.shotgun.speed * 1.2 : this.cfg.weapons.projectile.shotgun.speed;
            const pellets = this.cfg.weapons.projectile.shotgun.pellets;
            for (let i=0;i<pellets;i++){
              const spread = (Math.random()-0.5) * 0.45; // radians
              const cs = Math.cos(spread), sn = Math.sin(spread);
              const vx = nx * cs - ny * sn; const vy = nx * sn + ny * cs;
              this.bullets.push({ id: crypto.randomUUID().slice(0,6), pos:{x:p.pos.x,y:p.pos.y}, vel:{x:vx*speedB,y:vy*speedB}, ownerId:p.id, ttl: this.cfg.weapons.projectile.shotgun.ttl });
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
        const cd = this.cfg.melee.cooldownMs;
        if (since >= cd) {
          const dirx = p.input.aimX - p.pos.x;
          const diry = p.input.aimY - p.pos.y;
          const d = Math.hypot(dirx, diry) || 1;
          const nx = dirx / d, ny = diry / d;
          p.meleeDirX = nx; p.meleeDirY = ny;
          const reach = this.cfg.melee.reach; // px
          for (const z of this.players.values()){
            if (z.role !== "zombie" || !z.alive) continue;
            const dx = z.pos.x - p.pos.x; const dy = z.pos.y - p.pos.y;
            const dist = Math.hypot(dx,dy);
            if (dist > reach) continue;
            const dot = (dx/dist||0)*nx + (dy/dist||0)*ny;
            if (dot > Math.cos(this.cfg.melee.arcRad)) {
              // Apply melee damage from config
              z.zHp = Math.max(0, (z.zHp ?? this.cfg.zombies.baseHp) - this.cfg.weapons.damage.melee);
              if ((z.zHp ?? 0) <= 0) {
                z.alive = false;
                // Drop ammo on zombie death
                this.pickups.push({ id: crypto.randomUUID().slice(0,6), type: 'ammo', x: z.pos.x, y: z.pos.y });
                const id = z.id;
                setTimeout(() => { const zp = this.players.get(id); if (zp) { zp.pos = this.spawnZombiePos(); zp.alive = true; zp.zHp = zp.zMaxHp; } }, this.cfg.combat.respawnMs);
                p.score += 1;
              }
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
        const m = this.cfg.radii.bulletMargin; // bullet radius margin
        if (b.pos.x > rct.x - m && b.pos.x < rct.x + rct.w + m && b.pos.y > rct.y - m && b.pos.y < rct.y + rct.h + m) { blocked = true; break; }
      }
      if (blocked) continue;

      // Collision with zombies (class-based HP)
      let hit = false;
      for (const p of this.players.values()) {
        if (p.role !== "zombie" || !p.alive) continue;
        const r = this.cfg.radii.zombie; // zombie radius
        if (Math.hypot(p.pos.x - b.pos.x, p.pos.y - b.pos.y) < r) {
          const shooter = [...this.players.values()].find(p => p.id === b.ownerId);
          const weaponType = shooter?.weapon || 'pistol';
          const dmg = this.cfg.weapons.damage[weaponType as keyof typeof this.cfg.weapons.damage] || 0;
          p.zHp = Math.max(0, (p.zHp ?? this.cfg.zombies.baseHp) - dmg);
          if ((p.zHp ?? 0) <= 0) {
            p.alive = false;
            // Drop ammo on zombie death
            this.pickups.push({ id: crypto.randomUUID().slice(0,6), type: 'ammo', x: p.pos.x, y: p.pos.y });
            const id = p.id;
            setTimeout(() => { const zp = this.players.get(id); if (zp) { zp.pos = this.spawnZombiePos(); zp.alive = true; zp.zHp = zp.zMaxHp; } }, this.cfg.combat.respawnMs);
          }
          // Reward streamer
          const s = [...this.players.values()].find(q => q.id === b.ownerId);
          if (s) s.score += 1;
          hit = true; break;
        }
      }
      
      // Collision with AI zombies
      if (!hit) {
        for (const zombie of this.aiZombies) {
          const r = this.cfg.radii.zombie;
          if (Math.hypot(zombie.pos.x - b.pos.x, zombie.pos.y - b.pos.y) < r) {
            const dmg = 100;
            zombie.hp = Math.max(0, zombie.hp - dmg);
            // Reward streamer
            const s = [...this.players.values()].find(q => q.id === b.ownerId);
            if (s) s.score += 1;
            hit = true;
            break;
          }
        }
      }
      if (!hit) aliveBullets.push(b);
    }
    this.bullets = aliveBullets;

    // Find streamer at the start of the update
    const streamer = [...this.players.values()].find(p => p.role === "streamer");

    // Update spitter globs
    const aliveGlobs: typeof this.spittles = [];
    for (const g of this.spittles) {
      g.ttl -= this.tickMs;
      g.pos.x += g.vel.x * dt;
      g.pos.y += g.vel.y * dt;
      if (g.ttl <= 0) continue;
      if (g.pos.x < 0 || g.pos.x > this.W || g.pos.y < 0 || g.pos.y > this.H) continue;
      // collide with streamer
      if (streamer) {
        const r = this.cfg.radii.streamer + 2;
        if (Math.hypot(streamer.pos.x - g.pos.x, streamer.pos.y - g.pos.y) < r) {
          // apply slow and small damage
          (streamer as any).gooSlowUntil = now + this.cfg.zombies.spitter.slowMs;
          streamer.hp = Math.max(0, (streamer.hp ?? this.cfg.streamer.maxHp) - this.cfg.zombies.spitter.hitDamage);
          continue; // glob consumed
        }
      }
      aliveGlobs.push(g);
    }
    this.spittles = aliveGlobs;

    // Zombie damage to streamer
    if (streamer) {
      // Dash-kill pass: if streamer is dashing, kill non-brute zombies on contact
      if ((streamer.dashUntil || 0) > now) {
        for (const z of this.players.values()) {
          if (z.role !== 'zombie' || !z.alive) continue;
          const dist = Math.hypot(z.pos.x - streamer.pos.x, z.pos.y - streamer.pos.y);
          const thresh = this.cfg.radii.zombie + this.cfg.radii.streamer;
          if (dist <= thresh) {
            if (z.zClass === 'brute') {
              continue; // brutes resist dash kill
            }
            z.zHp = 0; z.alive = false;
            // Drop ammo on zombie death
            this.pickups.push({ id: crypto.randomUUID().slice(0,6), type: 'ammo', x: z.pos.x, y: z.pos.y });
            const id = z.id;
            setTimeout(() => { const zp = this.players.get(id); if (zp) { zp.pos = this.spawnZombiePos(); zp.alive = true; zp.zHp = zp.zMaxHp; } }, this.cfg.combat.respawnMs);
            streamer.score += 1;
          }
        }
      }
      // Spitter AI: fire globs toward streamer
      for (const z of this.players.values()){
        if (z.role !== 'zombie' || !z.alive || z.zClass !== 'spitter') continue;
        const rng = this.cfg.zombies.spitter.range;
        const dx = streamer.pos.x - z.pos.x; const dy = streamer.pos.y - z.pos.y; const dist = Math.hypot(dx, dy);
        if (dist <= rng && (z.nextSpitAt || 0) <= now) {
          const s = this.cfg.zombies.spitter.projectileSpeed;
          const nx = (dx / (dist||1)); const ny = (dy / (dist||1));
          this.spittles.push({ id: crypto.randomUUID().slice(0,6), pos: { x: z.pos.x, y: z.pos.y }, vel: { x: nx * s, y: ny * s }, ttl: this.cfg.zombies.spitter.projectileTtl });
          z.nextSpitAt = now + this.randRange(this.cfg.zombies.spitter.cooldownMsMin, this.cfg.zombies.spitter.cooldownMsMax);
        }
      }
      for (const z of this.players.values()) {
        if (z.role !== "zombie" || !z.alive) continue;
        const dist = Math.hypot(z.pos.x - streamer.pos.x, z.pos.y - streamer.pos.y);
        if (dist < 16) {
          const shielded = ((streamer as any).shieldUntil || 0) > now;
          if (!shielded) {
            if ((streamer.hp ?? this.cfg.streamer.maxHp) > 0) {
              streamer.hp = Math.max(0, (streamer.hp ?? this.cfg.streamer.maxHp) - this.cfg.combat.zombieTouchDamage);
            }
            if ((streamer.hp ?? 0) <= 0) {
              // Respawn streamer; lose unbanked on death (keep banked)
              streamer.pos = this.spawnInRandomRoom();
              streamer.hp = streamer.maxHp ?? this.cfg.streamer.maxHp;
              streamer.score = 0;
            }
          }// Knockback streamer slightly
          const dx = streamer.pos.x - z.pos.x; const dy = streamer.pos.y - z.pos.y; const d = Math.hypot(dx, dy) || 1;
          const kbMul = (z.zClass === 'brute') ? this.cfg.zombies.brute.extraKnockbackMul : 1;
          streamer.pos.x = Math.max(0, Math.min(this.W, streamer.pos.x + (dx / d) * this.cfg.combat.knockbackStep * kbMul));
          streamer.pos.y = Math.max(0, Math.min(this.H, streamer.pos.y + (dy / d) * this.cfg.combat.knockbackStep * kbMul));
          // Teleport zombie to edge to avoid instant re-hit
          z.pos = this.spawnZombiePos();
        }
      }
    }

    // (duplicate spawning block removed; handled by checkPickupSpawning())

    // Pickup collection
    const remaining: Pickup[] = [];
    for (const p of this.pickups) {
      let taken = false;
      for (const pl of this.players.values()) {
        const pr = pl.role === "streamer" ? 10 : 12;
        const pickupR = (pl.role === "streamer" && (((pl as any).magnetUntil || 0) > now)) ? 26 : 10;
        if (Math.hypot(pl.pos.x - p.x, pl.pos.y - p.y) < pr + pickupR) { // pickup radius
          if (p.type === "health" && pl.role === "streamer") {
            pl.hp = Math.min(pl.maxHp ?? this.cfg.streamer.maxHp, (pl.hp ?? this.cfg.streamer.maxHp) + 20);
            this.broadcast("notice", { message: "❤️ Health restored!" });
            taken = true; break;
          }
          if (p.type === "speed" && pl.role === "zombie") {
            pl.boostUntil = now + this.cfg.effects.zombieBoostMs; // speed boost
            taken = true; break;
          }
          if (p.type === "ammo" && pl.role === "streamer") {
            pl.pistolAmmo = Math.min((pl.pistolAmmo ?? 0) + this.cfg.weapons.ammo.pickupGain.pistol, this.cfg.weapons.ammo.max.pistol);
            pl.smgAmmo = Math.min((pl.smgAmmo ?? 0) + this.cfg.weapons.ammo.pickupGain.smg, this.cfg.weapons.ammo.max.smg);
            pl.shotgunAmmo = Math.min((pl.shotgunAmmo ?? 0) + this.cfg.weapons.ammo.pickupGain.shotgun, this.cfg.weapons.ammo.max.shotgun);
            this.broadcast("notice", { message: "🔫 Ammo refilled for all weapons!" });
            taken = true; break;
          }
          if (p.type === "weapon" && pl.role === "streamer") {
            // If currently bat-only, grant pistol and some starter ammo; otherwise weapon boost
            if ((pl.weapon||'bat') === 'bat') {
              pl.weapon = 'pistol';
              pl.pistolAmmo = Math.max(pl.pistolAmmo||0, 30);
              this.broadcast("notice", { message: "🔫 Pistol unlocked with ammo!" });
            } else {
              this.broadcast("notice", { message: "⚡ Weapon boost activated!" });
            }
            pl.weaponBoostUntil = now + this.cfg.effects.weaponBoostMs; // better weapon
            taken = true; break;
          }
          if (p.type === "shield" && pl.role === "streamer") {
            (pl as any).shieldUntil = now + this.cfg.effects.shieldMs; // shield
            this.broadcast("notice", { message: "🛡️ Shield activated - temporary invulnerability!" });
            taken = true; break;
          }
          if (p.type === "magnet" && pl.role === "streamer") {
            (pl as any).magnetUntil = now + this.cfg.effects.magnetMs; // big pickup radius
            this.broadcast("notice", { message: "🧲 Magnet activated - larger pickup radius!" });
            taken = true; break;
          }
          if (p.type === "freeze" && pl.role === "streamer") {
            this.zombieSlowUntil = now + this.cfg.effects.freezeMs; // slow zombies globally
            this.broadcast("notice", { message: "❄️ Freeze activated - all zombies slowed!" });
            taken = true; break;
          }
          if (p.type === "blast" && pl.role === "streamer") {
            // Clear nearby zombies and score for each
            const radius = this.cfg.pickups.blastRadius;
            let zombiesHit = 0;
            for (const z of this.players.values()){
              if (z.role !== "zombie" || !z.alive) continue;
              if (Math.hypot(z.pos.x - pl.pos.x, z.pos.y - pl.pos.y) <= radius){
                z.zHp = Math.max(0, (z.zHp ?? this.cfg.zombies.baseHp) - 100);
                if ((z.zHp ?? 0) <= 0) {
                  z.alive = false;
                  zombiesHit++;
                  // Drop ammo on zombie death
                  this.pickups.push({ id: crypto.randomUUID().slice(0,6), type: 'ammo', x: z.pos.x, y: z.pos.y });
                  const id = z.id;
                  setTimeout(() => { const zp = this.players.get(id); if (zp) { zp.pos = this.spawnZombiePos(); zp.alive = true; zp.zHp = zp.zMaxHp; } }, this.cfg.combat.respawnMs);
                  if (pl.role === "streamer") pl.score += 1;
                }
              }
            }
            this.broadcast("notice", { message: `💥 Blast killed ${zombiesHit} zombies!` });
            taken = true; break;
          }
          if (p.type === "treasure" && pl.role === "streamer") {
            pl.score += this.cfg.pickups.treasureScore;
            this.broadcast("notice", { message: `💎 Treasure found! +${this.cfg.pickups.treasureScore} points` });
            taken = true; break;
          }
          // Handle new treasure types
          const treasureValue = this.getTreasureValue(p.type);
          if (treasureValue > 0 && pl.role === "streamer") {
            pl.score += treasureValue;
            const treasureNames: Record<string, string> = {
              coin: "💰 Coin",
              gem: "💎 Gem", 
              crystal: "🔮 Crystal",
              orb: "🌟 Orb",
              relic: "🏺 Relic",
              artifact: "⚱️ Artifact",
              medallion: "🏅 Medallion",
              scroll: "📜 Scroll",
              crown: "👑 Crown"
            };
            const name = treasureNames[p.type] || "💎 Treasure";
            this.broadcast("notice", { message: `${name} found! +${treasureValue} points` });
            taken = true; break;
          }
          if (p.type === "key" && pl.role === "streamer") {
            // Open all doors: convert tile 4 (doorClosed) to 5 (doorOpen)
            if (this.map) {
              for (let i=0;i<this.map.tiles.length;i++) if (this.map.tiles[i]===4) this.map.tiles[i]=5;
              // Broadcast updated map to all clients
              const base64 = this.u8ToBase64(this.map.tiles);
              this.broadcast('map', { map: { w: this.map.w, h: this.map.h, size: this.map.size, theme: this.map.theme, tilesBase64: base64, props: this.map.props, lights: this.map.lights } });
            }
            this.broadcast("notice", { message: "🗝️ Key used! All doors are now open!" });
            taken = true; break;
          }
        }
      }
      if (!taken) remaining.push(p);
    }
    this.pickups = remaining;

    // Extraction zone feedback for streamer
    const s = [...this.players.values()].find(p => p.role === "streamer");
    if (s) {
      const active = this.extractions.find(e => (e.activeUntil || 0) > now);
      if (active) {
        const dist = Math.hypot((s.pos.x - active.x), (s.pos.y - active.y));
        if (dist <= active.r) {
          // Player is in extraction zone
          const lastExtractToast = (s as any).lastExtractToast || 0;
          if (now - lastExtractToast > 5000) { // Every 5 seconds
            const timeLeft = Math.max(0, Math.ceil(((active.activeUntil || 0) - now) / 1000));
            if (s.score > 0) {
              this.broadcast("notice", { message: `💰 In extraction zone! Press X to bank ${s.score} points (${timeLeft}s left)` });
            } else {
              this.broadcast("notice", { message: `🚁 In extraction zone! No points to bank (${timeLeft}s left)` });
            }
            (s as any).lastExtractToast = now;
          }
        }
      }
    }

    // Round timer: reset when time elapses
    if ((this.roundEndTime || 0) > 0 && now >= (this.roundEndTime as number)) {
      // On round end, handle extraction banking for streamer
      if (s) {
        const active = this.extractions.find(e => (e.activeUntil || 0) > now);
        if (active) {
          const dist = Math.hypot((s.pos.x - active.x), (s.pos.y - active.y));
          if (dist <= active.r) {
            // Bank unbanked
            s.banked = (s.banked || 0) + (s.score || 0);
            s.score = 0;
          } else {
            // Did not extract: lose unbanked
            s.score = 0;
          }
        } else {
          // No active extraction at end: lose unbanked
          s.score = 0;
        }
      }

      this.roundEndTime = now + this.roundDurationMs;
      this.bullets = [];
      this.pickups = [];
      // Reset and respawn extractions (1–2 per round)
      this.extractions = [];
      this.spawnExtractions();
      // Immediately rotate to set one active for the new round
      this.rotateExtractionIfNeeded(now);
      // Optionally regenerate map each round (for variety)
      this.generateTileMapAndWalls();
      // Broadcast new map to all clients
      if (this.map) {
        const base64 = this.u8ToBase64(this.map.tiles);
        this.broadcast('map', { map: { w: this.map.w, h: this.map.h, size: this.map.size, theme: this.map.theme, tilesBase64: base64, props: this.map.props, lights: this.map.lights } });
      }
      for (const p of this.players.values()) {
        if (p.role === "streamer") {
          p.pos = { x: this.W / 2, y: this.H / 2 };
          p.alive = true;
          p.hp = p.maxHp ?? this.cfg.streamer.maxHp;
          p.weapon = "pistol";
          p.pistolAmmo = this.cfg.weapons.ammo.initial.pistol;
          p.smgAmmo = 0;
          p.shotgunAmmo = 0;
        } else {
          p.pos = this.spawnZombiePos();
          p.alive = true;
          p.boostUntil = undefined;
          p.zHp = p.zMaxHp;
        }
      }
      // Let clients know a new round started
      this.broadcast("notice", { message: "New round!" });
    }
  }

  // AI Zombie methods
  spawnAIZombiesIfNeeded(now: number) {
    if (now - this.lastAIZombieSpawn < this.aiZombieSpawnCooldown) return;
    if (this.aiZombies.length >= this.maxAIZombies) return;
    
    // Only spawn if there's a streamer
    const streamer = [...this.players.values()].find(p => p.role === "streamer");
    if (!streamer) return;
    
    const spawnPos = this.getAIZombieSpawnPosition(streamer.pos);
    if (!spawnPos) return;
    
    const zClass = this.pickZombieClass();
    const baseHp = this.cfg.zombies.baseHp;
    const maxHp = Math.max(1, Math.round(baseHp * this.cfg.zombies.hpMul[zClass]));
    
    const aiZombie: AIZombie = {
      id: crypto.randomUUID().slice(0, 8),
      pos: spawnPos,
      vel: { x: 0, y: 0 },
      hp: maxHp,
      maxHp: maxHp,
      zClass: zClass,
      state: "idle",
      lastSeen: 0,
      lastAttack: 0,
      detectionRange: this.cfg.zombies.detectionRange[zClass],
      chaseRange: this.cfg.zombies.chaseRange[zClass],
      pathfindingCooldown: 500, // ms between pathfinding updates
      nextPathUpdate: now
    };
    
    this.aiZombies.push(aiZombie);
    this.lastAIZombieSpawn = now;
  }
  
  getRandomZombieDrop(): PickupType | null {
    // First check if any drop should happen at all
    if (Math.random() > this.cfg.aiZombies.dropChance) {
      return null; // No drop
    }
    
    const rand = Math.random();
    
    // Use config values for drop chances (normalized since we already passed the drop check)
    const totalChance = this.cfg.aiZombies.ammoDropChance + this.cfg.aiZombies.treasureDropChance;
    const normalizedAmmoChance = this.cfg.aiZombies.ammoDropChance / totalChance;
    
    if (rand < normalizedAmmoChance) {
      return "ammo";
    }
    
    // Treasure drops with configurable rarities
    const treasureRoll = Math.random();
    const rates = this.cfg.aiZombies.treasureDropRates;
    
    let cumulative = 0;
    for (const [treasure, rate] of Object.entries(rates)) {
      cumulative += rate;
      if (treasureRoll < cumulative) {
        return treasure as PickupType;
      }
    }
    
    // Fallback to coin if something goes wrong
    return "coin";
  }

  getTreasureValue(type: PickupType): number {
    return this.cfg.aiZombies.treasureValues[type] || 0;
  }

  getAIZombieSpawnPosition(streamerPos: Vec): Vec | null {
    if (!this.map || !this.map.rooms) return null;
    
    // Try to spawn in a room that's not too close to the streamer
    const attempts = 20;
    for (let i = 0; i < attempts; i++) {
      const room = this.map.rooms[Math.floor(Math.random() * this.map.rooms.length)];
      
      // Find floor tiles in this room
      const candidates: Vec[] = [];
      for (let ty = room.y + 1; ty < room.y + room.h - 1; ty++) {
        for (let tx = room.x + 1; tx < room.x + room.w - 1; tx++) {
          if (tx >= 0 && tx < this.map.w && ty >= 0 && ty < this.map.h) {
            const tile = this.map.tiles[ty * this.map.w + tx];
            if (tile === 0) { // floor tile
              const worldX = tx * this.map.size + this.map.size / 2;
              const worldY = ty * this.map.size + this.map.size / 2;
              
              // Check distance from streamer (not too close, not too far)
              const dist = Math.hypot(worldX - streamerPos.x, worldY - streamerPos.y);
              if (dist > 150 && dist < 400) {
                candidates.push({ x: worldX, y: worldY });
              }
            }
          }
        }
      }
      
      if (candidates.length > 0) {
        return candidates[Math.floor(Math.random() * candidates.length)];
      }
    }
    
    return null;
  }
  
  updateAIZombies(now: number) {
    const streamer = [...this.players.values()].find(p => p.role === "streamer");
    const dt = this.tickMs / 1000;
    
    for (let i = this.aiZombies.length - 1; i >= 0; i--) {
      const zombie = this.aiZombies[i];
      
      // Remove dead zombies
      if (zombie.hp <= 0) {
        // Drop random pickup (ammo or treasure) - only if drop chance succeeds
        const dropType = this.getRandomZombieDrop();
        if (dropType) {
          this.pickups.push({ 
            id: crypto.randomUUID().slice(0, 6), 
            type: dropType, 
            x: zombie.pos.x, 
            y: zombie.pos.y 
          });
        }
        this.aiZombies.splice(i, 1);
        continue;
      }
      
      if (!streamer) {
        zombie.state = "idle";
        continue;
      }
      
      const distToStreamer = Math.hypot(zombie.pos.x - streamer.pos.x, zombie.pos.y - streamer.pos.y);
      const hasLineOfSight = this.hasLineOfSight(zombie.pos, streamer.pos);
      
      // State machine
      switch (zombie.state) {
        case "idle":
          if (distToStreamer <= zombie.detectionRange && hasLineOfSight) {
            zombie.state = "chasing";
            zombie.targetId = streamer.id;
            zombie.lastSeen = now;
          }
          break;
          
        case "chasing":
          if (distToStreamer > zombie.chaseRange) {
            zombie.state = "idle";
            zombie.targetId = undefined;
          } else if (distToStreamer <= 20) {
            zombie.state = "attacking";
            zombie.lastAttack = now;
          } else if (hasLineOfSight) {
            zombie.lastSeen = now;
          }
          break;
          
        case "attacking":
          if (distToStreamer > 30) {
            zombie.state = "chasing";
          } else if (now - zombie.lastAttack > 1000) { // Attack every second
            this.aiZombieAttackStreamer(zombie, streamer, now);
            zombie.lastAttack = now;
          }
          break;
      }
      
      // Movement AI
      this.updateAIZombieMovement(zombie, streamer, now, dt);
      
      // Apply movement with collision
      this.moveAIZombie(zombie, dt);
    }
  }
  
  hasLineOfSight(from: Vec, to: Vec): boolean {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const distance = Math.hypot(dx, dy);
    
    if (distance === 0) return true;
    
    const steps = Math.ceil(distance / 16); // Check every 16 pixels
    const stepX = dx / steps;
    const stepY = dy / steps;
    
    for (let i = 1; i < steps; i++) {
      const checkX = from.x + stepX * i;
      const checkY = from.y + stepY * i;
      
      // Check if this point intersects with walls
      for (const wall of this.walls) {
        if (checkX >= wall.x && checkX <= wall.x + wall.w &&
            checkY >= wall.y && checkY <= wall.y + wall.h) {
          return false;
        }
      }
    }
    
    return true;
  }
  
  updateAIZombieMovement(zombie: AIZombie, streamer: Player, now: number, dt: number) {
    if (zombie.state === "idle") {
      zombie.vel.x = 0;
      zombie.vel.y = 0;
      return;
    }
    
    // Simple AI movement toward streamer
    const dx = streamer.pos.x - zombie.pos.x;
    const dy = streamer.pos.y - zombie.pos.y;
    const distance = Math.hypot(dx, dy);
    
    if (distance > 0) {
      const baseSpeed = this.cfg.speeds.zombie * this.cfg.zombies.speedMul[zombie.zClass];
      const speed = (this.zombieSlowUntil || 0) > now ? baseSpeed * this.cfg.speeds.zombieSlowMultiplier : baseSpeed;
      
      zombie.vel.x = (dx / distance) * speed;
      zombie.vel.y = (dy / distance) * speed;
    }
  }
  
  moveAIZombie(zombie: AIZombie, dt: number) {
    // Intended new position
    let nx = zombie.pos.x + zombie.vel.x * dt;
    let ny = zombie.pos.y + zombie.vel.y * dt;
    
    // Tile collision
    if (this.map) {
      const sz = this.map.size;
      const ix = Math.max(0, Math.min(this.map.w-1, Math.floor(nx / sz)));
      const iy = Math.max(0, Math.min(this.map.h-1, Math.floor(ny / sz)));
      const t = this.map.tiles[iy*this.map.w + ix] as TileId;
      
      const isSolid = (tt:TileId)=> tt===1 || tt===4; // wall or doorClosed
      const isLethal = (tt:TileId)=> tt===2; // pit
      const isSlow = (tt:TileId)=> tt===3; // water/sludge
      
      if (isSlow(t)) { 
        nx = zombie.pos.x + (zombie.vel.x * 0.6) * dt; 
        ny = zombie.pos.y + (zombie.vel.y * 0.6) * dt;
      }
      if (isSolid(t)) { 
        nx = zombie.pos.x; 
        ny = zombie.pos.y; 
      }
      if (isLethal(t)) {
        // Respawn zombie in a different location
        const newPos = this.getAIZombieSpawnPosition({ x: this.W/2, y: this.H/2 });
        if (newPos) {
          zombie.pos = newPos;
          return;
        }
      }
    }
    
    zombie.pos.x = Math.max(0, Math.min(this.W, nx));
    zombie.pos.y = Math.max(0, Math.min(this.H, ny));
    
    // Wall collision
    const pr = this.cfg.radii.zombie;
    for (const rct of this.walls) {
      const nearestX = Math.max(rct.x, Math.min(zombie.pos.x, rct.x + rct.w));
      const nearestY = Math.max(rct.y, Math.min(zombie.pos.y, rct.y + rct.h));
      let dx = zombie.pos.x - nearestX; 
      let dy = zombie.pos.y - nearestY; 
      let dist = Math.hypot(dx, dy);
      
      if (dist < pr) {
        if (dist === 0) {
          // Push out along smallest penetration axis
          const left = Math.abs(zombie.pos.x - rct.x);
          const right = Math.abs(rct.x + rct.w - zombie.pos.x);
          const top = Math.abs(zombie.pos.y - rct.y);
          const bottom = Math.abs(rct.y + rct.h - zombie.pos.y);
          const m = Math.min(left, right, top, bottom);
          if (m === left) zombie.pos.x = rct.x - pr;
          else if (m === right) zombie.pos.x = rct.x + rct.w + pr;
          else if (m === top) zombie.pos.y = rct.y - pr;
          else zombie.pos.y = rct.y + rct.h + pr;
        } else {
          const nx = dx / dist, ny = dy / dist;
          const push = (pr - dist) + 0.5;
          zombie.pos.x += nx * push; 
          zombie.pos.y += ny * push;
        }
      }
    }
  }
  
  aiZombieAttackStreamer(zombie: AIZombie, streamer: Player, now: number) {
    const shielded = ((streamer as any).shieldUntil || 0) > now;
    if (shielded) return;
    
    if ((streamer.hp ?? this.cfg.streamer.maxHp) > 0) {
      streamer.hp = Math.max(0, (streamer.hp ?? this.cfg.streamer.maxHp) - this.cfg.combat.zombieTouchDamage);
    }
    
    if ((streamer.hp ?? 0) <= 0) {
      // Respawn streamer; lose unbanked on death (keep banked)
      streamer.pos = this.spawnInRandomRoom();
      streamer.hp = streamer.maxHp ?? this.cfg.streamer.maxHp;
      streamer.score = 0;
    }
    
    // Knockback streamer slightly
    const dx = streamer.pos.x - zombie.pos.x; 
    const dy = streamer.pos.y - zombie.pos.y; 
    const d = Math.hypot(dx, dy) || 1;
    const kbMul = (zombie.zClass === 'brute') ? this.cfg.zombies.brute.extraKnockbackMul : 1;
    streamer.pos.x = Math.max(0, Math.min(this.W, streamer.pos.x + (dx / d) * this.cfg.combat.knockbackStep * kbMul));
    streamer.pos.y = Math.max(0, Math.min(this.H, streamer.pos.y + (dy / d) * this.cfg.combat.knockbackStep * kbMul));
  }

  broadcastState() {
    const snapshot = {
      type: "state",
      t: Date.now(),
      players: [...this.players.values()].map(this.publicPlayer),
      bullets: this.bullets.map(b => ({ id: b.id, x: b.pos.x, y: b.pos.y, ownerId: b.ownerId })),
      globs: this.spittles.map(g => ({ id: g.id, x: g.pos.x, y: g.pos.y })),
      walls: this.walls.map(o => ({ id: o.id, x: o.x, y: o.y, w: o.w, h: o.h })),
      pickups: this.pickups.map(pk => ({ id: pk.id, type: pk.type, x: pk.x, y: pk.y })),
      extractions: this.extractions.map(e => ({ id: e.id, x: e.x, y: e.y, r: e.r, activeUntil: e.activeUntil })),
      aiZombies: this.aiZombies.map(z => ({ 
        id: z.id, 
        x: z.pos.x, 
        y: z.pos.y, 
        hp: z.hp, 
        maxHp: z.maxHp, 
        zClass: z.zClass, 
        state: z.state,
        detectionRange: z.detectionRange,
        chaseRange: z.chaseRange
      })),
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
    banked: p.banked ?? 0,
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
    dashing: (p.dashUntil || 0) > Date.now(),
    lastDashAt: p.lastDashAt || 0,
    dashReadyAt: (p.lastDashAt || 0) + this.cfg.dash.cooldownMs,
    zClass: p.zClass || "",
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

  spawnInRandomRoom(): Vec {
    // Spawn within a random room
    if (!this.map || this.map.rooms.length === 0) {
      // Fallback to center if no rooms available
      return { x: this.W / 2, y: this.H / 2 };
    }
    
    const room = this.map.rooms[Math.floor(Math.random() * this.map.rooms.length)];
    const tileSize = this.map.size;
    
    // Convert room coordinates to world coordinates and add some padding
    const padding = tileSize * 0.5; // Half tile padding from walls
    const worldX = (room.x + 1) * tileSize + padding + Math.random() * ((room.w - 2) * tileSize - padding * 2);
    const worldY = (room.y + 1) * tileSize + padding + Math.random() * ((room.h - 2) * tileSize - padding * 2);
    
    return { x: worldX, y: worldY };
  }

  spawnZombiePos(): Vec {
    return this.spawnInRandomRoom();
  }

  // Map generation and helpers
  generateTileMapAndWalls() {
    const size = this.cfg.tiles.size;
    const gw = Math.max(10, Math.floor(this.W / size));
    const gh = Math.max(8, Math.floor(this.H / size));
    const theme: 'dungeon'|'cave'|'lab' = this.cfg.tiles.theme || 'dungeon';
    const tiles = new Uint8Array(gw*gh);
    // Fill with walls (1)
    tiles.fill(1);
    // Carve simple BSP-like rooms and corridors
    const rooms: {x:number;y:number;w:number;h:number}[] = [];
    const carveRoom = (x:number,y:number,w:number,h:number)=>{
      for (let j=y; j<y+h; j++) for (let i=x; i<x+w; i++) if (i>0&&i<gw-1&&j>0&&j<gh-1) tiles[j*gw+i]=0;
      rooms.push({x,y,w,h});
    };
    // Generate many more rooms using grid-based layout
    const gridCellsX = Math.floor(gw / 20); // Cells of ~20 tiles each
    const gridCellsY = Math.floor(gh / 15);
    const cellWidth = Math.floor(gw / gridCellsX);
    const cellHeight = Math.floor(gh / gridCellsY);
    
    // Room types for variety
    const roomTypes = ['small', 'medium', 'large', 'hall', 'chamber', 'vault'];
    
    for (let gy = 0; gy < gridCellsY; gy++) {
      for (let gx = 0; gx < gridCellsX; gx++) {
        // 70% chance to place a room in each grid cell
        if (Math.random() < 0.7) {
          const baseX = gx * cellWidth;
          const baseY = gy * cellHeight;
          const roomType = roomTypes[Math.floor(Math.random() * roomTypes.length)];
          
          let rw, rh;
          switch(roomType) {
            case 'small':
              rw = 5 + Math.floor(Math.random() * 4); // 5-8
              rh = 4 + Math.floor(Math.random() * 3); // 4-6
              break;
            case 'medium':
              rw = 8 + Math.floor(Math.random() * 5); // 8-12
              rh = 6 + Math.floor(Math.random() * 4); // 6-9
              break;
            case 'large':
              rw = 12 + Math.floor(Math.random() * 6); // 12-17
              rh = 8 + Math.floor(Math.random() * 5); // 8-12
              break;
            case 'hall':
              rw = 15 + Math.floor(Math.random() * 8); // 15-22 (long halls)
              rh = 4 + Math.floor(Math.random() * 2); // 4-5 (narrow)
              break;
            case 'chamber':
              rw = 10 + Math.floor(Math.random() * 4); // 10-13 (square-ish)
              rh = 9 + Math.floor(Math.random() * 4); // 9-12
              break;
            case 'vault':
              rw = 6 + Math.floor(Math.random() * 3); // 6-8 (small but important)
              rh = 5 + Math.floor(Math.random() * 2); // 5-6
              break;
            default:
              rw = 8 + Math.floor(Math.random() * 4);
              rh = 6 + Math.floor(Math.random() * 3);
          }
          
          // Ensure room fits in grid cell with margin
          rw = Math.min(rw, cellWidth - 2);
          rh = Math.min(rh, cellHeight - 2);
          
          const rx = baseX + 1 + Math.floor(Math.random() * Math.max(1, cellWidth - rw - 2));
          const ry = baseY + 1 + Math.floor(Math.random() * Math.max(1, cellHeight - rh - 2));
          
          // Ensure room is within bounds
          if (rx + rw < gw - 1 && ry + rh < gh - 1) {
            carveRoom(rx, ry, rw, rh);
          }
        }
      }
    }
    // Create extensive corridor network to connect rooms
    // First, connect adjacent rooms in grid for guaranteed connectivity
    for (let gy = 0; gy < gridCellsY; gy++) {
      for (let gx = 0; gx < gridCellsX; gx++) {
        const currentRooms = rooms.filter(r => 
          r.x >= gx * cellWidth && r.x < (gx + 1) * cellWidth &&
          r.y >= gy * cellHeight && r.y < (gy + 1) * cellHeight
        );
        
        if (currentRooms.length === 0) continue;
        const currentRoom = currentRooms[0];
        
        // Connect to right neighbor
        if (gx < gridCellsX - 1) {
          const rightRooms = rooms.filter(r => 
            r.x >= (gx + 1) * cellWidth && r.x < (gx + 2) * cellWidth &&
            r.y >= gy * cellHeight && r.y < (gy + 1) * cellHeight
          );
          
          if (rightRooms.length > 0) {
            const rightRoom = rightRooms[0];
            const corridorY = Math.floor((currentRoom.y + currentRoom.h/2 + rightRoom.y + rightRoom.h/2) / 2);
            const corridorWidth = 2 + Math.floor(Math.random() * 2);
            
            for (let offset = -Math.floor(corridorWidth/2); offset <= Math.floor(corridorWidth/2); offset++) {
              const cy = corridorY + offset;
              if (cy > 0 && cy < gh - 1) {
                for (let cx = currentRoom.x + currentRoom.w; cx < rightRoom.x; cx++) {
                  if (cx > 0 && cx < gw - 1) tiles[cy * gw + cx] = 0;
                }
              }
            }
          }
        }
        
        // Connect to bottom neighbor
        if (gy < gridCellsY - 1) {
          const bottomRooms = rooms.filter(r => 
            r.x >= gx * cellWidth && r.x < (gx + 1) * cellWidth &&
            r.y >= (gy + 1) * cellHeight && r.y < (gy + 2) * cellHeight
          );
          
          if (bottomRooms.length > 0) {
            const bottomRoom = bottomRooms[0];
            const corridorX = Math.floor((currentRoom.x + currentRoom.w/2 + bottomRoom.x + bottomRoom.w/2) / 2);
            const corridorWidth = 2 + Math.floor(Math.random() * 2);
            
            for (let offset = -Math.floor(corridorWidth/2); offset <= Math.floor(corridorWidth/2); offset++) {
              const cx = corridorX + offset;
              if (cx > 0 && cx < gw - 1) {
                for (let cy = currentRoom.y + currentRoom.h; cy < bottomRoom.y; cy++) {
                  if (cy > 0 && cy < gh - 1) tiles[cy * gw + cx] = 0;
                }
              }
            }
          }
        }
      }
    }
    
    // Add random long-distance connections for shortcuts and loops
    const numLongConnections = Math.floor(rooms.length * 0.15); // 15% of rooms get long connections
    for (let i = 0; i < numLongConnections; i++) {
      const roomA = rooms[Math.floor(Math.random() * rooms.length)];
      const roomB = rooms[Math.floor(Math.random() * rooms.length)];
      
      if (roomA === roomB) continue;
      
      const ax = Math.floor(roomA.x + roomA.w/2);
      const ay = Math.floor(roomA.y + roomA.h/2);
      const bx = Math.floor(roomB.x + roomB.w/2);
      const by = Math.floor(roomB.y + roomB.h/2);
      
      // Create L-shaped corridor
      const corridorWidth = 2;
      
      // Horizontal segment
      const minx = Math.min(ax, bx);
      const maxx = Math.max(ax, bx);
      for (let offset = -Math.floor(corridorWidth/2); offset <= Math.floor(corridorWidth/2); offset++) {
        const cy = ay + offset;
        if (cy > 0 && cy < gh - 1) {
          for (let cx = minx; cx <= maxx; cx++) {
            if (cx > 0 && cx < gw - 1) tiles[cy * gw + cx] = 0;
          }
        }
      }
      
      // Vertical segment
      const miny = Math.min(ay, by);
      const maxy = Math.max(ay, by);
      for (let offset = -Math.floor(corridorWidth/2); offset <= Math.floor(corridorWidth/2); offset++) {
        const cx = bx + offset;
        if (cx > 0 && cx < gw - 1) {
          for (let cy = miny; cy <= maxy; cy++) {
            if (cy > 0 && cy < gh - 1) tiles[cy * gw + cx] = 0;
          }
        }
      }
    }
    
    // Add environmental variety
    // Water/sludge areas (slow movement)
    const numWaterAreas = Math.floor(rooms.length * 0.08);
    for (let i = 0; i < numWaterAreas; i++) {
      const wx = 3 + Math.floor(Math.random() * (gw - 10));
      const wy = 3 + Math.floor(Math.random() * (gh - 8));
      const ww = 3 + Math.floor(Math.random() * 6);
      const wh = 2 + Math.floor(Math.random() * 5);
      
      for (let j = wy; j < wy + wh && j < gh - 1; j++) {
        for (let i = wx; i < wx + ww && i < gw - 1; i++) {
          if (tiles[j * gw + i] === 0) { // Only replace floor tiles
            tiles[j * gw + i] = 3; // Water/sludge
          }
        }
      }
    }
    
    // Pit traps (lethal)
    const numPits = Math.floor(rooms.length * 0.05);
    for (let i = 0; i < numPits; i++) {
      const px = 2 + Math.floor(Math.random() * (gw - 6));
      const py = 2 + Math.floor(Math.random() * (gh - 6));
      
      if (tiles[py * gw + px] === 0) {
        tiles[py * gw + px] = 2; // Pit
        // Sometimes create larger pit areas
        if (Math.random() < 0.4) {
          const pitSize = 1 + Math.floor(Math.random() * 2);
          for (let dy = 0; dy <= pitSize && py + dy < gh - 1; dy++) {
            for (let dx = 0; dx <= pitSize && px + dx < gw - 1; dx++) {
              if (tiles[(py + dy) * gw + (px + dx)] === 0) {
                tiles[(py + dy) * gw + (px + dx)] = 2;
              }
            }
          }
        }
      }
    }
    // Add border walls kept
    // Props/Lights - Scale with map size for immersive exploration
    const props: {x:number;y:number;type:'crate'|'pillar'|'bonepile'}[] = [];
    const lights: {x:number;y:number;r:number;a:number}[] = [];
    
    // Scale props with map size - aim for 1 prop per ~300 tiles
    const numProps = Math.floor((gw * gh) / 300);
    for (let k = 0; k < numProps; k++){
      props.push({ 
        x: 2 + Math.floor(Math.random() * (gw - 4)), 
        y: 2 + Math.floor(Math.random() * (gh - 4)), 
        type: (['crate','pillar','bonepile'] as const)[Math.floor(Math.random() * 3)] 
      });
    }
    
    // Scale lights with map size - more atmospheric lighting for exploration
    const numLights = Math.floor((gw * gh) / 500);
    for (let k = 0; k < numLights; k++){
      lights.push({ 
        x: 2 + Math.floor(Math.random() * (gw - 4)), 
        y: 2 + Math.floor(Math.random() * (gh - 4)), 
        r: 3 + Math.floor(Math.random() * 8), 
        a: 0.08 + Math.random() * 0.25 
      });
    }
    this.map = { w: gw, h: gh, size, theme, tiles, props, lights, rooms };
    // Derive collision rects from wall tiles via greedy merge
    this.walls = this.greedyRectsFromTiles(tiles, gw, gh, size);
    this.mapReady = true;
  }

  greedyRectsFromTiles(tiles: Uint8Array, gw:number, gh:number, size:number): Rect[] {
    const used = new Uint8Array(gw*gh);
    const rects: Rect[] = [];
    const isWall = (x:number,y:number)=> x>=0&&y>=0&&x<gw&&y<gh && tiles[y*gw+x]===1;
    for (let y=0;y<gh;y++){
      for (let x=0;x<gw;x++){
        const idx=y*gw+x;
        if (used[idx]) continue;
        if (!isWall(x,y)) continue;
        // grow width
        let w=1;
        while (isWall(x+w,y) && !used[y*gw + (x+w)]) w++;
        // grow height while full row of width
        let h=1; outer: while (y+h<gh){
          for (let xx=0; xx<w; xx++){ if (!isWall(x+xx,y+h) || used[(y+h)*gw+(x+xx)]) break outer; }
          h++;
        }
        for (let yy=0; yy<h; yy++) for (let xx=0; xx<w; xx++) used[(y+yy)*gw+(x+xx)]=1;
        rects.push({ id: crypto.randomUUID().slice(0,6), x: x*size, y: y*size, w: w*size, h: h*size });
      }
    }
    return rects;
  }

  u8ToBase64(u8: Uint8Array){
    // Convert to base64 without Buffer
    let s='';
    for (let i=0;i<u8.length;i++) s += String.fromCharCode(u8[i]);
    // @ts-ignore
    if (typeof btoa === 'function') return btoa(s);
    // Fallback simple base64
    // minimal polyfill
    // This is a light path; environment should have btoa.
    return (globalThis as any).Buffer ? (globalThis as any).Buffer.from(u8).toString('base64') : s;
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

  pickZombieClass(): "runner" | "brute" | "spitter" {
    const w = this.cfg.zombies.weights;
    const bag: Array<"runner"|"brute"|"spitter"> = [];
    for (let i=0;i<w.runner;i++) bag.push('runner');
    for (let i=0;i<w.brute;i++) bag.push('brute');
    for (let i=0;i<w.spitter;i++) bag.push('spitter');
    return bag[Math.floor(Math.random()*bag.length)] || 'runner';
  }

  randRange(a:number,b:number){ return a + Math.floor(Math.random()*(b-a+1)); }

  // M1: Extraction helpers
  spawnExtractions() {
    // Spawn exactly 1 extraction zone in a room accessible to the streamer
    let exPos: Vec | null = null;
    const streamer = [...this.players.values()].find(p => p.role === "streamer");
    
    if (this.map && this.map.rooms && this.map.rooms.length > 0 && streamer) {
      // Find streamer's current room
      const streamerTileX = Math.floor(streamer.pos.x / this.map.size);
      const streamerTileY = Math.floor(streamer.pos.y / this.map.size);
      
      // Get all accessible rooms using flood fill from streamer position
      const accessibleRooms = this.getAccessibleRooms(streamerTileX, streamerTileY);
      
      if (accessibleRooms.length > 0) {
        // Pick a random accessible room
        const room = accessibleRooms[Math.floor(Math.random() * accessibleRooms.length)];
        
        // Find a good floor position in this room
        const candidates: Vec[] = [];
        for (let ty = room.y + 1; ty < room.y + room.h - 1; ty++) {
          for (let tx = room.x + 1; tx < room.x + room.w - 1; tx++) {
            if (tx >= 0 && tx < this.map.w && ty >= 0 && ty < this.map.h) {
              const tile = this.map.tiles[ty * this.map.w + tx];
              if (tile === 0) { // floor tile
                const worldX = tx * this.map.size + this.map.size / 2;
                const worldY = ty * this.map.size + this.map.size / 2;
                candidates.push({ x: worldX, y: worldY });
              }
            }
          }
        }
        
        if (candidates.length > 0) {
          // Prefer center positions
          const centerX = (room.x + room.w / 2) * this.map.size;
          const centerY = (room.y + room.h / 2) * this.map.size;
          
          candidates.sort((a, b) => {
            const distA = Math.hypot(a.x - centerX, a.y - centerY);
            const distB = Math.hypot(b.x - centerX, b.y - centerY);
            return distA - distB;
          });
          
          // Pick from the most central positions
          const topCandidates = candidates.slice(0, Math.max(1, Math.floor(candidates.length * 0.3)));
          exPos = topCandidates[Math.floor(Math.random() * topCandidates.length)];
        }
      }
    }
    
    // Fallback: spawn near streamer if no accessible rooms found
    if (!exPos && streamer) {
      // Try positions in a radius around the streamer
      for (let attempts = 0; attempts < 20; attempts++) {
        const angle = Math.random() * Math.PI * 2;
        const dist = 100 + Math.random() * 200;
        const testX = streamer.pos.x + Math.cos(angle) * dist;
        const testY = streamer.pos.y + Math.sin(angle) * dist;
        
        if (testX >= 0 && testX < this.W && testY >= 0 && testY < this.H) {
          const tileX = Math.floor(testX / this.map!.size);
          const tileY = Math.floor(testY / this.map!.size);
          
          if (tileX >= 0 && tileX < this.map!.w && tileY >= 0 && tileY < this.map!.h) {
            const tile = this.map!.tiles[tileY * this.map!.w + tileX];
            if (tile === 0) { // floor tile
              exPos = { x: testX, y: testY };
              break;
            }
          }
        }
      }
    }
    
    // Final fallback
    if (!exPos) {
      exPos = this.randomFreePos(32);
    }
    
    if (exPos) {
      this.extractions.push({ 
        id: crypto.randomUUID().slice(0, 6), 
        x: exPos.x, 
        y: exPos.y, 
        r: this.cfg.extraction.radius 
      });
    }
  }

  // Get all rooms accessible from a starting tile position
  getAccessibleRooms(startX: number, startY: number): Array<{x: number; y: number; w: number; h: number}> {
    if (!this.map || !this.map.rooms) return [];
    
    // Use flood fill to find all reachable tiles
    const reachable = new Set<string>();
    const queue: Array<[number, number]> = [[startX, startY]];
    const visited = new Set<string>();
    
    const isWalkable = (x: number, y: number): boolean => {
      if (x < 0 || x >= this.map!.w || y < 0 || y >= this.map!.h) return false;
      const tile = this.map!.tiles[y * this.map!.w + x];
      return tile === 0; // Only floor tiles (no doors since we removed them)
    };
    
    while (queue.length > 0) {
      const [x, y] = queue.shift()!;
      const key = `${x},${y}`;
      
      if (visited.has(key)) continue;
      visited.add(key);
      
      if (!isWalkable(x, y)) continue;
      
      reachable.add(key);
      
      // Add adjacent tiles
      const neighbors = [[x+1,y], [x-1,y], [x,y+1], [x,y-1]];
      for (const [nx, ny] of neighbors) {
        const nKey = `${nx},${ny}`;
        if (!visited.has(nKey)) {
          queue.push([nx, ny]);
        }
      }
    }
    
    // Find which rooms contain reachable tiles
    const accessibleRooms: Array<{x: number; y: number; w: number; h: number}> = [];
    
    for (const room of this.map.rooms) {
      let hasReachableTile = false;
      
      for (let ty = room.y; ty < room.y + room.h && !hasReachableTile; ty++) {
        for (let tx = room.x; tx < room.x + room.w && !hasReachableTile; tx++) {
          if (reachable.has(`${tx},${ty}`)) {
            hasReachableTile = true;
          }
        }
      }
      
      if (hasReachableTile) {
        accessibleRooms.push(room);
      }
    }
    
    return accessibleRooms;
  }

  // Flood fill to find all tiles reachable from starting position
  getReachableTiles(startX: number, startY: number): Set<string> {
    if (!this.map) return new Set();
    
    const reachable = new Set<string>();
    const queue: Array<[number, number]> = [[startX, startY]];
    const visited = new Set<string>();
    
    const isWalkable = (x: number, y: number): boolean => {
      if (x < 0 || x >= this.map!.w || y < 0 || y >= this.map!.h) return false;
      const tile = this.map!.tiles[y * this.map!.w + x];
      return tile === 0 || tile === 5; // floor or doorOpen
    };
    
    while (queue.length > 0) {
      const [x, y] = queue.shift()!;
      const key = `${x},${y}`;
      
      if (visited.has(key)) continue;
      visited.add(key);
      
      if (!isWalkable(x, y)) continue;
      
      reachable.add(key);
      
      // Add adjacent tiles to queue
      const neighbors = [[x+1,y], [x-1,y], [x,y+1], [x,y-1]];
      for (const [nx, ny] of neighbors) {
        const nKey = `${nx},${ny}`;
        if (!visited.has(nKey)) {
          queue.push([nx, ny]);
        }
      }
    }
    
    return reachable;
  }

  rotateExtractionIfNeeded(nowMs: number) {
    if (this.extractions.length === 0) return;
    const active = this.extractions.find(e => (e.activeUntil || 0) > nowMs);
    if (active) return;
    // Choose a new extraction and set active window
    const idx = Math.floor(Math.random() * this.extractions.length);
    const dur = this.cfg.extraction.minActiveMs + Math.floor(Math.random() * (this.cfg.extraction.maxActiveMs - this.cfg.extraction.minActiveMs + 1));
    for (let i = 0; i < this.extractions.length; i++) this.extractions[i].activeUntil = undefined;
    this.extractions[idx].activeUntil = nowMs + dur;
    // Announce change
    this.broadcast("notice", { message: "Extraction moved!" });
  }
}
