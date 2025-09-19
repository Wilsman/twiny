export type GameConfig = {
  arena: { width: number; height: number };
  ticks: { mainMs: number; pickupMs: number };
  round: { durationMs: number };
  speeds: { streamer: number; zombie: number; zombieBoostMultiplier: number; zombieSlowMultiplier: number };
  streamer: { maxHp: number };
  combat: { zombieTouchDamage: number; knockbackStep: number; respawnMs: number };
  weapons: {
    damage: { pistol: number; smg: number; shotgun: number; railgun: number; flamethrower: number; melee: number };
    cooldownMs: {
      pistol: { base: number; boosted: number };
      smg: { base: number; boosted: number };
      shotgun: { base: number; boosted: number };
      railgun: { base: number; boosted: number };
      flamethrower: { base: number; boosted: number };
    };
    projectile: {
      pistol: { speed: number; ttl: number };
      smg: { speed: number; ttl: number };
      shotgun: { speed: number; ttl: number; pellets: number };
      railgun: { speed: number; ttl: number; pierce: number; width: number };
      flamethrower: { speed: number; ttl: number; cone: number; shards: number; burnMs: number; burnDps: number };
    };
    ammo: {
      initial: { pistol: number; smg: number; shotgun: number; railgun: number; flamethrower: number };
      pickupGain: { pistol: number; smg: number; shotgun: number; railgun: number; flamethrower: number };
      max: { pistol: number; smg: number; shotgun: number; railgun: number; flamethrower: number };
    };
  };
  melee: { cooldownMs: number; reach: number; arcRad: number; knockbackStep: number };
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
    weights: { runner: number; brute: number; spitter: number; stalker: number; bomber: number };
    speedMul: { runner: number; brute: number; spitter: number; stalker: number; bomber: number };
    hpMul: { runner: number; brute: number; spitter: number; stalker: number; bomber: number };
    detectionRange: { runner: number; brute: number; spitter: number; stalker: number; bomber: number };
    chaseRange: { runner: number; brute: number; spitter: number; stalker: number; bomber: number };
    brute: { extraKnockbackMul: number };
    spitter: { cooldownMsMin: number; cooldownMsMax: number; manualCooldownMs: number; projectileSpeed: number; projectileTtl: number; hitDamage: number; slowMs: number; streamerSlowMul: number; range: number };
    stalker: { cloakDurationMs: number; uncloakDurationMs: number; attackCooldownMs: number; cloakAlpha: number };
    bomber: { explosionRadius: number; explosionDamage: number; fuseTimeMs: number; warningRadius: number };
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
  tiles: { 
    size: number; 
    theme: "dungeon" | "cave" | "lab";
    traps: {
      waterFrequency: number;    // Multiplier for water trap spawn rate
      pitFrequency: number;      // Multiplier for death pit spawn rate  
      spikeFrequency: number;    // Multiplier for spike trap spawn rate
      poisonFrequency: number;   // Multiplier for poison pool spawn rate
    };
  };
  bosses: {
    spawnIntervalMs: number;     // Time between boss spawns
    maxActive: number;           // Maximum bosses active at once
    announceMs: number;          // Warning time before boss spawns
    types: {
      necromancer: {
        hp: number;
        speed: number;
        radius: number;
        damage: number;
        visual: {
          color: string;
          secondaryColor: string;
          symbol: string;
          minimapIcon: string;
          glowColor: string;
        };
        abilities: {
          summon: { cooldownMs: number; minionCount: number; minionHp: number };
          teleport: { cooldownMs: number; range: number };
          poisonField: { cooldownMs: number; radius: number; durationMs: number; dps: number };
        };
      };
      bruteKing: {
        hp: number;
        speed: number;
        radius: number;
        damage: number;
        visual: {
          color: string;
          secondaryColor: string;
          symbol: string;
          minimapIcon: string;
          glowColor: string;
        };
        abilities: {
          charge: { cooldownMs: number; speed: number; durationMs: number; damage: number };
          groundSlam: { cooldownMs: number; radius: number; damage: number; stunMs: number };
          enrage: { hpThreshold: number; speedMul: number; damageMul: number };
        };
      };
      shadowLord: {
        hp: number;
        speed: number;
        radius: number;
        damage: number;
        visual: {
          color: string;
          secondaryColor: string;
          symbol: string;
          minimapIcon: string;
          glowColor: string;
        };
        abilities: {
          phase: { cooldownMs: number; durationMs: number; alpha: number };
          shadowClone: { cooldownMs: number; cloneCount: number; cloneHp: number; durationMs: number };
          lifeDrain: { cooldownMs: number; range: number; dps: number; healMul: number };
        };
      };
    };
    lootDrops: {
      guaranteedDrops: number;   // Minimum drops on death
      bonusDropChance: number;   // Chance for extra drops
      maxBonusDrops: number;     // Maximum bonus drops
      treasureMultiplier: number; // Multiplier for treasure value
      specialDrops: {
        legendaryChance: number;  // Chance for legendary items
        weaponUpgradeChance: number; // Chance for weapon upgrades
        keyDropChance: number;    // Chance for keys
      };
    };
  };
};

export const CONFIG: GameConfig = {
  arena: { width: 7200, height: 4050 },
  ticks: { mainMs: 50, pickupMs: 500 },
  round: { durationMs: 5 * 60 * 1000 },
  speeds: { streamer: 175, zombie: 65, zombieBoostMultiplier: 1.75, zombieSlowMultiplier: 0.55 },
  streamer: { maxHp: 100 },
  combat: { zombieTouchDamage: 10, knockbackStep: 15, respawnMs: 800 },
  weapons: {
    damage: {
      pistol: 100,
      smg: 100,
      shotgun: 100, // Per pellet
      railgun: 320,
      flamethrower: 40,
      melee: 100,
    },
    cooldownMs: {
      pistol: { base: 320, boosted: 200 },
      smg: { base: 90, boosted: 60 },
      shotgun: { base: 800, boosted: 550 },
      railgun: { base: 1400, boosted: 900 },
      flamethrower: { base: 120, boosted: 80 },
    },
    projectile: {
      pistol: { speed: 360, ttl: 1200 },
      smg: { speed: 340, ttl: 900 },
      shotgun: { speed: 300, ttl: 600, pellets: 6 },
      railgun: { speed: 860, ttl: 1400, pierce: 6, width: 2.2 },
      flamethrower: { speed: 180, ttl: 280, cone: 0.65, shards: 5, burnMs: 1500, burnDps: 18 },
    },
    ammo: {
      initial: { pistol: 60, smg: 120, shotgun: 24, railgun: 8, flamethrower: 180 },
      pickupGain: { pistol: 15, smg: 30, shotgun: 6, railgun: 2, flamethrower: 45 },
      max: { pistol: 120, smg: 240, shotgun: 48, railgun: 16, flamethrower: 360 },
    },
  },
  melee: { cooldownMs: 500, reach: 32, arcRad: Math.PI / 1.2, knockbackStep: 20 },
  dash: { cooldownMs: 1000, durationMs: 180, speedMultiplier: 3.5 },
  pickups: {
    spawnIntervalMs: 12000,
    totalCap: 12,
    minDistance: 48,
    caps: { health: 3, speed: 3, ammo: 3, shield: 2, magnet: 2, freeze: 1, blast: 2, treasure: 3, key: 1 },
    treasureScore: 3,
    blastRadius: 90,
  },
  effects: { weaponBoostMs: 8000, shieldMs: 6000, magnetMs: 8000, zombieBoostMs: 7000, freezeMs: 6000 },
  extraction: { radius: 28, countMin: 1, countMax: 2, minActiveMs: 60_000, maxActiveMs: 90_000 },
  radii: { streamer: 10, zombie: 12, bulletMargin: 2 },
  zombies: {
    baseHp: 100,
    weights: { runner: 6, brute: 2, spitter: 2, stalker: 1, bomber: 1 },
    speedMul: { runner: 2.5, brute: 0.5, spitter: 1.5, stalker: 2.0, bomber: 1.0 },
    hpMul: { runner: 1.5, brute: 5, spitter: 2, stalker: 1.2, bomber: 2.5 },
    detectionRange: { runner: 300, brute: 300, spitter: 300, stalker: 400, bomber: 250 },
    chaseRange: { runner: 180, brute: 150, spitter: 200, stalker: 220, bomber: 120 },
    brute: { extraKnockbackMul: 1.4 },
    spitter: { cooldownMsMin: 1800, cooldownMsMax: 3000, manualCooldownMs: 900, projectileSpeed: 160, projectileTtl: 1800, hitDamage: 6, slowMs: 1600, streamerSlowMul: 0.65, range: 360 },
    stalker: { cloakDurationMs: 8000, uncloakDurationMs: 2000, attackCooldownMs: 1500, cloakAlpha: 0.15 },
    bomber: { explosionRadius: 80, explosionDamage: 40, fuseTimeMs: 2000, warningRadius: 100 },
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
  tiles: { 
    size: 24, 
    theme: "dungeon",
    traps: {
      waterFrequency: 0.15,    // 15% of rooms get water traps
      pitFrequency: 0.12,      // 12% of rooms get death pits
      spikeFrequency: 0.08,    // 8% of rooms get spike traps
      poisonFrequency: 0.06,   // 6% of rooms get poison pools
    }
  },
  bosses: {
    spawnIntervalMs: 120000,   // 2 minutes between boss spawns
    maxActive: 1,              // Only one boss at a time
    announceMs: 10000,         // 10 second warning before spawn
    types: {
      necromancer: {
        hp: 2000,
        speed: 80,
        radius: 20,
        damage: 25,
        visual: {
          color: "#4A0E4E",           // Dark purple
          secondaryColor: "#8B008B",  // Dark magenta
          symbol: "💀",               // Skull emoji
          minimapIcon: "⚫",          // Black circle
          glowColor: "#9932CC",       // Dark orchid glow
        },
        abilities: {
          summon: { cooldownMs: 15000, minionCount: 3, minionHp: 150 },
          teleport: { cooldownMs: 8000, range: 300 },
          poisonField: { cooldownMs: 12000, radius: 100, durationMs: 8000, dps: 8 },
        },
      },
      bruteKing: {
        hp: 3500,
        speed: 60,
        radius: 25,
        damage: 40,
        visual: {
          color: "#8B0000",           // Dark red
          secondaryColor: "#FF4500",  // Orange red
          symbol: "👑",               // Crown emoji
          minimapIcon: "🔴",          // Red circle
          glowColor: "#DC143C",       // Crimson glow
        },
        abilities: {
          charge: { cooldownMs: 10000, speed: 250, durationMs: 2000, damage: 60 },
          groundSlam: { cooldownMs: 15000, radius: 120, damage: 50, stunMs: 2000 },
          enrage: { hpThreshold: 0.3, speedMul: 1.5, damageMul: 1.8 },
        },
      },
      shadowLord: {
        hp: 2500,
        speed: 100,
        radius: 18,
        damage: 30,
        visual: {
          color: "#2F2F2F",           // Dark gray
          secondaryColor: "#4B0082",  // Indigo
          symbol: "👤",               // Silhouette emoji
          minimapIcon: "🟣",          // Purple circle
          glowColor: "#6A0DAD",       // Purple glow
        },
        abilities: {
          phase: { cooldownMs: 12000, durationMs: 4000, alpha: 0.2 },
          shadowClone: { cooldownMs: 20000, cloneCount: 2, cloneHp: 400, durationMs: 15000 },
          lifeDrain: { cooldownMs: 8000, range: 150, dps: 15, healMul: 0.8 },
        },
      },
    },
    lootDrops: {
      guaranteedDrops: 8,        // Always drop 8 items
      bonusDropChance: 0.7,      // 70% chance for bonus drops
      maxBonusDrops: 5,          // Up to 5 bonus drops
      treasureMultiplier: 3.0,   // 3x treasure value
      specialDrops: {
        legendaryChance: 0.15,   // 15% chance for legendary treasures
        weaponUpgradeChance: 0.25, // 25% chance for weapon upgrades
        keyDropChance: 0.8,      // 80% chance for keys
      },
    },
  },
};

export type TileId = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7; // floor, wall, pit, water, doorClosed, doorOpen, spikes, poison
