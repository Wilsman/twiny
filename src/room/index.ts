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

import { XP_THRESHOLDS, MOD_INDEX, statsFor } from '../upgrades';
import type { ActiveBullet, BulletSpawnSpec, Boss, BossMinion, PoisonField, BossType, ModId } from '../types';
import type { Vec, Input, Player, Rect, Pickup, PickupType, AIZombie, Extraction } from './room-types';

type Bullet = ActiveBullet;

import { CONFIG, TileId, type GameConfig } from '../config';
import { checkPickupSpawning as checkPickupSpawningImpl, getRandomZombieDrop as getRandomZombieDropImpl, getTreasureValue as getTreasureValueImpl } from './systems/pickups';
import { processUpgradeEffects as processUpgradeEffectsImpl, offerUpgrades as offerUpgradesImpl, applyUpgrade as applyUpgradeImpl } from './systems/upgrades';
import { createExplosion as createExplosionImpl, spawnSmallExplosion as spawnSmallExplosionImpl, addDamageNumber as addDamageNumberImpl, processDotEffects as processDotEffectsImpl, refundAmmoOnKill as refundAmmoOnKillImpl, applyChainDamage as applyChainDamageImpl } from './systems/combat';
import { processZombieAbilities as processZombieAbilitiesImpl, bomberExplode as bomberExplodeImpl, bomberExplodeAI as bomberExplodeAIImpl } from './systems/zombie-abilities';
import { spawnAIZombiesIfNeeded as spawnAIZombiesIfNeededImpl, updateAIZombies as updateAIZombiesImpl, getAIZombieSpawnPosition as getAIZombieSpawnPositionImpl, updateAIZombieMovement as updateAIZombieMovementImpl, moveAIZombie as moveAIZombieImpl, aiZombieAttackStreamer as aiZombieAttackStreamerImpl, hasLineOfSight as hasLineOfSightImpl } from './systems/ai-zombies';
import { update as updateImpl } from './systems/update';
import { generateTileMapAndWalls as generateTileMapAndWallsImpl, spawnInRandomRoom as spawnInRandomRoomImpl, spawnZombiePos as spawnZombiePosImpl, randomFreePos as randomFreePosImpl } from './systems/map';
import { processInputWithLagCompensation as processInputWithLagCompensationImpl } from './systems/input';
import { updateBossSystem as updateBossSystemImpl, spawnRandomBoss as spawnRandomBossImpl, updateBoss as updateBossImpl, processBossAbilities as processBossAbilitiesImpl, necromancerSummon as necromancerSummonImpl, necromancerTeleport as necromancerTeleportImpl, necromancerPoisonField as necromancerPoisonFieldImpl, bruteKingCharge as bruteKingChargeImpl, bruteKingGroundSlam as bruteKingGroundSlamImpl, shadowLordPhase as shadowLordPhaseImpl, shadowLordClones as shadowLordClonesImpl, shadowLordLifeDrain as shadowLordLifeDrainImpl, updateBossMinions as updateBossMinionsImpl, updatePoisonFields as updatePoisonFieldsImpl, onBossDeath as onBossDeathImpl, generateBossLoot as generateBossLootImpl, publicBoss as publicBossImpl } from './systems/bosses';
import { initRaidStats as initRaidStatsImpl, trackEnemyKill as trackEnemyKillImpl, trackBossKill as trackBossKillImpl, trackBulletFired as trackBulletFiredImpl, trackBulletHit as trackBulletHitImpl, trackDamageDealt as trackDamageDealtImpl, trackDamageTaken as trackDamageTakenImpl, trackPickupTaken as trackPickupTakenImpl, trackXPGained as trackXPGainedImpl } from './systems/stats';
import { broadcastState as broadcastStateImpl } from './systems/broadcast';
import { sanitizeName as sanitizeNameImpl, randomName as randomNameImpl } from './utils/names';


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
    return checkPickupSpawningImpl(this);
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
          const allowed = new Set(["Zombie","Skull","Fire","Joy","Love","Anger"]);
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
    return processUpgradeEffectsImpl(this, now);
  }

  
  createExplosion(x: number, y: number, damage: number, radius: number, ownerId: string) {
    return createExplosionImpl(this, x, y, damage, radius, ownerId);
  }

  
  processZombieAbilities(now: number) {
    return processZombieAbilitiesImpl(this, now);
  }

  
  bomberExplode(bomber: Player, now: number) {
    return bomberExplodeImpl(this, bomber, now);
  }

  
  bomberExplodeAI(bomber: AIZombie, now: number) {
    return bomberExplodeAIImpl(this, bomber, now);
  }

  
  addDamageNumber(x: number, y: number, damage: number, isCrit: boolean = false, isDot: boolean = false) {
    return addDamageNumberImpl(this, x, y, damage, isCrit, isDot);
  }


  update() {
    return updateImpl(this);
  }


  // AI Zombie methods
  spawnAIZombiesIfNeeded(now: number) {
    return spawnAIZombiesIfNeededImpl(this, now);
  }

  
  getRandomZombieDrop(): PickupType | null {
    return getRandomZombieDropImpl(this);
  }


  getTreasureValue(type: PickupType): number {
    return getTreasureValueImpl(this, type);
  }


  getAIZombieSpawnPosition(streamerPos: Vec): Vec | null {
    return getAIZombieSpawnPositionImpl(this, streamerPos);
  }

  
  updateAIZombies(now: number) {
    return updateAIZombiesImpl(this, now);
  }

  
  hasLineOfSight(from: Vec, to: Vec): boolean {
    return hasLineOfSightImpl(this, from, to);
  }

  
  updateAIZombieMovement(zombie: AIZombie, streamer: Player, now: number, dt: number) {
    return updateAIZombieMovementImpl(this, zombie, streamer, now, dt);
  }

  
  moveAIZombie(zombie: AIZombie, dt: number) {
    return moveAIZombieImpl(this, zombie, dt);
  }

  
  aiZombieAttackStreamer(zombie: AIZombie, streamer: Player, now: number) {
    return aiZombieAttackStreamerImpl(this, zombie, streamer, now);
  }


  broadcastState() {
    return broadcastStateImpl(this);
  }


  broadcast(type: string, payload: unknown) {
    const msg = JSON.stringify({ type, ...payload as any });
    for (const p of this.players.values()) {
      if (!p.ws) continue;
      try { p.ws.send(msg); } catch {}
    }
  }

  offerUpgrades(playerId: string) {
    return offerUpgradesImpl(this, playerId);
  }


  applyUpgrade(playerId: string, id: ModId) {
    return applyUpgradeImpl(this, playerId, id);
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
    return spawnSmallExplosionImpl(this, b);
  }


  processDotEffects(now: number) {
    return processDotEffectsImpl(this, now);
  }


  // Refund ammo on kill based on current weapon and percentage
  refundAmmoOnKill(owner: Player, pct: number) {
    return refundAmmoOnKillImpl(this, owner, pct);
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
    return applyChainDamageImpl(this, b, from, excludeId, count, dmg);
  }


  sanitizeName(n: string) {
    return sanitizeNameImpl(this, n);
  }


  randomName() {
    return randomNameImpl(this);
  }


  spawnInRandomRoom(): Vec {
    return spawnInRandomRoomImpl(this);
  }


  spawnZombiePos(): Vec {
    return spawnZombiePosImpl(this);
  }


  // Map generation and helpers
  generateTileMapAndWalls() {
    return generateTileMapAndWallsImpl(this);
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
    return randomFreePosImpl(this, buffer);
  }


  // Lag compensation method
  processInputWithLagCompensation(player: Player, input: Input, timestamp: number) {
    return processInputWithLagCompensationImpl(this, player, input, timestamp);
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
    return updateBossSystemImpl(this, now);
  }


  spawnRandomBoss() {
    return spawnRandomBossImpl(this);
  }


  updateBoss(boss: Boss, now: number) {
    return updateBossImpl(this, boss, now);
  }


  processBossAbilities(boss: Boss, now: number, streamer: Player) {
    return processBossAbilitiesImpl(this, boss, now, streamer);
  }


  // Boss ability implementations
  necromancerSummon(boss: Boss, now: number) {
    return necromancerSummonImpl(this, boss, now);
  }


  necromancerTeleport(boss: Boss, streamer: Player) {
    return necromancerTeleportImpl(this, boss, streamer);
  }


  necromancerPoisonField(boss: Boss, streamer: Player, now: number) {
    return necromancerPoisonFieldImpl(this, boss, streamer, now);
  }


  bruteKingCharge(boss: Boss, streamer: Player, now: number) {
    return bruteKingChargeImpl(this, boss, streamer, now);
  }


  bruteKingGroundSlam(boss: Boss, streamer: Player, now: number) {
    return bruteKingGroundSlamImpl(this, boss, streamer, now);
  }


  shadowLordPhase(boss: Boss, now: number) {
    return shadowLordPhaseImpl(this, boss, now);
  }


  shadowLordClones(boss: Boss, now: number) {
    return shadowLordClonesImpl(this, boss, now);
  }


  shadowLordLifeDrain(boss: Boss, streamer: Player, now: number) {
    return shadowLordLifeDrainImpl(this, boss, streamer, now);
  }


  updateBossMinions(now: number) {
    return updateBossMinionsImpl(this, now);
  }


  updatePoisonFields(now: number) {
    return updatePoisonFieldsImpl(this, now);
  }


  onBossDeath(boss: Boss) {
    return onBossDeathImpl(this, boss);
  }


  generateBossLoot(boss: Boss) {
    return generateBossLootImpl(this, boss);
  }


  publicBoss(boss: any) {
    return publicBossImpl(this, boss);
  }


  // Initialize raid stats for a player
  initRaidStats(player: any): void {
    return initRaidStatsImpl(this, player);
  }


  // Track enemy kill
  trackEnemyKill(player: any, enemyType: string): void {
    return trackEnemyKillImpl(this, player, enemyType);
  }


  // Track boss kill
  trackBossKill(player: any, bossType?: string): void {
    return trackBossKillImpl(this, player, bossType);
  }


  // Track bullet fired
  trackBulletFired(player: any): void {
    return trackBulletFiredImpl(this, player);
  }


  // Track bullet hit
  trackBulletHit(player: any): void {
    return trackBulletHitImpl(this, player);
  }


  // Track damage dealt
  trackDamageDealt(player: any, damage: number): void {
    return trackDamageDealtImpl(this, player, damage);
  }


  // Track damage taken
  trackDamageTaken(player: any, damage: number): void {
    return trackDamageTakenImpl(this, player, damage);
  }


  // Track pickup taken
  trackPickupTaken(player: any, pickupType: string): void {
    return trackPickupTakenImpl(this, player, pickupType);
  }


  // Track XP gained
  trackXPGained(player: any, xp: number): void {
    return trackXPGainedImpl(this, player, xp);
  }

  // Hit confirm helper for melee hitstop/FX
  hitConfirm(x: number, y: number): void {
    // Trigger hitstop/visual effects at the hit location
    // This can be expanded to add screen shake, particle effects, etc.
    this.broadcast("hit_confirm", { x, y, timestamp: Date.now() });
  }

}



