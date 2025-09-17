import type { RoomDO } from '../index';
import { statsFor, rollChoices } from '../../upgrades';
import type { ModId } from '../../types';


export function processUpgradeEffects(ctx: RoomDO, now: number) {
  for (const p of ctx.players.values()) {
    if (p.role !== 'streamer' || !p.mods) continue;
    const { s } = statsFor(p);
    
    // Shield regeneration (auto-repair)
    if (s.shieldRegenRate > 0) {
      if (!p.lastShieldRegen || now - p.lastShieldRegen >= 3000) {
        if ((p.hp ?? 0) < (p.maxHp ?? ctx.cfg.streamer.maxHp)) {
          p.hp = Math.min((p.maxHp ?? ctx.cfg.streamer.maxHp), (p.hp ?? 0) + 1);
          p.lastShieldRegen = now;
        }
      }
    }
    
    // Time dilation (bullet time when low health)
    if (s.timeDilationMs > 0) {
      const healthPct = (p.hp || 0) / (p.maxHp || ctx.cfg.streamer.maxHp);
      if (healthPct <= 0.25 && !((p as any).timeDilationUntil > now)) {
        (p as any).timeDilationUntil = now + s.timeDilationMs;
        ctx.broadcast('notice', { message: 'Alarm Time slows as death approaches...' });
      }
    }
    
    // Bullet time during dash
    if (s.bulletTimeMs > 0 && (p.dashUntil || 0) > now) {
      (p as any).bulletTimeUntil = Math.max((p as any).bulletTimeUntil || 0, now + s.bulletTimeMs);
    }
  }

}

export function offerUpgrades(ctx: RoomDO, playerId: string) {
  const p = ctx.players.get(playerId);
  if (!p || p.role !== 'streamer') return;
  const choices = rollChoices(p.mods || {}, Math.random);
  try {
    p.ws?.send(JSON.stringify({
      type: 'upgrade_offer',
      level: p.level || 0,
      choices: choices.map(c => ({ id: c.id, name: c.name, desc: c.desc, rarity: c.rarity, currentStacks: (p.mods?.[c.id as keyof typeof p.mods] as number) || 0 }))
    }));
  } catch {}

}

export function applyUpgrade(ctx: RoomDO, playerId: string, id: ModId) {
  const p = ctx.players.get(playerId);
  if (!p || p.role !== 'streamer') return;
  p.mods = p.mods || {};
  const prev = (p.mods[id] || 0) as number;
  (p.mods as any)[id] = prev + 1;
  ctx.broadcast('notice', { message: `${p.name} chose ${String(id).replace(/_/g,' ')}` });

}
