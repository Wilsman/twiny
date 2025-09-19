import type { RoomDO } from '../index';
import { XP_PER_KILL, XP_THRESHOLDS, statsFor, statusFrom, MOD_INDEX } from '../../upgrades';
import type { Bullet, Player, Pickup, PickupType, Vec, Rect, WeaponDrop } from '../room-types';
import type { BulletSpawnSpec } from '../../types';
import { TileId } from '../../config';


export function update(ctx: RoomDO) {
  const now = Date.now();

  let streamer = [...ctx.players.values()].find(p => p.role === "streamer");

  if (!ctx.roundActive) {
    return;
  }

  // Drop stale sockets (missed heartbeats for 40s)
  for (const [id, p] of ctx.players) {
    if (now - p.lastSeen > 40000) {
      ctx.players.delete(id);
    }
  }

  // Process upgrade effects
  ctx.processUpgradeEffects(now);
  
  // Process zombie special abilities
  ctx.processZombieAbilities(now);
  if (ctx.nextWeaponDropAt <= now) {
    if (ctx.weaponDrops.length >= ctx.maxWeaponDrops) {
      ctx.scheduleNextWeaponDrop(now, true);
    } else {
      const exclude = new Set<string>();
      if (streamer?.weapon) exclude.add(streamer.weapon);
      const weapon = ctx.chooseWeapon(exclude);
      const pos = ctx.randomFreePos(36);
      if (pos) {
        const initAmmo = (ctx.cfg.weapons.ammo.initial as any)[weapon] ?? 0;
        ctx.spawnWeaponDrop(weapon, pos.x, pos.y, initAmmo, 'spawn');
        ctx.scheduleNextWeaponDrop(now);
      } else {
        ctx.scheduleNextWeaponDrop(now, true);
      }
    }
  }

  // Extractions removed

  // Update AI Zombies
  ctx.updateAIZombies(now);

  // Spawn AI Zombies if needed
  ctx.spawnAIZombiesIfNeeded(now);

  // Update Boss System
  ctx.updateBossSystem(now);

  // Update Boss Minions
  ctx.updateBossMinions(now);

  // Update Poison Fields
  ctx.updatePoisonFields(now);

  // Integrate movement
  const dt = ctx.tickMs / 1000;
  for (const p of ctx.players.values()) {
    let baseSpeed = p.role === "streamer" ? ctx.cfg.speeds.streamer : ctx.cfg.speeds.zombie; // px/s
    if (p.role === 'zombie' && p.zClass) baseSpeed *= ctx.cfg.zombies.speedMul[p.zClass];
    if (p.role === "zombie" && (ctx.zombieSlowUntil || 0) > now) baseSpeed *= ctx.cfg.speeds.zombieSlowMultiplier; // global slow
    if (p.role === 'zombie' && ((p.slowUntil || 0) > now)) {
      baseSpeed *= Math.max(0.05, p.slowMul || 1);
    }
    if (p.role === 'streamer' && ((p as any).gooSlowUntil || 0) > now) baseSpeed *= ctx.cfg.zombies.spitter.streamerSlowMul;
    // Apply movement speed upgrades for streamer
    if (p.role === 'streamer') {
      const { s } = statsFor(p);
      baseSpeed *= s.movementSpeedMul;
    }
    const boosted = p.role === "zombie" && (p.boostUntil || 0) > now;
    let speed = boosted ? baseSpeed * ctx.cfg.speeds.zombieBoostMultiplier : baseSpeed;
    let vx = 0, vy = 0;
    if (p.input.up) vy -= 1;
    if (p.input.down) vy += 1;
    if (p.input.left) vx -= 1;
    if (p.input.right) vx += 1;
    // Zombie active abilities on left-click
    let useCharge = false; let chargeSpeed = 0;
    if (p.role === 'zombie' && p.zClass) {
      const nowMs = now;
      const since = nowMs - (p.lastAbilityAt || 0);
      if (p.zClass === 'runner') {
        if (p.input.shoot && since >= ctx.cfg.zombies.runnerAbility.cooldownMs) {
          p.boostUntil = nowMs + ctx.cfg.zombies.runnerAbility.durationMs;
          p.lastAbilityAt = nowMs;
        }
      } else if (p.zClass === 'brute') {
        if (p.input.shoot && since >= ctx.cfg.zombies.bruteAbility.cooldownMs) {
          const dirx = (p.input.aimX || p.pos.x) - p.pos.x;
          const diry = (p.input.aimY || p.pos.y) - p.pos.y;
          const d = Math.hypot(dirx, diry) || 1;
          p.chargeDirX = dirx / d; p.chargeDirY = diry / d;
          p.chargeUntil = nowMs + ctx.cfg.zombies.bruteAbility.durationMs;
          p.lastAbilityAt = nowMs;
        }
        if ((p.chargeUntil || 0) > nowMs) {
          useCharge = true; chargeSpeed = ctx.cfg.zombies.bruteAbility.speed;
          vx = p.chargeDirX || 0; vy = p.chargeDirY || 0;
        }
      } else if (p.zClass === 'spitter') {
        if (p.input.shoot && since >= ctx.cfg.zombies.spitter.manualCooldownMs) {
          const dx = (p.input.aimX || p.pos.x) - p.pos.x;
          const dy = (p.input.aimY || p.pos.y) - p.pos.y;
          const d = Math.hypot(dx, dy) || 1;
          const s = ctx.cfg.zombies.spitter.projectileSpeed;
          ctx.spittles.push({ id: crypto.randomUUID().slice(0,6), pos: { x: p.pos.x, y: p.pos.y }, vel: { x: (dx/d)*s, y: (dy/d)*s }, ttl: ctx.cfg.zombies.spitter.projectileTtl });
          p.lastAbilityAt = nowMs;
        }
      }
    }
    const len = Math.hypot(vx, vy) || 1;
    // Handle dash (streamer only)
    if (p.role === 'streamer') {
      // Trigger dash on key press if off cooldown
      const nowMs = Date.now();
      (p as any)._dashLatched = (p as any)._dashLatched || false;
      const ready = (nowMs - (p.lastDashAt || 0)) >= ctx.cfg.dash.cooldownMs;
      if (p.input.dash && ready && !(p as any)._dashLatched) {
        p.dashUntil = nowMs + ctx.cfg.dash.durationMs;
        p.lastDashAt = nowMs;
        (p as any)._dashLatched = true;
      }
      if (!p.input.dash && (p as any)._dashLatched) (p as any)._dashLatched = false;
      // Apply dash speed multiplier if active
      if ((p.dashUntil || 0) > nowMs) {
        const { s } = statsFor(p);
        speed *= ctx.cfg.dash.speedMultiplier * s.dashDistanceMul;
        // Trigger dash reload upgrade
        if (s.dashReloadPct > 0 && !((p as any).dashReloadTriggered)) {
          ctx.refundAmmoOnKill(p, s.dashReloadPct);
          (p as any).dashReloadTriggered = true;
        }
      } else {
        (p as any).dashReloadTriggered = false;
      }
    }
    const moveSpeed = useCharge ? chargeSpeed : speed;
    p.vel.x = (vx / len) * moveSpeed;
    p.vel.y = (vy / len) * moveSpeed;
    // Intended new position
    let nx = p.pos.x + p.vel.x * dt;
    let ny = p.pos.y + p.vel.y * dt;
    // Tile semantics: solid, door, pit, slow
    if (ctx.map) {
      const sz = ctx.map.size;
      const ix = Math.max(0, Math.min(ctx.map.w-1, Math.floor(nx / sz)));
      const iy = Math.max(0, Math.min(ctx.map.h-1, Math.floor(ny / sz)));
      const t = ctx.map.tiles[iy*ctx.map.w + ix] as TileId;
      const isSolid = (tt:TileId)=> tt===1 || tt===4; // wall or doorClosed
      const isLethal = (tt:TileId)=> tt===2; // pit
      const isSlow = (tt:TileId)=> tt===3; // water/sludge
      const isSpikes = (tt:TileId)=> tt===6; // spike trap
      const isPoison = (tt:TileId)=> tt===7; // poison pool
      
      // Door interaction feedback for streamer
      if (p.role === 'streamer' && t === 4) {
        const lastDoorToast = (p as any).lastDoorToast || 0;
        if (now - lastDoorToast > 3000) { // Throttle to every 3 seconds
          ctx.broadcast("notice", { message: "Door Closed door! Find a KEY pickup to open all doors" });
          (p as any).lastDoorToast = now;
        }
      }
      
      if (isSlow(t)) { 
        nx = p.pos.x + (p.vel.x * 0.6) * dt; 
        ny = p.pos.y + (p.vel.y * 0.6) * dt;
        // Water/sludge feedback for streamer
        if (p.role === 'streamer') {
          const lastSlowToast = (p as any).lastSlowToast || 0;
          if (now - lastSlowToast > 4000) {
            ctx.broadcast("notice", { message: "Droplet Moving through water - slowed down!" });
            (p as any).lastSlowToast = now;
          }
        }
      }
      if (isSolid(t)) { nx = p.pos.x; ny = p.pos.y; }
      if (isLethal(t)) {
        if (p.role === 'streamer') {
          ctx.broadcast("notice", { message: "Skull Fell into a pit! Respawning..." });
          ctx.handleStreamerDeath(p, 'pit');
          return;
        } else {
          p.alive = false; const id=p.id; setTimeout(()=>{ const zp=ctx.players.get(id); if (zp) { zp.pos=ctx.spawnZombiePos(); zp.alive=true; } }, ctx.cfg.combat.respawnMs);
        }
      }
      
      // Spike trap - damage over time
      if (isSpikes(t)) {
        const lastSpikeDamage = (p as any).lastSpikeDamage || 0;
        if (now - lastSpikeDamage > 500) { // Damage every 0.5 seconds
          if (p.role === 'streamer') {
            const damage = 8; // Moderate damage
            p.hp = Math.max(0, (p.hp ?? ctx.cfg.streamer.maxHp) - damage);
            ctx.trackDamageTaken(p, damage);
            // Add damage number for spikes
            ctx.addDamageNumber(p.pos.x, p.pos.y, damage, false, true);
            ctx.broadcast("notice", { message: "Dagger Stepped on spikes! Taking damage..." });
            (p as any).lastSpikeDamage = now;
            if ((p.hp ?? 0) <= 0) {
              ctx.handleStreamerDeath(p, 'spikes');
              return;
            }
          } else {
            const damage = 5;
            p.zHp = Math.max(0, (p.zHp ?? ctx.cfg.zombies.baseHp) - damage);
            // Add damage number for zombie on spikes
            ctx.addDamageNumber(p.pos.x, p.pos.y, damage, false, true);
            (p as any).lastSpikeDamage = now;
            if ((p.zHp ?? 0) <= 0) {
              p.alive = false; 
              const id = p.id; 
              setTimeout(() => { 
                const zp = ctx.players.get(id); 
                if (zp) { 
                  zp.pos = ctx.spawnZombiePos(); 
                  zp.alive = true; 
                  zp.zHp = zp.zMaxHp; 
                } 
              }, ctx.cfg.combat.respawnMs);
            }
          }
        }
      }
      
      // Poison pool - damage and slow
      if (isPoison(t)) {
        // Apply slow effect
        nx = p.pos.x + (p.vel.x * 0.4) * dt; 
        ny = p.pos.y + (p.vel.y * 0.4) * dt;
        
        const lastPoisonDamage = (p as any).lastPoisonDamage || 0;
        if (now - lastPoisonDamage > 1000) { // Damage every 1 second
          if (p.role === 'streamer') {
            const damage = 6; // Moderate damage
            p.hp = Math.max(0, (p.hp ?? ctx.cfg.streamer.maxHp) - damage);
            ctx.trackDamageTaken(p, damage);
            // Add damage number for poison
            ctx.addDamageNumber(p.pos.x, p.pos.y, damage, false, true);
            const lastPoisonToast = (p as any).lastPoisonToast || 0;
            if (now - lastPoisonToast > 3000) {
              ctx.broadcast("notice", { message: "Skull Poison pool! Taking damage and slowed..." });
              (p as any).lastPoisonToast = now;
            }
            (p as any).lastPoisonDamage = now;
            if ((p.hp ?? 0) <= 0) {
              ctx.handleStreamerDeath(p, 'poison');
              return;
            }
          } else {
            const damage = 4;
            p.zHp = Math.max(0, (p.zHp ?? ctx.cfg.zombies.baseHp) - damage);
            // Add damage number for zombie in poison
            ctx.addDamageNumber(p.pos.x, p.pos.y, damage, false, true);
            (p as any).lastPoisonDamage = now;
            if ((p.zHp ?? 0) <= 0) {
              p.alive = false; 
              const id = p.id; 
              setTimeout(() => { 
                const zp = ctx.players.get(id); 
                if (zp) { 
                  zp.pos = ctx.spawnZombiePos(); 
                  zp.alive = true; 
                  zp.zHp = zp.zMaxHp; 
                } 
              }, ctx.cfg.combat.respawnMs);
            }
          }
        }
      }
    }
    p.pos.x = Math.max(0, Math.min(ctx.W, nx));
    p.pos.y = Math.max(0, Math.min(ctx.H, ny));

    // Resolve collisions with walls (circle vs axis-aligned rectangles)
    const pr = p.role === "streamer" ? ctx.cfg.radii.streamer : ctx.cfg.radii.zombie;
    for (const rct of ctx.walls) {
      const nearestX = Math.max(rct.x, Math.min(p.pos.x, rct.x + rct.w));
      const nearestY = Math.max(rct.y, Math.min(p.pos.y, rct.y + rct.h));
      let dx = p.pos.x - nearestX; let dy = p.pos.y - nearestY; let dist = Math.hypot(dx, dy);
      if (dist < pr) {
        if (dist === 0) {
          // Center is inside rectangle; push out along smallest penetration axis
          const left = Math.abs(p.pos.x - rct.x);
          const right = Math.abs(rct.x + rct.w - p.pos.x);
          const top = Math.abs(p.pos.y - rct.y);
          const bottom = Math.abs(rct.y + rct.h - p.pos.y);
          const m = Math.min(left, right, top, bottom);
          if (m === left) p.pos.x = rct.x - pr;
          else if (m === right) p.pos.x = rct.x + rct.w + pr;
          else if (m === top) p.pos.y = rct.y - pr;
          else p.pos.y = rct.y + rct.h + pr;
        } else {
          const nx = dx / dist, ny = dy / dist;
          const push = (pr - dist) + 0.5;
          p.pos.x += nx * push; p.pos.y += ny * push;
        }
      }
    }

    // Shooting / attacking (streamer only)
    if (p.role === "streamer" && p.input.shoot) {
      const nowMs = Date.now();
      const boostedW = (p.weaponBoostUntil || 0) > nowMs;
      const weapon = p.weapon || "pistol";
      const dirx = p.input.aimX - p.pos.x;
      const diry = p.input.aimY - p.pos.y;
      const d = Math.hypot(dirx, diry) || 1;
      const nx = dirx / d, ny = diry / d;
      const since = nowMs - (p.lastShotAt || 0);
      let { s } = statsFor(p);
      // Apply berserker rage damage bonus
      if (s.berserkerStacks > 0) {
        const recentKills = ((p as any).berserkerKills || []).filter((t: number) => now - t <= 5000);
        const stacks = Math.min(recentKills.length, s.berserkerStacks);
        s = { ...s, damageMul: s.damageMul * (1 + stacks * 0.1) }; // 10% per stack
      }
      if (weapon === "pistol") {
        const baseCd = boostedW ? ctx.cfg.weapons.cooldownMs.pistol.boosted : ctx.cfg.weapons.cooldownMs.pistol.base;
        const cd = baseCd / Math.max(0.01, s.fireRateMul);
        (p as any)._pistolLatched = (p as any)._pistolLatched || false;
        const ammoCost = Math.max(1, Math.floor(1 * s.ammoEfficiencyMul));
        if (since >= cd && (p.pistolAmmo ?? 0) >= ammoCost && !(p as any)._pistolLatched) {
          const speedB = (boostedW ? ctx.cfg.weapons.projectile.pistol.speed * 1.166 : ctx.cfg.weapons.projectile.pistol.speed) * s.projectileSpeedMul;
          const spec: BulletSpawnSpec = {
            pos: { x: p.pos.x, y: p.pos.y },
            vel: { x: nx*speedB, y: ny*speedB },
            ttl: ctx.cfg.weapons.projectile.pistol.ttl,
            ownerId: p.id,
            meta: {
              damage: (ctx.cfg.weapons.damage.pistol||0) * s.damageMul,
              radius: ctx.cfg.radii.bulletMargin * s.bulletSizeMul,
              pierce: s.pierce,
              bounce: s.bounce,
              ricochet: s.ricochet,
              chain: s.chain,
              status: statusFrom(s),
              critChance: s.critChance,
              critMul: s.critMul,
            }
          };
          const spawned: BulletSpawnSpec[] = [spec];
          for (const [id, n] of Object.entries(p.mods||{})) {
            (MOD_INDEX as any)[id]?.hooks?.onShoot?.({ room: ctx as any, playerId: p.id, bullets: spawned, stats: s });
          }
          for (const sp of spawned) {
            ctx.bullets.push({ id: crypto.randomUUID().slice(0,6), ...sp });
            // Track bullet fired
            ctx.trackBulletFired(p);
          }
          p.pistolAmmo = Math.max(0, (p.pistolAmmo ?? 0) - ammoCost);
          p.lastShotAt = nowMs;
          (p as any)._pistolLatched = true;
        }
      } else if (weapon === "smg") {
        const baseCd = boostedW ? ctx.cfg.weapons.cooldownMs.smg.boosted : ctx.cfg.weapons.cooldownMs.smg.base;
        const cd = baseCd / Math.max(0.01, s.fireRateMul);
        const ammoCost = Math.max(1, Math.floor(1 * s.ammoEfficiencyMul));
        if (since >= cd && (p.smgAmmo ?? 0) >= ammoCost) {
          const speedB = (boostedW ? ctx.cfg.weapons.projectile.smg.speed * 1.176 : ctx.cfg.weapons.projectile.smg.speed) * s.projectileSpeedMul;
          const spread = (Math.random()-0.5) * 0.12 * s.spreadMul; // radians
          const cs = Math.cos(spread), sn = Math.sin(spread);
          const vx = nx * cs - ny * sn; const vy = nx * sn + ny * cs;
          const spec: BulletSpawnSpec = {
            pos: { x: p.pos.x, y: p.pos.y },
            vel: { x: vx*speedB, y: vy*speedB },
            ttl: ctx.cfg.weapons.projectile.smg.ttl,
            ownerId: p.id,
            meta: {
              damage: (ctx.cfg.weapons.damage.smg||0) * s.damageMul,
              radius: ctx.cfg.radii.bulletMargin * s.bulletSizeMul,
              pierce: s.pierce,
              bounce: s.bounce,
              ricochet: s.ricochet,
              chain: s.chain,
              status: statusFrom(s),
              critChance: s.critChance,
              critMul: s.critMul,
            }
          };
          const spawned: BulletSpawnSpec[] = [spec];
          for (const [id, n] of Object.entries(p.mods||{})) {
            (MOD_INDEX as any)[id]?.hooks?.onShoot?.({ room: ctx as any, playerId: p.id, bullets: spawned, stats: s });
          }
          for (const sp of spawned) {
            ctx.bullets.push({ id: crypto.randomUUID().slice(0,6), ...sp });
            // Track bullet fired
            ctx.trackBulletFired(p);
          }
          p.smgAmmo = Math.max(0, (p.smgAmmo ?? 0) - ammoCost);
          p.lastShotAt = nowMs;
        }
      } else if (weapon === "shotgun") {
        const baseCd = boostedW ? ctx.cfg.weapons.cooldownMs.shotgun.boosted : ctx.cfg.weapons.cooldownMs.shotgun.base;
        const cd = baseCd / Math.max(0.01, s.fireRateMul);
        const ammoCost = Math.max(1, Math.floor(1 * s.ammoEfficiencyMul));
        if (since >= cd && (p.shotgunAmmo ?? 0) >= ammoCost) {
          const speedB = (boostedW ? ctx.cfg.weapons.projectile.shotgun.speed * 1.2 : ctx.cfg.weapons.projectile.shotgun.speed) * s.projectileSpeedMul;
          const pellets = ctx.cfg.weapons.projectile.shotgun.pellets;
          const spawned: BulletSpawnSpec[] = [];
          for (let i=0;i<pellets;i++){
            const spread = (Math.random()-0.5) * 0.45 * s.spreadMul; // radians
            const cs = Math.cos(spread), sn = Math.sin(spread);
            const vx = nx * cs - ny * sn; const vy = nx * sn + ny * cs;
            spawned.push({
              pos:{x:p.pos.x,y:p.pos.y},
              vel:{x:vx*speedB,y:vy*speedB},
              ttl: ctx.cfg.weapons.projectile.shotgun.ttl,
              ownerId:p.id,
              meta:{
                damage:(ctx.cfg.weapons.damage.shotgun||0) * s.damageMul,
                radius: ctx.cfg.radii.bulletMargin * s.bulletSizeMul,
                pierce: s.pierce,
                bounce: s.bounce,
                ricochet: s.ricochet,
                chain: s.chain,
                status: statusFrom(s),
                critChance: s.critChance,
                critMul: s.critMul,
              }
            });
          }
          for (const [id, n] of Object.entries(p.mods||{})) {
            (MOD_INDEX as any)[id]?.hooks?.onShoot?.({ room: ctx as any, playerId: p.id, bullets: spawned, stats: s });
          }
          for (const sp of spawned) {
            ctx.bullets.push({ id: crypto.randomUUID().slice(0,6), ...sp });
            // Track bullet fired
            ctx.trackBulletFired(p);
          }
          p.shotgunAmmo = Math.max(0, (p.shotgunAmmo ?? 0) - ammoCost);
          p.lastShotAt = nowMs;
        }
      } else if (weapon === "railgun") {
        const baseCd = boostedW ? ctx.cfg.weapons.cooldownMs.railgun.boosted : ctx.cfg.weapons.cooldownMs.railgun.base;
        const cd = baseCd / Math.max(0.01, s.fireRateMul);
        const ammoCost = Math.max(1, Math.floor(2 * s.ammoEfficiencyMul));
        if (since >= cd && (p.railgunAmmo ?? 0) >= ammoCost) {
          const railCfg = ctx.cfg.weapons.projectile.railgun;
          const speedB = (boostedW ? railCfg.speed * 1.1 : railCfg.speed) * s.projectileSpeedMul;
          const radiusMul = railCfg.width || 1;
          const baseStatus = statusFrom(s);
          const spawned: BulletSpawnSpec[] = [{
            pos: { x: p.pos.x, y: p.pos.y },
            vel: { x: nx * speedB, y: ny * speedB },
            ttl: railCfg.ttl,
            ownerId: p.id,
            meta: {
              damage: (ctx.cfg.weapons.damage.railgun || 0) * s.damageMul,
              radius: ctx.cfg.radii.bulletMargin * radiusMul * s.bulletSizeMul,
              pierce: s.pierce + (railCfg.pierce || 0),
              bounce: s.bounce,
              ricochet: s.ricochet,
              chain: s.chain,
              status: baseStatus,
              critChance: Math.min(1, s.critChance + 0.25),
              critMul: Math.max(s.critMul, 2.4),
            }
          }];
          for (const [id, n] of Object.entries(p.mods||{})) {
            (MOD_INDEX as any)[id]?.hooks?.onShoot?.({ room: ctx as any, playerId: p.id, bullets: spawned, stats: s });
          }
          for (const sp of spawned) {
            ctx.bullets.push({ id: crypto.randomUUID().slice(0,6), ...sp });
            ctx.trackBulletFired(p);
          }
          p.railgunAmmo = Math.max(0, (p.railgunAmmo ?? 0) - ammoCost);
          p.lastShotAt = nowMs;
        }
      } else if (weapon === "flamethrower") {
        const baseCd = boostedW ? ctx.cfg.weapons.cooldownMs.flamethrower.boosted : ctx.cfg.weapons.cooldownMs.flamethrower.base;
        const cd = baseCd / Math.max(0.01, s.fireRateMul);
        const ammoCost = Math.max(1, Math.floor(3 * s.ammoEfficiencyMul));
        if (since >= cd && (p.flamethrowerAmmo ?? 0) >= ammoCost) {
          const flameCfg = ctx.cfg.weapons.projectile.flamethrower;
          const spawned: BulletSpawnSpec[] = [];
          for (let i = 0; i < flameCfg.shards; i++) {
            const spread = (Math.random() - 0.5) * flameCfg.cone * s.spreadMul;
            const cs = Math.cos(spread);
            const sn = Math.sin(spread);
            const vx = nx * cs - ny * sn;
            const vy = nx * sn + ny * cs;
            const baseStatus = statusFrom(s);
            const flameStatus: any = baseStatus ? { ...baseStatus } : {};
            flameStatus.burnChance = Math.max(flameStatus.burnChance ?? 0, 1);
            flameStatus.burnMs = Math.max(flameStatus.burnMs ?? 0, flameCfg.burnMs);
            flameStatus.burnDps = Math.max(flameStatus.burnDps ?? 0, flameCfg.burnDps);
            const finalStatus = Object.keys(flameStatus).length ? flameStatus : undefined;
            spawned.push({
              pos: { x: p.pos.x, y: p.pos.y },
              vel: { x: vx * flameCfg.speed * s.projectileSpeedMul, y: vy * flameCfg.speed * s.projectileSpeedMul },
              ttl: flameCfg.ttl,
              ownerId: p.id,
              meta: {
                damage: (ctx.cfg.weapons.damage.flamethrower || 0) * s.damageMul,
                radius: ctx.cfg.radii.bulletMargin * 0.75 * s.bulletSizeMul,
                pierce: Math.max(0, s.pierce - 1),
                bounce: Math.max(0, s.bounce - 1),
                ricochet: s.ricochet,
                chain: s.chain,
                status: finalStatus,
                critChance: s.critChance,
                critMul: s.critMul,
              }
            });
          }
          for (const [id, n] of Object.entries(p.mods||{})) {
            (MOD_INDEX as any)[id]?.hooks?.onShoot?.({ room: ctx as any, playerId: p.id, bullets: spawned, stats: s });
          }
          for (const sp of spawned) {
            ctx.bullets.push({ id: crypto.randomUUID().slice(0,6), ...sp });
            ctx.trackBulletFired(p);
          }
          p.flamethrowerAmmo = Math.max(0, (p.flamethrowerAmmo ?? 0) - ammoCost);
          p.lastShotAt = nowMs;
        }
      }
    }
    // Always-available bat (melee) on separate input
    if (p.role === "streamer" && p.input.melee) {
      const nowMs = Date.now();
      const since = nowMs - (p.lastMeleeAt || 0);
      const cd = ctx.cfg.melee.cooldownMs;
      if (since >= cd) {
        // Set melee timing and create hit tracking set
        p.lastMeleeAt = nowMs;
        const hitIds = new Set<string>();
        
        // Improved aim direction calculation with fallback
        let dirx = p.input.aimX - p.pos.x;
        let diry = p.input.aimY - p.pos.y;

        // Fallback to last melee direction if aim is zero or invalid
        if (Math.hypot(dirx, diry) < 1) {
          if (p.meleeDirX !== undefined && p.meleeDirY !== undefined) {
            dirx = p.meleeDirX;
            diry = p.meleeDirY;
          } else {
            // Default to right if no previous direction
            dirx = 1;
            diry = 0;
          }
        }

        const d = Math.hypot(dirx, diry) || 1;
        const nx = dirx / d, ny = diry / d;
        p.meleeDirX = nx; p.meleeDirY = ny;
        const reach = ctx.cfg.melee.reach;
        
        let hasHitConfirm = false;

        // Check PLAYER zombies for melee hits
        for (const z of ctx.players.values()){
          if (z.role !== "zombie" || !z.alive) continue;
          if (hitIds.has(z.id)) continue; // Skip if already hit this swing
          
          const dx = z.pos.x - p.pos.x;
          const dy = z.pos.y - p.pos.y;
          const dist = Math.hypot(dx, dy);
          if (dist > reach) continue;

          // Improved arc check - use dot product for cone attack
          const zombieDirX = dx / dist;
          const zombieDirY = dy / dist;
          const dot = zombieDirX * nx + zombieDirY * ny;

          // Wider arc check - zombie must be within the attack cone
          if (dot > Math.cos(ctx.cfg.melee.arcRad)) {
            // Apply melee damage
            const damage = ctx.cfg.weapons.damage.melee;
            const oldHp = z.zHp ?? ctx.cfg.zombies.baseHp;
            z.zHp = Math.max(0, oldHp - damage);

            // Apply knockback - push zombie away from player
            const knockbackDistance = ctx.cfg.melee.knockbackStep;
            const newX = z.pos.x + zombieDirX * knockbackDistance;
            const newY = z.pos.y + zombieDirY * knockbackDistance;

            // Clamp to map bounds
            z.pos.x = Math.max(0, Math.min(ctx.W, newX));
            z.pos.y = Math.max(0, Math.min(ctx.H, newY));

            // Add damage number for melee
            ctx.addDamageNumber(z.pos.x, z.pos.y, damage, false, false);
            
            // Mark this target as hit and trigger hit confirm on first hit
            hitIds.add(z.id);
            if (!hasHitConfirm) {
              ctx.hitConfirm(p.pos.x, p.pos.y);
              hasHitConfirm = true;
            }

            if ((z.zHp ?? 0) <= 0) {
              z.alive = false;
              // Drop ammo on zombie death
              ctx.pickups.push({ id: crypto.randomUUID().slice(0,6), type: 'ammo', x: z.pos.x, y: z.pos.y });
              const id = z.id;
              setTimeout(() => { const zp = ctx.players.get(id); if (zp) { zp.pos = ctx.spawnZombiePos(); zp.alive = true; zp.zHp = zp.zMaxHp; } }, ctx.cfg.combat.respawnMs);
              p.score += 1;
              // Track enemy kill
              ctx.trackEnemyKill(p, 'basic');
            }
          }
        }

        // Check AI zombies for melee hits (same logic)
        for (const zombie of ctx.aiZombies) {
          const aiId = `ai:${zombie.id}`;
          if (hitIds.has(aiId)) continue; // Skip if already hit this swing
          
          const dx = zombie.pos.x - p.pos.x;
          const dy = zombie.pos.y - p.pos.y;
          const dist = Math.hypot(dx, dy);
          if (dist > reach) continue;

          // Same arc check as player zombies
          const zombieDirX = dx / dist;
          const zombieDirY = dy / dist;
          const dot = zombieDirX * nx + zombieDirY * ny;

          if (dot > Math.cos(ctx.cfg.melee.arcRad)) {
            // Apply melee damage
            const damage = ctx.cfg.weapons.damage.melee;
            const oldHp = zombie.hp;
            zombie.hp = Math.max(0, zombie.hp - damage);

            // Apply knockback - push zombie away from player
            const knockbackDistance = ctx.cfg.melee.knockbackStep;
            const newX = zombie.pos.x + zombieDirX * knockbackDistance;
            const newY = zombie.pos.y + zombieDirY * knockbackDistance;

            // Clamp to map bounds
            zombie.pos.x = Math.max(0, Math.min(ctx.W, newX));
            zombie.pos.y = Math.max(0, Math.min(ctx.H, newY));

            // Add damage number for melee
            ctx.addDamageNumber(zombie.pos.x, zombie.pos.y, damage, false, false);

            // Track bullet hit (reuse for melee)
            ctx.trackBulletHit(p);
            ctx.trackDamageDealt(p, damage);
            
            // Mark this target as hit and trigger hit confirm on first hit
            hitIds.add(aiId);
            if (!hasHitConfirm) {
              ctx.hitConfirm(p.pos.x, p.pos.y);
              hasHitConfirm = true;
            }

            // Handle AI zombie death
            if (zombie.hp <= 0) {
              // Drop random pickup (ammo or treasure)
              const dropType = ctx.getRandomZombieDrop();
              if (dropType) {
                ctx.pickups.push({
                  id: crypto.randomUUID().slice(0, 6),
                  type: dropType,
                  x: zombie.pos.x,
                  y: zombie.pos.y
                });
              }

              // Award points and XP for AI zombie kill
              p.score += 1;
              p.xp = (p.xp||0) + XP_PER_KILL;
              ctx.trackEnemyKill(p, zombie.zClass || 'basic');
              ctx.trackXPGained(p, XP_PER_KILL);

              // Level up check
              const need = XP_THRESHOLDS(p.level||0);
              if ((p.xp||0) >= need) {
                p.xp = (p.xp||0) - need;
                p.level = (p.level||0) + 1;
                ctx.offerUpgrades(p.id);
              }

              // Remove dead AI zombie
              const idx = ctx.aiZombies.indexOf(zombie);
              if (idx >= 0) ctx.aiZombies.splice(idx, 1);
            }
          }
        }
      }
    }

    // Reset pistol latch when trigger released
    if (p.role === "streamer" && !p.input.shoot) {
      if ((p as any)._pistolLatched) (p as any)._pistolLatched = false;
    }
  }

  // Update bullets
  const aliveBullets: Bullet[] = [];
  for (const b of ctx.bullets) {
    b.ttl -= ctx.tickMs;
    b.pos.x += b.vel.x * dt;
    b.pos.y += b.vel.y * dt;
    if (b.ttl <= 0) continue;
    if (b.pos.x < 0 || b.pos.x > ctx.W || b.pos.y < 0 || b.pos.y > ctx.H) continue;

    // Collision with walls: use bullet-specific radius and allow simple bounce
    let blocked = false;
    for (const rct of ctx.walls) {
      const m = b.meta.radius || ctx.cfg.radii.bulletMargin;
      if (b.pos.x > rct.x - m && b.pos.x < rct.x + rct.w + m && b.pos.y > rct.y - m && b.pos.y < rct.y + rct.h + m) { blocked = true; break; }
    }
    if (blocked) {
      if (b.meta.bounce > 0) {
        b.meta.bounce -= 1;
        // Simple reflection: invert both components
        b.vel.x *= -1; b.vel.y *= -1;
        aliveBullets.push(b);
        continue;
      }
      continue;
    }

    // Collision with zombies (class-based HP)
    let consumed = false;
    for (const p of ctx.players.values()) {
      if (p.role !== "zombie" || !p.alive) continue;
      const r = ctx.cfg.radii.zombie; // zombie radius
      if (Math.hypot(p.pos.x - b.pos.x, p.pos.y - b.pos.y) < r) {
        const base = b.meta.damage || 0;
        const crit = Math.random() < (b.meta.critChance || 0);
        const dealt = Math.max(0, Math.round(base * (crit ? (b.meta.critMul || 1) : 1)));
        p.zHp = Math.max(0, (p.zHp ?? ctx.cfg.zombies.baseHp) - dealt);
        // Add damage number for bullet hit
        ctx.addDamageNumber(p.pos.x, p.pos.y, dealt, crit, false);
        const owner = ctx.players.get(b.ownerId);
        // Track bullet hit
        if (owner) {
          ctx.trackBulletHit(owner);
          ctx.trackDamageDealt(owner, dealt);
        }
        const ownerStats = owner ? statsFor(owner).s : undefined;
        // Lifesteal on hit
        if (owner && ownerStats && ownerStats.lifestealPct > 0 && owner.role === 'streamer') {
          const heal = Math.max(0, Math.floor(dealt * ownerStats.lifestealPct));
          owner.hp = Math.min(owner.maxHp ?? ctx.cfg.streamer.maxHp, (owner.hp ?? ctx.cfg.streamer.maxHp) + heal);
        };
        // Apply status effects
        if (b.meta.status) {
          const nowMs = now;
          const st = b.meta.status;
          if (st.slowMs && st.slowMul && Math.random() < (st.slowChance || 1)) {
            p.slowUntil = nowMs + st.slowMs; p.slowMul = st.slowMul;
          }
          if (st.burnMs && st.burnDps && Math.random() < (st.burnChance || 1)) {
            p.burns = p.burns || [];
            p.burns.push({ until: nowMs + st.burnMs, dps: st.burnDps, nextTick: nowMs + 1000, ownerId: b.ownerId });
          }
          if (st.bleedMs && st.bleedDps && Math.random() < (st.bleedChance || 1)) {
            p.bleeds = p.bleeds || [];
            p.bleeds.push({ until: nowMs + st.bleedMs, dps: st.bleedDps, nextTick: nowMs + 1000, ownerId: b.ownerId });
          }
        }
        // Call onHit hooks
        if (owner && owner.mods) {
          for (const [id, n] of Object.entries(owner.mods)) {
            (MOD_INDEX as any)[id]?.hooks?.onHit?.({ room: ctx as any, bullet: b, targetId: p.id, killed: false, stats: ownerStats || {} });
          }
        }
        let killed = false;
        if ((p.zHp ?? 0) <= 0) {
          p.alive = false; killed = true;
          // Drop ammo on zombie death
          ctx.pickups.push({ id: crypto.randomUUID().slice(0,6), type: 'ammo', x: p.pos.x, y: p.pos.y });
          const id = p.id;
          setTimeout(() => { const zp = ctx.players.get(id); if (zp) { zp.pos = ctx.spawnZombiePos(); zp.alive = true; zp.zHp = zp.zMaxHp; } }, ctx.cfg.combat.respawnMs);
          // Reload on kill
          if (owner && ownerStats && ownerStats.reloadOnKillPct > 0 && owner.role === 'streamer') {
            ctx.refundAmmoOnKill(owner, ownerStats.reloadOnKillPct);
          }
          // Reward streamer (only on kill)
          if (owner && owner.role === 'streamer') {
            owner.score += 1;
            owner.xp = (owner.xp||0) + XP_PER_KILL;
            const need = XP_THRESHOLDS(owner.level||0);
            if ((owner.xp||0) >= need) {
              owner.xp = (owner.xp||0) - need; owner.level = (owner.level||0) + 1;
              ctx.offerUpgrades(owner.id);
            }
          }
          // Call onKill hooks and handle berserker stacks
          if (killed && owner && owner.mods) {
            for (const [id, n] of Object.entries(owner.mods)) {
              (MOD_INDEX as any)[id]?.hooks?.onKill?.({ room: ctx as any, killerId: owner.id, victimId: p.id, stats: ownerStats || {} });
            }
            // Track berserker kills
            if (ownerStats && ownerStats.berserkerStacks > 0) {
              (owner as any).berserkerKills = (owner as any).berserkerKills || [];
              (owner as any).berserkerKills.push(now);
            }
            // Blood aura healing
            if (ownerStats && ownerStats.vampireAuraRange > 0) {
              const healAmount = Math.floor(ownerStats.vampireAuraRange / 10); // 5 HP per 50px range
              owner.hp = Math.min(owner.maxHp ?? ctx.cfg.streamer.maxHp, (owner.hp ?? ctx.cfg.streamer.maxHp) + healAmount);
            }
          }
        }
        // Handle pierce or ricochet
        if (b.meta.pierce > 0) {
          b.meta.pierce -= 1; aliveBullets.push(b);
        } else {
          // Try ricochet if available
          if (b.meta.ricochet > 0 && ctx.retargetBulletRicochet(b, p.id)) {
            b.meta.ricochet -= 1; aliveBullets.push(b);
          } else {
            consumed = true;
          }
        }
        // Chain lightning
        if (b.meta.chain > 0) {
          ctx.applyChainDamage(b, { x: b.pos.x, y: b.pos.y }, p.id, b.meta.chain, Math.round((b.meta.damage||0)*0.7));
        }
        break;
      }
    }
    // If not consumed by player-zombie hit, check collision with AI zombies
    if (!consumed) {
      let hitAI = false;
      for (const zombie of ctx.aiZombies) {
        const r = ctx.cfg.radii.zombie;
        if (Math.hypot(zombie.pos.x - b.pos.x, zombie.pos.y - b.pos.y) < r) {
          const base = b.meta.damage || 0;
          const crit = Math.random() < (b.meta.critChance || 0);
          const dealt = Math.max(0, Math.round(base * (crit ? (b.meta.critMul || 1) : 1)));
          zombie.hp = Math.max(0, zombie.hp - dealt);
          // Add damage number for bullet hit on AI zombie
          ctx.addDamageNumber(zombie.pos.x, zombie.pos.y, dealt, crit, false);
          const owner = ctx.players.get(b.ownerId);
          // Track bullet hit
          if (owner) {
            ctx.trackBulletHit(owner);
            ctx.trackDamageDealt(owner, dealt);
          }
          const ownerStats = owner ? statsFor(owner).s : undefined;
          // Lifesteal
          if (owner && ownerStats && ownerStats.lifestealPct > 0 && owner.role === 'streamer') {
            const heal = Math.max(0, Math.floor(dealt * ownerStats.lifestealPct));
            owner.hp = Math.min(owner.maxHp ?? ctx.cfg.streamer.maxHp, (owner.hp ?? ctx.cfg.streamer.maxHp) + heal);
          }
          // Status effects
          if (b.meta.status) {
            const nowMs = now;
            const st = b.meta.status;
            if (st.slowMs && st.slowMul && Math.random() < (st.slowChance || 1)) { zombie.slowUntil = nowMs + st.slowMs; zombie.slowMul = st.slowMul; }
            if (st.burnMs && st.burnDps && Math.random() < (st.burnChance || 1)) { zombie.burns = zombie.burns || []; zombie.burns.push({ until: nowMs + st.burnMs, dps: st.burnDps, nextTick: nowMs + 1000, ownerId: b.ownerId }); }
            if (st.bleedMs && st.bleedDps && Math.random() < (st.bleedChance || 1)) { zombie.bleeds = zombie.bleeds || []; zombie.bleeds.push({ until: nowMs + st.bleedMs, dps: st.bleedDps, nextTick: nowMs + 1000, ownerId: b.ownerId }); }
          }
          // Kill check for reload-on-kill
          const wasKilled = zombie.hp <= 0;
          if (wasKilled && owner && ownerStats && ownerStats.reloadOnKillPct > 0 && owner.role === 'streamer') {
            ctx.refundAmmoOnKill(owner, ownerStats.reloadOnKillPct);
          }
          // Reward streamer (only on kill)
          if (wasKilled && owner && owner.role === 'streamer') {
            owner.score += 1;
            owner.xp = (owner.xp||0) + XP_PER_KILL;
            // Track AI zombie kill
            ctx.trackEnemyKill(owner, zombie.zClass || 'basic');
            ctx.trackXPGained(owner, XP_PER_KILL);
            const need = XP_THRESHOLDS(owner.level||0);
            if ((owner.xp||0) >= need) { owner.xp -= need; owner.level = (owner.level||0) + 1; ctx.offerUpgrades(owner.id); }
          }
          // Pierce/ricochet handling
          if (b.meta.pierce > 0) { b.meta.pierce -= 1; aliveBullets.push(b); }
          else if (b.meta.ricochet > 0 && ctx.retargetBulletRicochet(b, 'ai:'+zombie.id)) { b.meta.ricochet -= 1; aliveBullets.push(b); }
          else { consumed = true; }
          // Chain lightning
          if (b.meta.chain > 0) { ctx.applyChainDamage(b, { x: b.pos.x, y: b.pos.y }, 'ai:'+zombie.id, b.meta.chain, Math.round((b.meta.damage||0)*0.7)); }
          hitAI = true;
          break;
        }
      }
      // Check collision with bosses if not consumed by zombies
      if (!hitAI && !consumed) {
        let hitBoss = false;
        for (const boss of ctx.bosses) {
          if (boss.state === "dying") continue;
          
          // Skip if boss is phased (Shadow Lord ability)
          if (boss.phased) continue;
          
          const bossRadius = boss.radius;
          if (Math.hypot(boss.pos.x - b.pos.x, boss.pos.y - b.pos.y) < bossRadius) {
            const base = b.meta.damage || 0;
            const crit = Math.random() < (b.meta.critChance || 0);
            const dealt = Math.max(0, Math.round(base * (crit ? (b.meta.critMul || 1) : 1)));
            boss.hp = Math.max(0, boss.hp - dealt);
            
            // Add damage number for boss hit
            ctx.addDamageNumber(boss.pos.x, boss.pos.y, dealt, crit, false);
            
            const owner = ctx.players.get(b.ownerId);
            const ownerStats = owner ? statsFor(owner).s : undefined;
            
            // Lifesteal on boss hit
            if (owner && ownerStats && ownerStats.lifestealPct > 0 && owner.role === 'streamer') {
              const heal = Math.max(0, Math.floor(dealt * ownerStats.lifestealPct));
              owner.hp = Math.min(owner.maxHp ?? ctx.cfg.streamer.maxHp, (owner.hp ?? ctx.cfg.streamer.maxHp) + heal);
            }
            
            // Check if boss died
            if (boss.hp <= 0 && (boss.state as any) !== "dying") {
              boss.state = "dying";
              // Reward streamer for boss kill
              if (owner && owner.role === 'streamer') {
                // Track boss kill
                ctx.trackBossKill(owner, boss.type);
                owner.score += 10; // More points for boss kill
                const bossXP = XP_PER_KILL * 5; // 5x XP for boss
                owner.xp = (owner.xp||0) + bossXP;
                ctx.trackXPGained(owner, bossXP);
                const need = XP_THRESHOLDS(owner.level||0);
                if ((owner.xp||0) >= need) {
                  owner.xp = (owner.xp||0) - need;
                  owner.level = (owner.level||0) + 1;
                  ctx.offerUpgrades(owner.id);
                }
              }
            }
            
            // Pierce/ricochet handling
            if (b.meta.pierce > 0) {
              b.meta.pierce -= 1;
              aliveBullets.push(b);
            } else if (b.meta.ricochet > 0 && ctx.retargetBulletRicochet(b, 'boss:'+boss.id)) {
              b.meta.ricochet -= 1;
              aliveBullets.push(b);
            } else {
              consumed = true;
            }
            
            // Chain lightning
            if (b.meta.chain > 0) {
              ctx.applyChainDamage(b, { x: b.pos.x, y: b.pos.y }, 'boss:'+boss.id, b.meta.chain, Math.round((b.meta.damage||0)*0.7));
            }
            
            hitBoss = true;
            break;
          }
        }
        
        if (!hitBoss && !consumed) aliveBullets.push(b);
      }
    }
  }
  ctx.bullets = aliveBullets;

  // Process damage-over-time effects (burn/bleed) for both player zombies and AI zombies
  ctx.processDotEffects(now);

  // Find streamer at the start of the update
  streamer = [...ctx.players.values()].find(p => p.role === "streamer");

  // Update spitter globs
  const aliveGlobs: typeof ctx.spittles = [];
  for (const g of ctx.spittles) {
    g.ttl -= ctx.tickMs;
    g.pos.x += g.vel.x * dt;
    g.pos.y += g.vel.y * dt;
    if (g.ttl <= 0) continue;
    if (g.pos.x < 0 || g.pos.x > ctx.W || g.pos.y < 0 || g.pos.y > ctx.H) continue;
    // collide with streamer
    if (streamer) {
      const r = ctx.cfg.radii.streamer + 2;
      if (Math.hypot(streamer.pos.x - g.pos.x, streamer.pos.y - g.pos.y) < r) {
        // apply slow and small damage
        (streamer as any).gooSlowUntil = now + ctx.cfg.zombies.spitter.slowMs;
        streamer.hp = Math.max(0, (streamer.hp ?? ctx.cfg.streamer.maxHp) - ctx.cfg.zombies.spitter.hitDamage);
        ctx.trackDamageTaken(streamer, ctx.cfg.zombies.spitter.hitDamage);
        continue; // glob consumed
      }
    }
    aliveGlobs.push(g);
  }
  ctx.spittles = aliveGlobs;

  // Zombie damage to streamer
  if (streamer) {
    // Check for ghost walk invulnerability
    const isInvulnerable = ((streamer as any).ghostWalkUntil || 0) > now;
    // Dash-kill pass: if streamer is dashing, kill non-brute zombies on contact
    if ((streamer.dashUntil || 0) > now) {
      for (const z of ctx.players.values()) {
        if (z.role !== 'zombie' || !z.alive) continue;
        const dist = Math.hypot(z.pos.x - streamer.pos.x, z.pos.y - streamer.pos.y);
        const thresh = ctx.cfg.radii.zombie + ctx.cfg.radii.streamer;
        if (dist <= thresh) {
          if (z.zClass === 'brute') {
            continue; // brutes resist dash kill
          }
          z.zHp = 0; z.alive = false;
          // Drop ammo on zombie death
          ctx.pickups.push({ id: crypto.randomUUID().slice(0,6), type: 'ammo', x: z.pos.x, y: z.pos.y });
          const id = z.id;
          setTimeout(() => { const zp = ctx.players.get(id); if (zp) { zp.pos = ctx.spawnZombiePos(); zp.alive = true; zp.zHp = zp.zMaxHp; } }, ctx.cfg.combat.respawnMs);
          streamer.score += 1;
        }
      }
    }
    // Spitter AI: fire globs toward streamer
    for (const z of ctx.players.values()){
      if (z.role !== 'zombie' || !z.alive || z.zClass !== 'spitter') continue;
      const rng = ctx.cfg.zombies.spitter.range;
      const dx = streamer.pos.x - z.pos.x; const dy = streamer.pos.y - z.pos.y; const dist = Math.hypot(dx, dy);
      if (dist <= rng && (z.nextSpitAt || 0) <= now) {
        const s = ctx.cfg.zombies.spitter.projectileSpeed;
        const nx = (dx / (dist||1)); const ny = (dy / (dist||1));
        ctx.spittles.push({ id: crypto.randomUUID().slice(0,6), pos: { x: z.pos.x, y: z.pos.y }, vel: { x: nx * s, y: ny * s }, ttl: ctx.cfg.zombies.spitter.projectileTtl });
        z.nextSpitAt = now + ctx.randRange(ctx.cfg.zombies.spitter.cooldownMsMin, ctx.cfg.zombies.spitter.cooldownMsMax);
      }
    }
    for (const z of ctx.players.values()) {
      if (z.role !== "zombie" || !z.alive) continue;
      const dist = Math.hypot(z.pos.x - streamer.pos.x, z.pos.y - streamer.pos.y);
      if (dist < 16) {
        const shielded = ((streamer as any).shieldUntil || 0) > now;
        if (!shielded && !isInvulnerable) {
          if ((streamer.hp ?? ctx.cfg.streamer.maxHp) > 0) {
            streamer.hp = Math.max(0, (streamer.hp ?? ctx.cfg.streamer.maxHp) - ctx.cfg.combat.zombieTouchDamage);
            ctx.trackDamageTaken(streamer, ctx.cfg.combat.zombieTouchDamage);
          }
          if ((streamer.hp ?? 0) <= 0) {
            ctx.handleStreamerDeath(streamer, 'zombie_touch');
            return;
          }
        }// Knockback streamer slightly
        const dx = streamer.pos.x - z.pos.x; const dy = streamer.pos.y - z.pos.y; const d = Math.hypot(dx, dy) || 1;
        const kbMul = (z.zClass === 'brute') ? ctx.cfg.zombies.brute.extraKnockbackMul : 1;
        streamer.pos.x = Math.max(0, Math.min(ctx.W, streamer.pos.x + (dx / d) * ctx.cfg.combat.knockbackStep * kbMul));
        streamer.pos.y = Math.max(0, Math.min(ctx.H, streamer.pos.y + (dy / d) * ctx.cfg.combat.knockbackStep * kbMul));
        // Teleport zombie to edge to avoid instant re-hit
        z.pos = ctx.spawnZombiePos();
      }
    }
  }

  // (duplicate spawning block removed; handled by checkPickupSpawning())

  // Pickup collection
  const remaining: Pickup[] = [];
  for (const p of ctx.pickups) {
    let taken = false;
    for (const pl of ctx.players.values()) {
      const pr = pl.role === "streamer" ? 10 : 12;
      const pickupR = (pl.role === "streamer" && (((pl as any).magnetUntil || 0) > now)) ? 26 : 10;
      if (Math.hypot(pl.pos.x - p.x, pl.pos.y - p.y) < pr + pickupR) { // pickup radius
        if (p.type === "health" && pl.role === "streamer") {
          pl.hp = Math.min(pl.maxHp ?? ctx.cfg.streamer.maxHp, (pl.hp ?? ctx.cfg.streamer.maxHp) + 20);
          ctx.broadcast("notice", { message: "Love Health restored!" });
          ctx.trackPickupTaken(pl, p.type);
          taken = true; break;
        }
        if (p.type === "speed" && pl.role === "zombie") {
          pl.boostUntil = now + ctx.cfg.effects.zombieBoostMs; // speed boost
          taken = true; break;
        }
        if (p.type === "ammo" && pl.role === "streamer") {
          pl.pistolAmmo = Math.min((pl.pistolAmmo ?? 0) + ctx.cfg.weapons.ammo.pickupGain.pistol, ctx.cfg.weapons.ammo.max.pistol);
          pl.smgAmmo = Math.min((pl.smgAmmo ?? 0) + ctx.cfg.weapons.ammo.pickupGain.smg, ctx.cfg.weapons.ammo.max.smg);
          pl.shotgunAmmo = Math.min((pl.shotgunAmmo ?? 0) + ctx.cfg.weapons.ammo.pickupGain.shotgun, ctx.cfg.weapons.ammo.max.shotgun);
          pl.railgunAmmo = Math.min((pl.railgunAmmo ?? 0) + ctx.cfg.weapons.ammo.pickupGain.railgun, ctx.cfg.weapons.ammo.max.railgun);
          pl.flamethrowerAmmo = Math.min((pl.flamethrowerAmmo ?? 0) + ctx.cfg.weapons.ammo.pickupGain.flamethrower, ctx.cfg.weapons.ammo.max.flamethrower);
          ctx.broadcast("notice", { message: "Ammo cache redistributed across the arsenal!" });
          ctx.trackPickupTaken(pl, p.type);
          taken = true; break;
        }
        if (p.type === "weapon" && pl.role === "streamer") {
          // If currently bat-only, grant pistol and some starter ammo; otherwise weapon boost
          if ((pl.weapon||'bat') === 'bat') {
            pl.weapon = 'pistol';
            pl.pistolAmmo = Math.max(pl.pistolAmmo||0, 30);
            ctx.broadcast("notice", { message: "Pistol Pistol unlocked with ammo!" });
          } else {
            ctx.broadcast("notice", { message: "Shock Weapon boost activated!" });
          }
          pl.weaponBoostUntil = now + ctx.cfg.effects.weaponBoostMs; // better weapon
          ctx.trackPickupTaken(pl, p.type);
          taken = true; break;
        }
        if (p.type === "shield" && pl.role === "streamer") {
          (pl as any).shieldUntil = now + ctx.cfg.effects.shieldMs; // shield
          ctx.broadcast("notice", { message: "Shield Shield activated - temporary invulnerability!" });
          ctx.trackPickupTaken(pl, p.type);
          taken = true; break;
        }
        if (p.type === "magnet" && pl.role === "streamer") {
          (pl as any).magnetUntil = now + ctx.cfg.effects.magnetMs; // big pickup radius
          ctx.broadcast("notice", { message: "Magnet Magnet activated - larger pickup radius!" });
          ctx.trackPickupTaken(pl, p.type);
          taken = true; break;
        }
        if (p.type === "freeze" && pl.role === "streamer") {
          ctx.zombieSlowUntil = now + ctx.cfg.effects.freezeMs; // slow zombies globally
          ctx.broadcast("notice", { message: "Snow Freeze activated - all zombies slowed!" });
          ctx.trackPickupTaken(pl, p.type);
          taken = true; break;
        }
        if (p.type === "blast" && pl.role === "streamer") {
          // Clear nearby zombies and score for each
          const radius = ctx.cfg.pickups.blastRadius;
          let zombiesHit = 0;
          for (const z of ctx.players.values()){
            if (z.role !== "zombie" || !z.alive) continue;
            if (Math.hypot(z.pos.x - pl.pos.x, z.pos.y - pl.pos.y) <= radius){
              z.zHp = Math.max(0, (z.zHp ?? ctx.cfg.zombies.baseHp) - 100);
              // Add damage number for blast hit on zombie
              ctx.addDamageNumber(z.pos.x, z.pos.y, 100, false, false);
              if ((z.zHp ?? 0) <= 0) {
                z.alive = false;
                zombiesHit++;
                // Drop ammo on zombie death
                ctx.pickups.push({ id: crypto.randomUUID().slice(0,6), type: 'ammo', x: z.pos.x, y: z.pos.y });
                const id = z.id;
                setTimeout(() => { const zp = ctx.players.get(id); if (zp) { zp.pos = ctx.spawnZombiePos(); zp.alive = true; zp.zHp = zp.zMaxHp; } }, ctx.cfg.combat.respawnMs);
                if (pl.role === "streamer") pl.score += 1;
              }
            }
          }
          ctx.broadcast("notice", { message: `Impact Blast killed ${zombiesHit} zombies!` });
          ctx.trackPickupTaken(pl, p.type);
          taken = true; break;
        }
        if (p.type === "treasure" && pl.role === "streamer") {
          pl.score += ctx.cfg.pickups.treasureScore;
          ctx.broadcast("notice", { message: `Gem Treasure found! +${ctx.cfg.pickups.treasureScore} points` });
          ctx.trackPickupTaken(pl, p.type);
          if (streamer && Math.random() < 0.35) {
            const exclude = new Set<string>();
            if (streamer.weapon) exclude.add(streamer.weapon);
            const weaponDrop = ctx.chooseWeapon(exclude);
            const initAmmo = (ctx.cfg.weapons.ammo.initial as any)[weaponDrop] ?? 0;
            ctx.spawnWeaponDrop(weaponDrop, p.x, p.y, initAmmo, 'treasure');
          }
          taken = true; break;
        }
        // Handle new treasure types
        const treasureValue = ctx.getTreasureValue(p.type);
        if (treasureValue > 0 && pl.role === "streamer") {
          pl.score += treasureValue;
          const treasureNames: Record<string, string> = {
            coin: "MoneyBag Coin",
            gem: "Gem Gem", 
            crystal: "CrystalBall Crystal",
            orb: "Star Orb",
            relic: "Vase Relic",
            artifact: "Coffin Artifact",
            medallion: "Medal Medallion",
            scroll: "Scroll Scroll",
            crown: "Crown Crown"
          };
          const name = treasureNames[p.type] || "Gem Treasure";
          ctx.broadcast("notice", { message: `${name} found! +${treasureValue} points` });
          ctx.trackPickupTaken(pl, p.type);
          if (streamer && Math.random() < 0.2) {
            const exclude = new Set<string>();
            if (streamer.weapon) exclude.add(streamer.weapon);
            const weaponDrop = ctx.chooseWeapon(exclude);
            const initAmmo = (ctx.cfg.weapons.ammo.initial as any)[weaponDrop] ?? 0;
            ctx.spawnWeaponDrop(weaponDrop, p.x, p.y, initAmmo, 'treasure');
          }
          taken = true; break;
        }
        if (p.type === "key" && pl.role === "streamer") {
          // Open all doors: convert tile 4 (doorClosed) to 5 (doorOpen)
          if (ctx.map) {
            for (let i=0;i<ctx.map.tiles.length;i++) if (ctx.map.tiles[i]===4) ctx.map.tiles[i]=5;
            // Broadcast updated map to all clients
            const base64 = ctx.u8ToBase64(ctx.map.tiles);
            ctx.broadcast('map', { map: { w: ctx.map.w, h: ctx.map.h, size: ctx.map.size, theme: ctx.map.theme, tilesBase64: base64, props: ctx.map.props, lights: ctx.map.lights } });
          }
          ctx.broadcast("notice", { message: "Key Key used! All doors are now open!" });
          ctx.trackPickupTaken(pl, p.type);
          taken = true; break;
        }
      }
    }
    if (!taken) remaining.push(p);
  }
  ctx.pickups = remaining;

  if (streamer) {
    const interactDown = !!streamer.input.interact;
    const latched = !!(streamer as any)._interactLatched;
    const interactPressed = interactDown && !latched;
    if (interactDown) {
      (streamer as any)._interactLatched = true;
    } else if (latched) {
      (streamer as any)._interactLatched = false;
    }

    const swapRadius = 26;
    const keptDrops: WeaponDrop[] = [];
    for (const drop of ctx.weaponDrops) {
      const dist = Math.hypot(streamer.pos.x - drop.x, streamer.pos.y - drop.y);
      if (dist < swapRadius && interactPressed) {
        ctx.performWeaponSwap(streamer, drop);
        continue;
      }
      keptDrops.push(drop);
    }
    ctx.weaponDrops = keptDrops;
  }

  // Extractions removed

  const streamerPlayer = streamer;

  // Round timer: end raid when time elapses
  if ((ctx.roundEndTime || 0) > 0 && now >= (ctx.roundEndTime as number)) {
    if (streamerPlayer) {
      streamerPlayer.alive = false;
      streamerPlayer.vel.x = 0;
      streamerPlayer.vel.y = 0;
      streamerPlayer.input = {
        up: false,
        down: false,
        left: false,
        right: false,
        shoot: false,
        melee: false,
        dash: false,
        aimX: streamerPlayer.pos.x,
        aimY: streamerPlayer.pos.y,
      };
    }
    ctx.endRound('timeout', { streamer: streamerPlayer || undefined });
    return;
  }

}
