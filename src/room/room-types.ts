import type { ModId, ActiveBullet, WeaponId } from '../types';

export type Vec = { x: number; y: number };

export type Bullet = ActiveBullet;

export interface Input {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  shoot: boolean;
  aimX: number;
  aimY: number;
  melee?: boolean;
  dash?: boolean;
  interact?: boolean;
}


export type PlayerRole = 'streamer' | 'zombie';

export interface Player {
  id: string;
  role: PlayerRole;
  name: string;
  pos: Vec;
  vel: Vec;
  input: Input;
  ws?: WebSocket;
  score: number;
  banked?: number;
  alive: boolean;
  lastSeen: number;
  lastShotAt?: number;
  lastMeleeAt?: number;
  lastDashAt?: number;
  level?: number;
  xp?: number;
  mods?: Partial<Record<ModId, number>>;
  hp?: number;
  maxHp?: number;
  boostUntil?: number;
  ammo?: number;
  maxAmmo?: number;
  weaponBoostUntil?: number;
  emote?: string;
  emoteUntil?: number;
  weapon?: WeaponId;
  pistolAmmo?: number;
  smgAmmo?: number;
  shotgunAmmo?: number;
  railgunAmmo?: number;
  flamethrowerAmmo?: number;
  meleeDirX?: number;
  meleeDirY?: number;
  dashUntil?: number;
  lagMs?: number;
  inputBuffer?: Array<{ input: Input; timestamp: number }>;
  lastInputTime?: number;
  zClass?: 'runner' | 'brute' | 'spitter' | 'stalker' | 'bomber';
  zHp?: number;
  zMaxHp?: number;
  nextSpitAt?: number;
  lastAbilityAt?: number;
  chargeUntil?: number;
  chargeDirX?: number;
  chargeDirY?: number;
  slowUntil?: number;
  slowMul?: number;
  burns?: Array<{ until: number; dps: number; nextTick: number; ownerId: string }>;
  bleeds?: Array<{ until: number; dps: number; nextTick: number; ownerId: string }>;
  cloaked?: boolean;
  cloakUntil?: number;
  uncloakUntil?: number;
  fuseStarted?: number;
  fuseUntil?: number;
  lastShieldRegen?: number;
  hpShield?: number;
  raidStats?: any;
  [key: string]: any;
}

export interface Rect {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Extraction {
  id: string;
  x: number;
  y: number;
  r: number;
  activeUntil?: number;
}

export type PickupType =
  | 'health'
  | 'speed'
  | 'ammo'
  | 'weapon'
  | 'shield'
  | 'magnet'
  | 'freeze'
  | 'blast'
  | 'treasure'
  | 'key'
  | 'coin'
  | 'gem'
  | 'relic'
  | 'artifact'
  | 'crystal'
  | 'orb'
  | 'medallion'
  | 'scroll'
  | 'crown';

export interface Pickup {
  id: string;
  type: PickupType;
  x: number;
  y: number;
}

export type WeaponDropSource = 'boss' | 'treasure' | 'swap' | 'spawn';

export interface WeaponDrop {
  id: string;
  weapon: NonNullable<Player['weapon']>;
  ammo: number;
  x: number;
  y: number;
  source: WeaponDropSource;
}
export interface AIZombie {
  id: string;
  pos: Vec;
  vel: Vec;
  hp: number;
  maxHp: number;
  zClass: 'runner' | 'brute' | 'spitter' | 'stalker' | 'bomber';
  state: 'idle' | 'chasing' | 'attacking';
  targetId?: string;
  lastSeen: number;
  lastAttack: number;
  detectionRange: number;
  chaseRange: number;
  roomId?: string;
  pathfindingCooldown: number;
  nextPathUpdate: number;
  slowUntil?: number;
  slowMul?: number;
  burns?: Array<{ until: number; dps: number; nextTick: number; ownerId: string }>;
  bleeds?: Array<{ until: number; dps: number; nextTick: number; ownerId: string }>;
  cloaked?: boolean;
  cloakUntil?: number;
  uncloakUntil?: number;
  fuseStarted?: number;
  fuseUntil?: number;
}

export type TestOverlapType = 
  | 'spawn_smg'
  | 'spawn_shotgun' 
  | 'spawn_railgun'
  | 'spawn_flamethrower'
  | 'spawn_health'
  | 'spawn_ammo'
  | 'spawn_shield'
  | 'spawn_speed'
  | 'spawn_zombie_runner'
  | 'spawn_zombie_brute'
  | 'spawn_zombie_spitter'
  | 'spawn_zombie_stalker'
  | 'spawn_zombie_bomber'
  | 'spawn_boss_necromancer'
  | 'spawn_boss_brute_king'
  | 'spawn_boss_shadow_lord';

export interface TestOverlap {
  id: string;
  type: TestOverlapType;
  x: number;
  y: number;
  radius: number;
  label: string;
  color: string;
  lastTriggered?: number;
  cooldownMs: number;
}




