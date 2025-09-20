import type { RoomDO } from '../index';
import type { Boss, BossMinion, PoisonField, BossType } from '../../types';
import type { PickupType, Player } from '../room-types';


export function updateBossSystem(ctx: RoomDO, now: number) {
  // Check for boss spawn announcement
  if (!ctx.nextBossAnnouncement && now - ctx.lastBossSpawn > ctx.bossSpawnCooldown - ctx.cfg.bosses.announceMs) {
    if (ctx.bosses.length < ctx.cfg.bosses.maxActive) {
      ctx.nextBossAnnouncement = now + ctx.cfg.bosses.announceMs;
      ctx.broadcast("notice", { message: "Warning A powerful boss is approaching! Prepare for battle!" });
    }
  }

  // Spawn boss if it's time
  if (ctx.nextBossAnnouncement && now >= ctx.nextBossAnnouncement) {
    ctx.spawnRandomBoss();
    ctx.nextBossAnnouncement = undefined;
    ctx.lastBossSpawn = now;
  }

  // Update existing bosses
  for (let i = ctx.bosses.length - 1; i >= 0; i--) {
    const boss = ctx.bosses[i];
    ctx.updateBoss(boss, now);
    
    // Remove dead bosses
    if (boss.hp <= 0 && boss.state === "dying") {
      ctx.onBossDeath(boss);
      ctx.bosses.splice(i, 1);
    }
  }

}

export function spawnRandomBoss(ctx: RoomDO) {
  const bossTypes: BossType[] = ["necromancer", "bruteKing", "shadowLord"];
  const randomType = bossTypes[Math.floor(Math.random() * bossTypes.length)];
  const spawnPos = ctx.spawnInRandomRoom();
  
  const bossConfig = ctx.cfg.bosses.types[randomType];
  const boss: Boss = {
    id: crypto.randomUUID().slice(0, 8),
    type: randomType,
    pos: spawnPos,
    vel: { x: 0, y: 0 },
    hp: bossConfig.hp,
    maxHp: bossConfig.hp,
    radius: bossConfig.radius,
    damage: bossConfig.damage,
    speed: bossConfig.speed,
    state: "spawning",
    lastSeen: Date.now(),
    spawnTime: Date.now(),
    minionIds: [],
    cloneIds: []
  };

  ctx.bosses.push(boss);
  ctx.broadcast("boss_spawn", { boss: ctx.publicBoss(boss) });
  ctx.broadcast("notice", { message: `Skull ${randomType.toUpperCase()} has entered the arena!` });

}

export function updateBoss(ctx: RoomDO, boss: Boss, now: number) {
  const streamer = [...ctx.players.values()].find(p => p.role === "streamer" && p.alive);
  if (!streamer) {
    boss.state = "idle";
    return;
  }
  
  // End charge ability if duration has passed
  if (boss.state === "ability" && boss.type === "bruteKing" && boss.chargeUntil && now >= boss.chargeUntil) {
    boss.state = "chasing";
    boss.chargeUntil = undefined;
    boss.vel.x = 0;
    boss.vel.y = 0;
  }

  const dist = Math.hypot(boss.pos.x - streamer.pos.x, boss.pos.y - streamer.pos.y);
  
  // Check if phase ability has expired
  if (boss.phased && boss.phaseUntil && now > boss.phaseUntil) {
    boss.phased = false;
    boss.phaseUntil = undefined;
    ctx.broadcast("notice", { message: "Ghost Shadow Lord returns to reality!" });
  }
  
  // Handle boss states
  switch (boss.state) {
    case "spawning":
      if (now - boss.spawnTime > 2000) {
        boss.state = "idle";
      }
      break;
      
    case "idle":
      if (dist < 400) {
        boss.state = "chasing";
        boss.targetId = streamer.id;
      }
      break;
      
    case "chasing":
      if (dist > 600) {
        boss.state = "idle";
        boss.targetId = undefined;
      } else if (dist < boss.radius + 30) {
        boss.state = "attacking";
      }
      break;
      
    case "attacking":
      if (dist > boss.radius + 50) {
        boss.state = "chasing";
      }
      break;
  }

  // Movement AI - improved movement logic
  if (boss.state === "ability" && boss.type === "bruteKing" && boss.chargeUntil && now < boss.chargeUntil) {
    // Handle charge movement
    const config = ctx.cfg.bosses.types.bruteKing.abilities.charge;
    let chargeSpeed = config.speed;
    if (boss.enraged) {
      chargeSpeed *= ctx.cfg.bosses.types.bruteKing.abilities.enrage.speedMul;
    }
    
    // Ensure charge direction is set, otherwise default to current velocity or stop
    if (boss.chargeDirX !== undefined && boss.chargeDirY !== undefined) {
      boss.vel.x = boss.chargeDirX * chargeSpeed;
      boss.vel.y = boss.chargeDirY * chargeSpeed;
    } else {
      // If charge direction isn't set, revert to chasing state
      boss.state = "chasing";
      boss.chargeUntil = undefined;
    }
  } else if ((boss.state === "chasing" || boss.state === "attacking") && streamer) {
    // Normal chasing/attacking movement
    const dx = streamer.pos.x - boss.pos.x;
    const dy = streamer.pos.y - boss.pos.y;
    const len = Math.hypot(dx, dy) || 1;
    
    let speed = boss.speed;
    if (boss.enraged && boss.type === "bruteKing") {
      const config = ctx.cfg.bosses.types.bruteKing;
      speed *= config.abilities.enrage.speedMul;
    }
    
    // Only move if not too close (prevents jittering)
    if (len > boss.radius + ctx.cfg.radii.streamer + 5) {
      boss.vel.x = (dx / len) * speed;
      boss.vel.y = (dy / len) * speed;
    } else {
      // Slow down when very close
      boss.vel.x = (dx / len) * speed * 0.3;
      boss.vel.y = (dy / len) * speed * 0.3;
    }
  } else if (boss.state === "idle") {
    // Idle wandering movement
    if (!boss.wanderTarget || Math.hypot(boss.pos.x - boss.wanderTarget.x, boss.pos.y - boss.wanderTarget.y) < 20) {
      // Set new wander target
      boss.wanderTarget = {
        x: boss.pos.x + (Math.random() - 0.5) * 200,
        y: boss.pos.y + (Math.random() - 0.5) * 200
      };
      // Keep target in bounds
      boss.wanderTarget.x = Math.max(boss.radius, Math.min(ctx.W - boss.radius, boss.wanderTarget.x));
      boss.wanderTarget.y = Math.max(boss.radius, Math.min(ctx.H - boss.radius, boss.wanderTarget.y));
    }
    
    const dx = boss.wanderTarget.x - boss.pos.x;
    const dy = boss.wanderTarget.y - boss.pos.y;
    const len = Math.hypot(dx, dy) || 1;
    
    boss.vel.x = (dx / len) * boss.speed * 0.5; // Slower idle movement
    boss.vel.y = (dy / len) * boss.speed * 0.5;
  } else {
    boss.vel.x = 0;
    boss.vel.y = 0;
  }

  // Update position
  const dt = ctx.tickMs / 1000;
  boss.pos.x += boss.vel.x * dt;
  boss.pos.y += boss.vel.y * dt;

  // Keep boss in bounds
  boss.pos.x = Math.max(boss.radius, Math.min(ctx.W - boss.radius, boss.pos.x));
  boss.pos.y = Math.max(boss.radius, Math.min(ctx.H - boss.radius, boss.pos.y));

  // Handle abilities
  ctx.processBossAbilities(boss, now, streamer);

  // Handle contact damage with cooldown and range check
  if (boss.state === "attacking" && streamer && dist < boss.radius + ctx.cfg.radii.streamer + 10) {
    // Add damage cooldown to prevent hitting every tick and ensure close range
    // Also prevent damage while boss is phased
    if ((!boss.lastDamage || now - boss.lastDamage > 1000) && dist < 100 && !boss.phased) { // 1 second cooldown + max 100px range + not phased
      let damage = boss.damage;
      if (boss.enraged && boss.type === "bruteKing") {
        damage *= ctx.cfg.bosses.types.bruteKing.abilities.enrage.damageMul;
      }
      
      streamer.hp = Math.max(0, (streamer.hp ?? ctx.cfg.streamer.maxHp) - damage);
      ctx.trackDamageTaken(streamer, damage);
      ctx.addDamageNumber(streamer.pos.x, streamer.pos.y, damage, false, false);
      boss.lastDamage = now;
      
      // Knockback
      const kx = (streamer.pos.x - boss.pos.x) / (dist || 1);
      const ky = (streamer.pos.y - boss.pos.y) / (dist || 1);
      streamer.pos.x += kx * ctx.cfg.combat.knockbackStep * 2;
      streamer.pos.y += ky * ctx.cfg.combat.knockbackStep * 2;
    }
  }

  // Check for enrage condition (Brute King only)
  if (boss.type === "bruteKing" && !boss.enraged) {
    const hpPct = boss.hp / boss.maxHp;
    if (hpPct <= ctx.cfg.bosses.types.bruteKing.abilities.enrage.hpThreshold) {
      boss.enraged = true;
      ctx.broadcast("notice", { message: "Fire BRUTE KING ENRAGES! Speed and damage increased!" });
    }
  }

}

export function processBossAbilities(ctx: RoomDO, boss: Boss, now: number, streamer: Player) {
  const bossConfig = ctx.cfg.bosses.types[boss.type];
  
  // Process abilities based on boss type
  switch (boss.type) {
    case 'necromancer':
      const necroConfig = bossConfig as typeof ctx.cfg.bosses.types.necromancer;
      
      // Summon minions
      if (!boss.lastSummon || now - boss.lastSummon > necroConfig.abilities.summon.cooldownMs) {
        if (Math.random() < 0.3) {
          ctx.necromancerSummon(boss, now);
          boss.lastSummon = now;
        }
      }
      
      // Teleport
      if (!boss.lastTeleport || now - boss.lastTeleport > necroConfig.abilities.teleport.cooldownMs) {
        if (Math.random() < 0.2) {
          ctx.necromancerTeleport(boss, streamer);
          boss.lastTeleport = now;
        }
      }
      
      // Poison field
      if (!boss.lastPoisonField || now - boss.lastPoisonField > necroConfig.abilities.poisonField.cooldownMs) {
        if (Math.random() < 0.25) {
          ctx.necromancerPoisonField(boss, streamer, now);
          boss.lastPoisonField = now;
        }
      }
      break;
      
    case 'bruteKing':
      const bruteConfig = bossConfig as typeof ctx.cfg.bosses.types.bruteKing;
      
      // Check for enrage
      if (!boss.enraged && boss.hp <= boss.maxHp * bruteConfig.abilities.enrage.hpThreshold) {
        boss.enraged = true;
        boss.speed *= bruteConfig.abilities.enrage.speedMul;
        boss.damage *= bruteConfig.abilities.enrage.damageMul;
        ctx.broadcast("notice", { message: `Skull The ${boss.type} becomes enraged!` });
      }
      
      // Charge attack
      if (!boss.lastCharge || now - boss.lastCharge > bruteConfig.abilities.charge.cooldownMs) {
        if (Math.random() < 0.4) {
          ctx.bruteKingCharge(boss, streamer, now);
          boss.lastCharge = now;
        }
      }
      
      // Ground slam
      if (!boss.lastGroundSlam || now - boss.lastGroundSlam > bruteConfig.abilities.groundSlam.cooldownMs) {
        if (Math.random() < 0.3) {
          ctx.bruteKingGroundSlam(boss, streamer, now);
          boss.lastGroundSlam = now;
        }
      }
      break;
      
    case 'shadowLord':
      const shadowConfig = bossConfig as typeof ctx.cfg.bosses.types.shadowLord;
      
      // Phase ability
      if (!boss.lastPhase || now - boss.lastPhase > shadowConfig.abilities.phase.cooldownMs) {
        if (Math.random() < 0.2) {
          ctx.shadowLordPhase(boss, now);
          boss.lastPhase = now;
        }
      }
      
      // Shadow clones
      if (!boss.lastShadowClone || now - boss.lastShadowClone > shadowConfig.abilities.shadowClone.cooldownMs) {
        if (Math.random() < 0.25) {
          ctx.shadowLordClones(boss, now);
          boss.lastShadowClone = now;
        }
      }
      
      // Life drain
      if (!boss.lastLifeDrain || now - boss.lastLifeDrain > shadowConfig.abilities.lifeDrain.cooldownMs) {
        const drainRange = shadowConfig.abilities.lifeDrain.range;
        const distToStreamer = Math.hypot(boss.pos.x - streamer.pos.x, boss.pos.y - streamer.pos.y);

        if (distToStreamer <= drainRange && Math.random() < 0.3) {
          ctx.shadowLordLifeDrain(boss, streamer, now);
          boss.lastLifeDrain = now;
        }
      }
      break;
  }

}

export function necromancerSummon(ctx: RoomDO, boss: Boss, now: number) {
  const config = ctx.cfg.bosses.types.necromancer.abilities.summon;
  for (let i = 0; i < config.minionCount; i++) {
    const angle = (Math.PI * 2 * i) / config.minionCount;
    const spawnX = boss.pos.x + Math.cos(angle) * 60;
    const spawnY = boss.pos.y + Math.sin(angle) * 60;
    
    const minion: BossMinion = {
      id: crypto.randomUUID().slice(0, 8),
      bossId: boss.id,
      pos: { x: spawnX, y: spawnY },
      vel: { x: 0, y: 0 },
      hp: config.minionHp,
      maxHp: config.minionHp,
      state: "idle",
      lastSeen: now,
      spawnTime: now
    };
    
    ctx.bossMinions.push(minion);
    boss.minionIds = boss.minionIds || [];
    boss.minionIds.push(minion.id);
  }
  
  ctx.broadcast("notice", { message: "Skull Necromancer summons undead minions!" });

}

export function necromancerTeleport(ctx: RoomDO, boss: Boss, streamer: Player) {
  const config = ctx.cfg.bosses.types.necromancer.abilities.teleport;
  const angle = Math.random() * Math.PI * 2;
  const distance = 100 + Math.random() * (config.range - 100);
  
  const newX = streamer.pos.x + Math.cos(angle) * distance;
  const newY = streamer.pos.y + Math.sin(angle) * distance;
  
  boss.pos.x = Math.max(boss.radius, Math.min(ctx.W - boss.radius, newX));
  boss.pos.y = Math.max(boss.radius, Math.min(ctx.H - boss.radius, newY));
  
  ctx.broadcast("boss_teleport", { bossId: boss.id, pos: boss.pos });

}

export function necromancerPoisonField(ctx: RoomDO, boss: Boss, streamer: Player, now: number) {
  const config = ctx.cfg.bosses.types.necromancer.abilities.poisonField;
  
  const poisonField: PoisonField = {
    id: crypto.randomUUID().slice(0, 8),
    pos: { x: streamer.pos.x, y: streamer.pos.y },
    radius: config.radius,
    dps: config.dps,
    createdAt: now,
    expiresAt: now + config.durationMs,
    ownerId: boss.id
  };
  
  ctx.poisonFields.push(poisonField);
  ctx.broadcast("poison_field", { field: poisonField });

}

export function bruteKingCharge(ctx: RoomDO, boss: Boss, streamer: Player, now: number) {
  const config = ctx.cfg.bosses.types.bruteKing.abilities.charge;
  const dx = streamer.pos.x - boss.pos.x;
  const dy = streamer.pos.y - boss.pos.y;
  const len = Math.hypot(dx, dy) || 1;
  
  boss.chargeDirX = dx / len;
  boss.chargeDirY = dy / len;
  boss.chargeUntil = now + config.durationMs;
  boss.state = "ability";
  
  ctx.broadcast("notice", { message: "Shock Brute King charges forward!" });

}

export function bruteKingGroundSlam(ctx: RoomDO, boss: Boss, streamer: Player, now: number) {
  const config = ctx.cfg.bosses.types.bruteKing.abilities.groundSlam;
  const dist = Math.hypot(boss.pos.x - streamer.pos.x, boss.pos.y - streamer.pos.y);
  
  if (dist <= config.radius) {
    const damage = config.damage;
    streamer.hp = Math.max(0, (streamer.hp ?? ctx.cfg.streamer.maxHp) - damage);
    ctx.trackDamageTaken(streamer, damage);
    ctx.addDamageNumber(streamer.pos.x, streamer.pos.y, damage, false, false);
    
    // Stun effect
    (streamer as any).stunUntil = now + config.stunMs;
  }
  
  ctx.broadcast("ground_slam", { pos: boss.pos, radius: config.radius });
  ctx.broadcast("notice", { message: "Impact Ground slam creates shockwaves!" });

}

export function shadowLordPhase(ctx: RoomDO, boss: Boss, now: number) {
  const config = ctx.cfg.bosses.types.shadowLord.abilities.phase;
  boss.phased = true;
  boss.phaseUntil = now + config.durationMs;
  
  ctx.broadcast("notice", { message: "Ghost Shadow Lord phases out of reality!" });

}

export function shadowLordClones(ctx: RoomDO, boss: Boss, now: number) {
  const config = ctx.cfg.bosses.types.shadowLord.abilities.shadowClone;
  
  for (let i = 0; i < config.cloneCount; i++) {
    const angle = (Math.PI * 2 * i) / config.cloneCount;
    const spawnX = boss.pos.x + Math.cos(angle) * 80;
    const spawnY = boss.pos.y + Math.sin(angle) * 80;
    
    const clone: BossMinion = {
      id: crypto.randomUUID().slice(0, 8),
      bossId: boss.id,
      pos: { x: spawnX, y: spawnY },
      vel: { x: 0, y: 0 },
      hp: config.cloneHp,
      maxHp: config.cloneHp,
      state: "idle",
      lastSeen: now,
      spawnTime: now,
      expiresAt: now + config.durationMs
    };
    
    ctx.bossMinions.push(clone);
    boss.cloneIds = boss.cloneIds || [];
    boss.cloneIds.push(clone.id);
  }
  
  ctx.broadcast("notice", { message: "Moon Shadow clones emerge from the darkness!" });

}

export function shadowLordLifeDrain(ctx: RoomDO, boss: Boss, streamer: Player, now: number) {
  const config = ctx.cfg.bosses.types.shadowLord.abilities.lifeDrain;
  const damage = config.dps;
  const heal = Math.round(damage * config.healMul);

  const distance = Math.hypot(boss.pos.x - streamer.pos.x, boss.pos.y - streamer.pos.y);
  if (distance > config.range) {
    return;
  }

  streamer.hp = Math.max(0, (streamer.hp ?? ctx.cfg.streamer.maxHp) - damage);
  ctx.trackDamageTaken(streamer, damage);
  boss.hp = Math.min(boss.maxHp, boss.hp + heal);
  
  ctx.addDamageNumber(streamer.pos.x, streamer.pos.y, damage, false, true);
  ctx.addDamageNumber(boss.pos.x, boss.pos.y, -heal, false, false); // Negative for healing
  
  ctx.broadcast("life_drain", { from: boss.pos, to: streamer.pos });

}

export function updateBossMinions(ctx: RoomDO, now: number) {
  for (let i = ctx.bossMinions.length - 1; i >= 0; i--) {
    const minion = ctx.bossMinions[i];
    
    // Remove expired minions
    if (minion.expiresAt && now > minion.expiresAt) {
      ctx.bossMinions.splice(i, 1);
      continue;
    }
    
    // Remove minions whose boss is dead
    const boss = ctx.bosses.find(b => b.id === minion.bossId);
    if (!boss) {
      ctx.bossMinions.splice(i, 1);
      continue;
    }
    
    // Simple AI for minions
    const streamer = [...ctx.players.values()].find(p => p.role === "streamer" && p.alive);
    if (streamer) {
      const dist = Math.hypot(minion.pos.x - streamer.pos.x, minion.pos.y - streamer.pos.y);
      
      if (dist < 200) {
        minion.state = "chasing";
        minion.targetId = streamer.id;
        
        const dx = streamer.pos.x - minion.pos.x;
        const dy = streamer.pos.y - minion.pos.y;
        const len = Math.hypot(dx, dy) || 1;
        
        const speed = 80;
        minion.vel.x = (dx / len) * speed;
        minion.vel.y = (dy / len) * speed;
        
        // Update position
        const dt = ctx.tickMs / 1000;
        minion.pos.x += minion.vel.x * dt;
        minion.pos.y += minion.vel.y * dt;
        
        // Contact damage
        if (dist < 20) {
          const damage = 15;
          streamer.hp = Math.max(0, (streamer.hp ?? ctx.cfg.streamer.maxHp) - damage);
          ctx.trackDamageTaken(streamer, damage);
          ctx.addDamageNumber(streamer.pos.x, streamer.pos.y, damage, false, false);
        }
      }
    }
  }

}

export function updatePoisonFields(ctx: RoomDO, now: number) {
  for (let i = ctx.poisonFields.length - 1; i >= 0; i--) {
    const field = ctx.poisonFields[i];
    
    if (now > field.expiresAt) {
      ctx.poisonFields.splice(i, 1);
      continue;
    }
    
    // Damage streamer if in poison field
    const streamer = [...ctx.players.values()].find(p => p.role === "streamer" && p.alive);
    if (streamer) {
      const dist = Math.hypot(streamer.pos.x - field.pos.x, streamer.pos.y - field.pos.y);
      if (dist <= field.radius) {
        // Accumulate fractional damage to prevent rounding to 0
        field.accumulatedDamage = (field.accumulatedDamage || 0) + (field.dps * (ctx.tickMs / 1000));
        const damage = Math.floor(field.accumulatedDamage);
        if (damage > 0) {
          streamer.hp = Math.max(0, (streamer.hp ?? ctx.cfg.streamer.maxHp) - damage);
          ctx.trackDamageTaken(streamer, damage);
          ctx.addDamageNumber(streamer.pos.x, streamer.pos.y, damage, false, true);
          field.accumulatedDamage -= damage;
        }
      }
    }
  }

}

export function onBossDeath(ctx: RoomDO, boss: Boss) {
  // Generate loot drops
  ctx.generateBossLoot(boss);
  
  // Clean up minions and clones
  ctx.bossMinions = ctx.bossMinions.filter(m => m.bossId !== boss.id);
  
  // Broadcast death
  ctx.broadcast("boss_death", { bossId: boss.id, pos: boss.pos });
  ctx.broadcast("notice", { message: `Skull ${boss.type.toUpperCase()} has been defeated! Loot scattered!` });

}

export function generateBossLoot(ctx: RoomDO, boss: Boss) {
  const config = ctx.cfg.bosses.lootDrops;
  const dropCount = config.guaranteedDrops + 
    (Math.random() < config.bonusDropChance ? Math.floor(Math.random() * config.maxBonusDrops) : 0);
  
  for (let i = 0; i < dropCount; i++) {
    const angle = (Math.PI * 2 * i) / dropCount + Math.random() * 0.5;
    const distance = 30 + Math.random() * 60;
    const dropX = boss.pos.x + Math.cos(angle) * distance;
    const dropY = boss.pos.y + Math.sin(angle) * distance;
    
    let dropType: PickupType;
    
    // Boss drops: ammo, health, and treasures (no keys)
    const rand = Math.random();
    if (rand < 0.4) {
      // 40% chance for ammo
      dropType = "ammo";
    } else if (rand < 0.6) {
      // 20% chance for health
      dropType = "health";
    } else if (rand < 0.8) {
      // 20% chance for valuable treasures
      const valuableTreasures: PickupType[] = ["gem", "crystal", "orb", "relic", "artifact"];
      dropType = valuableTreasures[Math.floor(Math.random() * valuableTreasures.length)];
    } else {
      // 20% chance for special items
      const specialItems: PickupType[] = ["crown", "scroll"];
      dropType = specialItems[Math.floor(Math.random() * specialItems.length)];
    }
    
    ctx.pickups.push({
      id: crypto.randomUUID().slice(0, 6),
      type: dropType,
      x: Math.max(20, Math.min(ctx.W - 20, dropX)),
      y: Math.max(20, Math.min(ctx.H - 20, dropY))
    });
  }

  const streamer = [...ctx.players.values()].find(p => p.role === "streamer");
  const exclude = new Set<string>();
  if (streamer?.weapon) exclude.add(streamer.weapon);
  const weaponDrop = ctx.chooseWeapon(exclude);
  const wAngle = Math.random() * Math.PI * 2;
  const wRadius = 40 + Math.random() * 60;
  const wx = boss.pos.x + Math.cos(wAngle) * wRadius;
  const wy = boss.pos.y + Math.sin(wAngle) * wRadius;
  const initAmmo = (ctx.cfg.weapons.ammo.initial as any)[weaponDrop] ?? 0;
  ctx.spawnWeaponDrop(weaponDrop, wx, wy, initAmmo, 'boss');

}

export function publicBoss(ctx: RoomDO, boss: any) {
  const bossConfig = ctx.cfg.bosses.types[boss.type];
  return {
    id: boss.id,
    type: boss.type,
    pos: boss.pos,
    hp: boss.hp,
    maxHp: boss.maxHp,
    radius: boss.radius,
    state: boss.state,
    enraged: boss.enraged,
    phased: boss.phased,
    visual: bossConfig.visual,
    ...(boss.type === 'shadowLord'
      ? { lifeDrainRange: bossConfig.abilities.lifeDrain.range }
      : {})
  };

}
