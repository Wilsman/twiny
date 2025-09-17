import type { RoomDO } from '../index';
import type { Player, AIZombie, Vec } from '../room-types';


export function spawnAIZombiesIfNeeded(ctx: RoomDO, now: number) {
  if (now - ctx.lastAIZombieSpawn < ctx.aiZombieSpawnCooldown) return;
  if (ctx.aiZombies.length >= ctx.maxAIZombies) return;
  
  // Only spawn if there's a streamer
  const streamer = [...ctx.players.values()].find(p => p.role === "streamer");
  if (!streamer) return;
  
  const spawnPos = ctx.getAIZombieSpawnPosition(streamer.pos);
  if (!spawnPos) return;
  
  const zClass = ctx.pickZombieClass();
  const baseHp = ctx.cfg.zombies.baseHp;
  const maxHp = Math.max(1, Math.round(baseHp * ctx.cfg.zombies.hpMul[zClass]));
  
  const aiZombie: AIZombie = {
    id: crypto.randomUUID().slice(0, 8),
    pos: spawnPos,
    vel: { x: 0, y: 0 },
    hp: maxHp,
    maxHp: maxHp,
    zClass: zClass,
    state: "idle",
    lastSeen: 0,
    lastAttack: 0,
    detectionRange: ctx.cfg.zombies.detectionRange[zClass],
    chaseRange: ctx.cfg.zombies.chaseRange[zClass],
    pathfindingCooldown: 500, // ms between pathfinding updates
    nextPathUpdate: now
  };
  
  ctx.aiZombies.push(aiZombie);
  ctx.lastAIZombieSpawn = now;

}

export function updateAIZombies(ctx: RoomDO, now: number) {
  const streamer = [...ctx.players.values()].find(p => p.role === "streamer");
  const dt = ctx.tickMs / 1000;
  
  for (let i = ctx.aiZombies.length - 1; i >= 0; i--) {
    const zombie = ctx.aiZombies[i];
    
    // Remove dead zombies
    if (zombie.hp <= 0) {
      // Drop random pickup (ammo or treasure) - only if drop chance succeeds
      const dropType = ctx.getRandomZombieDrop();
      if (dropType) {
        ctx.pickups.push({ 
          id: crypto.randomUUID().slice(0, 6), 
          type: dropType, 
          x: zombie.pos.x, 
          y: zombie.pos.y 
        });
      }
      ctx.aiZombies.splice(i, 1);
      continue;
    }
    
    if (!streamer) {
      zombie.state = "idle";
      continue;
    }
    
    const distToStreamer = Math.hypot(zombie.pos.x - streamer.pos.x, zombie.pos.y - streamer.pos.y);
    const hasLineOfSight = ctx.hasLineOfSight(zombie.pos, streamer.pos);
    
    // State machine
    switch (zombie.state) {
      case "idle":
        if (distToStreamer <= zombie.detectionRange && hasLineOfSight) {
          zombie.state = "chasing";
          zombie.targetId = streamer.id;
          zombie.lastSeen = now;
        }
        break;
        
      case "chasing":
        if (distToStreamer > zombie.chaseRange) {
          zombie.state = "idle";
          zombie.targetId = undefined;
        } else if (distToStreamer <= 20) {
          zombie.state = "attacking";
          zombie.lastAttack = now;
        } else if (hasLineOfSight) {
          zombie.lastSeen = now;
        }
        break;
        
      case "attacking":
        if (distToStreamer > 30) {
          zombie.state = "chasing";
        } else if (now - zombie.lastAttack > 1000) { // Attack every second
          ctx.aiZombieAttackStreamer(zombie, streamer, now);
          zombie.lastAttack = now;
        }
        break;
    }
    
    // Movement AI
    ctx.updateAIZombieMovement(zombie, streamer, now, dt);
    
    // Apply movement with collision
    ctx.moveAIZombie(zombie, dt);
  }

}

export function getAIZombieSpawnPosition(ctx: RoomDO, streamerPos: Vec) {
  if (!ctx.map || !ctx.map.rooms) return null;
  
  // Try to spawn in a room that's not too close to the streamer
  const attempts = 20;
  for (let i = 0; i < attempts; i++) {
    const room = ctx.map.rooms[Math.floor(Math.random() * ctx.map.rooms.length)];
    
    // Find floor tiles in this room
    const candidates: Vec[] = [];
    for (let ty = room.y + 1; ty < room.y + room.h - 1; ty++) {
      for (let tx = room.x + 1; tx < room.x + room.w - 1; tx++) {
        if (tx >= 0 && tx < ctx.map.w && ty >= 0 && ty < ctx.map.h) {
          const tile = ctx.map.tiles[ty * ctx.map.w + tx];
          if (tile === 0) { // floor tile
            const worldX = tx * ctx.map.size + ctx.map.size / 2;
            const worldY = ty * ctx.map.size + ctx.map.size / 2;
            
            // Check distance from streamer (not too close, not too far)
            const dist = Math.hypot(worldX - streamerPos.x, worldY - streamerPos.y);
            if (dist > 150 && dist < 400) {
              candidates.push({ x: worldX, y: worldY });
            }
          }
        }
      }
    }
    
    if (candidates.length > 0) {
      return candidates[Math.floor(Math.random() * candidates.length)];
    }
  }
  
  return null;

}

export function updateAIZombieMovement(ctx: RoomDO, zombie: AIZombie, streamer: Player, now: number, dt: number) {
  if (zombie.state === "idle") {
    zombie.vel.x = 0;
    zombie.vel.y = 0;
    return;
  }
  
  // Simple AI movement toward streamer
  const dx = streamer.pos.x - zombie.pos.x;
  const dy = streamer.pos.y - zombie.pos.y;
  const distance = Math.hypot(dx, dy);
  
  if (distance > 0) {
    const baseSpeed = ctx.cfg.speeds.zombie * ctx.cfg.zombies.speedMul[zombie.zClass];
    let speed = (ctx.zombieSlowUntil || 0) > now ? baseSpeed * ctx.cfg.speeds.zombieSlowMultiplier : baseSpeed;
    if ((zombie.slowUntil || 0) > now) speed *= Math.max(0.05, zombie.slowMul || 1);
    
    zombie.vel.x = (dx / distance) * speed;
    zombie.vel.y = (dy / distance) * speed;
  }

}

export function moveAIZombie(ctx: RoomDO, zombie: AIZombie, dt: number) {
  // Intended new position
  let nx = zombie.pos.x + zombie.vel.x * dt;
  let ny = zombie.pos.y + zombie.vel.y * dt;
  
  // Tile collision
  if (ctx.map) {
    const sz = ctx.map.size;
    const ix = Math.max(0, Math.min(ctx.map.w-1, Math.floor(nx / sz)));
    const iy = Math.max(0, Math.min(ctx.map.h-1, Math.floor(ny / sz)));
    const t = ctx.map.tiles[iy*ctx.map.w + ix] as TileId;
    
    const isSolid = (tt:TileId)=> tt===1 || tt===4; // wall or doorClosed
    const isLethal = (tt:TileId)=> tt===2; // pit
    const isSlow = (tt:TileId)=> tt===3; // water/sludge
    
    if (isSlow(t)) { 
      nx = zombie.pos.x + (zombie.vel.x * 0.6) * dt; 
      ny = zombie.pos.y + (zombie.vel.y * 0.6) * dt;
    }
    if (isSolid(t)) { 
      nx = zombie.pos.x; 
      ny = zombie.pos.y; 
    }
    if (isLethal(t)) {
      // Respawn zombie in a different location
      const newPos = ctx.getAIZombieSpawnPosition({ x: ctx.W/2, y: ctx.H/2 });
      if (newPos) {
        zombie.pos = newPos;
        return;
      }
    }
  }
  
  zombie.pos.x = Math.max(0, Math.min(ctx.W, nx));
  zombie.pos.y = Math.max(0, Math.min(ctx.H, ny));
  
  // Wall collision
  const pr = ctx.cfg.radii.zombie;
  for (const rct of ctx.walls) {
    const nearestX = Math.max(rct.x, Math.min(zombie.pos.x, rct.x + rct.w));
    const nearestY = Math.max(rct.y, Math.min(zombie.pos.y, rct.y + rct.h));
    let dx = zombie.pos.x - nearestX; 
    let dy = zombie.pos.y - nearestY; 
    let dist = Math.hypot(dx, dy);
    
    if (dist < pr) {
      if (dist === 0) {
        // Push out along smallest penetration axis
        const left = Math.abs(zombie.pos.x - rct.x);
        const right = Math.abs(rct.x + rct.w - zombie.pos.x);
        const top = Math.abs(zombie.pos.y - rct.y);
        const bottom = Math.abs(rct.y + rct.h - zombie.pos.y);
        const m = Math.min(left, right, top, bottom);
        if (m === left) zombie.pos.x = rct.x - pr;
        else if (m === right) zombie.pos.x = rct.x + rct.w + pr;
        else if (m === top) zombie.pos.y = rct.y - pr;
        else zombie.pos.y = rct.y + rct.h + pr;
      } else {
        const nx = dx / dist, ny = dy / dist;
        const push = (pr - dist) + 0.5;
        zombie.pos.x += nx * push; 
        zombie.pos.y += ny * push;
      }
    }
  }

}

export function aiZombieAttackStreamer(ctx: RoomDO, zombie: AIZombie, streamer: Player, now: number) {
  const shielded = ((streamer as any).shieldUntil || 0) > now;
  if (shielded) return;
  
  if ((streamer.hp ?? ctx.cfg.streamer.maxHp) > 0) {
    streamer.hp = Math.max(0, (streamer.hp ?? ctx.cfg.streamer.maxHp) - ctx.cfg.combat.zombieTouchDamage);
    ctx.trackDamageTaken(streamer, ctx.cfg.combat.zombieTouchDamage);
    // Add damage number for zombie hit on streamer
    ctx.addDamageNumber(streamer.pos.x, streamer.pos.y, ctx.cfg.combat.zombieTouchDamage, false, false);
  }
  
  if ((streamer.hp ?? 0) <= 0) {
    // Respawn streamer; lose unbanked on death (keep banked)
    streamer.pos = ctx.spawnInRandomRoom();
    streamer.hp = streamer.maxHp ?? ctx.cfg.streamer.maxHp;
    streamer.score = 0;
  }
  
  // Knockback streamer slightly
  const dx = streamer.pos.x - zombie.pos.x; 
  const dy = streamer.pos.y - zombie.pos.y; 
  const d = Math.hypot(dx, dy) || 1;
  const kbMul = (zombie.zClass === 'brute') ? ctx.cfg.zombies.brute.extraKnockbackMul : 1;
  streamer.pos.x = Math.max(0, Math.min(ctx.W, streamer.pos.x + (dx / d) * ctx.cfg.combat.knockbackStep * kbMul));
  streamer.pos.y = Math.max(0, Math.min(ctx.H, streamer.pos.y + (dy / d) * ctx.cfg.combat.knockbackStep * kbMul));

}

export function hasLineOfSight(ctx: RoomDO, from: Vec, to: Vec) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  
  if (distance === 0) return true;
  
  const steps = Math.ceil(distance / 16); // Check every 16 pixels
  const stepX = dx / steps;
  const stepY = dy / steps;
  
  for (let i = 1; i < steps; i++) {
    const checkX = from.x + stepX * i;
    const checkY = from.y + stepY * i;
    
    // Check if this point intersects with walls
    for (const wall of ctx.walls) {
      if (checkX >= wall.x && checkX <= wall.x + wall.w &&
          checkY >= wall.y && checkY <= wall.y + wall.h) {
        return false;
      }
    }
  }
  
  return true;

}
