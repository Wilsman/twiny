import {
  ModDef,
  ModHooks,
  ModId,
  Rarity,
  StatBlock,
  WeaponProcInstance,
  WeaponProcId,
} from "./types";

// XP pacing
export const XP_PER_KILL = 1;
export const XP_THRESHOLDS = (lvl: number) => 3 + Math.floor(lvl * 1.8); // small, fast roguelite loops

// Base stats and aggregation
export function baseStats(): StatBlock {
  return {
    damageMul: 1,
    fireRateMul: 1,
    projectileSpeedMul: 1,
    bulletSizeMul: 1,
    spreadMul: 1,
    knockbackMul: 1,
    critChance: 0,
    critMul: 1.5,
    pierce: 0,
    bounce: 0,
    ricochet: 0,
    split: 0,
    chain: 0,
    burnChance: 0,
    burnDps: 0,
    burnMs: 0,
    slowChance: 0,
    slowMul: 1,
    slowMs: 0,
    bleedChance: 0,
    bleedDps: 0,
    bleedMs: 0,
    reloadOnKillPct: 0,
    lifestealPct: 0,
    ammoEfficiencyMul: 1,
    magnetBonus: 0,
    dashReloadPct: 0,
    // New stats for advanced upgrades
    movementSpeedMul: 1,
    dashDistanceMul: 1,
    ghostWalkMs: 0,
    berserkerStacks: 0,
    vampireAuraRange: 0,
    timeDilationMs: 0,
    bulletTimeMs: 0,
    explosiveDeathDamage: 0,
    shieldRegenRate: 0,
  };
}

export function statsFor(p: any): {
  s: StatBlock;
  procs: WeaponProcInstance[];
} {
  const s = baseStats();
  const mods: Partial<Record<ModId, number>> = p?.mods || {};
  const procMap: Partial<Record<WeaponProcId, WeaponProcInstance>> = {};
  for (const [id, stacks] of Object.entries(mods) as [ModId, number][]) {
    const def = MOD_INDEX[id];
    if (def?.apply) def.apply(s, stacks);
    if (def?.weaponProcs && stacks > 0) {
      for (const grant of def.weaponProcs) {
        const existing = procMap[grant.id] || {
          id: grant.id,
          stacks: 0,
          chance: 0,
          potency: 0,
        };
        existing.stacks += stacks;
        if (grant.flatChance) existing.chance += grant.flatChance;
        if (grant.chancePerStack)
          existing.chance += grant.chancePerStack * stacks;
        if (grant.maxChance !== undefined)
          existing.chance = Math.min(existing.chance, grant.maxChance);
        if (grant.flatPotency) existing.potency += grant.flatPotency;
        if (grant.potencyPerStack)
          existing.potency += grant.potencyPerStack * stacks;
        procMap[grant.id] = existing;
      }
    }
  }
  const procs = Object.values(procMap).map((proc) => ({
    ...proc,
    chance: Math.max(0, Math.min(proc.chance, 1)),
    potency: Math.max(0, proc.potency),
  }));
  return { s, procs };
}

export function statusFrom(s: StatBlock) {
  const st: any = {};
  if (s.burnMs && s.burnDps && s.burnChance) {
    st.burnMs = s.burnMs;
    st.burnDps = s.burnDps;
    st.burnChance = s.burnChance;
  }
  if (s.slowMs && s.slowMul && s.slowChance) {
    st.slowMs = s.slowMs;
    st.slowMul = s.slowMul;
    st.slowChance = s.slowChance;
  }
  if (s.bleedMs && s.bleedDps && s.bleedChance) {
    st.bleedMs = s.bleedMs;
    st.bleedDps = s.bleedDps;
    st.bleedChance = s.bleedChance;
  }
  return Object.keys(st).length ? st : undefined;
}

// Upgrade catalog
export const MODS: ModDef[] = [
  {
    id: "damage_up",
    name: "+15% Damage",
    rarity: "common",
    desc: "All weapons deal 15% more damage.",
    apply: (s, k) => {
      s.damageMul *= Math.pow(1.15, k);
    },
  },
  {
    id: "firerate_up",
    name: "+20% Fire Rate",
    rarity: "common",
    desc: "Shoot faster.",
    apply: (s, k) => {
      s.fireRateMul *= Math.pow(1.2, k);
    },
  },
  {
    id: "bullet_size",
    name: "Bigger Bullets",
    rarity: "uncommon",
    desc: "+20% bullet size per stack.",
    apply: (s, k) => {
      s.bulletSizeMul *= Math.pow(1.2, k);
    },
  },
  {
    id: "spread_down",
    name: "Tighter Spread",
    rarity: "uncommon",
    desc: "-15% spread.",
    apply: (s, k) => {
      s.spreadMul *= Math.pow(0.85, k);
    },
  },
  {
    id: "pierce",
    name: "Piercing",
    rarity: "rare",
    desc: "+1 pierce per stack.",
    apply: (s, k) => {
      s.pierce += k;
    },
  },
  {
    id: "bounce",
    name: "Bouncy Bullets",
    rarity: "rare",
    desc: "+1 wall bounce.",
    apply: (s, k) => {
      s.bounce += k;
    },
  },
  {
    id: "crit_chance",
    name: "Criticals",
    rarity: "rare",
    desc: "+10% crit chance (+50% crit dmg).",
    apply: (s, k) => {
      s.critChance += 0.1 * k;
      s.critMul = Math.max(s.critMul, 1.5);
    },
  },
  {
    id: "crit_dmg",
    name: "Critical Damage",
    rarity: "rare",
    desc: "+50% crit damage.",
    apply: (s, k) => {
      s.critMul = Math.max(s.critMul, 1.5 + 0.5 * k);
    },
  },
  {
    id: "status_burn",
    name: "Incendiary",
    rarity: "rare",
    desc: "Bullets have 15% to ignite (12 DPS for 3s).",
    apply: (s, k) => {
      s.burnChance += 0.15 * k;
      s.burnDps = Math.max(s.burnDps, 12);
      s.burnMs = Math.max(s.burnMs, 3000);
    },
  },
  {
    id: "status_slow",
    name: "Cryo Rounds",
    rarity: "uncommon",
    desc: "15% chance to slow (40% for 2s).",
    apply: (s, k) => {
      s.slowChance += 0.15 * k;
      s.slowMul = Math.min(s.slowMul, 0.6);
      s.slowMs = Math.max(s.slowMs, 2000);
    },
  },
  {
    id: "lifesteal",
    name: "Lifesteal",
    rarity: "epic",
    desc: "Heal 2% of damage dealt.",
    apply: (s, k) => {
      s.lifestealPct += 0.02 * k;
    },
  },
  {
    id: "reload_on_kill",
    name: "Adrenaline",
    rarity: "epic",
    desc: "Refund 10% ammo on kill.",
    apply: (s, k) => {
      s.reloadOnKillPct += 0.1 * k;
    },
  },
  {
    id: "on_hit_explode",
    name: "Micro-grenades",
    rarity: "epic",
    desc: "Small explosion on hit.",
    hooks: {
      onHit: ({ room, bullet }) => {
        (room as any).spawnSmallExplosion?.(bullet);
      },
    },
  },
  {
    id: "chain_lightning",
    name: "Storm Chorus",
    rarity: "rare",
    desc: "On-hit chance to arc stormlight between foes.",
    weaponProcs: [
      {
        id: "arc_burst",
        flatChance: 0.06,
        chancePerStack: 0.04,
        maxChance: 0.45,
        flatPotency: 1,
        potencyPerStack: 0.75,
      },
    ],
  },
  {
    id: "void_hooks",
    name: "Umbral Net",
    rarity: "epic",
    desc: "Impact points lash nearby zombies toward the strike.",
    weaponProcs: [
      {
        id: "gravity_snare",
        flatChance: 0.05,
        chancePerStack: 0.03,
        maxChance: 0.35,
        flatPotency: 1,
        potencyPerStack: 0.6,
      },
    ],
  },
  {
    id: "volatile_payload",
    name: "Volatile Payload",
    rarity: "epic",
    desc: "Killing blows may detonate the target.",
    weaponProcs: [
      {
        id: "volatile_core",
        flatChance: 0.08,
        chancePerStack: 0.05,
        maxChance: 0.5,
        flatPotency: 1,
        potencyPerStack: 0.5,
      },
    ],
  },
  {
    id: "sanguine_cycle",
    name: "Sanguine Cycle",
    rarity: "uncommon",
    desc: "Chance to siphon a surge of health on hit.",
    weaponProcs: [
      {
        id: "siphon_bloom",
        flatChance: 0.1,
        chancePerStack: 0.06,
        maxChance: 0.55,
        flatPotency: 1,
        potencyPerStack: 0.45,
      },
    ],
  },
  {
    id: "shotgun_extra_pellet",
    name: "+Pellets",
    rarity: "uncommon",
    desc: "+1 shotgun pellet.",
    hooks: {
      onShoot: ({ bullets }) => {
        /* can be implemented to add an extra pellet where appropriate */
      },
    },
  },
  {
    id: "weapon_stability",
    name: "Weapon Stability",
    rarity: "common",
    desc: "Weapon spread −20%.",
    apply: (s, k) => {
      s.spreadMul *= Math.pow(0.8, k);
    },
  },
  {
    id: "weapon_precision",
    name: "Weapon Precision",
    rarity: "common",
    desc: "Weapon crit chance +15%.",
    apply: (s, k) => {
      s.critChance += 0.15 * k;
    },
  },
  {
    id: "dash_reload",
    name: "Combat Slide",
    rarity: "rare",
    desc: "Dashing reloads 20% ammo.",
    apply: (s, k) => {
      s.dashReloadPct += 0.2 * k;
    },
  },
  {
    id: "ammo_efficiency",
    name: "Ammo Saver",
    rarity: "uncommon",
    desc: "Shots cost 10% less ammo.",
    apply: (s, k) => {
      s.ammoEfficiencyMul *= Math.pow(0.9, k);
    },
  },
  {
    id: "magnet_radius",
    name: "Loot Vacuum",
    rarity: "common",
    desc: "+40px pickup radius UI hint.",
    apply: (s, k) => {
      s.magnetBonus += 40 * k;
    },
  },

  // New fun upgrades
  {
    id: "movement_speed",
    name: "Swift Feet",
    rarity: "common",
    desc: "+25% movement speed.",
    apply: (s, k) => {
      s.movementSpeedMul *= Math.pow(1.25, k);
    },
  },
  {
    id: "dash_distance",
    name: "Long Dash",
    rarity: "uncommon",
    desc: "+50% dash distance.",
    apply: (s, k) => {
      s.dashDistanceMul *= Math.pow(1.5, k);
    },
  },
  {
    id: "double_jump",
    name: "Air Walker",
    rarity: "rare",
    desc: "Dash resets on kill (simulates double jump).",
    hooks: {
      onKill: ({ room, killerId }) => {
        const p = (room as any).players?.get(killerId);
        if (p) p.lastDashAt = 0;
      },
    },
  },
  {
    id: "ghost_walk",
    name: "Phase Step",
    rarity: "epic",
    desc: "Brief invulnerability after dash (0.5s).",
    apply: (s, k) => {
      s.ghostWalkMs += 500 * k;
    },
  },
  {
    id: "berserker",
    name: "Berserker Rage",
    rarity: "rare",
    desc: "+10% damage per recent kill (max 5 stacks).",
    apply: (s, k) => {
      s.berserkerStacks += 5 * k;
    },
  },
  {
    id: "vampire_aura",
    name: "Blood Aura",
    rarity: "epic",
    desc: "Heal from nearby zombie deaths (+50px range).",
    apply: (s, k) => {
      s.vampireAuraRange += 50 * k;
    },
  },
  {
    id: "time_dilation",
    name: "Bullet Time",
    rarity: "legendary",
    desc: "Slow time on low health (2s duration).",
    apply: (s, k) => {
      s.timeDilationMs += 2000 * k;
    },
  },
  {
    id: "bullet_time",
    name: "Matrix Mode",
    rarity: "legendary",
    desc: "Slow projectiles when dashing (1s).",
    apply: (s, k) => {
      s.bulletTimeMs += 1000 * k;
    },
  },
  {
    id: "explosive_death",
    name: "Martyrdom",
    rarity: "rare",
    desc: "Explode on death dealing 50 damage.",
    apply: (s, k) => {
      s.explosiveDeathDamage += 50 * k;
    },
  },
  {
    id: "shield_regen",
    name: "Auto-Repair",
    rarity: "uncommon",
    desc: "Regenerate 1 HP every 3 seconds.",
    apply: (s, k) => {
      s.shieldRegenRate += k;
    },
  },
];

export const MOD_INDEX: Record<ModId, ModDef> = Object.fromEntries(
  MODS.map((m) => [m.id, m])
) as any;

// Rolling choices for offers
export function rollChoices(
  current: Partial<Record<ModId, number>>,
  rng: () => number
): ModDef[] {
  const weights: Record<Rarity, number> = {
    common: 70,
    uncommon: 22,
    rare: 6,
    epic: 1.8,
    legendary: 0.2,
  };
  const pool = MODS.map((m) => ({ m, w: weights[m.rarity] }));
  const picks: ModDef[] = [];
  for (let i = 0; i < 3; i++) {
    let total = pool.reduce((s, p) => s + p.w, 0);
    let r = rng() * total;
    let chosen: ModDef | null = null;
    for (const p of pool) {
      r -= p.w;
      if (r <= 0) {
        chosen = p.m;
        break;
      }
    }
    if (!chosen) chosen = pool[pool.length - 1].m;
    if (picks.some((x) => x.id === chosen!.id)) {
      i--;
      continue;
    }
    picks.push(chosen);
  }
  return picks;
}
