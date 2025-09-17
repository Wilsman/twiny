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

import type { ModId } from './types';

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
  level?: number; // streamer only
  xp?: number;    // streamer only
  mods?: Partial<Record<ModId, number>>; // stack counts
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
  zClass?: "runner" | "brute" | "spitter" | "stalker" | "bomber";
  zHp?: number;
  zMaxHp?: number;
  nextSpitAt?: number;
  lastAbilityAt?: number;
  chargeUntil?: number;
  chargeDirX?: number;
  chargeDirY?: number;
  // Status effects (zombies only)
  slowUntil?: number;
  slowMul?: number;
  burns?: Array<{ until:number; dps:number; nextTick:number; ownerId:string }>;
  bleeds?: Array<{ until:number; dps:number; nextTick:number; ownerId:string }>;
  // New zombie abilities
  cloaked?: boolean;
  cloakUntil?: number;
  uncloakUntil?: number;
  fuseStarted?: number;
  fuseUntil?: number;
  lastShieldRegen?: number;
}

import { XP_PER_KILL, XP_THRESHOLDS, rollChoices, MOD_INDEX, statsFor, statusFrom } from './upgrades';
import type { ActiveBullet, BulletSpawnSpec, Boss, BossMinion, PoisonField, BossType } from './types';

type Bullet = ActiveBullet;

interface Rect { id: string; x: number; y: number; w: number; h: number }
  // Extractions removed
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
  zClass: "runner" | "brute" | "spitter" | "stalker" | "bomber";
  state: "idle" | "chasing" | "attacking";
  targetId?: string;
  lastSeen: number;
  lastAttack: number;
  detectionRange: number;
  chaseRange: number;
  roomId?: string;
  pathfindingCooldown: number;
  nextPathUpdate: number;
  // Status effects
  slowUntil?: number;
  slowMul?: number;
  burns?: Array<{ until:number; dps:number; nextTick:number; ownerId:string }>;
  bleeds?: Array<{ until:number; dps:number; nextTick:number; ownerId:string }>;
  // New zombie abilities
  cloaked?: boolean;
  cloakUntil?: number;
  uncloakUntil?: number;
  fuseStarted?: number;
  fuseUntil?: number;
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
  // Boss system properties
  bosses: Boss[] = [];
  bossMinions: BossMinion[] = [];
  poisonFields: PoisonField[] = [];
  lastBossSpawn = 0;
  nextBossAnnouncement?: number;
  bossSpawnCooldown = CONFIG.bosses.spawnIntervalMs;
  // Damage numbers for visual feedback
  damageNumbers: Array<{id: string; x: number; y: number; damage: number; isCrit: boolean; isDot: boolean; timestamp: number}> = [];
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
          p.level = 0; p.xp = 0; p.mods = {};
          // Initialize raid stats
          this.initRaidStats(p);
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
        case 'choose_upgrade': {
          const p = this.players.get(pid);
          if (!p || p.role !== 'streamer') return;
          const id = String(msg.id||'');
          if (!MOD_INDEX[id as keyof typeof MOD_INDEX]) return;
          this.applyUpgrade(p.id, id as any);
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
        // attempt_extract removed
      }
    } catch {}
  }

  onClose(pid: string) {
    const p = this.players.get(pid);
    if (!p) return;
    // Handle explosive death upgrade
    if (p.role === 'streamer' && p.mods) {
      const { s } = statsFor(p);
      if (s.explosiveDeathDamage > 0) {
        this.createExplosion(p.pos.x, p.pos.y, s.explosiveDeathDamage, 60, p.id);
      }
    }
    this.players.delete(pid);
    this.broadcast("players_update", { players: [...this.players.values()].map(this.publicPlayer) });
  }

  processUpgradeEffects(now: number) {
    for (const p of this.players.values()) {
      if (p.role !== 'streamer' || !p.mods) continue;
      const { s } = statsFor(p);
      
      // Shield regeneration (auto-repair)
      if (s.shieldRegenRate > 0) {
        if (!p.lastShieldRegen || now - p.lastShieldRegen >= 3000) {
          if ((p.hp ?? 0) < (p.maxHp ?? this.cfg.streamer.maxHp)) {
            p.hp = Math.min((p.maxHp ?? this.cfg.streamer.maxHp), (p.hp ?? 0) + 1);
            p.lastShieldRegen = now;
          }
        }
      }
      
      // Time dilation (bullet time when low health)
      if (s.timeDilationMs > 0) {
        const healthPct = (p.hp || 0) / (p.maxHp || this.cfg.streamer.maxHp);
        if (healthPct <= 0.25 && !((p as any).timeDilationUntil > now)) {
          (p as any).timeDilationUntil = now + s.timeDilationMs;
          this.broadcast('notice', { message: '⏰ Time slows as death approaches...' });
        }
      }
      
      // Bullet time during dash
      if (s.bulletTimeMs > 0 && (p.dashUntil || 0) > now) {
        (p as any).bulletTimeUntil = Math.max((p as any).bulletTimeUntil || 0, now + s.bulletTimeMs);
      }
    }
  }
  
  createExplosion(x: number, y: number, damage: number, radius: number, ownerId: string) {
    // Damage all zombies in radius
    for (const z of this.players.values()) {
      if (z.role !== 'zombie' || !z.alive) continue;
      const dist = Math.hypot(z.pos.x - x, z.pos.y - y);
      if (dist <= radius) {
        const dmg = Math.round(damage * (1 - dist / radius)); // Falloff damage
        z.zHp = Math.max(0, (z.zHp ?? this.cfg.zombies.baseHp) - dmg);
        // Add damage number
        this.addDamageNumber(z.pos.x, z.pos.y, dmg, false, false);
        if ((z.zHp ?? 0) <= 0) {
          z.alive = false;
          this.pickups.push({ id: crypto.randomUUID().slice(0,6), type: 'ammo', x: z.pos.x, y: z.pos.y });
          const id = z.id;
          setTimeout(() => { const zp = this.players.get(id); if (zp) { zp.pos = this.spawnZombiePos(); zp.alive = true; zp.zHp = zp.zMaxHp; } }, this.cfg.combat.respawnMs);
        }
      }
    }
    // Damage AI zombies
    for (const z of this.aiZombies) {
      const dist = Math.hypot(z.pos.x - x, z.pos.y - y);
      if (dist <= radius) {
        const dmg = Math.round(damage * (1 - dist / radius));
        z.hp = Math.max(0, z.hp - dmg);
        // Add damage number for AI zombies
        this.addDamageNumber(z.pos.x, z.pos.y, dmg, false, false);
      }
    }
    this.broadcast('notice', { message: '💥 Explosive death!' });
  }
  
  processZombieAbilities(now: number) {
    // Process player zombies
    for (const z of this.players.values()) {
      if (z.role !== 'zombie' || !z.alive) continue;
      
      // Stalker cloaking mechanics
      if (z.zClass === 'stalker') {
        if (!z.cloakUntil) {
          z.cloakUntil = now + this.cfg.zombies.stalker.cloakDurationMs;
          z.cloaked = true;
        } else if (z.cloakUntil < now && z.cloaked) {
          z.cloaked = false;
          z.uncloakUntil = now + this.cfg.zombies.stalker.uncloakDurationMs;
        } else if (z.uncloakUntil && z.uncloakUntil < now) {
          z.cloakUntil = now + this.cfg.zombies.stalker.cloakDurationMs;
          z.cloaked = true;
          z.uncloakUntil = undefined;
        }
      }
      
      // Bomber fuse mechanics
      if (z.zClass === 'bomber' && z.zHp && z.zHp <= (z.zMaxHp || 100) * 0.3) {
        if (!z.fuseStarted) {
          z.fuseStarted = now;
          z.fuseUntil = now + this.cfg.zombies.bomber.fuseTimeMs;
          this.broadcast('notification', { message: `Bomber ${z.name} is about to explode!` });
        }
        
        if (z.fuseUntil && now >= z.fuseUntil) {
          this.bomberExplode(z, now);
        }
      }
    }
    
    // Process AI zombies
    for (const z of this.aiZombies) {
      // Stalker cloaking for AI
      if (z.zClass === 'stalker') {
        if (!z.cloakUntil) {
          z.cloakUntil = now + this.cfg.zombies.stalker.cloakDurationMs;
          z.cloaked = true;
        } else if (z.cloakUntil < now && z.cloaked) {
          z.cloaked = false;
          z.uncloakUntil = now + this.cfg.zombies.stalker.uncloakDurationMs;
        } else if (z.uncloakUntil && z.uncloakUntil < now) {
          z.cloakUntil = now + this.cfg.zombies.stalker.cloakDurationMs;
          z.cloaked = true;
          z.uncloakUntil = undefined;
        }
      }
      
      // Bomber fuse for AI
      if (z.zClass === 'bomber' && z.hp <= z.maxHp * 0.3) {
        if (!z.fuseStarted) {
          z.fuseStarted = now;
          z.fuseUntil = now + this.cfg.zombies.bomber.fuseTimeMs;
        }
        
        if (z.fuseUntil && now >= z.fuseUntil) {
          this.bomberExplodeAI(z, now);
        }
      }
    }
  }
  
  bomberExplode(bomber: Player, now: number) {
    const radius = this.cfg.zombies.bomber.explosionRadius;
    const damage = this.cfg.zombies.bomber.explosionDamage;
    
    // Damage streamer if in range
    const streamer = [...this.players.values()].find(p => p.role === 'streamer');
    if (streamer) {
      const dist = Math.hypot(bomber.pos.x - streamer.pos.x, bomber.pos.y - streamer.pos.y);
      if (dist <= radius) {
        const dmg = Math.round(damage * (1 - dist / radius));
        streamer.hp = Math.max(0, (streamer.hp ?? this.cfg.streamer.maxHp) - dmg);
        this.trackDamageTaken(streamer, dmg);
        this.broadcast('notification', { message: `Bomber explosion deals ${dmg} damage!` });
      }
    }
    
    // Kill the bomber
    bomber.alive = false;
    bomber.zHp = 0;
    
    // Create explosion effect
    this.broadcast('explosion', { x: bomber.pos.x, y: bomber.pos.y, radius, damage });
  }
  
  bomberExplodeAI(bomber: AIZombie, now: number) {
    const radius = this.cfg.zombies.bomber.explosionRadius;
    const damage = this.cfg.zombies.bomber.explosionDamage;
    
    // Damage streamer if in range
    const streamer = [...this.players.values()].find(p => p.role === 'streamer');
    if (streamer) {
      const dist = Math.hypot(bomber.pos.x - streamer.pos.x, bomber.pos.y - streamer.pos.y);
      if (dist <= radius) {
        const dmg = Math.round(damage * (1 - dist / radius));
        streamer.hp = Math.max(0, (streamer.hp ?? this.cfg.streamer.maxHp) - dmg);
        this.trackDamageTaken(streamer, dmg);
      }
    }
    
    // Remove the AI bomber
    const idx = this.aiZombies.indexOf(bomber);
    if (idx >= 0) this.aiZombies.splice(idx, 1);
    
    // Create explosion effect
    this.broadcast('explosion', { x: bomber.pos.x, y: bomber.pos.y, radius, damage });
  }
  
  addDamageNumber(x: number, y: number, damage: number, isCrit: boolean = false, isDot: boolean = false) {
    this.damageNumbers.push({
      id: crypto.randomUUID().slice(0, 6),
      x, y, damage, isCrit, isDot,
      timestamp: Date.now()
    });
  }

  update() {
    const now = Date.now();

    // Drop stale sockets (missed heartbeats for 40s)
    for (const [id, p] of this.players) {
      if (now - p.lastSeen > 40000) {
        this.players.delete(id);
      }
    }

    // Process upgrade effects
    this.processUpgradeEffects(now);
    
    // Process zombie special abilities
    this.processZombieAbilities(now);

    // Extractions removed

    // Update AI Zombies
    this.updateAIZombies(now);

    // Spawn AI Zombies if needed
    this.spawnAIZombiesIfNeeded(now);

    // Update Boss System
    this.updateBossSystem(now);

    // Update Boss Minions
    this.updateBossMinions(now);

    // Update Poison Fields
    this.updatePoisonFields(now);

    // Integrate movement
    const dt = this.tickMs / 1000;
    for (const p of this.players.values()) {
      let baseSpeed = p.role === "streamer" ? this.cfg.speeds.streamer : this.cfg.speeds.zombie; // px/s
      if (p.role === 'zombie' && p.zClass) baseSpeed *= this.cfg.zombies.speedMul[p.zClass];
      if (p.role === "zombie" && (this.zombieSlowUntil || 0) > now) baseSpeed *= this.cfg.speeds.zombieSlowMultiplier; // global slow
      if (p.role === 'zombie' && ((p.slowUntil || 0) > now)) {
        baseSpeed *= Math.max(0.05, p.slowMul || 1);
      }
      if (p.role === 'streamer' && ((p as any).gooSlowUntil || 0) > now) baseSpeed *= this.cfg.zombies.spitter.streamerSlowMul;
      // Apply movement speed upgrades for streamer
      if (p.role === 'streamer') {
        const { s } = statsFor(p);
        baseSpeed *= s.movementSpeedMul;
      }
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
          const { s } = statsFor(p);
          speed *= this.cfg.dash.speedMultiplier * s.dashDistanceMul;
          // Trigger dash reload upgrade
          if (s.dashReloadPct > 0 && !((p as any).dashReloadTriggered)) {
            this.refundAmmoOnKill(p, s.dashReloadPct);
            (p as any).dashReloadTriggered = true;
          }
        } else {
          (p as any).dashReloadTriggered = false;
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
        const isSpikes = (tt:TileId)=> tt===6; // spike trap
        const isPoison = (tt:TileId)=> tt===7; // poison pool
        
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
        
        // Spike trap - damage over time
        if (isSpikes(t)) {
          const lastSpikeDamage = (p as any).lastSpikeDamage || 0;
          if (now - lastSpikeDamage > 500) { // Damage every 0.5 seconds
            if (p.role === 'streamer') {
              const damage = 8; // Moderate damage
              p.hp = Math.max(0, (p.hp ?? this.cfg.streamer.maxHp) - damage);
              this.trackDamageTaken(p, damage);
              // Add damage number for spikes
              this.addDamageNumber(p.pos.x, p.pos.y, damage, false, true);
              this.broadcast("notice", { message: "🗡️ Stepped on spikes! Taking damage..." });
              (p as any).lastSpikeDamage = now;
              if ((p.hp ?? 0) <= 0) {
                p.pos = this.spawnInRandomRoom();
                p.hp = p.maxHp ?? this.cfg.streamer.maxHp;
                nx = p.pos.x; ny = p.pos.y;
              }
            } else {
              const damage = 5;
              p.zHp = Math.max(0, (p.zHp ?? this.cfg.zombies.baseHp) - damage);
              // Add damage number for zombie on spikes
              this.addDamageNumber(p.pos.x, p.pos.y, damage, false, true);
              (p as any).lastSpikeDamage = now;
              if ((p.zHp ?? 0) <= 0) {
                p.alive = false; 
                const id = p.id; 
                setTimeout(() => { 
                  const zp = this.players.get(id); 
                  if (zp) { 
                    zp.pos = this.spawnZombiePos(); 
                    zp.alive = true; 
                    zp.zHp = zp.zMaxHp; 
                  } 
                }, this.cfg.combat.respawnMs);
              }
            }
          }
        }
        
        // Poison pool - damage and slow
        if (isPoison(t)) {
          // Apply slow effect
          nx = p.pos.x + (p.vel.x * 0.4) * dt; 
          ny = p.pos.y + (p.vel.y * 0.4) * dt;
          
          const lastPoisonDamage = (p as any).lastPoisonDamage || 0;
          if (now - lastPoisonDamage > 1000) { // Damage every 1 second
            if (p.role === 'streamer') {
              const damage = 6; // Moderate damage
              p.hp = Math.max(0, (p.hp ?? this.cfg.streamer.maxHp) - damage);
              this.trackDamageTaken(p, damage);
              // Add damage number for poison
              this.addDamageNumber(p.pos.x, p.pos.y, damage, false, true);
              const lastPoisonToast = (p as any).lastPoisonToast || 0;
              if (now - lastPoisonToast > 3000) {
                this.broadcast("notice", { message: "☠️ Poison pool! Taking damage and slowed..." });
                (p as any).lastPoisonToast = now;
              }
              (p as any).lastPoisonDamage = now;
              if ((p.hp ?? 0) <= 0) {
                p.pos = this.spawnInRandomRoom();
                p.hp = p.maxHp ?? this.cfg.streamer.maxHp;
                nx = p.pos.x; ny = p.pos.y;
              }
            } else {
              const damage = 4;
              p.zHp = Math.max(0, (p.zHp ?? this.cfg.zombies.baseHp) - damage);
              // Add damage number for zombie in poison
              this.addDamageNumber(p.pos.x, p.pos.y, damage, false, true);
              (p as any).lastPoisonDamage = now;
              if ((p.zHp ?? 0) <= 0) {
                p.alive = false; 
                const id = p.id; 
                setTimeout(() => { 
                  const zp = this.players.get(id); 
                  if (zp) { 
                    zp.pos = this.spawnZombiePos(); 
                    zp.alive = true; 
                    zp.zHp = zp.zMaxHp; 
                  } 
                }, this.cfg.combat.respawnMs);
              }
            }
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
        let { s } = statsFor(p);
        // Apply berserker rage damage bonus
        if (s.berserkerStacks > 0) {
          const recentKills = ((p as any).berserkerKills || []).filter((t: number) => now - t <= 5000);
          const stacks = Math.min(recentKills.length, s.berserkerStacks);
          s = { ...s, damageMul: s.damageMul * (1 + stacks * 0.1) }; // 10% per stack
        }
        if (weapon === "pistol") {
          const baseCd = boostedW ? this.cfg.weapons.cooldownMs.pistol.boosted : this.cfg.weapons.cooldownMs.pistol.base;
          const cd = baseCd / Math.max(0.01, s.fireRateMul);
          (p as any)._pistolLatched = (p as any)._pistolLatched || false;
          const ammoCost = Math.max(1, Math.floor(1 * s.ammoEfficiencyMul));
          if (since >= cd && (p.pistolAmmo ?? 0) >= ammoCost && !(p as any)._pistolLatched) {
            const speedB = (boostedW ? this.cfg.weapons.projectile.pistol.speed * 1.166 : this.cfg.weapons.projectile.pistol.speed) * s.projectileSpeedMul;
            const spec: BulletSpawnSpec = {
              pos: { x: p.pos.x, y: p.pos.y },
              vel: { x: nx*speedB, y: ny*speedB },
              ttl: this.cfg.weapons.projectile.pistol.ttl,
              ownerId: p.id,
              meta: {
                damage: (this.cfg.weapons.damage.pistol||0) * s.damageMul,
                radius: this.cfg.radii.bulletMargin * s.bulletSizeMul,
                pierce: s.pierce,
                bounce: s.bounce,
                ricochet: s.ricochet,
                chain: s.chain,
                status: statusFrom(s),
                critChance: s.critChance,
                critMul: s.critMul,
              }
            };
            const spawned: BulletSpawnSpec[] = [spec];
            for (const [id, n] of Object.entries(p.mods||{})) {
              (MOD_INDEX as any)[id]?.hooks?.onShoot?.({ room: this as any, playerId: p.id, bullets: spawned, stats: s });
            }
            for (const sp of spawned) {
              this.bullets.push({ id: crypto.randomUUID().slice(0,6), ...sp });
              // Track bullet fired
              this.trackBulletFired(p);
            }
            p.pistolAmmo = Math.max(0, (p.pistolAmmo ?? 0) - ammoCost);
            p.lastShotAt = nowMs;
            (p as any)._pistolLatched = true;
          }
        } else if (weapon === "smg") {
          const baseCd = boostedW ? this.cfg.weapons.cooldownMs.smg.boosted : this.cfg.weapons.cooldownMs.smg.base;
          const cd = baseCd / Math.max(0.01, s.fireRateMul);
          const ammoCost = Math.max(1, Math.floor(1 * s.ammoEfficiencyMul));
          if (since >= cd && (p.smgAmmo ?? 0) >= ammoCost) {
            const speedB = (boostedW ? this.cfg.weapons.projectile.smg.speed * 1.176 : this.cfg.weapons.projectile.smg.speed) * s.projectileSpeedMul;
            const spread = (Math.random()-0.5) * 0.12 * s.spreadMul; // radians
            const cs = Math.cos(spread), sn = Math.sin(spread);
            const vx = nx * cs - ny * sn; const vy = nx * sn + ny * cs;
            const spec: BulletSpawnSpec = {
              pos: { x: p.pos.x, y: p.pos.y },
              vel: { x: vx*speedB, y: vy*speedB },
              ttl: this.cfg.weapons.projectile.smg.ttl,
              ownerId: p.id,
              meta: {
                damage: (this.cfg.weapons.damage.smg||0) * s.damageMul,
                radius: this.cfg.radii.bulletMargin * s.bulletSizeMul,
                pierce: s.pierce,
                bounce: s.bounce,
                ricochet: s.ricochet,
                chain: s.chain,
                status: statusFrom(s),
                critChance: s.critChance,
                critMul: s.critMul,
              }
            };
            const spawned: BulletSpawnSpec[] = [spec];
            for (const [id, n] of Object.entries(p.mods||{})) {
              (MOD_INDEX as any)[id]?.hooks?.onShoot?.({ room: this as any, playerId: p.id, bullets: spawned, stats: s });
            }
            for (const sp of spawned) {
              this.bullets.push({ id: crypto.randomUUID().slice(0,6), ...sp });
              // Track bullet fired
              this.trackBulletFired(p);
            }
            p.smgAmmo = Math.max(0, (p.smgAmmo ?? 0) - ammoCost);
            p.lastShotAt = nowMs;
          }
        } else if (weapon === "shotgun") {
          const baseCd = boostedW ? this.cfg.weapons.cooldownMs.shotgun.boosted : this.cfg.weapons.cooldownMs.shotgun.base;
          const cd = baseCd / Math.max(0.01, s.fireRateMul);
          const ammoCost = Math.max(1, Math.floor(1 * s.ammoEfficiencyMul));
          if (since >= cd && (p.shotgunAmmo ?? 0) >= ammoCost) {
            const speedB = (boostedW ? this.cfg.weapons.projectile.shotgun.speed * 1.2 : this.cfg.weapons.projectile.shotgun.speed) * s.projectileSpeedMul;
            const pellets = this.cfg.weapons.projectile.shotgun.pellets;
            const spawned: BulletSpawnSpec[] = [];
            for (let i=0;i<pellets;i++){
              const spread = (Math.random()-0.5) * 0.45 * s.spreadMul; // radians
              const cs = Math.cos(spread), sn = Math.sin(spread);
              const vx = nx * cs - ny * sn; const vy = nx * sn + ny * cs;
              spawned.push({
                pos:{x:p.pos.x,y:p.pos.y},
                vel:{x:vx*speedB,y:vy*speedB},
                ttl: this.cfg.weapons.projectile.shotgun.ttl,
                ownerId:p.id,
                meta:{
                  damage:(this.cfg.weapons.damage.shotgun||0) * s.damageMul,
                  radius: this.cfg.radii.bulletMargin * s.bulletSizeMul,
                  pierce: s.pierce,
                  bounce: s.bounce,
                  ricochet: s.ricochet,
                  chain: s.chain,
                  status: statusFrom(s),
                  critChance: s.critChance,
                  critMul: s.critMul,
                }
              });
            }
            for (const [id, n] of Object.entries(p.mods||{})) {
              (MOD_INDEX as any)[id]?.hooks?.onShoot?.({ room: this as any, playerId: p.id, bullets: spawned, stats: s });
            }
            for (const sp of spawned) {
              this.bullets.push({ id: crypto.randomUUID().slice(0,6), ...sp });
              // Track bullet fired
              this.trackBulletFired(p);
            }
            p.shotgunAmmo = Math.max(0, (p.shotgunAmmo ?? 0) - ammoCost);
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
              const damage = this.cfg.weapons.damage.melee;
              z.zHp = Math.max(0, (z.zHp ?? this.cfg.zombies.baseHp) - damage);
              // Add damage number for melee
              this.addDamageNumber(z.pos.x, z.pos.y, damage, false, false);
              if ((z.zHp ?? 0) <= 0) {
                z.alive = false;
                // Drop ammo on zombie death
                this.pickups.push({ id: crypto.randomUUID().slice(0,6), type: 'ammo', x: z.pos.x, y: z.pos.y });
                const id = z.id;
                setTimeout(() => { const zp = this.players.get(id); if (zp) { zp.pos = this.spawnZombiePos(); zp.alive = true; zp.zHp = zp.zMaxHp; } }, this.cfg.combat.respawnMs);
                p.score += 1;
                // Track enemy kill
                this.trackEnemyKill(p, 'basic');
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

      // Collision with walls: use bullet-specific radius and allow simple bounce
      let blocked = false;
      for (const rct of this.walls) {
        const m = b.meta.radius || this.cfg.radii.bulletMargin;
        if (b.pos.x > rct.x - m && b.pos.x < rct.x + rct.w + m && b.pos.y > rct.y - m && b.pos.y < rct.y + rct.h + m) { blocked = true; break; }
      }
      if (blocked) {
        if (b.meta.bounce > 0) {
          b.meta.bounce -= 1;
          // Simple reflection: invert both components
          b.vel.x *= -1; b.vel.y *= -1;
          aliveBullets.push(b);
          continue;
        }
        continue;
      }

      // Collision with zombies (class-based HP)
      let consumed = false;
      for (const p of this.players.values()) {
        if (p.role !== "zombie" || !p.alive) continue;
        const r = this.cfg.radii.zombie; // zombie radius
        if (Math.hypot(p.pos.x - b.pos.x, p.pos.y - b.pos.y) < r) {
          const base = b.meta.damage || 0;
          const crit = Math.random() < (b.meta.critChance || 0);
          const dealt = Math.max(0, Math.round(base * (crit ? (b.meta.critMul || 1) : 1)));
          p.zHp = Math.max(0, (p.zHp ?? this.cfg.zombies.baseHp) - dealt);
          // Add damage number for bullet hit
          this.addDamageNumber(p.pos.x, p.pos.y, dealt, crit, false);
          const owner = this.players.get(b.ownerId);
          // Track bullet hit
          if (owner) {
            this.trackBulletHit(owner);
            this.trackDamageDealt(owner, dealt);
          }
          const ownerStats = owner ? statsFor(owner).s : undefined;
          // Lifesteal on hit
          if (owner && ownerStats && ownerStats.lifestealPct > 0 && owner.role === 'streamer') {
            const heal = Math.max(0, Math.floor(dealt * ownerStats.lifestealPct));
            owner.hp = Math.min(owner.maxHp ?? this.cfg.streamer.maxHp, (owner.hp ?? this.cfg.streamer.maxHp) + heal);
          };
          // Apply status effects
          if (b.meta.status) {
            const nowMs = now;
            const st = b.meta.status;
            if (st.slowMs && st.slowMul && Math.random() < (st.slowChance || 1)) {
              p.slowUntil = nowMs + st.slowMs; p.slowMul = st.slowMul;
            }
            if (st.burnMs && st.burnDps && Math.random() < (st.burnChance || 1)) {
              p.burns = p.burns || [];
              p.burns.push({ until: nowMs + st.burnMs, dps: st.burnDps, nextTick: nowMs + 1000, ownerId: b.ownerId });
            }
            if (st.bleedMs && st.bleedDps && Math.random() < (st.bleedChance || 1)) {
              p.bleeds = p.bleeds || [];
              p.bleeds.push({ until: nowMs + st.bleedMs, dps: st.bleedDps, nextTick: nowMs + 1000, ownerId: b.ownerId });
            }
          }
          // Call onHit hooks
          if (owner && owner.mods) {
            for (const [id, n] of Object.entries(owner.mods)) {
              (MOD_INDEX as any)[id]?.hooks?.onHit?.({ room: this as any, bullet: b, targetId: p.id, killed: false, stats: ownerStats || {} });
            }
          }
          let killed = false;
          if ((p.zHp ?? 0) <= 0) {
            p.alive = false; killed = true;
            // Drop ammo on zombie death
            this.pickups.push({ id: crypto.randomUUID().slice(0,6), type: 'ammo', x: p.pos.x, y: p.pos.y });
            const id = p.id;
            setTimeout(() => { const zp = this.players.get(id); if (zp) { zp.pos = this.spawnZombiePos(); zp.alive = true; zp.zHp = zp.zMaxHp; } }, this.cfg.combat.respawnMs);
            // Reload on kill
            if (owner && ownerStats && ownerStats.reloadOnKillPct > 0 && owner.role === 'streamer') {
              this.refundAmmoOnKill(owner, ownerStats.reloadOnKillPct);
            }
            // Reward streamer (only on kill)
            if (owner && owner.role === 'streamer') {
              owner.score += 1;
              owner.xp = (owner.xp||0) + XP_PER_KILL;
              const need = XP_THRESHOLDS(owner.level||0);
              if ((owner.xp||0) >= need) {
                owner.xp = (owner.xp||0) - need; owner.level = (owner.level||0) + 1;
                this.offerUpgrades(owner.id);
              }
            }
            // Call onKill hooks and handle berserker stacks
            if (killed && owner && owner.mods) {
              for (const [id, n] of Object.entries(owner.mods)) {
                (MOD_INDEX as any)[id]?.hooks?.onKill?.({ room: this as any, killerId: owner.id, victimId: p.id, stats: ownerStats || {} });
              }
              // Track berserker kills
              if (ownerStats && ownerStats.berserkerStacks > 0) {
                (owner as any).berserkerKills = (owner as any).berserkerKills || [];
                (owner as any).berserkerKills.push(now);
              }
              // Blood aura healing
              if (ownerStats && ownerStats.vampireAuraRange > 0) {
                const healAmount = Math.floor(ownerStats.vampireAuraRange / 10); // 5 HP per 50px range
                owner.hp = Math.min(owner.maxHp ?? this.cfg.streamer.maxHp, (owner.hp ?? this.cfg.streamer.maxHp) + healAmount);
              }
            }
          }
          // Handle pierce or ricochet
          if (b.meta.pierce > 0) {
            b.meta.pierce -= 1; aliveBullets.push(b);
          } else {
            // Try ricochet if available
            if (b.meta.ricochet > 0 && this.retargetBulletRicochet(b, p.id)) {
              b.meta.ricochet -= 1; aliveBullets.push(b);
            } else {
              consumed = true;
            }
          }
          // Chain lightning
          if (b.meta.chain > 0) {
            this.applyChainDamage(b, { x: b.pos.x, y: b.pos.y }, p.id, b.meta.chain, Math.round((b.meta.damage||0)*0.7));
          }
          break;
        }
      }
      // If not consumed by player-zombie hit, check collision with AI zombies
      if (!consumed) {
        let hitAI = false;
        for (const zombie of this.aiZombies) {
          const r = this.cfg.radii.zombie;
          if (Math.hypot(zombie.pos.x - b.pos.x, zombie.pos.y - b.pos.y) < r) {
            const base = b.meta.damage || 0;
            const crit = Math.random() < (b.meta.critChance || 0);
            const dealt = Math.max(0, Math.round(base * (crit ? (b.meta.critMul || 1) : 1)));
            zombie.hp = Math.max(0, zombie.hp - dealt);
            // Add damage number for bullet hit on AI zombie
            this.addDamageNumber(zombie.pos.x, zombie.pos.y, dealt, crit, false);
            const owner = this.players.get(b.ownerId);
            // Track bullet hit
            if (owner) {
              this.trackBulletHit(owner);
              this.trackDamageDealt(owner, dealt);
            }
            const ownerStats = owner ? statsFor(owner).s : undefined;
            // Lifesteal
            if (owner && ownerStats && ownerStats.lifestealPct > 0 && owner.role === 'streamer') {
              const heal = Math.max(0, Math.floor(dealt * ownerStats.lifestealPct));
              owner.hp = Math.min(owner.maxHp ?? this.cfg.streamer.maxHp, (owner.hp ?? this.cfg.streamer.maxHp) + heal);
            }
            // Status effects
            if (b.meta.status) {
              const nowMs = now;
              const st = b.meta.status;
              if (st.slowMs && st.slowMul && Math.random() < (st.slowChance || 1)) { zombie.slowUntil = nowMs + st.slowMs; zombie.slowMul = st.slowMul; }
              if (st.burnMs && st.burnDps && Math.random() < (st.burnChance || 1)) { zombie.burns = zombie.burns || []; zombie.burns.push({ until: nowMs + st.burnMs, dps: st.burnDps, nextTick: nowMs + 1000, ownerId: b.ownerId }); }
              if (st.bleedMs && st.bleedDps && Math.random() < (st.bleedChance || 1)) { zombie.bleeds = zombie.bleeds || []; zombie.bleeds.push({ until: nowMs + st.bleedMs, dps: st.bleedDps, nextTick: nowMs + 1000, ownerId: b.ownerId }); }
            }
            // Kill check for reload-on-kill
            const wasKilled = zombie.hp <= 0;
            if (wasKilled && owner && ownerStats && ownerStats.reloadOnKillPct > 0 && owner.role === 'streamer') {
              this.refundAmmoOnKill(owner, ownerStats.reloadOnKillPct);
            }
            // Reward streamer (only on kill)
            if (wasKilled && owner && owner.role === 'streamer') {
              owner.score += 1;
              owner.xp = (owner.xp||0) + XP_PER_KILL;
              // Track AI zombie kill
              this.trackEnemyKill(owner, zombie.zClass || 'basic');
              this.trackXPGained(owner, XP_PER_KILL);
              const need = XP_THRESHOLDS(owner.level||0);
              if ((owner.xp||0) >= need) { owner.xp -= need; owner.level = (owner.level||0) + 1; this.offerUpgrades(owner.id); }
            }
            // Pierce/ricochet handling
            if (b.meta.pierce > 0) { b.meta.pierce -= 1; aliveBullets.push(b); }
            else if (b.meta.ricochet > 0 && this.retargetBulletRicochet(b, 'ai:'+zombie.id)) { b.meta.ricochet -= 1; aliveBullets.push(b); }
            else { consumed = true; }
            // Chain lightning
            if (b.meta.chain > 0) { this.applyChainDamage(b, { x: b.pos.x, y: b.pos.y }, 'ai:'+zombie.id, b.meta.chain, Math.round((b.meta.damage||0)*0.7)); }
            hitAI = true;
            break;
          }
        }
        // Check collision with bosses if not consumed by zombies
        if (!hitAI && !consumed) {
          let hitBoss = false;
          for (const boss of this.bosses) {
            if (boss.state === "dying") continue;
            
            // Skip if boss is phased (Shadow Lord ability)
            if (boss.phased) continue;
            
            const bossRadius = boss.radius;
            if (Math.hypot(boss.pos.x - b.pos.x, boss.pos.y - b.pos.y) < bossRadius) {
              const base = b.meta.damage || 0;
              const crit = Math.random() < (b.meta.critChance || 0);
              const dealt = Math.max(0, Math.round(base * (crit ? (b.meta.critMul || 1) : 1)));
              boss.hp = Math.max(0, boss.hp - dealt);
              
              // Add damage number for boss hit
              this.addDamageNumber(boss.pos.x, boss.pos.y, dealt, crit, false);
              
              const owner = this.players.get(b.ownerId);
              const ownerStats = owner ? statsFor(owner).s : undefined;
              
              // Lifesteal on boss hit
              if (owner && ownerStats && ownerStats.lifestealPct > 0 && owner.role === 'streamer') {
                const heal = Math.max(0, Math.floor(dealt * ownerStats.lifestealPct));
                owner.hp = Math.min(owner.maxHp ?? this.cfg.streamer.maxHp, (owner.hp ?? this.cfg.streamer.maxHp) + heal);
              }
              
              // Check if boss died
              if (boss.hp <= 0 && (boss.state as any) !== "dying") {
                boss.state = "dying";
                // Reward streamer for boss kill
                if (owner && owner.role === 'streamer') {
                  // Track boss kill
                  this.trackBossKill(owner, boss.type);
                  owner.score += 10; // More points for boss kill
                  const bossXP = XP_PER_KILL * 5; // 5x XP for boss
                  owner.xp = (owner.xp||0) + bossXP;
                  this.trackXPGained(owner, bossXP);
                  const need = XP_THRESHOLDS(owner.level||0);
                  if ((owner.xp||0) >= need) {
                    owner.xp = (owner.xp||0) - need;
                    owner.level = (owner.level||0) + 1;
                    this.offerUpgrades(owner.id);
                  }
                }
              }
              
              // Pierce/ricochet handling
              if (b.meta.pierce > 0) {
                b.meta.pierce -= 1;
                aliveBullets.push(b);
              } else if (b.meta.ricochet > 0 && this.retargetBulletRicochet(b, 'boss:'+boss.id)) {
                b.meta.ricochet -= 1;
                aliveBullets.push(b);
              } else {
                consumed = true;
              }
              
              // Chain lightning
              if (b.meta.chain > 0) {
                this.applyChainDamage(b, { x: b.pos.x, y: b.pos.y }, 'boss:'+boss.id, b.meta.chain, Math.round((b.meta.damage||0)*0.7));
              }
              
              hitBoss = true;
              break;
            }
          }
          
          if (!hitBoss && !consumed) aliveBullets.push(b);
        }
      }
    }
    this.bullets = aliveBullets;

    // Process damage-over-time effects (burn/bleed) for both player zombies and AI zombies
    this.processDotEffects(now);

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
          this.trackDamageTaken(streamer, this.cfg.zombies.spitter.hitDamage);
          continue; // glob consumed
        }
      }
      aliveGlobs.push(g);
    }
    this.spittles = aliveGlobs;

    // Zombie damage to streamer
    if (streamer) {
      // Check for ghost walk invulnerability
      const isInvulnerable = ((streamer as any).ghostWalkUntil || 0) > now;
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
          if (!shielded && !isInvulnerable) {
            if ((streamer.hp ?? this.cfg.streamer.maxHp) > 0) {
              streamer.hp = Math.max(0, (streamer.hp ?? this.cfg.streamer.maxHp) - this.cfg.combat.zombieTouchDamage);
              this.trackDamageTaken(streamer, this.cfg.combat.zombieTouchDamage);
            }
            if ((streamer.hp ?? 0) <= 0) {
              // Handle explosive death before respawn
              const { s } = statsFor(streamer);
              if (s.explosiveDeathDamage > 0) {
                this.createExplosion(streamer.pos.x, streamer.pos.y, s.explosiveDeathDamage, 60, streamer.id);
              }
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
            this.trackPickupTaken(pl, p.type);
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
            this.trackPickupTaken(pl, p.type);
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
            this.trackPickupTaken(pl, p.type);
            taken = true; break;
          }
          if (p.type === "shield" && pl.role === "streamer") {
            (pl as any).shieldUntil = now + this.cfg.effects.shieldMs; // shield
            this.broadcast("notice", { message: "🛡️ Shield activated - temporary invulnerability!" });
            this.trackPickupTaken(pl, p.type);
            taken = true; break;
          }
          if (p.type === "magnet" && pl.role === "streamer") {
            (pl as any).magnetUntil = now + this.cfg.effects.magnetMs; // big pickup radius
            this.broadcast("notice", { message: "🧲 Magnet activated - larger pickup radius!" });
            this.trackPickupTaken(pl, p.type);
            taken = true; break;
          }
          if (p.type === "freeze" && pl.role === "streamer") {
            this.zombieSlowUntil = now + this.cfg.effects.freezeMs; // slow zombies globally
            this.broadcast("notice", { message: "❄️ Freeze activated - all zombies slowed!" });
            this.trackPickupTaken(pl, p.type);
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
                // Add damage number for blast hit on zombie
                this.addDamageNumber(z.pos.x, z.pos.y, 100, false, false);
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
            this.trackPickupTaken(pl, p.type);
            taken = true; break;
          }
          if (p.type === "treasure" && pl.role === "streamer") {
            pl.score += this.cfg.pickups.treasureScore;
            this.broadcast("notice", { message: `💎 Treasure found! +${this.cfg.pickups.treasureScore} points` });
            this.trackPickupTaken(pl, p.type);
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
            this.trackPickupTaken(pl, p.type);
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
            this.trackPickupTaken(pl, p.type);
            taken = true; break;
          }
        }
      }
      if (!taken) remaining.push(p);
    }
    this.pickups = remaining;

    // Extractions removed

    const s = [...this.players.values()].find(p => p.role === "streamer");

    // Round timer: reset when time elapses
    if ((this.roundEndTime || 0) > 0 && now >= (this.roundEndTime as number)) {
      // On round end, just reset unbanked score (no extractions)
      if (s) { s.score = 0; }

      this.roundEndTime = now + this.roundDurationMs;
      this.bullets = [];
      this.pickups = [];
      // Extractions removed – no respawn/rotation
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
      let speed = (this.zombieSlowUntil || 0) > now ? baseSpeed * this.cfg.speeds.zombieSlowMultiplier : baseSpeed;
      if ((zombie.slowUntil || 0) > now) speed *= Math.max(0.05, zombie.slowMul || 1);
      
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
      this.trackDamageTaken(streamer, this.cfg.combat.zombieTouchDamage);
      // Add damage number for zombie hit on streamer
      this.addDamageNumber(streamer.pos.x, streamer.pos.y, this.cfg.combat.zombieTouchDamage, false, false);
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
    // Clean up old damage numbers (older than 1 second to prevent duplicates)
    const now = Date.now();
    this.damageNumbers = this.damageNumbers.filter(dn => now - dn.timestamp < 1000);

    const snapshot = {
      type: "state",
      t: Date.now(),
      players: [...this.players.values()].map(this.publicPlayer),
      bullets: this.bullets.map(b => ({ id: b.id, x: b.pos.x, y: b.pos.y, ownerId: b.ownerId })),
      globs: this.spittles.map(g => ({ id: g.id, x: g.pos.x, y: g.pos.y })),
      walls: this.walls.map(o => ({ id: o.id, x: o.x, y: o.y, w: o.w, h: o.h })),
      pickups: this.pickups.map(pk => ({ id: pk.id, type: pk.type, x: pk.x, y: pk.y })),
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
      damageNumbers: this.damageNumbers.map(dn => ({
        id: dn.id,
        x: dn.x,
        y: dn.y,
        damage: dn.damage,
        isCrit: dn.isCrit,
        isDot: dn.isDot,
        timestamp: dn.timestamp
      })),
      bosses: this.bosses.map(boss => this.publicBoss(boss)),
      bossMinions: this.bossMinions.map(minion => ({
        id: minion.id,
        bossId: minion.bossId,
        pos: minion.pos,
        hp: minion.hp,
        maxHp: minion.maxHp,
        state: minion.state
      })),
      poisonFields: this.poisonFields.map(field => ({
        id: field.id,
        pos: field.pos,
        radius: field.radius,
        dps: field.dps,
        expiresAt: field.expiresAt
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

  offerUpgrades(playerId: string) {
    const p = this.players.get(playerId);
    if (!p || p.role !== 'streamer') return;
    const choices = rollChoices(p.mods || {}, Math.random);
    try {
      p.ws?.send(JSON.stringify({
        type: 'upgrade_offer',
        level: p.level || 0,
        choices: choices.map(c => ({ id: c.id, name: c.name, desc: c.desc, rarity: c.rarity, currentStacks: (p.mods?.[c.id as keyof typeof p.mods] as number) || 0 }))
      }));
    } catch {}
  }

  applyUpgrade(playerId: string, id: import('./types').ModId) {
    const p = this.players.get(playerId);
    if (!p || p.role !== 'streamer') return;
    p.mods = p.mods || {};
    const prev = (p.mods[id] || 0) as number;
    (p.mods as any)[id] = prev + 1;
    this.broadcast('notice', { message: `${p.name} chose ${String(id).replace(/_/g,' ')}` });
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
    maxHp: p.role === "streamer" ? (p.maxHp ?? this.cfg.streamer.maxHp) : p.maxHp,
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
    level: p.level || 0,
    xp: p.xp || 0,
    xpForNext: XP_THRESHOLDS(p.level || 0),
    mods: Object.entries(p.mods || {}).map(([id, stacks]) => {
      const mod = MOD_INDEX[id as keyof typeof MOD_INDEX];
      return {
        id,
        stacks,
        name: mod?.name || id,
        desc: mod?.desc || "",
        rarity: mod?.rarity || "common",
      };
    }),
    raidStats: (p as any).raidStats || null,
  });

  // Optional effect used by some mods; small AoE damage on bullet hit
  spawnSmallExplosion(b: Bullet) {
    const radius = 26;
    for (const z of this.players.values()){
      if (z.role !== 'zombie' || !z.alive) continue;
      if (Math.hypot(z.pos.x - b.pos.x, z.pos.y - b.pos.y) <= radius) {
        z.zHp = Math.max(0, (z.zHp ?? this.cfg.zombies.baseHp) - Math.round((b.meta?.damage||20) * 0.5));
        // Add damage number for explosion hit on zombie
        this.addDamageNumber(z.pos.x, z.pos.y, Math.round((b.meta?.damage||20) * 0.5), false, false);
        if ((z.zHp ?? 0) <= 0) {
          z.alive = false;
          this.pickups.push({ id: crypto.randomUUID().slice(0,6), type: 'ammo', x: z.pos.x, y: z.pos.y });
          const id = z.id;
          setTimeout(() => { const zp = this.players.get(id); if (zp) { zp.pos = this.spawnZombiePos(); zp.alive = true; zp.zHp = zp.zMaxHp; } }, this.cfg.combat.respawnMs);
        }
      }
    }
  }

  processDotEffects(now: number) {
    // Player-controlled zombies
    for (const z of this.players.values()){
      if (z.role !== 'zombie' || !z.alive) continue;
      if (z.burns && z.burns.length){
        let kept: typeof z.burns = [];
        for (const e of z.burns){
          if (now > e.until) continue;
          if (now >= e.nextTick) {
            e.nextTick += 1000;
            z.zHp = Math.max(0, (z.zHp ?? this.cfg.zombies.baseHp) - e.dps);
            const owner = this.players.get(e.ownerId);
            // Lifesteal on DoT damage
            if (owner && owner.role==='streamer') {
              const s = statsFor(owner).s;
              if (s.lifestealPct>0) {
                const heal = Math.max(0, Math.floor(e.dps * s.lifestealPct));
                owner.hp = Math.min(owner.maxHp ?? this.cfg.streamer.maxHp, (owner.hp ?? this.cfg.streamer.maxHp) + heal);
              }
              owner.score += 1;
              owner.xp = (owner.xp||0) + XP_PER_KILL;
              const need = XP_THRESHOLDS(owner.level||0);
              if ((owner.xp||0) >= need) { owner.xp -= need; owner.level = (owner.level||0) + 1; this.offerUpgrades(owner.id); }
            }
            if ((z.zHp ?? 0) <= 0) {
              z.alive = false;
              this.pickups.push({ id: crypto.randomUUID().slice(0,6), type: 'ammo', x: z.pos.x, y: z.pos.y });
              const id = z.id;
              setTimeout(()=>{ const zp=this.players.get(id); if (zp){ zp.pos=this.spawnZombiePos(); zp.alive=true; zp.zHp=zp.zMaxHp; } }, this.cfg.combat.respawnMs);
              if (owner && owner.role==='streamer') {
                const s = statsFor(owner).s;
                if (s.reloadOnKillPct>0) this.refundAmmoOnKill(owner, s.reloadOnKillPct);
              }
              continue; // don't keep this effect
            }
          }
          kept.push(e);
        }
        z.burns = kept;
      }
      if (z.bleeds && z.bleeds.length){
        let kept: typeof z.bleeds = [];
        for (const e of z.bleeds){
          if (now > e.until) continue;
          if (now >= e.nextTick) {
            e.nextTick += 1000;
            z.zHp = Math.max(0, (z.zHp ?? this.cfg.zombies.baseHp) - e.dps);
            const owner = this.players.get(e.ownerId);
            if (owner && owner.role==='streamer') {
              const s = statsFor(owner).s;
              if (s.lifestealPct>0) {
                const heal = Math.max(0, Math.floor(e.dps * s.lifestealPct));
                owner.hp = Math.min(owner.maxHp ?? this.cfg.streamer.maxHp, (owner.hp ?? this.cfg.streamer.maxHp) + heal);
              }
              owner.score += 1;
              owner.xp = (owner.xp||0) + XP_PER_KILL;
              const need = XP_THRESHOLDS(owner.level||0);
              if ((owner.xp||0) >= need) { owner.xp -= need; owner.level = (owner.level||0) + 1; this.offerUpgrades(owner.id); }
            }
            if ((z.zHp ?? 0) <= 0) {
              z.alive = false;
              this.pickups.push({ id: crypto.randomUUID().slice(0,6), type: 'ammo', x: z.pos.x, y: z.pos.y });
              const id = z.id;
              setTimeout(()=>{ const zp=this.players.get(id); if (zp){ zp.pos=this.spawnZombiePos(); zp.alive=true; zp.zHp=zp.zMaxHp; } }, this.cfg.combat.respawnMs);
              if (owner && owner.role==='streamer') {
                const s = statsFor(owner).s;
                if (s.reloadOnKillPct>0) this.refundAmmoOnKill(owner, s.reloadOnKillPct);
              }
              continue;
            }
          }
          kept.push(e);
        }
        z.bleeds = kept;
      }
    }
    // AI zombies
    for (const a of this.aiZombies){
      if (a.burns && a.burns.length){
        let kept: typeof a.burns = [];
        for (const e of a.burns){
          if (now > e.until) continue;
          if (now >= e.nextTick) {
            e.nextTick += 1000;
            a.hp = Math.max(0, a.hp - e.dps);
            const owner = this.players.get(e.ownerId);
            if (owner && owner.role==='streamer') {
              const s = statsFor(owner).s;
              if (s.lifestealPct>0) {
                const heal = Math.max(0, Math.floor(e.dps * s.lifestealPct));
                owner.hp = Math.min(owner.maxHp ?? this.cfg.streamer.maxHp, (owner.hp ?? this.cfg.streamer.maxHp) + heal);
              }
              owner.score += 1;
              owner.xp = (owner.xp||0) + XP_PER_KILL;
              const need = XP_THRESHOLDS(owner.level||0);
              if ((owner.xp||0) >= need) { owner.xp -= need; owner.level = (owner.level||0) + 1; this.offerUpgrades(owner.id); }
            }
            if (a.hp <= 0) {
              if (owner && owner.role==='streamer') {
                const s = statsFor(owner).s;
                if (s.reloadOnKillPct>0) this.refundAmmoOnKill(owner, s.reloadOnKillPct);
              }
              continue; // killed; removal handled in updateAIZombies
            }
          }
          kept.push(e);
        }
        a.burns = kept;
      }
      if (a.bleeds && a.bleeds.length){
        let kept: typeof a.bleeds = [];
        for (const e of a.bleeds){
          if (now > e.until) continue;
          if (now >= e.nextTick) {
            e.nextTick += 1000;
            a.hp = Math.max(0, a.hp - e.dps);
            const owner = this.players.get(e.ownerId);
            if (owner && owner.role==='streamer') {
              const s = statsFor(owner).s;
              if (s.lifestealPct>0) {
                const heal = Math.max(0, Math.floor(e.dps * s.lifestealPct));
                owner.hp = Math.min(owner.maxHp ?? this.cfg.streamer.maxHp, (owner.hp ?? this.cfg.streamer.maxHp) + heal);
              }
              owner.score += 1;
              owner.xp = (owner.xp||0) + XP_PER_KILL;
              const need = XP_THRESHOLDS(owner.level||0);
              if ((owner.xp||0) >= need) { owner.xp -= need; owner.level = (owner.level||0) + 1; this.offerUpgrades(owner.id); }
            }
            if (a.hp <= 0) {
              if (owner && owner.role==='streamer') {
                const s = statsFor(owner).s;
                if (s.reloadOnKillPct>0) this.refundAmmoOnKill(owner, s.reloadOnKillPct);
              }
              continue;
            }
          }
          kept.push(e);
        }
        a.bleeds = kept;
      }
    }
  }

  // Refund ammo on kill based on current weapon and percentage
  refundAmmoOnKill(owner: Player, pct: number) {
    const w = owner.weapon || 'pistol';
    if (w === 'pistol') {
      const add = Math.max(1, Math.floor(this.cfg.weapons.ammo.max.pistol * pct));
      owner.pistolAmmo = Math.min(this.cfg.weapons.ammo.max.pistol, (owner.pistolAmmo||0) + add);
    } else if (w === 'smg') {
      const add = Math.max(1, Math.floor(this.cfg.weapons.ammo.max.smg * pct));
      owner.smgAmmo = Math.min(this.cfg.weapons.ammo.max.smg, (owner.smgAmmo||0) + add);
    } else if (w === 'shotgun') {
      const add = Math.max(1, Math.floor(this.cfg.weapons.ammo.max.shotgun * pct));
      owner.shotgunAmmo = Math.min(this.cfg.weapons.ammo.max.shotgun, (owner.shotgunAmmo||0) + add);
    }
  }

  // Try to retarget a bullet toward the nearest zombie for ricochet
  retargetBulletRicochet(b: Bullet, excludeId: string): boolean {
    const speed = Math.hypot(b.vel.x, b.vel.y) || 1;
    const range = 220;
    let best: { x:number;y:number; id:string } | null = null;
    let bestD = Infinity;
    for (const z of this.players.values()){
      if (z.role !== 'zombie' || !z.alive) continue;
      if (z.id === excludeId) continue;
      const d = Math.hypot(z.pos.x - b.pos.x, z.pos.y - b.pos.y);
      if (d < range && d < bestD) { bestD = d; best = { x:z.pos.x, y:z.pos.y, id:z.id }; }
    }
    for (const z of this.aiZombies){
      const zid = 'ai:'+z.id; if (zid === excludeId) continue;
      const d = Math.hypot(z.pos.x - b.pos.x, z.pos.y - b.pos.y);
      if (d < range && d < bestD) { bestD = d; best = { x:z.pos.x, y:z.pos.y, id:zid }; }
    }
    if (!best) return false;
    const dx = best.x - b.pos.x; const dy = best.y - b.pos.y; const dd = Math.hypot(dx,dy) || 1;
    b.vel.x = (dx/dd) * speed; b.vel.y = (dy/dd) * speed;
    return true;
  }

  // Apply chain lightning damage bouncing to nearest targets
  applyChainDamage(b: Bullet, from: {x:number;y:number}, excludeId: string, count: number, dmg: number) {
    const visited = new Set<string>([excludeId]);
    let pos = { x: from.x, y: from.y };
    let remaining = count;
    let damage = dmg;
    const range = 200;
    while (remaining > 0 && damage > 0) {
      let best: { isAI:boolean; p?: Player; a?: AIZombie; id:string; x:number; y:number } | null = null;
      let bestD = Infinity;
      
      // Check player zombies
      for (const z of this.players.values()){
        if (z.role !== 'zombie' || !z.alive) continue;
        if (visited.has(z.id)) continue;
        const d = Math.hypot(z.pos.x - pos.x, z.pos.y - pos.y);
        if (d < range && d < bestD) { 
          bestD = d; 
          best = { isAI: false, p: z, id: z.id, x: z.pos.x, y: z.pos.y }; 
        }
      }
      
      // Check AI zombies
      for (const z of this.aiZombies) {
        const zid = 'ai:' + z.id; 
        if (visited.has(zid)) continue;
        const d = Math.hypot(z.pos.x - pos.x, z.pos.y - pos.y);
        if (d < range && d < bestD) { 
          bestD = d; 
          best = { isAI: true, a: z, id: zid, x: z.pos.x, y: z.pos.y }; 
        }
      }
      
      if (!best) break;
      
      // Apply damage and show damage number
      if (best.isAI && best.a) {
        // AI zombie hit
        best.a.hp = Math.max(0, best.a.hp - damage);
        this.addDamageNumber(best.a.pos.x, best.a.pos.y, damage, false, false);
        
        // Reward owner
        const owner = this.players.get(b.ownerId);
        if (owner && owner.role === 'streamer') {
          owner.score += 1;
          owner.xp = (owner.xp || 0) + XP_PER_KILL;
          const need = XP_THRESHOLDS(owner.level || 0);
          if ((owner.xp || 0) >= need) { 
            owner.xp -= need; 
            owner.level = (owner.level || 0) + 1; 
            this.offerUpgrades(owner.id); 
          }
          
          // Refund ammo if applicable
          const s = statsFor(owner).s;
          if (s && s.reloadOnKillPct > 0) {
            this.refundAmmoOnKill(owner, s.reloadOnKillPct);
          }
        }
      } else if (!best.isAI && best.p) {
        // Player zombie hit
        best.p.zHp = Math.max(0, (best.p.zHp ?? this.cfg.zombies.baseHp) - damage);
        this.addDamageNumber(best.p.pos.x, best.p.pos.y, damage, false, false);
        
        // Handle zombie death
        if ((best.p.zHp ?? 0) <= 0) {
          best.p.alive = false;
          // Respawn logic would go here if needed
        }
      }
      
      // Update position and reduce damage for next bounce
      if (best) {
        visited.add(best.id);
        pos = { x: best.x, y: best.y };
        remaining -= 1;
        damage = Math.floor(damage * 0.7);
      } else {
        break;
      }
    }
  }

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
    // Water/sludge areas (slow movement) - configurable frequency
    const numWaterAreas = Math.floor(rooms.length * this.cfg.tiles.traps.waterFrequency);
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
    
    // Pit traps (lethal) - configurable frequency
    const numPits = Math.floor(rooms.length * this.cfg.tiles.traps.pitFrequency);
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
    // Spike traps (damage over time) - configurable frequency
    const numSpikeTraps = Math.floor(rooms.length * this.cfg.tiles.traps.spikeFrequency);
    for (let i = 0; i < numSpikeTraps; i++) {
      const sx = 2 + Math.floor(Math.random() * (gw - 6));
      const sy = 2 + Math.floor(Math.random() * (gh - 6));
      
      if (tiles[sy * gw + sx] === 0) {
        tiles[sy * gw + sx] = 6; // Spikes
        // Sometimes create spike clusters
        if (Math.random() < 0.3) {
          const spikeSize = 1 + Math.floor(Math.random() * 2);
          for (let dy = 0; dy <= spikeSize && sy + dy < gh - 1; dy++) {
            for (let dx = 0; dx <= spikeSize && sx + dx < gw - 1; dx++) {
              if (tiles[(sy + dy) * gw + (sx + dx)] === 0) {
                tiles[(sy + dy) * gw + (sx + dx)] = 6;
              }
            }
          }
        }
      }
    }
    // Poison pools (damage and slow) - configurable frequency
    const numPoisonPools = Math.floor(rooms.length * this.cfg.tiles.traps.poisonFrequency);
    for (let i = 0; i < numPoisonPools; i++) {
      const px = 3 + Math.floor(Math.random() * (gw - 10));
      const py = 3 + Math.floor(Math.random() * (gh - 8));
      const pw = 2 + Math.floor(Math.random() * 4);
      const ph = 2 + Math.floor(Math.random() * 3);
      
      for (let j = py; j < py + ph && j < gh - 1; j++) {
        for (let i = px; i < px + pw && i < gw - 1; i++) {
          if (tiles[j * gw + i] === 0) { // Only replace floor tiles
            tiles[j * gw + i] = 7; // Poison
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

  pickZombieClass(): "runner" | "brute" | "spitter" | "stalker" | "bomber" {
    const w = this.cfg.zombies.weights;
    const bag: Array<"runner"|"brute"|"spitter"|"stalker"|"bomber"> = [];
    for (let i=0;i<w.runner;i++) bag.push('runner');
    for (let i=0;i<w.brute;i++) bag.push('brute');
    for (let i=0;i<w.spitter;i++) bag.push('spitter');
    for (let i=0;i<w.stalker;i++) bag.push('stalker');
    for (let i=0;i<w.bomber;i++) bag.push('bomber');
    return bag[Math.floor(Math.random()*bag.length)] || 'runner';
  }

  randRange(a:number,b:number){ return a + Math.floor(Math.random()*(b-a+1)); }

  // Extractions removed
  spawnExtractions() { /* no-op */ }

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

  rotateExtractionIfNeeded(nowMs: number) { /* no-op */ }

  // Boss System Methods
  updateBossSystem(now: number) {
    // Check for boss spawn announcement
    if (!this.nextBossAnnouncement && now - this.lastBossSpawn > this.bossSpawnCooldown - this.cfg.bosses.announceMs) {
      if (this.bosses.length < this.cfg.bosses.maxActive) {
        this.nextBossAnnouncement = now + this.cfg.bosses.announceMs;
        this.broadcast("notice", { message: "⚠️ A powerful boss is approaching! Prepare for battle!" });
      }
    }

    // Spawn boss if it's time
    if (this.nextBossAnnouncement && now >= this.nextBossAnnouncement) {
      this.spawnRandomBoss();
      this.nextBossAnnouncement = undefined;
      this.lastBossSpawn = now;
    }

    // Update existing bosses
    for (let i = this.bosses.length - 1; i >= 0; i--) {
      const boss = this.bosses[i];
      this.updateBoss(boss, now);
      
      // Remove dead bosses
      if (boss.hp <= 0 && boss.state === "dying") {
        this.onBossDeath(boss);
        this.bosses.splice(i, 1);
      }
    }
  }

  spawnRandomBoss() {
    const bossTypes: BossType[] = ["necromancer", "bruteKing", "shadowLord"];
    const randomType = bossTypes[Math.floor(Math.random() * bossTypes.length)];
    const spawnPos = this.spawnInRandomRoom();
    
    const bossConfig = this.cfg.bosses.types[randomType];
    const boss: Boss = {
      id: crypto.randomUUID().slice(0, 8),
      type: randomType,
      pos: spawnPos,
      vel: { x: 0, y: 0 },
      hp: bossConfig.hp,
      maxHp: bossConfig.hp,
      radius: bossConfig.radius,
      damage: bossConfig.damage,
      speed: bossConfig.speed,
      state: "spawning",
      lastSeen: Date.now(),
      spawnTime: Date.now(),
      minionIds: [],
      cloneIds: []
    };

    this.bosses.push(boss);
    this.broadcast("boss_spawn", { boss: this.publicBoss(boss) });
    this.broadcast("notice", { message: `💀 ${randomType.toUpperCase()} has entered the arena!` });
  }

  updateBoss(boss: Boss, now: number) {
    const streamer = [...this.players.values()].find(p => p.role === "streamer" && p.alive);
    if (!streamer) {
      boss.state = "idle";
      return;
    }

    const dist = Math.hypot(boss.pos.x - streamer.pos.x, boss.pos.y - streamer.pos.y);
    
    // Check if phase ability has expired
    if (boss.phased && boss.phaseUntil && now > boss.phaseUntil) {
      boss.phased = false;
      boss.phaseUntil = undefined;
      this.broadcast("notice", { message: "👻 Shadow Lord returns to reality!" });
    }
    
    // Handle boss states
    switch (boss.state) {
      case "spawning":
        if (now - boss.spawnTime > 2000) {
          boss.state = "idle";
        }
        break;
        
      case "idle":
        if (dist < 400) {
          boss.state = "chasing";
          boss.targetId = streamer.id;
        }
        break;
        
      case "chasing":
        if (dist > 600) {
          boss.state = "idle";
          boss.targetId = undefined;
        } else if (dist < boss.radius + 30) {
          boss.state = "attacking";
        }
        break;
        
      case "attacking":
        if (dist > boss.radius + 50) {
          boss.state = "chasing";
        }
        break;
    }

    // Movement AI - improved movement logic
    if ((boss.state === "chasing" || boss.state === "attacking") && streamer) {
      const dx = streamer.pos.x - boss.pos.x;
      const dy = streamer.pos.y - boss.pos.y;
      const len = Math.hypot(dx, dy) || 1;
      
      let speed = boss.speed;
      if (boss.enraged && boss.type === "bruteKing") {
        const config = this.cfg.bosses.types.bruteKing;
        speed *= config.abilities.enrage.speedMul;
      }
      
      // Only move if not too close (prevents jittering)
      if (len > boss.radius + this.cfg.radii.streamer + 5) {
        boss.vel.x = (dx / len) * speed;
        boss.vel.y = (dy / len) * speed;
      } else {
        // Slow down when very close
        boss.vel.x = (dx / len) * speed * 0.3;
        boss.vel.y = (dy / len) * speed * 0.3;
      }
    } else if (boss.state === "idle") {
      // Idle wandering movement
      if (!boss.wanderTarget || Math.hypot(boss.pos.x - boss.wanderTarget.x, boss.pos.y - boss.wanderTarget.y) < 20) {
        // Set new wander target
        boss.wanderTarget = {
          x: boss.pos.x + (Math.random() - 0.5) * 200,
          y: boss.pos.y + (Math.random() - 0.5) * 200
        };
        // Keep target in bounds
        boss.wanderTarget.x = Math.max(boss.radius, Math.min(this.W - boss.radius, boss.wanderTarget.x));
        boss.wanderTarget.y = Math.max(boss.radius, Math.min(this.H - boss.radius, boss.wanderTarget.y));
      }
      
      const dx = boss.wanderTarget.x - boss.pos.x;
      const dy = boss.wanderTarget.y - boss.pos.y;
      const len = Math.hypot(dx, dy) || 1;
      
      boss.vel.x = (dx / len) * boss.speed * 0.5; // Slower idle movement
      boss.vel.y = (dy / len) * boss.speed * 0.5;
    } else {
      boss.vel.x = 0;
      boss.vel.y = 0;
    }

    // Update position
    const dt = this.tickMs / 1000;
    boss.pos.x += boss.vel.x * dt;
    boss.pos.y += boss.vel.y * dt;

    // Keep boss in bounds
    boss.pos.x = Math.max(boss.radius, Math.min(this.W - boss.radius, boss.pos.x));
    boss.pos.y = Math.max(boss.radius, Math.min(this.H - boss.radius, boss.pos.y));

    // Handle abilities
    this.processBossAbilities(boss, now, streamer);

    // Handle contact damage with cooldown and range check
    if (boss.state === "attacking" && streamer && dist < boss.radius + this.cfg.radii.streamer + 10) {
      // Add damage cooldown to prevent hitting every tick and ensure close range
      // Also prevent damage while boss is phased
      if ((!boss.lastDamage || now - boss.lastDamage > 1000) && dist < 100 && !boss.phased) { // 1 second cooldown + max 100px range + not phased
        let damage = boss.damage;
        if (boss.enraged && boss.type === "bruteKing") {
          damage *= this.cfg.bosses.types.bruteKing.abilities.enrage.damageMul;
        }
        
        streamer.hp = Math.max(0, (streamer.hp ?? this.cfg.streamer.maxHp) - damage);
        this.trackDamageTaken(streamer, damage);
        this.addDamageNumber(streamer.pos.x, streamer.pos.y, damage, false, false);
        boss.lastDamage = now;
        
        // Knockback
        const kx = (streamer.pos.x - boss.pos.x) / (dist || 1);
        const ky = (streamer.pos.y - boss.pos.y) / (dist || 1);
        streamer.pos.x += kx * this.cfg.combat.knockbackStep * 2;
        streamer.pos.y += ky * this.cfg.combat.knockbackStep * 2;
      }
    }

    // Check for enrage condition (Brute King only)
    if (boss.type === "bruteKing" && !boss.enraged) {
      const hpPct = boss.hp / boss.maxHp;
      if (hpPct <= this.cfg.bosses.types.bruteKing.abilities.enrage.hpThreshold) {
        boss.enraged = true;
        this.broadcast("notice", { message: "🔥 BRUTE KING ENRAGES! Speed and damage increased!" });
      }
    }
  }

  processBossAbilities(boss: Boss, now: number, streamer: Player) {
    const bossConfig = this.cfg.bosses.types[boss.type];
    
    // Process abilities based on boss type
    switch (boss.type) {
      case 'necromancer':
        const necroConfig = bossConfig as typeof this.cfg.bosses.types.necromancer;
        
        // Summon minions
        if (!boss.lastSummon || now - boss.lastSummon > necroConfig.abilities.summon.cooldownMs) {
          if (Math.random() < 0.3) {
            this.necromancerSummon(boss, now);
            boss.lastSummon = now;
          }
        }
        
        // Teleport
        if (!boss.lastTeleport || now - boss.lastTeleport > necroConfig.abilities.teleport.cooldownMs) {
          if (Math.random() < 0.2) {
            this.necromancerTeleport(boss, streamer);
            boss.lastTeleport = now;
          }
        }
        
        // Poison field
        if (!boss.lastPoisonField || now - boss.lastPoisonField > necroConfig.abilities.poisonField.cooldownMs) {
          if (Math.random() < 0.25) {
            this.necromancerPoisonField(boss, streamer, now);
            boss.lastPoisonField = now;
          }
        }
        break;
        
      case 'bruteKing':
        const bruteConfig = bossConfig as typeof this.cfg.bosses.types.bruteKing;
        
        // Check for enrage
        if (!boss.enraged && boss.hp <= boss.maxHp * bruteConfig.abilities.enrage.hpThreshold) {
          boss.enraged = true;
          boss.speed *= bruteConfig.abilities.enrage.speedMul;
          boss.damage *= bruteConfig.abilities.enrage.damageMul;
          this.broadcast("notice", { message: `💀 The ${boss.type} becomes enraged!` });
        }
        
        // Charge attack
        if (!boss.lastCharge || now - boss.lastCharge > bruteConfig.abilities.charge.cooldownMs) {
          if (Math.random() < 0.4) {
            this.bruteKingCharge(boss, streamer, now);
            boss.lastCharge = now;
          }
        }
        
        // Ground slam
        if (!boss.lastGroundSlam || now - boss.lastGroundSlam > bruteConfig.abilities.groundSlam.cooldownMs) {
          if (Math.random() < 0.3) {
            this.bruteKingGroundSlam(boss, streamer, now);
            boss.lastGroundSlam = now;
          }
        }
        break;
        
      case 'shadowLord':
        const shadowConfig = bossConfig as typeof this.cfg.bosses.types.shadowLord;
        
        // Phase ability
        if (!boss.lastPhase || now - boss.lastPhase > shadowConfig.abilities.phase.cooldownMs) {
          if (Math.random() < 0.2) {
            this.shadowLordPhase(boss, now);
            boss.lastPhase = now;
          }
        }
        
        // Shadow clones
        if (!boss.lastShadowClone || now - boss.lastShadowClone > shadowConfig.abilities.shadowClone.cooldownMs) {
          if (Math.random() < 0.25) {
            this.shadowLordClones(boss, now);
            boss.lastShadowClone = now;
          }
        }
        
        // Life drain
        if (!boss.lastLifeDrain || now - boss.lastLifeDrain > shadowConfig.abilities.lifeDrain.cooldownMs) {
          if (Math.random() < 0.3) {
            this.shadowLordLifeDrain(boss, streamer, now);
            boss.lastLifeDrain = now;
          }
        }
        break;
    }
  }

  // Boss ability implementations
  necromancerSummon(boss: Boss, now: number) {
    const config = this.cfg.bosses.types.necromancer.abilities.summon;
    for (let i = 0; i < config.minionCount; i++) {
      const angle = (Math.PI * 2 * i) / config.minionCount;
      const spawnX = boss.pos.x + Math.cos(angle) * 60;
      const spawnY = boss.pos.y + Math.sin(angle) * 60;
      
      const minion: BossMinion = {
        id: crypto.randomUUID().slice(0, 8),
        bossId: boss.id,
        pos: { x: spawnX, y: spawnY },
        vel: { x: 0, y: 0 },
        hp: config.minionHp,
        maxHp: config.minionHp,
        state: "idle",
        lastSeen: now,
        spawnTime: now
      };
      
      this.bossMinions.push(minion);
      boss.minionIds = boss.minionIds || [];
      boss.minionIds.push(minion.id);
    }
    
    this.broadcast("notice", { message: "💀 Necromancer summons undead minions!" });
  }

  necromancerTeleport(boss: Boss, streamer: Player) {
    const config = this.cfg.bosses.types.necromancer.abilities.teleport;
    const angle = Math.random() * Math.PI * 2;
    const distance = 100 + Math.random() * (config.range - 100);
    
    const newX = streamer.pos.x + Math.cos(angle) * distance;
    const newY = streamer.pos.y + Math.sin(angle) * distance;
    
    boss.pos.x = Math.max(boss.radius, Math.min(this.W - boss.radius, newX));
    boss.pos.y = Math.max(boss.radius, Math.min(this.H - boss.radius, newY));
    
    this.broadcast("boss_teleport", { bossId: boss.id, pos: boss.pos });
  }

  necromancerPoisonField(boss: Boss, streamer: Player, now: number) {
    const config = this.cfg.bosses.types.necromancer.abilities.poisonField;
    
    const poisonField: PoisonField = {
      id: crypto.randomUUID().slice(0, 8),
      pos: { x: streamer.pos.x, y: streamer.pos.y },
      radius: config.radius,
      dps: config.dps,
      createdAt: now,
      expiresAt: now + config.durationMs,
      ownerId: boss.id
    };
    
    this.poisonFields.push(poisonField);
    this.broadcast("poison_field", { field: poisonField });
  }

  bruteKingCharge(boss: Boss, streamer: Player, now: number) {
    const config = this.cfg.bosses.types.bruteKing.abilities.charge;
    const dx = streamer.pos.x - boss.pos.x;
    const dy = streamer.pos.y - boss.pos.y;
    const len = Math.hypot(dx, dy) || 1;
    
    boss.chargeDirX = dx / len;
    boss.chargeDirY = dy / len;
    boss.chargeUntil = now + config.durationMs;
    boss.state = "ability";
    
    this.broadcast("notice", { message: "⚡ Brute King charges forward!" });
  }

  bruteKingGroundSlam(boss: Boss, streamer: Player, now: number) {
    const config = this.cfg.bosses.types.bruteKing.abilities.groundSlam;
    const dist = Math.hypot(boss.pos.x - streamer.pos.x, boss.pos.y - streamer.pos.y);
    
    if (dist <= config.radius) {
      const damage = config.damage;
      streamer.hp = Math.max(0, (streamer.hp ?? this.cfg.streamer.maxHp) - damage);
      this.trackDamageTaken(streamer, damage);
      this.addDamageNumber(streamer.pos.x, streamer.pos.y, damage, false, false);
      
      // Stun effect
      (streamer as any).stunUntil = now + config.stunMs;
    }
    
    this.broadcast("ground_slam", { pos: boss.pos, radius: config.radius });
    this.broadcast("notice", { message: "💥 Ground slam creates shockwaves!" });
  }

  shadowLordPhase(boss: Boss, now: number) {
    const config = this.cfg.bosses.types.shadowLord.abilities.phase;
    boss.phased = true;
    boss.phaseUntil = now + config.durationMs;
    
    this.broadcast("notice", { message: "👻 Shadow Lord phases out of reality!" });
  }

  shadowLordClones(boss: Boss, now: number) {
    const config = this.cfg.bosses.types.shadowLord.abilities.shadowClone;
    
    for (let i = 0; i < config.cloneCount; i++) {
      const angle = (Math.PI * 2 * i) / config.cloneCount;
      const spawnX = boss.pos.x + Math.cos(angle) * 80;
      const spawnY = boss.pos.y + Math.sin(angle) * 80;
      
      const clone: BossMinion = {
        id: crypto.randomUUID().slice(0, 8),
        bossId: boss.id,
        pos: { x: spawnX, y: spawnY },
        vel: { x: 0, y: 0 },
        hp: config.cloneHp,
        maxHp: config.cloneHp,
        state: "idle",
        lastSeen: now,
        spawnTime: now,
        expiresAt: now + config.durationMs
      };
      
      this.bossMinions.push(clone);
      boss.cloneIds = boss.cloneIds || [];
      boss.cloneIds.push(clone.id);
    }
    
    this.broadcast("notice", { message: "🌙 Shadow clones emerge from the darkness!" });
  }

  shadowLordLifeDrain(boss: Boss, streamer: Player, now: number) {
    const config = this.cfg.bosses.types.shadowLord.abilities.lifeDrain;
    const damage = config.dps;
    const heal = Math.round(damage * config.healMul);
    
    streamer.hp = Math.max(0, (streamer.hp ?? this.cfg.streamer.maxHp) - damage);
    this.trackDamageTaken(streamer, damage);
    boss.hp = Math.min(boss.maxHp, boss.hp + heal);
    
    this.addDamageNumber(streamer.pos.x, streamer.pos.y, damage, false, true);
    this.addDamageNumber(boss.pos.x, boss.pos.y, -heal, false, false); // Negative for healing
    
    this.broadcast("life_drain", { from: boss.pos, to: streamer.pos });
  }

  updateBossMinions(now: number) {
    for (let i = this.bossMinions.length - 1; i >= 0; i--) {
      const minion = this.bossMinions[i];
      
      // Remove expired minions
      if (minion.expiresAt && now > minion.expiresAt) {
        this.bossMinions.splice(i, 1);
        continue;
      }
      
      // Remove minions whose boss is dead
      const boss = this.bosses.find(b => b.id === minion.bossId);
      if (!boss) {
        this.bossMinions.splice(i, 1);
        continue;
      }
      
      // Simple AI for minions
      const streamer = [...this.players.values()].find(p => p.role === "streamer" && p.alive);
      if (streamer) {
        const dist = Math.hypot(minion.pos.x - streamer.pos.x, minion.pos.y - streamer.pos.y);
        
        if (dist < 200) {
          minion.state = "chasing";
          minion.targetId = streamer.id;
          
          const dx = streamer.pos.x - minion.pos.x;
          const dy = streamer.pos.y - minion.pos.y;
          const len = Math.hypot(dx, dy) || 1;
          
          const speed = 80;
          minion.vel.x = (dx / len) * speed;
          minion.vel.y = (dy / len) * speed;
          
          // Update position
          const dt = this.tickMs / 1000;
          minion.pos.x += minion.vel.x * dt;
          minion.pos.y += minion.vel.y * dt;
          
          // Contact damage
          if (dist < 20) {
            const damage = 15;
            streamer.hp = Math.max(0, (streamer.hp ?? this.cfg.streamer.maxHp) - damage);
            this.trackDamageTaken(streamer, damage);
            this.addDamageNumber(streamer.pos.x, streamer.pos.y, damage, false, false);
          }
        }
      }
    }
  }

  updatePoisonFields(now: number) {
    for (let i = this.poisonFields.length - 1; i >= 0; i--) {
      const field = this.poisonFields[i];
      
      if (now > field.expiresAt) {
        this.poisonFields.splice(i, 1);
        continue;
      }
      
      // Damage streamer if in poison field
      const streamer = [...this.players.values()].find(p => p.role === "streamer" && p.alive);
      if (streamer) {
        const dist = Math.hypot(streamer.pos.x - field.pos.x, streamer.pos.y - field.pos.y);
        if (dist <= field.radius) {
          const damage = Math.round(field.dps * (this.tickMs / 1000));
          streamer.hp = Math.max(0, (streamer.hp ?? this.cfg.streamer.maxHp) - damage);
          this.trackDamageTaken(streamer, damage);
          this.addDamageNumber(streamer.pos.x, streamer.pos.y, damage, false, true);
        }
      }
    }
  }

  onBossDeath(boss: Boss) {
    // Generate loot drops
    this.generateBossLoot(boss);
    
    // Clean up minions and clones
    this.bossMinions = this.bossMinions.filter(m => m.bossId !== boss.id);
    
    // Broadcast death
    this.broadcast("boss_death", { bossId: boss.id, pos: boss.pos });
    this.broadcast("notice", { message: `💀 ${boss.type.toUpperCase()} has been defeated! Loot scattered!` });
  }

  generateBossLoot(boss: Boss) {
    const config = this.cfg.bosses.lootDrops;
    const dropCount = config.guaranteedDrops + 
      (Math.random() < config.bonusDropChance ? Math.floor(Math.random() * config.maxBonusDrops) : 0);
    
    for (let i = 0; i < dropCount; i++) {
      const angle = (Math.PI * 2 * i) / dropCount + Math.random() * 0.5;
      const distance = 30 + Math.random() * 60;
      const dropX = boss.pos.x + Math.cos(angle) * distance;
      const dropY = boss.pos.y + Math.sin(angle) * distance;
      
      let dropType: PickupType;
      
      // Boss drops: ammo, health, and treasures (no keys)
      const rand = Math.random();
      if (rand < 0.4) {
        // 40% chance for ammo
        dropType = "ammo";
      } else if (rand < 0.6) {
        // 20% chance for health
        dropType = "health";
      } else if (rand < 0.8) {
        // 20% chance for valuable treasures
        const valuableTreasures: PickupType[] = ["gem", "crystal", "orb", "relic", "artifact"];
        dropType = valuableTreasures[Math.floor(Math.random() * valuableTreasures.length)];
      } else {
        // 20% chance for special items
        const specialItems: PickupType[] = ["crown", "scroll", "weapon"];
        dropType = specialItems[Math.floor(Math.random() * specialItems.length)];
      }
      
      this.pickups.push({
        id: crypto.randomUUID().slice(0, 6),
        type: dropType,
        x: Math.max(20, Math.min(this.W - 20, dropX)),
        y: Math.max(20, Math.min(this.H - 20, dropY))
      });
    }
  }

  publicBoss(boss: any) {
    const visual = this.cfg.bosses.types[boss.type].visual;
    return {
      id: boss.id,
      type: boss.type,
      pos: boss.pos,
      hp: boss.hp,
      maxHp: boss.maxHp,
      radius: boss.radius,
      state: boss.state,
      enraged: boss.enraged,
      phased: boss.phased,
      visual: visual
    };
  }

  // Initialize raid stats for a player
  initRaidStats(player: any): void {
    console.log('Initializing raid stats for player:', player.id, player.name);
    if (!player.raidStats) {
      player.raidStats = {
        enemiesKilled: 0,
        bossesKilled: 0,
        bulletsFired: 0,
        bulletsHit: 0,
        coinsCollected: 0,
        pickupsTaken: 0,
        damageDealt: 0,
        damageTaken: 0,
        totalXPGained: 0,
        startTime: Date.now(),
        enemyBreakdown: {
          basic: 0,
          runner: 0,
          brute: 0,
          spitter: 0,
          stalker: 0,
          bomber: 0
        },
        bossesDefeated: []
      };
    }
  }

  // Track enemy kill
  trackEnemyKill(player: any, enemyType: string): void {
    if (player.role !== 'streamer') return; // Only track for streamers
    if (!player.raidStats) this.initRaidStats(player);
    player.raidStats!.enemiesKilled++;
    console.log('Enemy killed! Type:', enemyType, 'Total kills:', player.raidStats!.enemiesKilled);
    
    // Track by enemy type
    switch (enemyType) {
      case 'runner':
        player.raidStats!.enemyBreakdown.runner++;
        break;
      case 'brute':
        player.raidStats!.enemyBreakdown.brute++;
        break;
      case 'spitter':
        player.raidStats!.enemyBreakdown.spitter++;
        break;
      case 'stalker':
        player.raidStats!.enemyBreakdown.stalker++;
        break;
      case 'bomber':
        player.raidStats!.enemyBreakdown.bomber++;
        break;
      default:
        player.raidStats!.enemyBreakdown.basic++;
        break;
    }
  }

  // Track boss kill
  trackBossKill(player: any, bossType?: string): void {
    if (player.role !== 'streamer') return; // Only track for streamers
    if (!player.raidStats) this.initRaidStats(player);
    player.raidStats!.bossesKilled++;
    if (bossType) {
      player.raidStats!.bossesDefeated.push(bossType);
    }
  }

  // Track bullet fired
  trackBulletFired(player: any): void {
    if (player.role !== 'streamer') return; // Only track for streamers
    if (!player.raidStats) this.initRaidStats(player);
    player.raidStats!.bulletsFired++;
    console.log('Bullet fired! Total:', player.raidStats!.bulletsFired);
  }

  // Track bullet hit
  trackBulletHit(player: any): void {
    if (player.role !== 'streamer') return; // Only track for streamers
    if (!player.raidStats) this.initRaidStats(player);
    player.raidStats!.bulletsHit++;
  }

  // Track damage dealt
  trackDamageDealt(player: any, damage: number): void {
    if (player.role !== 'streamer') return; // Only track for streamers
    if (!player.raidStats) this.initRaidStats(player);
    player.raidStats!.damageDealt += damage;
  }

  // Track damage taken
  trackDamageTaken(player: any, damage: number): void {
    if (player.role !== 'streamer') return; // Only track for streamers
    if (!player.raidStats) this.initRaidStats(player);
    player.raidStats!.damageTaken += damage;
    console.log('Damage taken! Amount:', damage, 'Total:', player.raidStats!.damageTaken);
  }

  // Track pickup taken
  trackPickupTaken(player: any, pickupType: string): void {
    if (player.role !== 'streamer') return; // Only track for streamers
    if (!player.raidStats) this.initRaidStats(player);
    player.raidStats!.pickupsTaken++;
    
    if (pickupType.includes('coin') || pickupType.includes('gem') || 
        pickupType.includes('crystal') || pickupType.includes('treasure')) {
      player.raidStats!.coinsCollected++;
    }
  }

  // Track XP gained
  trackXPGained(player: any, xp: number): void {
    if (player.role !== 'streamer') return; // Only track for streamers
    if (!player.raidStats) this.initRaidStats(player);
    player.raidStats!.totalXPGained += xp;
  }
}
