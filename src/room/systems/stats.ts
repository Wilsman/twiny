import type { RoomDO } from '../index';

export function initRaidStats(ctx: RoomDO, player: any) {
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

export function trackEnemyKill(ctx: RoomDO, player: any, enemyType: string) {
  if (player.role !== 'streamer') return; // Only track for streamers
  if (!player.raidStats) ctx.initRaidStats(player);
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

export function trackBossKill(ctx: RoomDO, player: any, bossType?: string) {
  if (player.role !== 'streamer') return; // Only track for streamers
  if (!player.raidStats) ctx.initRaidStats(player);
  player.raidStats!.bossesKilled++;
  if (bossType) {
    player.raidStats!.bossesDefeated.push(bossType);
  }

}

export function trackBulletFired(ctx: RoomDO, player: any) {
  if (player.role !== 'streamer') return; // Only track for streamers
  if (!player.raidStats) ctx.initRaidStats(player);
  player.raidStats!.bulletsFired++;
  console.log('Bullet fired! Total:', player.raidStats!.bulletsFired);

}

export function trackBulletHit(ctx: RoomDO, player: any) {
  if (player.role !== 'streamer') return; // Only track for streamers
  if (!player.raidStats) ctx.initRaidStats(player);
  player.raidStats!.bulletsHit++;

}

export function trackDamageDealt(ctx: RoomDO, player: any, damage: number) {
  if (player.role !== 'streamer') return; // Only track for streamers
  if (!player.raidStats) ctx.initRaidStats(player);
  player.raidStats!.damageDealt += damage;

}

export function trackDamageTaken(ctx: RoomDO, player: any, damage: number) {
  if (player.role !== 'streamer') return; // Only track for streamers
  if (!player.raidStats) ctx.initRaidStats(player);
  player.raidStats!.damageTaken += damage;
  console.log('Damage taken! Amount:', damage, 'Total:', player.raidStats!.damageTaken);

}

export function trackPickupTaken(ctx: RoomDO, player: any, pickupType: string) {
  if (player.role !== 'streamer') return; // Only track for streamers
  if (!player.raidStats) ctx.initRaidStats(player);
  player.raidStats!.pickupsTaken++;
  
  if (pickupType.includes('coin') || pickupType.includes('gem') || 
      pickupType.includes('crystal') || pickupType.includes('treasure')) {
    player.raidStats!.coinsCollected++;
  }

}

export function trackXPGained(ctx: RoomDO, player: any, xp: number) {
  if (player.role !== 'streamer') return; // Only track for streamers
  if (!player.raidStats) ctx.initRaidStats(player);
  player.raidStats!.totalXPGained += xp;

}
