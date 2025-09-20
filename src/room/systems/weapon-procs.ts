import type { RoomDO } from '../index';
import type { Player, Bullet } from '../room-types';
import type { BulletSpawnSpec, StatBlock, WeaponProcInstance } from '../../types';
import { WEAPON_PROC_INDEX } from '../../weapon-procs';
import type { WeaponProcDef } from '../../types';

const ensureCooldownMap = (owner: Player) => {
  const key = '_procCooldowns';
  const store = (owner as any)[key];
  if (store) return store as Record<string, number>;
  (owner as any)[key] = {};
  return (owner as any)[key] as Record<string, number>;
};

const computeTriggerCount = (owner: Player, def: WeaponProcDef, chance: number) => {
  if (!owner) return 0;
  const normalized = Math.max(0, chance);
  if (normalized <= 0) return 0;
  const cooldowns = ensureCooldownMap(owner);
  const now = Date.now();
  if (def.cooldownMs) {
    const readyAt = cooldowns[def.id] ?? 0;
    if (readyAt > now) return 0;
  }
  let triggers = 0;
  if (normalized >= 1) {
    triggers = Math.floor(normalized);
    const fractional = normalized - triggers;
    if (Math.random() < fractional) triggers += 1;
  } else if (Math.random() < normalized) {
    triggers = 1;
  }
  if (triggers > 0 && def.cooldownMs) {
    cooldowns[def.id] = now + def.cooldownMs;
  }
  return triggers;
};

const buildContextBase = (room: RoomDO, owner: Player, stats: StatBlock, instance: WeaponProcInstance) => ({
  room,
  owner,
  stats,
  instance,
});

export function triggerProcsOnShoot(
  room: RoomDO,
  owner: Player | undefined,
  weapon: string | undefined,
  bullets: BulletSpawnSpec[],
  stats: StatBlock | undefined,
  procs: WeaponProcInstance[] | undefined,
) {
  if (!owner || !stats || !procs?.length) return;
  for (const proc of procs) {
    const def = WEAPON_PROC_INDEX[proc.id];
    if (!def?.events?.onShoot) continue;
    const triggers = computeTriggerCount(owner, def, proc.chance);
    for (let i = 0; i < triggers; i++) {
      def.events.onShoot({
        ...buildContextBase(room, owner, stats, proc),
        weapon,
        bullets,
      });
    }
  }
}

export function triggerProcsOnHit(
  room: RoomDO,
  owner: Player | undefined,
  bullet: Bullet,
  stats: StatBlock | undefined,
  procs: WeaponProcInstance[] | undefined,
  details: {
    targetId?: string;
    targetType?: 'playerZombie' | 'aiZombie' | 'boss';
    killed?: boolean;
    impact: { x: number; y: number };
  },
) {
  if (!owner || !stats || !procs?.length) return;
  for (const proc of procs) {
    const def = WEAPON_PROC_INDEX[proc.id];
    if (!def?.events?.onHit) continue;
    const triggers = computeTriggerCount(owner, def, proc.chance);
    for (let i = 0; i < triggers; i++) {
      def.events.onHit({
        ...buildContextBase(room, owner, stats, proc),
        bullet,
        targetId: details.targetId,
        targetType: details.targetType,
        killed: details.killed,
        impact: details.impact,
      });
    }
  }
}

export function triggerProcsOnKill(
  room: RoomDO,
  owner: Player | undefined,
  bullet: Bullet | undefined,
  stats: StatBlock | undefined,
  procs: WeaponProcInstance[] | undefined,
  details: {
    victimId: string;
    targetType?: 'playerZombie' | 'aiZombie' | 'boss';
    impact: { x: number; y: number };
  },
) {
  if (!owner || !stats || !procs?.length) return;
  for (const proc of procs) {
    const def = WEAPON_PROC_INDEX[proc.id];
    if (!def?.events?.onKill) continue;
    const triggers = computeTriggerCount(owner, def, proc.chance);
    for (let i = 0; i < triggers; i++) {
      def.events.onKill({
        ...buildContextBase(room, owner, stats, proc),
        victimId: details.victimId,
        bullet,
        targetType: details.targetType,
        impact: details.impact,
      });
    }
  }
}
