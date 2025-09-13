export type GameConfig = {
  arena: { width: number; height: number };
  ticks: { mainMs: number; pickupMs: number };
  round: { durationMs: number };
  speeds: { streamer: number; zombie: number; zombieBoostMultiplier: number; zombieSlowMultiplier: number };
  streamer: { maxHp: number };
  combat: { zombieTouchDamage: number; knockbackStep: number; respawnMs: number };
  weapons: {
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
};

export const CONFIG: GameConfig = {
  arena: { width: 2880, height: 1620 },
  ticks: { mainMs: 50, pickupMs: 500 },
  round: { durationMs: 5 * 60 * 1000 },
  speeds: { streamer: 175, zombie: 65, zombieBoostMultiplier: 1.75, zombieSlowMultiplier: 0.55 },
  streamer: { maxHp: 100 },
  combat: { zombieTouchDamage: 10, knockbackStep: 12, respawnMs: 800 },
  weapons: {
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
    caps: { health: 3, speed: 3, ammo: 3, weapon: 2, shield: 2, magnet: 2, freeze: 1, blast: 2, treasure: 3 },
    treasureScore: 3,
    blastRadius: 90,
  },
  effects: { weaponBoostMs: 8000, shieldMs: 6000, magnetMs: 8000, zombieBoostMs: 7000, freezeMs: 6000 },
  extraction: { radius: 28, countMin: 1, countMax: 2, minActiveMs: 60_000, maxActiveMs: 90_000 },
  radii: { streamer: 10, zombie: 12, bulletMargin: 2 },
};
