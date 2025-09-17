import type { RoomDO } from '../index';
import type { Player, AIZombie } from '../room-types';


export function processZombieAbilities(ctx: RoomDO, now: number) {
  // Process player zombies
  for (const z of ctx.players.values()) {
    if (z.role !== 'zombie' || !z.alive) continue;
    
    // Stalker cloaking mechanics
    if (z.zClass === 'stalker') {
      if (!z.cloakUntil) {
        z.cloakUntil = now + ctx.cfg.zombies.stalker.cloakDurationMs;
        z.cloaked = true;
      } else if (z.cloakUntil < now && z.cloaked) {
        z.cloaked = false;
        z.uncloakUntil = now + ctx.cfg.zombies.stalker.uncloakDurationMs;
      } else if (z.uncloakUntil && z.uncloakUntil < now) {
        z.cloakUntil = now + ctx.cfg.zombies.stalker.cloakDurationMs;
        z.cloaked = true;
        z.uncloakUntil = undefined;
      }
    }
    
    // Bomber fuse mechanics
    if (z.zClass === 'bomber' && z.zHp && z.zHp <= (z.zMaxHp || 100) * 0.3) {
      if (!z.fuseStarted) {
        z.fuseStarted = now;
        z.fuseUntil = now + ctx.cfg.zombies.bomber.fuseTimeMs;
        ctx.broadcast('notification', { message: `Bomber ${z.name} is about to explode!` });
      }
      
      if (z.fuseUntil && now >= z.fuseUntil) {
        ctx.bomberExplode(z, now);
      }
    }
  }
  
  // Process AI zombies
  for (const z of ctx.aiZombies) {
    // Stalker cloaking for AI
    if (z.zClass === 'stalker') {
      if (!z.cloakUntil) {
        z.cloakUntil = now + ctx.cfg.zombies.stalker.cloakDurationMs;
        z.cloaked = true;
      } else if (z.cloakUntil < now && z.cloaked) {
        z.cloaked = false;
        z.uncloakUntil = now + ctx.cfg.zombies.stalker.uncloakDurationMs;
      } else if (z.uncloakUntil && z.uncloakUntil < now) {
        z.cloakUntil = now + ctx.cfg.zombies.stalker.cloakDurationMs;
        z.cloaked = true;
        z.uncloakUntil = undefined;
      }
    }
    
    // Bomber fuse for AI
    if (z.zClass === 'bomber' && z.hp <= z.maxHp * 0.3) {
      if (!z.fuseStarted) {
        z.fuseStarted = now;
        z.fuseUntil = now + ctx.cfg.zombies.bomber.fuseTimeMs;
      }
      
      if (z.fuseUntil && now >= z.fuseUntil) {
        ctx.bomberExplodeAI(z, now);
      }
    }
  }

}

export function bomberExplode(ctx: RoomDO, bomber: Player, now: number) {
  const radius = ctx.cfg.zombies.bomber.explosionRadius;
  const damage = ctx.cfg.zombies.bomber.explosionDamage;
  
  // Damage streamer if in range
  const streamer = [...ctx.players.values()].find(p => p.role === 'streamer');
  if (streamer) {
    const dist = Math.hypot(bomber.pos.x - streamer.pos.x, bomber.pos.y - streamer.pos.y);
    if (dist <= radius) {
      const dmg = Math.round(damage * (1 - dist / radius));
      streamer.hp = Math.max(0, (streamer.hp ?? ctx.cfg.streamer.maxHp) - dmg);
      ctx.trackDamageTaken(streamer, dmg);
      ctx.broadcast('notification', { message: `Bomber explosion deals ${dmg} damage!` });
    }
  }
  
  // Kill the bomber
  bomber.alive = false;
  bomber.zHp = 0;
  
  // Create explosion effect
  ctx.broadcast('explosion', { x: bomber.pos.x, y: bomber.pos.y, radius, damage });

}

export function bomberExplodeAI(ctx: RoomDO, bomber: AIZombie, now: number) {
  const radius = ctx.cfg.zombies.bomber.explosionRadius;
  const damage = ctx.cfg.zombies.bomber.explosionDamage;
  
  // Damage streamer if in range
  const streamer = [...ctx.players.values()].find(p => p.role === 'streamer');
  if (streamer) {
    const dist = Math.hypot(bomber.pos.x - streamer.pos.x, bomber.pos.y - streamer.pos.y);
    if (dist <= radius) {
      const dmg = Math.round(damage * (1 - dist / radius));
      streamer.hp = Math.max(0, (streamer.hp ?? ctx.cfg.streamer.maxHp) - dmg);
      ctx.trackDamageTaken(streamer, dmg);
    }
  }
  
  // Remove the AI bomber
  const idx = ctx.aiZombies.indexOf(bomber);
  if (idx >= 0) ctx.aiZombies.splice(idx, 1);
  
  // Create explosion effect
  ctx.broadcast('explosion', { x: bomber.pos.x, y: bomber.pos.y, radius, damage });

}
