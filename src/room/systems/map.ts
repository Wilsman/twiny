import type { RoomDO } from '../index';

export function generateTileMapAndWalls(ctx: RoomDO) {
  const size = ctx.cfg.tiles.size;
  const gw = Math.max(10, Math.floor(ctx.W / size));
  const gh = Math.max(8, Math.floor(ctx.H / size));
  const theme: 'dungeon'|'cave'|'lab' = ctx.cfg.tiles.theme || 'dungeon';
  const tiles = new Uint8Array(gw*gh);
  // Fill with walls (1)
  tiles.fill(1);
  // Carve simple BSP-like rooms and corridors
  const rooms: {x:number;y:number;w:number;h:number}[] = [];
  const carveRoom = (x:number,y:number,w:number,h:number)=>{
    for (let j=y; j<y+h; j++) for (let i=x; i<x+w; i++) if (i>0&&i<gw-1&&j>0&&j<gh-1) tiles[j*gw+i]=0;
    rooms.push({x,y,w,h});
  };
  // Generate many more rooms using grid-based layout
  const gridCellsX = Math.floor(gw / 20); // Cells of ~20 tiles each
  const gridCellsY = Math.floor(gh / 15);
  const cellWidth = Math.floor(gw / gridCellsX);
  const cellHeight = Math.floor(gh / gridCellsY);
  
  // Room types for variety
  const roomTypes = ['small', 'medium', 'large', 'hall', 'chamber', 'vault'];
  
  for (let gy = 0; gy < gridCellsY; gy++) {
    for (let gx = 0; gx < gridCellsX; gx++) {
      // 70% chance to place a room in each grid cell
      if (Math.random() < 0.7) {
        const baseX = gx * cellWidth;
        const baseY = gy * cellHeight;
        const roomType = roomTypes[Math.floor(Math.random() * roomTypes.length)];
        
        let rw, rh;
        switch(roomType) {
          case 'small':
            rw = 5 + Math.floor(Math.random() * 4); // 5-8
            rh = 4 + Math.floor(Math.random() * 3); // 4-6
            break;
          case 'medium':
            rw = 8 + Math.floor(Math.random() * 5); // 8-12
            rh = 6 + Math.floor(Math.random() * 4); // 6-9
            break;
          case 'large':
            rw = 12 + Math.floor(Math.random() * 6); // 12-17
            rh = 8 + Math.floor(Math.random() * 5); // 8-12
            break;
          case 'hall':
            rw = 15 + Math.floor(Math.random() * 8); // 15-22 (long halls)
            rh = 4 + Math.floor(Math.random() * 2); // 4-5 (narrow)
            break;
          case 'chamber':
            rw = 10 + Math.floor(Math.random() * 4); // 10-13 (square-ish)
            rh = 9 + Math.floor(Math.random() * 4); // 9-12
            break;
          case 'vault':
            rw = 6 + Math.floor(Math.random() * 3); // 6-8 (small but important)
            rh = 5 + Math.floor(Math.random() * 2); // 5-6
            break;
          default:
            rw = 8 + Math.floor(Math.random() * 4);
            rh = 6 + Math.floor(Math.random() * 3);
        }
        
        // Ensure room fits in grid cell with margin
        rw = Math.min(rw, cellWidth - 2);
        rh = Math.min(rh, cellHeight - 2);
        
        const rx = baseX + 1 + Math.floor(Math.random() * Math.max(1, cellWidth - rw - 2));
        const ry = baseY + 1 + Math.floor(Math.random() * Math.max(1, cellHeight - rh - 2));
        
        // Ensure room is within bounds
        if (rx + rw < gw - 1 && ry + rh < gh - 1) {
          carveRoom(rx, ry, rw, rh);
        }
      }
    }
  }
  // Create extensive corridor network to connect rooms
  // First, connect adjacent rooms in grid for guaranteed connectivity
  for (let gy = 0; gy < gridCellsY; gy++) {
    for (let gx = 0; gx < gridCellsX; gx++) {
      const currentRooms = rooms.filter(r => 
        r.x >= gx * cellWidth && r.x < (gx + 1) * cellWidth &&
        r.y >= gy * cellHeight && r.y < (gy + 1) * cellHeight
      );
      
      if (currentRooms.length === 0) continue;
      const currentRoom = currentRooms[0];
      
      // Connect to right neighbor
      if (gx < gridCellsX - 1) {
        const rightRooms = rooms.filter(r => 
          r.x >= (gx + 1) * cellWidth && r.x < (gx + 2) * cellWidth &&
          r.y >= gy * cellHeight && r.y < (gy + 1) * cellHeight
        );
        
        if (rightRooms.length > 0) {
          const rightRoom = rightRooms[0];
          const corridorY = Math.floor((currentRoom.y + currentRoom.h/2 + rightRoom.y + rightRoom.h/2) / 2);
          const corridorWidth = 2 + Math.floor(Math.random() * 2);
          
          for (let offset = -Math.floor(corridorWidth/2); offset <= Math.floor(corridorWidth/2); offset++) {
            const cy = corridorY + offset;
            if (cy > 0 && cy < gh - 1) {
              for (let cx = currentRoom.x + currentRoom.w; cx < rightRoom.x; cx++) {
                if (cx > 0 && cx < gw - 1) tiles[cy * gw + cx] = 0;
              }
            }
          }
        }
      }
      
      // Connect to bottom neighbor
      if (gy < gridCellsY - 1) {
        const bottomRooms = rooms.filter(r => 
          r.x >= gx * cellWidth && r.x < (gx + 1) * cellWidth &&
          r.y >= (gy + 1) * cellHeight && r.y < (gy + 2) * cellHeight
        );
        
        if (bottomRooms.length > 0) {
          const bottomRoom = bottomRooms[0];
          const corridorX = Math.floor((currentRoom.x + currentRoom.w/2 + bottomRoom.x + bottomRoom.w/2) / 2);
          const corridorWidth = 2 + Math.floor(Math.random() * 2);
          
          for (let offset = -Math.floor(corridorWidth/2); offset <= Math.floor(corridorWidth/2); offset++) {
            const cx = corridorX + offset;
            if (cx > 0 && cx < gw - 1) {
              for (let cy = currentRoom.y + currentRoom.h; cy < bottomRoom.y; cy++) {
                if (cy > 0 && cy < gh - 1) tiles[cy * gw + cx] = 0;
              }
            }
          }
        }
      }
    }
  }
  
  // Add random long-distance connections for shortcuts and loops
  const numLongConnections = Math.floor(rooms.length * 0.15); // 15% of rooms get long connections
  for (let i = 0; i < numLongConnections; i++) {
    const roomA = rooms[Math.floor(Math.random() * rooms.length)];
    const roomB = rooms[Math.floor(Math.random() * rooms.length)];
    
    if (roomA === roomB) continue;
    
    const ax = Math.floor(roomA.x + roomA.w/2);
    const ay = Math.floor(roomA.y + roomA.h/2);
    const bx = Math.floor(roomB.x + roomB.w/2);
    const by = Math.floor(roomB.y + roomB.h/2);
    
    // Create L-shaped corridor
    const corridorWidth = 2;
    
    // Horizontal segment
    const minx = Math.min(ax, bx);
    const maxx = Math.max(ax, bx);
    for (let offset = -Math.floor(corridorWidth/2); offset <= Math.floor(corridorWidth/2); offset++) {
      const cy = ay + offset;
      if (cy > 0 && cy < gh - 1) {
        for (let cx = minx; cx <= maxx; cx++) {
          if (cx > 0 && cx < gw - 1) tiles[cy * gw + cx] = 0;
        }
      }
    }
    
    // Vertical segment
    const miny = Math.min(ay, by);
    const maxy = Math.max(ay, by);
    for (let offset = -Math.floor(corridorWidth/2); offset <= Math.floor(corridorWidth/2); offset++) {
      const cx = bx + offset;
      if (cx > 0 && cx < gw - 1) {
        for (let cy = miny; cy <= maxy; cy++) {
          if (cy > 0 && cy < gh - 1) tiles[cy * gw + cx] = 0;
        }
      }
    }
  }
  
  // Add environmental variety
  // Water/sludge areas (slow movement) - configurable frequency
  const numWaterAreas = Math.floor(rooms.length * ctx.cfg.tiles.traps.waterFrequency);
  for (let i = 0; i < numWaterAreas; i++) {
    const wx = 3 + Math.floor(Math.random() * (gw - 10));
    const wy = 3 + Math.floor(Math.random() * (gh - 8));
    const ww = 3 + Math.floor(Math.random() * 6);
    const wh = 2 + Math.floor(Math.random() * 5);
    
    for (let j = wy; j < wy + wh && j < gh - 1; j++) {
      for (let i = wx; i < wx + ww && i < gw - 1; i++) {
        if (tiles[j * gw + i] === 0) { // Only replace floor tiles
          tiles[j * gw + i] = 3; // Water/sludge
        }
      }
    }
  }
  
  // Pit traps (lethal) - configurable frequency
  const numPits = Math.floor(rooms.length * ctx.cfg.tiles.traps.pitFrequency);
  for (let i = 0; i < numPits; i++) {
    const px = 2 + Math.floor(Math.random() * (gw - 6));
    const py = 2 + Math.floor(Math.random() * (gh - 6));
    
    if (tiles[py * gw + px] === 0) {
      tiles[py * gw + px] = 2; // Pit
      // Sometimes create larger pit areas
      if (Math.random() < 0.4) {
        const pitSize = 1 + Math.floor(Math.random() * 2);
        for (let dy = 0; dy <= pitSize && py + dy < gh - 1; dy++) {
          for (let dx = 0; dx <= pitSize && px + dx < gw - 1; dx++) {
            if (tiles[(py + dy) * gw + (px + dx)] === 0) {
              tiles[(py + dy) * gw + (px + dx)] = 2;
            }
          }
        }
      }
    }
  }
  // Spike traps (damage over time) - configurable frequency
  const numSpikeTraps = Math.floor(rooms.length * ctx.cfg.tiles.traps.spikeFrequency);
  for (let i = 0; i < numSpikeTraps; i++) {
    const sx = 2 + Math.floor(Math.random() * (gw - 6));
    const sy = 2 + Math.floor(Math.random() * (gh - 6));
    
    if (tiles[sy * gw + sx] === 0) {
      tiles[sy * gw + sx] = 6; // Spikes
      // Sometimes create spike clusters
      if (Math.random() < 0.3) {
        const spikeSize = 1 + Math.floor(Math.random() * 2);
        for (let dy = 0; dy <= spikeSize && sy + dy < gh - 1; dy++) {
          for (let dx = 0; dx <= spikeSize && sx + dx < gw - 1; dx++) {
            if (tiles[(sy + dy) * gw + (sx + dx)] === 0) {
              tiles[(sy + dy) * gw + (sx + dx)] = 6;
            }
          }
        }
      }
    }
  }
  // Poison pools (damage and slow) - configurable frequency
  const numPoisonPools = Math.floor(rooms.length * ctx.cfg.tiles.traps.poisonFrequency);
  for (let i = 0; i < numPoisonPools; i++) {
    const px = 3 + Math.floor(Math.random() * (gw - 10));
    const py = 3 + Math.floor(Math.random() * (gh - 8));
    const pw = 2 + Math.floor(Math.random() * 4);
    const ph = 2 + Math.floor(Math.random() * 3);
    
    for (let j = py; j < py + ph && j < gh - 1; j++) {
      for (let i = px; i < px + pw && i < gw - 1; i++) {
        if (tiles[j * gw + i] === 0) { // Only replace floor tiles
          tiles[j * gw + i] = 7; // Poison
        }
      }
    }
  }
  
  // Add border walls kept
  // Props/Lights - Scale with map size for immersive exploration
  const props: {x:number;y:number;type:'crate'|'pillar'|'bonepile'}[] = [];
  const lights: {x:number;y:number;r:number;a:number}[] = [];
  
  // Scale props with map size - aim for 1 prop per ~300 tiles
  const numProps = Math.floor((gw * gh) / 300);
  for (let k = 0; k < numProps; k++){
    props.push({ 
      x: 2 + Math.floor(Math.random() * (gw - 4)), 
      y: 2 + Math.floor(Math.random() * (gh - 4)), 
      type: (['crate','pillar','bonepile'] as const)[Math.floor(Math.random() * 3)] 
    });
  }
  
  // Scale lights with map size - more atmospheric lighting for exploration
  const numLights = Math.floor((gw * gh) / 500);
  for (let k = 0; k < numLights; k++){
    lights.push({ 
      x: 2 + Math.floor(Math.random() * (gw - 4)), 
      y: 2 + Math.floor(Math.random() * (gh - 4)), 
      r: 3 + Math.floor(Math.random() * 8), 
      a: 0.08 + Math.random() * 0.25 
    });
  }
  ctx.map = { w: gw, h: gh, size, theme, tiles, props, lights, rooms };
  // Derive collision rects from wall tiles via greedy merge
  ctx.walls = ctx.greedyRectsFromTiles(tiles, gw, gh, size);
  ctx.mapReady = true;

}

export function spawnInRandomRoom(ctx: RoomDO) {
  // Spawn within a random room
  if (!ctx.map || ctx.map.rooms.length === 0) {
    // Fallback to center if no rooms available
    return { x: ctx.W / 2, y: ctx.H / 2 };
  }
  
  const room = ctx.map.rooms[Math.floor(Math.random() * ctx.map.rooms.length)];
  const tileSize = ctx.map.size;
  
  // Convert room coordinates to world coordinates and add some padding
  const padding = tileSize * 0.5; // Half tile padding from walls
  const worldX = (room.x + 1) * tileSize + padding + Math.random() * ((room.w - 2) * tileSize - padding * 2);
  const worldY = (room.y + 1) * tileSize + padding + Math.random() * ((room.h - 2) * tileSize - padding * 2);
  
  return { x: worldX, y: worldY };

}

export function spawnZombiePos(ctx: RoomDO) {
  return ctx.spawnInRandomRoom();

}

export function randomFreePos(ctx: RoomDO, buffer = 24) {
  for (let tries = 0; tries < 40; tries++) {
    const x = buffer + Math.random() * (ctx.W - buffer * 2);
    const y = buffer + Math.random() * (ctx.H - buffer * 2);
    // Not too close to center spawn
    if (Math.hypot(x - ctx.W/2, y - ctx.H/2) < 60) continue;
    let ok = true;
    for (const rct of ctx.walls) {
      const margin = 18;
      if (x > rct.x - margin && x < rct.x + rct.w + margin && y > rct.y - margin && y < rct.y + rct.h + margin) { ok = false; break; }
    }
    if (!ok) continue;
    return { x, y };
  }
  return null;

}
