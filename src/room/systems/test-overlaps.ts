import type { RoomDO } from '../index';
import type { TestOverlap, TestOverlapType, Player, PickupType } from '../room-types';
import type { WeaponId } from '../../types';

export function checkTestOverlapInteractions(ctx: RoomDO, now: number) {
  if (ctx.cfg.gameMode !== 'testing' || ctx.testOverlaps.length === 0) {
    return;
  }

  const streamer = [...ctx.players.values()].find(p => p.role === 'streamer');
  if (!streamer || !streamer.alive) {
    return;
  }

  // Check if streamer is stepping on any test overlaps
  for (const overlap of ctx.testOverlaps) {
    const distance = Math.hypot(streamer.pos.x - overlap.x, streamer.pos.y - overlap.y);
    
    if (distance <= overlap.radius) {
      // Check cooldown
      if (overlap.lastTriggered && now - overlap.lastTriggered < overlap.cooldownMs) {
        continue;
      }

      // Trigger the overlap effect
      triggerTestOverlap(ctx, overlap, streamer, now);
      overlap.lastTriggered = now;
    }
  }
}

function triggerTestOverlap(ctx: RoomDO, overlap: TestOverlap, streamer: Player, now: number) {
  const spawnDistance = 60; // Distance in front of overlap to spawn items
  const spawnX = overlap.x + spawnDistance;
  const spawnY = overlap.y;

  switch (overlap.type) {
    // Weapon spawns
    case 'spawn_smg':
      spawnWeaponDrop(ctx, 'smg', spawnX, spawnY);
      break;
    case 'spawn_shotgun':
      spawnWeaponDrop(ctx, 'shotgun', spawnX, spawnY);
      break;
    case 'spawn_railgun':
      spawnWeaponDrop(ctx, 'railgun', spawnX, spawnY);
      break;
    case 'spawn_flamethrower':
      spawnWeaponDrop(ctx, 'flamethrower', spawnX, spawnY);
      break;

    // Pickup spawns
    case 'spawn_health':
      spawnPickup(ctx, 'health', spawnX, spawnY);
      break;
    case 'spawn_ammo':
      spawnPickup(ctx, 'ammo', spawnX, spawnY);
      break;
    case 'spawn_shield':
      spawnPickup(ctx, 'shield', spawnX, spawnY);
      break;
    case 'spawn_speed':
      spawnPickup(ctx, 'speed', spawnX, spawnY);
      break;

    // Zombie spawns
    case 'spawn_zombie_runner':
      spawnAIZombie(ctx, 'runner', spawnX, spawnY);
      break;
    case 'spawn_zombie_brute':
      spawnAIZombie(ctx, 'brute', spawnX, spawnY);
      break;
    case 'spawn_zombie_spitter':
      spawnAIZombie(ctx, 'spitter', spawnX, spawnY);
      break;
    case 'spawn_zombie_stalker':
      spawnAIZombie(ctx, 'stalker', spawnX, spawnY);
      break;
    case 'spawn_zombie_bomber':
      spawnAIZombie(ctx, 'bomber', spawnX, spawnY);
      break;

    // Boss spawns
    case 'spawn_boss_necromancer':
      spawnBoss(ctx, 'necromancer', spawnX, spawnY);
      break;
    case 'spawn_boss_brute_king':
      spawnBoss(ctx, 'bruteKing', spawnX, spawnY);
      break;
    case 'spawn_boss_shadow_lord':
      spawnBoss(ctx, 'shadowLord', spawnX, spawnY);
      break;
  }

  // Send notification to streamer
  try {
    streamer.ws?.send(JSON.stringify({
      type: 'test_overlap_triggered',
      overlap: {
        id: overlap.id,
        type: overlap.type,
        label: overlap.label
      }
    }));
  } catch {}
}

function spawnWeaponDrop(ctx: RoomDO, weapon: WeaponId, x: number, y: number) {
  // Remove existing weapon drops at this location to prevent stacking
  ctx.weaponDrops = ctx.weaponDrops.filter(drop => 
    Math.hypot(drop.x - x, drop.y - y) > 30
  );

  const ammoAmounts = {
    smg: ctx.cfg.weapons.ammo.max.smg,
    shotgun: ctx.cfg.weapons.ammo.max.shotgun,
    railgun: ctx.cfg.weapons.ammo.max.railgun,
    flamethrower: ctx.cfg.weapons.ammo.max.flamethrower,
    pistol: ctx.cfg.weapons.ammo.max.pistol
  };

  ctx.weaponDrops.push({
    id: crypto.randomUUID().slice(0, 8),
    weapon,
    ammo: ammoAmounts[weapon] || 0,
    x,
    y,
    source: 'spawn'
  });
}

function spawnPickup(ctx: RoomDO, type: PickupType, x: number, y: number) {
  // Remove existing pickups at this location to prevent stacking
  ctx.pickups = ctx.pickups.filter(pickup => 
    Math.hypot(pickup.x - x, pickup.y - y) > 30
  );

  ctx.pickups.push({
    id: crypto.randomUUID().slice(0, 8),
    type,
    x,
    y
  });
}

function spawnAIZombie(ctx: RoomDO, zClass: 'runner' | 'brute' | 'spitter' | 'stalker' | 'bomber', x: number, y: number) {
  // Remove existing AI zombies at this location to prevent stacking
  ctx.aiZombies = ctx.aiZombies.filter(zombie => 
    Math.hypot(zombie.pos.x - x, zombie.pos.y - y) > 50
  );

  const baseHp = ctx.cfg.zombies.baseHp;
  const maxHp = Math.max(1, Math.round(baseHp * ctx.cfg.zombies.hpMul[zClass]));

  ctx.aiZombies.push({
    id: crypto.randomUUID().slice(0, 8),
    pos: { x, y },
    vel: { x: 0, y: 0 },
    hp: maxHp,
    maxHp,
    zClass,
    state: 'idle',
    lastSeen: Date.now(),
    lastAttack: 0,
    detectionRange: ctx.cfg.zombies.detectionRange[zClass],
    chaseRange: ctx.cfg.zombies.chaseRange[zClass],
    pathfindingCooldown: 1000,
    nextPathUpdate: 0
  });
}

function spawnBoss(ctx: RoomDO, bossType: 'necromancer' | 'bruteKing' | 'shadowLord', x: number, y: number) {
  // Remove existing bosses at this location to prevent stacking
  ctx.bosses = ctx.bosses.filter(boss => 
    Math.hypot(boss.pos.x - x, boss.pos.y - y) > 100
  );

  const bossConfig = ctx.cfg.bosses.types[bossType];
  
  ctx.bosses.push({
    id: crypto.randomUUID().slice(0, 8),
    type: bossType,
    pos: { x, y },
    vel: { x: 0, y: 0 },
    hp: bossConfig.hp,
    maxHp: bossConfig.hp,
    radius: bossConfig.radius,
    damage: bossConfig.damage,
    speed: bossConfig.speed,
    state: 'idle',
    targetId: undefined,
    lastSeen: Date.now(),
    spawnTime: Date.now(),
    enraged: false
  });

  // Announce boss spawn
  ctx.broadcast('boss_spawn', {
    bossType,
    position: { x, y },
    message: `A ${bossType} has been summoned for testing!`
  });
}
