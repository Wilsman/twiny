export type GameConfig = {
  arena: { width: number; height: number };
  ticks: { mainMs: number; pickupMs: number };
  round: { durationMs: number };
  speeds: { streamer: number; zombie: number; zombieBoostMultiplier: number; zombieSlowMultiplier: number };
  streamer: { maxHp: number };
  combat: { zombieTouchDamage: number; knockbackStep: number; respawnMs: number };
  weapons: {
    damage: { pistol: number; smg: number; shotgun: number; melee: number };
    cooldownMs: { pistol: { base: number; boosted: number }; smg: { base: number; boosted: number }; shotgun: { base: number; boosted: number } };
    projectile: { pistol: { speed: number; ttl: number }; smg: { speed: number; ttl: number }; shotgun: { speed: number; ttl: number; pellets: number } };
    ammo: { initial: { pistol: number; smg: number; shotgun: number }; pickupGain: { pistol: number; smg: number; shotgun: number }; max: { pistol: number; smg: number; shotgun: number } };
  };
  melee: { cooldownMs: number; reach: number; arcRad: number };
  dash: { cooldownMs: number; durationMs: number; speedMultiplier: number };
  pickups: {
    spawnIntervalMs: number;
    totalCap: number;
    minDistance: number;
    caps: Record<string, number>;
    treasureScore: number;
    blastRadius: number;
  };
  effects: { weaponBoostMs: number; shieldMs: number; magnetMs: number; zombieBoostMs: number; freezeMs: number };
  extraction: { radius: number; countMin: number; countMax: number; minActiveMs: number; maxActiveMs: number };
  radii: { streamer: number; zombie: number; bulletMargin: number };
  zombies: {
    baseHp: number;
    weights: { runner: number; brute: number; spitter: number };
    speedMul: { runner: number; brute: number; spitter: number };
    hpMul: { runner: number; brute: number; spitter: number };
    detectionRange: { runner: number; brute: number; spitter: number };
    chaseRange: { runner: number; brute: number; spitter: number };
    brute: { extraKnockbackMul: number };
    spitter: { cooldownMsMin: number; cooldownMsMax: number; manualCooldownMs: number; projectileSpeed: number; projectileTtl: number; hitDamage: number; slowMs: number; streamerSlowMul: number; range: number };
    runnerAbility: { cooldownMs: number; durationMs: number };
    bruteAbility: { cooldownMs: number; durationMs: number; speed: number };
  };
  aiZombies: {
    maxCount: number;
    spawnCooldownMs: number;
    dropChance: number;
    ammoDropChance: number;
    treasureDropChance: number;
    treasureValues: Record<string, number>;
    treasureDropRates: Record<string, number>;
  };
  tiles: { size: number; theme: "dungeon" | "cave" | "lab" };
};

export const CONFIG: GameConfig = {
  arena: { width: 7200, height: 4050 },
  ticks: { mainMs: 50, pickupMs: 500 },
  round: { durationMs: 5 * 60 * 1000 },
  speeds: { streamer: 175, zombie: 65, zombieBoostMultiplier: 1.75, zombieSlowMultiplier: 0.55 },
  streamer: { maxHp: 100 },
  combat: { zombieTouchDamage: 10, knockbackStep: 12, respawnMs: 800 },
  weapons: {
    damage: {
      pistol: 100,
      smg: 100,
      shotgun: 100, // Per pellet
      melee: 100,
    },
    cooldownMs: {
      pistol: { base: 320, boosted: 200 },
      smg: { base: 90, boosted: 60 },
      shotgun: { base: 800, boosted: 550 },
    },
    projectile: {
      pistol: { speed: 360, ttl: 1200 },
      smg: { speed: 340, ttl: 900 },
      shotgun: { speed: 300, ttl: 600, pellets: 6 },
    },
    ammo: {
      initial: { pistol: 60, smg: 120, shotgun: 24 },
      pickupGain: { pistol: 15, smg: 30, shotgun: 6 },
      max: { pistol: 120, smg: 240, shotgun: 48 },
    },
  },
  melee: { cooldownMs: 500, reach: 28, arcRad: Math.PI / 1.8 },
  dash: { cooldownMs: 1000, durationMs: 180, speedMultiplier: 3.5 },
  pickups: {
    spawnIntervalMs: 12000,
    totalCap: 12,
    minDistance: 48,
    caps: { health: 3, speed: 3, ammo: 3, weapon: 2, shield: 2, magnet: 2, freeze: 1, blast: 2, treasure: 3, key: 1 },
    treasureScore: 3,
    blastRadius: 90,
  },
  effects: { weaponBoostMs: 8000, shieldMs: 6000, magnetMs: 8000, zombieBoostMs: 7000, freezeMs: 6000 },
  extraction: { radius: 28, countMin: 1, countMax: 2, minActiveMs: 60_000, maxActiveMs: 90_000 },
  radii: { streamer: 10, zombie: 12, bulletMargin: 2 },
  zombies: {
    baseHp: 100,
    weights: { runner: 6, brute: 2, spitter: 2 },
    speedMul: { runner: 2.5, brute: 0.5, spitter: 1.5 },
    hpMul: { runner: 1.5, brute: 5, spitter: 2 },
    detectionRange: { runner: 300, brute: 300, spitter: 300 },
    chaseRange: { runner: 180, brute: 150, spitter: 200 },
    brute: { extraKnockbackMul: 1.4 },
    spitter: { cooldownMsMin: 1800, cooldownMsMax: 3000, manualCooldownMs: 900, projectileSpeed: 160, projectileTtl: 1800, hitDamage: 6, slowMs: 1600, streamerSlowMul: 0.65, range: 360 },
    runnerAbility: { cooldownMs: 1200, durationMs: 280 },
    bruteAbility: { cooldownMs: 1600, durationMs: 320, speed: 240 },
  },
  aiZombies: {
    maxCount: 30,
    spawnCooldownMs: 5000,
    dropChance: 0.45, // overall chance that ANY drop happens at all
    ammoDropChance: 0.5, // chance of ammo drop (if drop happens)
    treasureDropChance: 0.3, // chance of treasure drop (if drop happens)
    treasureValues: {
      coin: 10,
      gem: 25,
      crystal: 50,
      orb: 75,
      relic: 100,
      artifact: 150,
      medallion: 250,
      scroll: 400,
      crown: 1000
    },
    treasureDropRates: {
      coin: 0.25,        // Common (25%)
      gem: 0.20,         // Common (20%)
      crystal: 0.15,     // Uncommon (15%)
      orb: 0.13,         // Uncommon (13%)
      relic: 0.11,       // Rare (11%)
      artifact: 0.08,    // Rare (8%)
      medallion: 0.05,   // Epic (5%)
      scroll: 0.02,      // Epic (2%)
      crown: 0.01        // Legendary (1%)
    }
  },
  tiles: { size: 24, theme: "dungeon" },
};

export type TileId = 0 | 1 | 2 | 3 | 4 | 5; // floor, wall, pit, water, doorClosed, doorOpen
