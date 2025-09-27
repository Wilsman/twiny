import type { RoomDO } from '../index';
import type { PickupType } from '../room-types';


export function checkPickupSpawning(ctx: RoomDO) {
  // Skip automatic pickup spawning in testing mode
  if (ctx.cfg.gameMode === 'testing') {
    return;
  }
  
  const now = Date.now();
  if (now - ctx.lastPickupSpawn > ctx.pickupIntervalMs) {
    ctx.lastPickupSpawn = now;
    const totalCap = ctx.cfg.pickups.totalCap;
    if (ctx.pickups.length < totalCap) {
      const caps = ctx.cfg.pickups.caps as Record<PickupType, number>;
      const counts = { health:0, speed:0, ammo:0, shield:0, magnet:0, freeze:0, blast:0, treasure:0 } as Record<PickupType, number>;
      for (const pk of ctx.pickups) counts[pk.type]++;
      const types: PickupType[] = ["health","speed","ammo","shield","magnet","freeze","blast","treasure"]; 
      // Weighted pick: prefer under-cap types
      const options: PickupType[] = [];
      for (const t of types){
        const capacity = Math.max(0, (caps[t]||0)-counts[t]);
        for (let i=0;i<capacity;i++) options.push(t);
      }
      if (options.length > 0) {
        const type = options[Math.floor(Math.random()*options.length)];
        const pos = ctx.randomFreePos(28);
        if (pos && ctx.okDistanceFromPickups(pos.x, pos.y, ctx.cfg.pickups.minDistance)) {
          ctx.pickups.push({ id: crypto.randomUUID().slice(0,6), type, x: pos.x, y: pos.y });
        }
      }
    }
  }

}

export function getRandomZombieDrop(ctx: RoomDO) {
  // First check if any drop should happen at all
  if (Math.random() > ctx.cfg.aiZombies.dropChance) {
    return null; // No drop
  }
  
  const rand = Math.random();
  
  // Use config values for drop chances (normalized since we already passed the drop check)
  const totalChance = ctx.cfg.aiZombies.ammoDropChance + ctx.cfg.aiZombies.treasureDropChance;
  const normalizedAmmoChance = ctx.cfg.aiZombies.ammoDropChance / totalChance;
  
  if (rand < normalizedAmmoChance) {
    return "ammo";
  }
  
  // Treasure drops with configurable rarities
  const treasureRoll = Math.random();
  const rates = ctx.cfg.aiZombies.treasureDropRates;
  
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

export function getTreasureValue(ctx: RoomDO, type: PickupType) {
  return ctx.cfg.aiZombies.treasureValues[type] || 0;

}
