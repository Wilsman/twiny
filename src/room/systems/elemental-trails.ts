import type { RoomDO } from '../index';
import type { ElementalTrailSegment } from '../../types';
import type { Player, AIZombie } from '../room-types';
import { XP_PER_KILL, XP_THRESHOLDS, statsFor, MOD_INDEX } from '../../upgrades';

const HIT_KEY = '__elementalTrailHits';

function registerHit(target: any, segmentId: string, now: number) {
  let store: Map<string, number> = target[HIT_KEY];
  if (!store) {
    store = new Map();
    target[HIT_KEY] = store;
  }
  // prune stale records to keep memory bounded
  for (const [id, ts] of store) {
    if (now - ts > 6000) {
      store.delete(id);
    }
  }
  if (store.has(segmentId)) return false;
  store.set(segmentId, now);
  return true;
}

function applyBurn(target: any, ownerId: string, potency: number, durationMs: number, now: number) {
  const dps = Math.max(1, Math.round(potency));
  const effect = { until: now + durationMs, dps, nextTick: now + 1000, ownerId };
  target.burns = target.burns || [];
  target.burns.push(effect);
}

function applyPoison(target: any, ownerId: string, potency: number, durationMs: number, now: number) {
  const dps = Math.max(1, Math.round(potency));
  const effect = { until: now + durationMs, dps, nextTick: now + 1000, ownerId };
  target.bleeds = target.bleeds || [];
  target.bleeds.push(effect);
}

function applyLifesteal(ctx: RoomDO, owner: Player | undefined, stats: ReturnType<typeof statsFor>['s'] | undefined, damage: number) {
  if (!owner || owner.role !== 'streamer') return;
  if (!stats || !stats.lifestealPct || stats.lifestealPct <= 0) return;
  const heal = Math.max(0, Math.floor(damage * stats.lifestealPct));
  if (heal > 0) {
    owner.hp = Math.min(owner.maxHp ?? ctx.cfg.streamer.maxHp, (owner.hp ?? ctx.cfg.streamer.maxHp) + heal);
  }
}

function rewardStreamerKill(
  ctx: RoomDO,
  owner: Player,
  stats: ReturnType<typeof statsFor>['s'],
  now: number,
  victim: { id: string; type: 'playerZombie' | 'aiZombie' | 'boss'; pos: { x: number; y: number }; zClass?: string; bossType?: string }
) {
  if (victim.type === 'boss') {
    owner.score += 10;
    const xpGain = XP_PER_KILL * 5;
    owner.xp = (owner.xp || 0) + xpGain;
    ctx.trackXPGained(owner, xpGain);
    ctx.trackBossKill(owner, victim.bossType || 'unknown');
  } else {
    owner.score += 1;
    owner.xp = (owner.xp || 0) + XP_PER_KILL;
    ctx.trackXPGained(owner, XP_PER_KILL);
    ctx.trackEnemyKill(owner, victim.zClass || 'basic');
  }

  const need = XP_THRESHOLDS(owner.level || 0);
  if ((owner.xp || 0) >= need) {
    owner.xp = (owner.xp || 0) - need;
    owner.level = (owner.level || 0) + 1;
    ctx.offerUpgrades(owner.id);
  }

  if (stats.reloadOnKillPct > 0) {
    ctx.refundAmmoOnKill(owner, stats.reloadOnKillPct);
  }

  if (stats.berserkerStacks > 0) {
    (owner as any).berserkerKills = (owner as any).berserkerKills || [];
    (owner as any).berserkerKills.push(now);
  }

  if (stats.vampireAuraRange > 0) {
    const heal = Math.floor(stats.vampireAuraRange / 10);
    if (heal > 0) {
      owner.hp = Math.min(owner.maxHp ?? ctx.cfg.streamer.maxHp, (owner.hp ?? ctx.cfg.streamer.maxHp) + heal);
    }
  }

  if (owner.mods) {
    for (const [id, n] of Object.entries(owner.mods)) {
      if (!n) continue;
      MOD_INDEX[id as keyof typeof MOD_INDEX]?.hooks?.onKill?.({
        room: ctx as any,
        killerId: owner.id,
        victimId: victim.id,
        stats,
      });
    }
  }
}

function handlePlayerZombieHit(
  ctx: RoomDO,
  segment: ElementalTrailSegment,
  owner: Player | undefined,
  stats: ReturnType<typeof statsFor>['s'] | undefined,
  zombie: Player,
  now: number,
  damage: number
) {
  const before = zombie.zHp ?? ctx.cfg.zombies.baseHp;
  zombie.zHp = Math.max(0, before - damage);
  ctx.addDamageNumber(zombie.pos.x, zombie.pos.y, damage, false, false);
  if (owner) ctx.trackDamageDealt(owner, damage);
  applyLifesteal(ctx, owner, stats, damage);

  if ((zombie.zHp ?? 0) <= 0) {
    zombie.alive = false;
    ctx.pickups.push({ id: crypto.randomUUID().slice(0, 6), type: 'ammo', x: zombie.pos.x, y: zombie.pos.y });
    const id = zombie.id;
    setTimeout(() => {
      const zp = ctx.players.get(id);
      if (zp) {
        zp.pos = ctx.spawnZombiePos();
        zp.alive = true;
        zp.zHp = zp.zMaxHp;
      }
    }, ctx.cfg.combat.respawnMs);

    if (owner && owner.role === 'streamer' && stats) {
      rewardStreamerKill(ctx, owner, stats, now, {
        id: zombie.id,
        type: 'playerZombie',
        pos: { x: zombie.pos.x, y: zombie.pos.y },
        zClass: zombie.zClass || 'basic',
      });
    }
  }
}

function handleAIZombieHit(
  ctx: RoomDO,
  segment: ElementalTrailSegment,
  owner: Player | undefined,
  stats: ReturnType<typeof statsFor>['s'] | undefined,
  zombie: AIZombie,
  now: number,
  damage: number
) {
  zombie.hp = Math.max(0, zombie.hp - damage);
  ctx.addDamageNumber(zombie.pos.x, zombie.pos.y, damage, false, false);
  if (owner) ctx.trackDamageDealt(owner, damage);
  applyLifesteal(ctx, owner, stats, damage);

  if (zombie.hp <= 0 && owner && owner.role === 'streamer' && stats) {
    rewardStreamerKill(ctx, owner, stats, now, {
      id: 'ai:' + zombie.id,
      type: 'aiZombie',
      pos: { x: zombie.pos.x, y: zombie.pos.y },
      zClass: zombie.zClass,
    });
  }
}

function handleBossHit(
  ctx: RoomDO,
  segment: ElementalTrailSegment,
  owner: Player | undefined,
  stats: ReturnType<typeof statsFor>['s'] | undefined,
  boss: any,
  now: number,
  damage: number
) {
  boss.hp = Math.max(0, boss.hp - damage);
  ctx.addDamageNumber(boss.pos.x, boss.pos.y, damage, false, false);
  if (owner) ctx.trackDamageDealt(owner, damage);
  applyLifesteal(ctx, owner, stats, damage);

  const bossKilled = boss.hp <= 0;
  if (bossKilled && boss.state !== 'dying') {
    boss.state = 'dying';
    if (owner && owner.role === 'streamer' && stats) {
      rewardStreamerKill(ctx, owner, stats, now, {
        id: 'boss:' + boss.id,
        type: 'boss',
        pos: { x: boss.pos.x, y: boss.pos.y },
        bossType: boss.type,
      });
    }
  }
}

export function updateElementalTrails(ctx: RoomDO, now: number) {
  const active: ElementalTrailSegment[] = [];
  for (const segment of ctx.elementalTrails) {
    if (now > segment.expiresAt) {
      continue;
    }
    active.push(segment);

    const owner = ctx.players.get(segment.ownerId);
    const statsSnapshot = owner ? statsFor(owner) : undefined;
    const stats = statsSnapshot?.s;

    const burnDuration = 2000 + (segment.stacks - 1) * 400;
    const poisonDuration = 2200 + (segment.stacks - 1) * 450;

    for (const player of ctx.players.values()) {
      if (player.role !== 'zombie' || !player.alive) continue;
      const dist = Math.hypot(player.pos.x - segment.pos.x, player.pos.y - segment.pos.y);
      if (dist > segment.radius) continue;
      if (!registerHit(player, segment.id, now)) continue;

      if (segment.effect === 'ignite') {
        applyBurn(player, segment.ownerId, segment.potency, burnDuration, now);
      } else if (segment.effect === 'poison') {
        applyPoison(player, segment.ownerId, segment.potency - 1, poisonDuration, now);
      } else if (segment.effect === 'shock') {
        handlePlayerZombieHit(ctx, segment, owner, stats, player, now, segment.potency + 2);
      }
    }

    for (const zombie of ctx.aiZombies) {
      const dist = Math.hypot(zombie.pos.x - segment.pos.x, zombie.pos.y - segment.pos.y);
      if (dist > segment.radius) continue;
      if (!registerHit(zombie, segment.id, now)) continue;

      if (segment.effect === 'ignite') {
        applyBurn(zombie, segment.ownerId, segment.potency, burnDuration, now);
      } else if (segment.effect === 'poison') {
        applyPoison(zombie, segment.ownerId, segment.potency - 1, poisonDuration, now);
      } else if (segment.effect === 'shock') {
        handleAIZombieHit(ctx, segment, owner, stats, zombie, now, segment.potency + 2);
      }
    }

    for (const boss of ctx.bosses) {
      if (boss.state === 'dying') continue;
      const dist = Math.hypot(boss.pos.x - segment.pos.x, boss.pos.y - segment.pos.y);
      if (dist > boss.radius + segment.radius) continue;
      if (!registerHit(boss, segment.id, now)) continue;

      if (segment.effect === 'ignite') {
        applyBurn(boss, segment.ownerId, segment.potency + 1, burnDuration + 400, now);
      } else if (segment.effect === 'poison') {
        applyPoison(boss, segment.ownerId, segment.potency, poisonDuration + 400, now);
      } else if (segment.effect === 'shock') {
        handleBossHit(ctx, segment, owner, stats, boss, now, segment.potency + 3);
      }
    }
  }

  ctx.elementalTrails = active;
}
