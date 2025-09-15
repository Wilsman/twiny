import { ModDef, ModHooks, ModId, Rarity, StatBlock } from "./types";

// XP pacing
export const XP_PER_KILL = 1;
export const XP_THRESHOLDS = (lvl:number)=> 3 + Math.floor(lvl*1.8); // small, fast roguelite loops

// Base stats and aggregation
export function baseStats(): StatBlock {
  return {
    damageMul: 1, fireRateMul: 1, projectileSpeedMul: 1,
    bulletSizeMul: 1, spreadMul: 1, knockbackMul: 1,
    critChance: 0, critMul: 1.5,
    pierce: 0, bounce: 0, ricochet: 0, split: 0, chain: 0,
    burnChance:0,burnDps:0,burnMs:0, slowChance:0,slowMul:1,slowMs:0, bleedChance:0,bleedDps:0,bleedMs:0,
    reloadOnKillPct: 0, lifestealPct: 0, ammoEfficiencyMul: 1,
    magnetBonus: 0, dashReloadPct: 0,
  };
}

export function statsFor(p: any): { s: StatBlock } {
  const s = baseStats();
  const mods: Partial<Record<ModId, number>> = p?.mods || {};
  for (const [id, stacks] of Object.entries(mods) as [ModId, number][]) {
    const def = MOD_INDEX[id];
    if (def?.apply) def.apply(s, stacks);
  }
  return { s };
}

export function statusFrom(s: StatBlock) {
  const st: any = {};
  if (s.burnMs && s.burnDps && s.burnChance) { st.burnMs = s.burnMs; st.burnDps = s.burnDps; st.burnChance = s.burnChance; }
  if (s.slowMs && s.slowMul && s.slowChance) { st.slowMs = s.slowMs; st.slowMul = s.slowMul; st.slowChance = s.slowChance; }
  if (s.bleedMs && s.bleedDps && s.bleedChance) { st.bleedMs = s.bleedMs; st.bleedDps = s.bleedDps; st.bleedChance = s.bleedChance; }
  return Object.keys(st).length ? st : undefined;
}

// Upgrade catalog
export const MODS: ModDef[] = [
  { id:'damage_up', name:'+15% Damage', rarity:'common', desc:'All weapons deal 15% more damage.',
    apply:(s,k)=>{ s.damageMul *= Math.pow(1.15, k); } },
  { id:'firerate_up', name:'+20% Fire Rate', rarity:'common', desc:'Shoot faster.',
    apply:(s,k)=>{ s.fireRateMul *= Math.pow(1.2, k); } },
  { id:'bullet_size', name:'Bigger Bullets', rarity:'uncommon', desc:'+20% bullet size per stack.',
    apply:(s,k)=>{ s.bulletSizeMul *= Math.pow(1.2, k); } },
  { id:'spread_down', name:'Tighter Spread', rarity:'uncommon', desc:'-15% spread.',
    apply:(s,k)=>{ s.spreadMul *= Math.pow(0.85, k); } },
  { id:'pierce', name:'Piercing', rarity:'rare', desc:'+1 pierce per stack.',
    apply:(s,k)=>{ s.pierce += k; } },
  { id:'bounce', name:'Bouncy Bullets', rarity:'rare', desc:'+1 wall bounce.',
    apply:(s,k)=>{ s.bounce += k; } },
  { id:'crit_chance', name:'Criticals', rarity:'rare', desc:'+10% crit chance (+50% crit dmg).',
    apply:(s,k)=>{ s.critChance += 0.10*k; s.critMul = Math.max(s.critMul, 1.5); } },
  { id:'status_burn', name:'Incendiary', rarity:'rare', desc:'Bullets have 15% to ignite (12 DPS for 3s).',
    apply:(s,k)=>{ s.burnChance += 0.15*k; s.burnDps = Math.max(s.burnDps, 12); s.burnMs = Math.max(s.burnMs, 3000); } },
  { id:'status_slow', name:'Cryo Rounds', rarity:'uncommon', desc:'15% chance to slow (40% for 2s).',
    apply:(s,k)=>{ s.slowChance += 0.15*k; s.slowMul = Math.min(s.slowMul, 0.6); s.slowMs = Math.max(s.slowMs, 2000); } },
  { id:'lifesteal', name:'Lifesteal', rarity:'epic', desc:'Heal 2% of damage dealt.',
    apply:(s,k)=>{ s.lifestealPct += 0.02*k; } },
  { id:'reload_on_kill', name:'Adrenaline', rarity:'epic', desc:'Refund 10% ammo on kill.',
    apply:(s,k)=>{ s.reloadOnKillPct += 0.10*k; } },
  { id:'on_hit_explode', name:'Micro-grenades', rarity:'epic', desc:'Small explosion on hit.',
    hooks:{ onHit: ({room,bullet}) => { (room as any).spawnSmallExplosion?.(bullet); } } },
  { id:'shotgun_extra_pellet', name:'+Pellets', rarity:'uncommon', desc:'+1 shotgun pellet.',
    hooks:{ onShoot: ({bullets}) => { /* can be implemented to add an extra pellet where appropriate */ } } },
  { id:'smg_stability', name:'SMG Stability', rarity:'common', desc:'SMG spread −20%.',
    apply:(s,k)=>{ s.spreadMul *= Math.pow(0.8, k); } },
  { id:'pistol_precision', name:'Pistol Precision', rarity:'common', desc:'Pistol crit chance +15%.',
    apply:(s,k)=>{ s.critChance += 0.15*k; } },
  { id:'dash_reload', name:'Combat Slide', rarity:'rare', desc:'Dashing reloads 20% ammo.',
    apply:(s,k)=>{ s.dashReloadPct += 0.2*k; } },
  { id:'ammo_efficiency', name:'Ammo Saver', rarity:'uncommon', desc:'Shots cost 10% less ammo.',
    apply:(s,k)=>{ s.ammoEfficiencyMul *= Math.pow(0.9, k); } },
  { id:'magnet_radius', name:'Loot Vacuum', rarity:'common', desc:'+40px pickup radius UI hint.',
    apply:(s,k)=>{ s.magnetBonus += 40*k; } },
];

export const MOD_INDEX: Record<ModId, ModDef> = Object.fromEntries(MODS.map(m=>[m.id,m])) as any;

// Rolling choices for offers
export function rollChoices(current: Partial<Record<ModId,number>>, rng: () => number): ModDef[] {
  const weights: Record<Rarity, number> = { common: 70, uncommon: 22, rare: 6, epic: 1.8, legendary: 0.2 };
  const pool = MODS.map(m => ({ m, w: weights[m.rarity] }));
  const picks: ModDef[] = [];
  for (let i=0; i<3; i++){
    let total = pool.reduce((s,p)=> s+p.w, 0);
    let r = rng()*total;
    let chosen: ModDef | null = null;
    for (const p of pool) { r -= p.w; if (r<=0){ chosen = p.m; break; } }
    if (!chosen) chosen = pool[pool.length-1].m;
    if (picks.some(x=>x.id===chosen!.id)) { i--; continue; }
    picks.push(chosen);
  }
  return picks;
}
  
