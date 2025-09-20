import type { RoomDO } from '../index';
import type { Bullet, Player, AIZombie } from '../room-types';
import { XP_PER_KILL, XP_THRESHOLDS, statsFor } from '../../upgrades';


export function createExplosion(ctx: RoomDO, x: number, y: number, damage: number, radius: number, ownerId: string) {
  // Damage all zombies in radius
  for (const z of ctx.players.values()) {
    if (z.role !== 'zombie' || !z.alive) continue;
    const dist = Math.hypot(z.pos.x - x, z.pos.y - y);
    if (dist <= radius) {
      const dmg = Math.round(damage * (1 - dist / radius)); // Falloff damage
      z.zHp = Math.max(0, (z.zHp ?? ctx.cfg.zombies.baseHp) - dmg);
      // Add damage number
      ctx.addDamageNumber(z.pos.x, z.pos.y, dmg, false, false);
      if ((z.zHp ?? 0) <= 0) {
        z.alive = false;
        ctx.pickups.push({ id: crypto.randomUUID().slice(0,6), type: 'ammo', x: z.pos.x, y: z.pos.y });
        const id = z.id;
        setTimeout(() => { const zp = ctx.players.get(id); if (zp) { zp.pos = ctx.spawnZombiePos(); zp.alive = true; zp.zHp = zp.zMaxHp; } }, ctx.cfg.combat.respawnMs);
      }
    }
  }
  // Damage AI zombies
  for (const z of ctx.aiZombies) {
    const dist = Math.hypot(z.pos.x - x, z.pos.y - y);
    if (dist <= radius) {
      const dmg = Math.round(damage * (1 - dist / radius));
      z.hp = Math.max(0, z.hp - dmg);
      // Add damage number for AI zombies
      ctx.addDamageNumber(z.pos.x, z.pos.y, dmg, false, false);
    }
  }
  ctx.broadcast('notice', { message: 'Impact Explosive death!' });

}

export function spawnSmallExplosion(ctx: RoomDO, b: Bullet) {
  const radius = 26;
  for (const z of ctx.players.values()){
    if (z.role !== 'zombie' || !z.alive) continue;
    if (Math.hypot(z.pos.x - b.pos.x, z.pos.y - b.pos.y) <= radius) {
      z.zHp = Math.max(0, (z.zHp ?? ctx.cfg.zombies.baseHp) - Math.round((b.meta?.damage||20) * 0.5));
      // Add damage number for explosion hit on zombie
      ctx.addDamageNumber(z.pos.x, z.pos.y, Math.round((b.meta?.damage||20) * 0.5), false, false);
      if ((z.zHp ?? 0) <= 0) {
        z.alive = false;
        ctx.pickups.push({ id: crypto.randomUUID().slice(0,6), type: 'ammo', x: z.pos.x, y: z.pos.y });
        const id = z.id;
        setTimeout(() => { const zp = ctx.players.get(id); if (zp) { zp.pos = ctx.spawnZombiePos(); zp.alive = true; zp.zHp = zp.zMaxHp; } }, ctx.cfg.combat.respawnMs);
      }
    }
  }

}

export function addDamageNumber(ctx: RoomDO, x: number, y: number, damage: number, isCrit: boolean = false, isDot: boolean = false) {
  ctx.damageNumbers.push({
    id: crypto.randomUUID().slice(0, 6),
    x, y, damage, isCrit, isDot,
    timestamp: Date.now()
  });

}

export function processDotEffects(ctx: RoomDO, now: number) {
  // Player-controlled zombies
  for (const z of ctx.players.values()){
    if (z.role !== 'zombie' || !z.alive) continue;
    if (z.burns && z.burns.length){
      let kept: typeof z.burns = [];
      for (const e of z.burns){
        if (now > e.until) continue;
        if (now >= e.nextTick) {
          e.nextTick += 1000;
          z.zHp = Math.max(0, (z.zHp ?? ctx.cfg.zombies.baseHp) - e.dps);
          const owner = ctx.players.get(e.ownerId);
          // Lifesteal on DoT damage
          if (owner && owner.role==='streamer') {
            const { s } = statsFor(owner);
            if (s.lifestealPct>0) {
              const heal = Math.max(0, Math.floor(e.dps * s.lifestealPct));
              owner.hp = Math.min(owner.maxHp ?? ctx.cfg.streamer.maxHp, (owner.hp ?? ctx.cfg.streamer.maxHp) + heal);
            }
            owner.score += 1;
            owner.xp = (owner.xp||0) + XP_PER_KILL;
            const need = XP_THRESHOLDS(owner.level||0);
            if ((owner.xp||0) >= need) { owner.xp -= need; owner.level = (owner.level||0) + 1; ctx.offerUpgrades(owner.id); }
          }
          if ((z.zHp ?? 0) <= 0) {
            z.alive = false;
            ctx.pickups.push({ id: crypto.randomUUID().slice(0,6), type: 'ammo', x: z.pos.x, y: z.pos.y });
            const id = z.id;
            setTimeout(()=>{ const zp=ctx.players.get(id); if (zp){ zp.pos=ctx.spawnZombiePos(); zp.alive=true; zp.zHp=zp.zMaxHp; } }, ctx.cfg.combat.respawnMs);
            if (owner && owner.role==='streamer') {
              const { s } = statsFor(owner);
              if (s.reloadOnKillPct>0) ctx.refundAmmoOnKill(owner, s.reloadOnKillPct);
            }
            continue; // don't keep this effect
          }
        }
        kept.push(e);
      }
      z.burns = kept;
    }
    if (z.bleeds && z.bleeds.length){
      let kept: typeof z.bleeds = [];
      for (const e of z.bleeds){
        if (now > e.until) continue;
        if (now >= e.nextTick) {
          e.nextTick += 1000;
          z.zHp = Math.max(0, (z.zHp ?? ctx.cfg.zombies.baseHp) - e.dps);
          const owner = ctx.players.get(e.ownerId);
          if (owner && owner.role==='streamer') {
            const { s } = statsFor(owner);
            if (s.lifestealPct>0) {
              const heal = Math.max(0, Math.floor(e.dps * s.lifestealPct));
              owner.hp = Math.min(owner.maxHp ?? ctx.cfg.streamer.maxHp, (owner.hp ?? ctx.cfg.streamer.maxHp) + heal);
            }
            owner.score += 1;
            owner.xp = (owner.xp||0) + XP_PER_KILL;
            const need = XP_THRESHOLDS(owner.level||0);
            if ((owner.xp||0) >= need) { owner.xp -= need; owner.level = (owner.level||0) + 1; ctx.offerUpgrades(owner.id); }
          }
          if ((z.zHp ?? 0) <= 0) {
            z.alive = false;
            ctx.pickups.push({ id: crypto.randomUUID().slice(0,6), type: 'ammo', x: z.pos.x, y: z.pos.y });
            const id = z.id;
            setTimeout(()=>{ const zp=ctx.players.get(id); if (zp){ zp.pos=ctx.spawnZombiePos(); zp.alive=true; zp.zHp=zp.zMaxHp; } }, ctx.cfg.combat.respawnMs);
            if (owner && owner.role==='streamer') {
              const { s } = statsFor(owner);
              if (s.reloadOnKillPct>0) ctx.refundAmmoOnKill(owner, s.reloadOnKillPct);
            }
            continue;
          }
        }
        kept.push(e);
      }
      z.bleeds = kept;
    }
  }
  // AI zombies
  for (const a of ctx.aiZombies){
    if (a.burns && a.burns.length){
      let kept: typeof a.burns = [];
      for (const e of a.burns){
        if (now > e.until) continue;
        if (now >= e.nextTick) {
          e.nextTick += 1000;
          a.hp = Math.max(0, a.hp - e.dps);
          const owner = ctx.players.get(e.ownerId);
          if (owner && owner.role==='streamer') {
            const { s } = statsFor(owner);
            if (s.lifestealPct>0) {
              const heal = Math.max(0, Math.floor(e.dps * s.lifestealPct));
              owner.hp = Math.min(owner.maxHp ?? ctx.cfg.streamer.maxHp, (owner.hp ?? ctx.cfg.streamer.maxHp) + heal);
            }
            owner.score += 1;
            owner.xp = (owner.xp||0) + XP_PER_KILL;
            const need = XP_THRESHOLDS(owner.level||0);
            if ((owner.xp||0) >= need) { owner.xp -= need; owner.level = (owner.level||0) + 1; ctx.offerUpgrades(owner.id); }
          }
          if (a.hp <= 0) {
            if (owner && owner.role==='streamer') {
              const { s } = statsFor(owner);
              if (s.reloadOnKillPct>0) ctx.refundAmmoOnKill(owner, s.reloadOnKillPct);
            }
            continue; // killed; removal handled in updateAIZombies
          }
        }
        kept.push(e);
      }
      a.burns = kept;
    }
    if (a.bleeds && a.bleeds.length){
      let kept: typeof a.bleeds = [];
      for (const e of a.bleeds){
        if (now > e.until) continue;
        if (now >= e.nextTick) {
          e.nextTick += 1000;
          a.hp = Math.max(0, a.hp - e.dps);
          const owner = ctx.players.get(e.ownerId);
          if (owner && owner.role==='streamer') {
            const { s } = statsFor(owner);
            if (s.lifestealPct>0) {
              const heal = Math.max(0, Math.floor(e.dps * s.lifestealPct));
              owner.hp = Math.min(owner.maxHp ?? ctx.cfg.streamer.maxHp, (owner.hp ?? ctx.cfg.streamer.maxHp) + heal);
            }
            owner.score += 1;
            owner.xp = (owner.xp||0) + XP_PER_KILL;
            const need = XP_THRESHOLDS(owner.level||0);
            if ((owner.xp||0) >= need) { owner.xp -= need; owner.level = (owner.level||0) + 1; ctx.offerUpgrades(owner.id); }
          }
          if (a.hp <= 0) {
            if (owner && owner.role==='streamer') {
              const { s } = statsFor(owner);
              if (s.reloadOnKillPct>0) ctx.refundAmmoOnKill(owner, s.reloadOnKillPct);
            }
            continue;
          }
        }
        kept.push(e);
      }
      a.bleeds = kept;
    }
  }

}

export function refundAmmoOnKill(ctx: RoomDO, owner: Player, pct: number) {
  const w = owner.weapon || 'pistol';
  if (w === 'pistol') {
    const add = Math.max(1, Math.floor(ctx.cfg.weapons.ammo.max.pistol * pct));
    owner.pistolAmmo = Math.min(ctx.cfg.weapons.ammo.max.pistol, (owner.pistolAmmo||0) + add);
  } else if (w === 'smg') {
    const add = Math.max(1, Math.floor(ctx.cfg.weapons.ammo.max.smg * pct));
    owner.smgAmmo = Math.min(ctx.cfg.weapons.ammo.max.smg, (owner.smgAmmo||0) + add);
  } else if (w === 'shotgun') {
    const add = Math.max(1, Math.floor(ctx.cfg.weapons.ammo.max.shotgun * pct));
    owner.shotgunAmmo = Math.min(ctx.cfg.weapons.ammo.max.shotgun, (owner.shotgunAmmo||0) + add);
  } else if (w === 'railgun') {
    const add = Math.max(1, Math.floor(ctx.cfg.weapons.ammo.max.railgun * pct));
    owner.railgunAmmo = Math.min(ctx.cfg.weapons.ammo.max.railgun, (owner.railgunAmmo||0) + add);
  } else if (w === 'flamethrower') {
    const add = Math.max(1, Math.floor(ctx.cfg.weapons.ammo.max.flamethrower * pct));
    owner.flamethrowerAmmo = Math.min(ctx.cfg.weapons.ammo.max.flamethrower, (owner.flamethrowerAmmo||0) + add);
  }

}

export function applyChainDamage(ctx: RoomDO, b: Bullet, from: {x:number;y:number}, excludeId: string, count: number, dmg: number) {
  const visited = new Set<string>([excludeId]);
  let pos = { x: from.x, y: from.y };
  let remaining = count;
  let damage = dmg;
  const range = 200;
  while (remaining > 0 && damage > 0) {
    let best: { isAI:boolean; p?: Player; a?: AIZombie; id:string; x:number; y:number } | null = null;
    let bestD = Infinity;
    
    // Check player zombies
    for (const z of ctx.players.values()){
      if (z.role !== 'zombie' || !z.alive) continue;
      if (visited.has(z.id)) continue;
      const d = Math.hypot(z.pos.x - pos.x, z.pos.y - pos.y);
      if (d < range && d < bestD) { 
        bestD = d; 
        best = { isAI: false, p: z, id: z.id, x: z.pos.x, y: z.pos.y }; 
      }
    }
    
    // Check AI zombies
    for (const z of ctx.aiZombies) {
      const zid = 'ai:' + z.id; 
      if (visited.has(zid)) continue;
      const d = Math.hypot(z.pos.x - pos.x, z.pos.y - pos.y);
      if (d < range && d < bestD) { 
        bestD = d; 
        best = { isAI: true, a: z, id: zid, x: z.pos.x, y: z.pos.y }; 
      }
    }
    
    if (!best) break;
    
    // Apply damage and show damage number
    if (best.isAI && best.a) {
      // AI zombie hit
      best.a.hp = Math.max(0, best.a.hp - damage);
      ctx.addDamageNumber(best.a.pos.x, best.a.pos.y, damage, false, false);
      
      // Reward owner
      const owner = ctx.players.get(b.ownerId);
      if (owner && owner.role === 'streamer') {
        owner.score += 1;
        owner.xp = (owner.xp || 0) + XP_PER_KILL;
        const need = XP_THRESHOLDS(owner.level || 0);
        if ((owner.xp || 0) >= need) { 
          owner.xp -= need; 
          owner.level = (owner.level || 0) + 1; 
          ctx.offerUpgrades(owner.id); 
        }
        
        // Refund ammo if applicable
        const { s } = statsFor(owner);
        if (s && s.reloadOnKillPct > 0) {
          ctx.refundAmmoOnKill(owner, s.reloadOnKillPct);
        }
      }
    } else if (!best.isAI && best.p) {
      // Player zombie hit
      best.p.zHp = Math.max(0, (best.p.zHp ?? ctx.cfg.zombies.baseHp) - damage);
      ctx.addDamageNumber(best.p.pos.x, best.p.pos.y, damage, false, false);
      
      // Handle zombie death
      if ((best.p.zHp ?? 0) <= 0) {
        best.p.alive = false;
        // Respawn logic would go here if needed
      }
    }
    
    // Update position and reduce damage for next bounce
    if (best) {
      visited.add(best.id);
      pos = { x: best.x, y: best.y };
      remaining -= 1;
      damage = Math.floor(damage * 0.7);
    } else {
      break;
    }
  }

}
