// src/types.ts
export type ModId =
  | 'damage_up' | 'firerate_up' | 'bullet_size'
  | 'pierce' | 'bounce' | 'ricochet' | 'shot_split'
  | 'spread_down' | 'reload_on_kill' | 'lifesteal'
  | 'knockback_up' | 'crit_chance' | 'crit_dmg' | 'status_burn'
  | 'status_slow' | 'status_bleed'
  | 'extra_bullet' | 'weapon_stability' | 'weapon_precision'
  | 'dash_reload' | 'on_hit_explode' | 'chain_lightning'
  | 'magnet_radius' | 'on_extract_refund' | 'ammo_efficiency'
  | 'movement_speed' | 'dash_distance' | 'double_jump' | 'ghost_walk'
  | 'berserker' | 'vampire_aura' | 'time_dilation' | 'bullet_time'
  | 'explosive_death' | 'shield_regen'
  | 'elemental_trail'
  | 'void_hooks' | 'volatile_payload' | 'sanguine_cycle';

export type Rarity = 'common'|'uncommon'|'rare'|'epic'|'legendary';

export type WeaponProcId =
  | 'arc_burst'
  | 'gravity_snare'
  | 'volatile_core'
  | 'siphon_bloom';

export type WeaponId =
  | 'pistol'
  | 'smg'
  | 'shotgun'
  | 'railgun'
  | 'flamethrower'
  | 'bat';

export type BulletTrait =
  | 'burn'
  | 'slow'
  | 'bleed'
  | 'chain'
  | 'ricochet'
  | 'pierce';

export interface BulletVisualHint {
  weapon?: WeaponId;
  empowered?: boolean;
  traits?: BulletTrait[];
}

export interface WeaponProcGrant {
  id: WeaponProcId;
  flatChance?: number;
  chancePerStack?: number;
  maxChance?: number;
  flatPotency?: number;
  potencyPerStack?: number;
}

export interface ModDef {
  id: ModId;
  name: string;
  desc: string;
  rarity: Rarity;
  maxStacks?: number;        // default infinite
  // Pure stat changes:
  apply?: (s: StatBlock, stacks: number) => void;
  // Event hooks (optional):
  hooks?: Partial<ModHooks>;
  // Proc-based effects that can be shared across weapons
  weaponProcs?: WeaponProcGrant[];
}

export interface StatBlock {
  damageMul: number;         // x
  fireRateMul: number;       // x
  projectileSpeedMul: number;// x
  bulletSizeMul: number;     // x (used for collision radius margin)
  spreadMul: number;         // x
  knockbackMul: number;      // x
  critChance: number;        // 0..1
  critMul: number;           // x
  pierce: number;            // hits before despawn
  bounce: number;            // wall bounces
  ricochet: number;          // number of ricochets to nearest enemy
  split: number;             // extra bullets per shot (per split event)
  chain: number;             // chain count for lightning
  burnChance: number; burnDps: number; burnMs: number;
  slowChance: number; slowMul: number; slowMs: number;
  bleedChance: number; bleedDps: number; bleedMs: number;
  reloadOnKillPct: number;
  lifestealPct: number;
  ammoEfficiencyMul: number; // <1 means cheaper per shot
  magnetBonus: number;       // +px to pickup range (client hint only)
  dashReloadPct: number;
  // New stats for advanced upgrades
  movementSpeedMul: number;  // movement speed multiplier
  dashDistanceMul: number;   // dash distance multiplier
  ghostWalkMs: number;       // ghost walk duration
  berserkerStacks: number;   // berserker damage stacks
  vampireAuraRange: number;  // vampire aura range
  timeDilationMs: number;    // time dilation duration
  bulletTimeMs: number;      // bullet time duration
  explosiveDeathDamage: number; // explosive death damage
  shieldRegenRate: number;   // shield regeneration rate
}

export interface ModHooks {
  // Invoked when server is about to spawn bullets for a shot:
  onShoot?: (ctx: ShotContext) => void;
  // Invoked when a bullet hits something
  onHit?: (ctx: HitContext) => void;
  // Invoked when a zombie dies
  onKill?: (ctx: KillContext) => void;
}

export interface WeaponProcInstance {
  id: WeaponProcId;
  stacks: number;
  chance: number;
  potency: number;
}

export interface ShotContext {
  room: any;        // avoid circular import with RoomDO
  playerId: string;
  // mutable – push extra bullets, tweak per-shot spread, etc.
  bullets: BulletSpawnSpec[];
  stats: StatBlock;    // computed stats snapshot
}

export interface HitContext {
  room: any; // avoid circular import
  bullet: ActiveBullet;
  targetId?: string;   // zombie id
  killed?: boolean;
  stats: StatBlock;
}

export interface KillContext {
  room: any; // avoid circular import
  killerId: string;
  victimId: string;
  stats: StatBlock;
}

// Compact info we bake into a bullet at spawn (no functions):
export interface BulletSpawnSpec {
  pos: {x:number;y:number};
  vel: {x:number;y:number};
  ttl: number;
  ownerId: string;
  visual?: BulletVisualHint;
  meta: {
    damage: number;
    radius: number;         // collision radius for this bullet
    pierce: number;
    bounce: number;
    ricochet: number;
    chain: number;
    status?: { 
      burnMs?:number; burnDps?:number; burnChance?:number;
      slowMs?:number; slowMul?:number; slowChance?:number;
      bleedMs?:number; bleedDps?:number; bleedChance?:number;
    };
    critChance: number;
    critMul: number;
  };
}
export type ActiveBullet = BulletSpawnSpec & { id: string };

export interface WeaponProcContextBase {
  room: any;
  owner: any;
  instance: WeaponProcInstance;
  stats: StatBlock;
}

export interface WeaponProcShootContext extends WeaponProcContextBase {
  weapon?: string;
  bullets: BulletSpawnSpec[];
}

export interface WeaponProcHitContext extends WeaponProcContextBase {
  bullet: ActiveBullet;
  targetId?: string;
  targetType?: 'playerZombie' | 'aiZombie' | 'boss';
  killed?: boolean;
  impact: { x: number; y: number };
}

export interface WeaponProcKillContext extends WeaponProcContextBase {
  victimId: string;
  bullet?: ActiveBullet;
  targetType?: 'playerZombie' | 'aiZombie' | 'boss';
  impact: { x: number; y: number };
}

export interface WeaponProcHooks {
  onShoot?: (ctx: WeaponProcShootContext) => void;
  onHit?: (ctx: WeaponProcHitContext) => void;
  onKill?: (ctx: WeaponProcKillContext) => void;
}

export interface WeaponProcDef {
  id: WeaponProcId;
  name: string;
  description: string;
  flavor?: string;
  cooldownMs?: number;
  events: WeaponProcHooks;
}

export type ZombieClass = "runner" | "brute" | "spitter" | "stalker" | "bomber";

export type BossType = "necromancer" | "bruteKing" | "shadowLord";

export interface Boss {
  id: string;
  type: BossType;
  pos: { x: number; y: number };
  vel: { x: number; y: number };
  hp: number;
  maxHp: number;
  radius: number;
  damage: number;
  speed: number;
  state: "spawning" | "idle" | "chasing" | "attacking" | "ability" | "dying";
  targetId?: string;
  lastSeen: number;
  spawnTime: number;
  
  // Ability cooldowns
  lastSummon?: number;
  lastTeleport?: number;
  lastPoisonField?: number;
  lastCharge?: number;
  lastGroundSlam?: number;
  lastPhase?: number;
  lastShadowClone?: number;
  lastLifeDrain?: number;
  
  // State tracking
  enraged?: boolean;
  phased?: boolean;
  phaseUntil?: number;
  chargeUntil?: number;
  chargeDirX?: number;
  chargeDirY?: number;
  stunUntil?: number;
  
  // Minions and clones
  minionIds?: string[];
  cloneIds?: string[];
  
  // Status effects
  slowUntil?: number;
  slowMul?: number;
  burns?: Array<{ until: number; dps: number; nextTick: number; ownerId: string }>;
  bleeds?: Array<{ until: number; dps: number; nextTick: number; ownerId: string }>;
  
  // Damage cooldown
  lastDamage?: number;
  
  // Wandering AI
  wanderTarget?: { x: number; y: number };
}

export interface BossMinion {
  id: string;
  bossId: string;
  pos: { x: number; y: number };
  vel: { x: number; y: number };
  hp: number;
  maxHp: number;
  state: "idle" | "chasing" | "attacking";
  targetId?: string;
  lastSeen: number;
  spawnTime: number;
  expiresAt?: number;
}

export interface PoisonField {
  id: string;
  pos: { x: number; y: number };
  radius: number;
  dps: number;
  createdAt: number;
  expiresAt: number;
  ownerId: string;
  accumulatedDamage?: number;
}

export interface ElementalTrailSegment {
  id: string;
  ownerId: string;
  pos: { x: number; y: number };
  radius: number;
  effect: 'ignite' | 'poison' | 'shock';
  createdAt: number;
  expiresAt: number;
  potency: number;
  stacks: number;
}

export interface RaidStats {
  enemiesKilled: number;
  bossesKilled: number;
  bulletsFired: number;
  bulletsHit: number;
  coinsCollected: number;
  pickupsTaken: number;
  damageDealt: number;
  damageTaken: number;
  totalXPGained: number;
  startTime: number;
  enemyBreakdown: {
    basic: number;
    runner: number;
    brute: number;
    spitter: number;
    stalker: number;
    bomber: number;
  };
  bossesDefeated: string[]; // Array of boss names/types killed
}

export interface Player {
  id: string;
  name: string;
  x: number;
  y: number;
  hp?: number;
  maxHp?: number;
  score: number;
  banked?: number;
  role: "streamer" | "zombie";
  alive: boolean;
  weapon?: 'pistol' | 'smg' | 'shotgun' | 'railgun' | 'flamethrower' | 'bat';
  pistolAmmo?: number;
  smgAmmo?: number;
  shotgunAmmo?: number;
  railgunAmmo?: number;
  flamethrowerAmmo?: number;
  weaponed?: boolean;
  boosted?: boolean;
  level?: number;
  xp?: number;
  xpForNext?: number;
  mods?: Partial<Record<ModId, number>>;
  zClass?: string;
  emote?: string;
  emoteUntil?: number;
  meleeAt?: number;
  meleeDirX?: number;
  meleeDirY?: number;
  dashing?: boolean;
  dashReadyAt?: number;
  lastDashAt?: number;
  raidStats?: RaidStats;
}
