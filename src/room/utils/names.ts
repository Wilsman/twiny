import type { RoomDO } from '../index';

export function sanitizeName(ctx: RoomDO, n: string) {
  if (!n) return "";
  const ok = n.replace(/[^a-zA-Z0-9 _-]/g, "").slice(0, 20);
  return ok.trim();

}

export function randomName(ctx: RoomDO) {
  const list = (ctx.env.TARKOV_NAMES || "").split(",").map(s => s.trim()).filter(Boolean);
  return list[Math.floor(Math.random() * list.length)] || "FactoryGhost";

}
