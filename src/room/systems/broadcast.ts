import type { RoomDO } from '../index';

export function broadcastState(ctx: RoomDO) {
  // Clean up old damage numbers (older than 1 second to prevent duplicates)
  const now = Date.now();
  ctx.damageNumbers = ctx.damageNumbers.filter(dn => now - dn.timestamp < 1000);

  const snapshot = {
    type: "state",
    t: Date.now(),
    players: [...ctx.players.values()].map(ctx.publicPlayer),
    bullets: ctx.bullets.map(b => ({
      id: b.id,
      x: b.pos.x,
      y: b.pos.y,
      ownerId: b.ownerId,
      visual: b.visual ? { ...b.visual } : undefined,
    })),
    globs: ctx.spittles.map(g => ({ id: g.id, x: g.pos.x, y: g.pos.y })),
    walls: ctx.walls.map(o => ({ id: o.id, x: o.x, y: o.y, w: o.w, h: o.h })),
    pickups: ctx.pickups.map(pk => ({ id: pk.id, type: pk.type, x: pk.x, y: pk.y })),
    weaponDrops: ctx.weaponDrops.map(w => ({ id: w.id, weapon: w.weapon, ammo: w.ammo, x: w.x, y: w.y, source: w.source })),
          aiZombies: ctx.aiZombies.map(z => ({ 
      id: z.id, 
      x: z.pos.x, 
      y: z.pos.y, 
      hp: z.hp, 
      maxHp: z.maxHp, 
      zClass: z.zClass, 
      state: z.state,
      detectionRange: z.detectionRange,
      chaseRange: z.chaseRange
    })),
    damageNumbers: ctx.damageNumbers.map(dn => ({
      id: dn.id,
      x: dn.x,
      y: dn.y,
      damage: dn.damage,
      isCrit: dn.isCrit,
      isDot: dn.isDot,
      timestamp: dn.timestamp
    })),
    bosses: ctx.bosses.map(boss => ctx.publicBoss(boss)),
    bossMinions: ctx.bossMinions.map(minion => ({
      id: minion.id,
      bossId: minion.bossId,
      pos: minion.pos,
      hp: minion.hp,
      maxHp: minion.maxHp,
      state: minion.state
    })),
    poisonFields: ctx.poisonFields.map(field => ({
      id: field.id,
      pos: field.pos,
      radius: field.radius,
      dps: field.dps,
      expiresAt: field.expiresAt
    })),
    arena: { w: ctx.W, h: ctx.H },
    remainingTime: Math.max(0, Math.floor(((ctx.roundEndTime || Date.now()) - Date.now()) / 1000)),
    chatEnabled: ctx.chatEnabled,
    roundActive: ctx.roundActive,
  };
  const msg = JSON.stringify(snapshot);
  for (const p of ctx.players.values()) {
    if (!p.ws) continue;
    try { p.ws.send(msg); } catch {}
  }

}
