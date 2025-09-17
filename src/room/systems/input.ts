import type { RoomDO } from '../index';
import type { Player, Input } from '../room-types';


export function processInputWithLagCompensation(ctx: RoomDO, player: Player, input: Input, timestamp: number) {
  const now = Date.now();
  
  // Calculate lag
  if (player.lastInputTime) {
    const timeDiff = now - player.lastInputTime;
    player.lagMs = Math.max(0, Math.min(500, timeDiff)); // Cap at 500ms
  }
  
  // Store input in buffer for potential rollback
  if (!player.inputBuffer) player.inputBuffer = [];
  player.inputBuffer.push({ input: { ...input }, timestamp });
  
  // Keep only recent inputs (1 second)
  const cutoff = now - 1000;
  player.inputBuffer = player.inputBuffer.filter(i => i.timestamp > cutoff);
  
  // Apply input immediately (server authoritative)
  player.input = input;
  player.lastInputTime = now;

}
