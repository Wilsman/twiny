import type { WeaponProcDef, WeaponProcId } from './types';

const clampChance = (value: number) => Math.max(0, Math.min(1, value));

export const WEAPON_PROCS: WeaponProcDef[] = [
  {
    id: 'arc_burst',
    name: 'Arc Burst',
    description: 'Chain a burst of stormlight between nearby foes.',
    cooldownMs: 250,
    events: {
      onHit: (ctx) => {
        if (!ctx?.room?.applyChainDamage) return;
        const potency = Math.max(0, ctx.instance.potency || 0);
        const chains = Math.max(1, Math.round(1 + potency));
        const baseDamage = ctx.bullet?.meta?.damage || 0;
        const damageScale = 0.45 + 0.12 * potency;
        const damage = Math.max(6, Math.round(baseDamage * damageScale));
        const impact = ctx.impact || { x: ctx.bullet.pos.x, y: ctx.bullet.pos.y };
        const exclude = ctx.targetId || '';
        ctx.room.applyChainDamage(ctx.bullet, impact, exclude, chains, damage);
      },
    },
  },
  {
    id: 'gravity_snare',
    name: 'Gravity Snare',
    description: 'A void tether tugs and slows nearby zombies.',
    cooldownMs: 300,
    events: {
      onHit: (ctx) => {
        const room = ctx.room;
        if (!room) return;
        const potency = Math.max(0, ctx.instance.potency || 0);
        const radius = 140 + 20 * potency;
        const slowMs = 900 + 180 * potency;
        const pullStrength = 0.16 + 0.04 * potency;
        const maxTargets = 3 + Math.floor(potency);
        const now = Date.now();
        const center = ctx.impact || { x: ctx.bullet.pos.x, y: ctx.bullet.pos.y };
        let affected = 0;

        const pullPlayerZombie = (z: any) => {
          if (!z || z.role !== 'zombie' || !z.alive) return;
          const dx = center.x - z.pos.x;
          const dy = center.y - z.pos.y;
          const dist = Math.hypot(dx, dy);
          if (dist > radius || dist === 0) return;
          const ratio = pullStrength * (1 - dist / radius);
          z.pos.x += dx * ratio;
          z.pos.y += dy * ratio;
          z.slowUntil = Math.max(z.slowUntil || 0, now + slowMs);
          z.slowMul = Math.min(z.slowMul ?? 1, 0.55);
          affected++;
        };

        const pullAIZombie = (z: any) => {
          if (!z) return;
          const dx = center.x - z.pos.x;
          const dy = center.y - z.pos.y;
          const dist = Math.hypot(dx, dy);
          if (dist > radius || dist === 0) return;
          const ratio = pullStrength * (1 - dist / radius);
          z.pos.x += dx * ratio;
          z.pos.y += dy * ratio;
          z.slowUntil = Math.max(z.slowUntil || 0, now + slowMs);
          z.slowMul = Math.min(z.slowMul ?? 1, 0.55);
          affected++;
        };

        for (const z of room.players?.values?.() || []) {
          if (affected >= maxTargets) break;
          pullPlayerZombie(z);
        }

        if (affected < maxTargets) {
          for (const z of room.aiZombies || []) {
            if (affected >= maxTargets) break;
            pullAIZombie(z);
          }
        }
      },
    },
  },
  {
    id: 'volatile_core',
    name: 'Volatile Core',
    description: 'Killing blows can rupture into a volatile nova.',
    cooldownMs: 300,
    events: {
      onKill: (ctx) => {
        if (!ctx?.room?.createExplosion) return;
        const potency = Math.max(0, ctx.instance.potency || 0);
        const center = ctx.impact || (ctx.bullet ? { x: ctx.bullet.pos.x, y: ctx.bullet.pos.y } : null);
        if (!center) return;
        const baseDamage = ctx.bullet?.meta?.damage || 0;
        const damageMul = 0.9 + 0.25 * potency;
        const damage = Math.max(10, Math.round(baseDamage * damageMul));
        const radius = 60 + 12 * potency;
        const ownerId = ctx.owner?.id || ctx.bullet?.ownerId || '';
        ctx.room.createExplosion(center.x, center.y, damage, radius, ownerId);
      },
    },
  },
  {
    id: 'siphon_bloom',
    name: 'Siphon Bloom',
    description: 'A blooming siphon heals the shooter beyond basic lifesteal.',
    cooldownMs: 150,
    events: {
      onHit: (ctx) => {
        const owner = ctx.owner;
        const room = ctx.room;
        if (!owner || owner.role !== 'streamer' || !room) return;
        const potency = Math.max(0, ctx.instance.potency || 0);
        const baseDamage = ctx.bullet?.meta?.damage || 0;
        const healAmount = Math.max(1, Math.round(baseDamage * (0.06 + 0.04 * potency)));
        const maxHp = owner.maxHp ?? room.cfg?.streamer?.maxHp ?? 100;
        owner.hp = Math.min(maxHp, (owner.hp ?? maxHp) + healAmount);
      },
    },
  },
];

export const WEAPON_PROC_INDEX: Record<WeaponProcId, WeaponProcDef> = Object.fromEntries(
  WEAPON_PROCS.map((proc) => [proc.id, proc])
) as Record<WeaponProcId, WeaponProcDef>;

export const clampProcChance = clampChance;
