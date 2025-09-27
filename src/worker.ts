import { RoomDO } from "./room";

export interface Env {
  ROOMS: DurableObjectNamespace;
  TARKOV_NAMES: string;
}

declare global {
  interface DurableObjectNamespace {
    idFromName(name: string): DurableObjectId;
    get(id: DurableObjectId): DurableObjectStub;
  }
  
  interface DurableObjectId {}
  
  interface DurableObjectStub {
    fetch(request: Request): Promise<Response>;
  }
}

export default {
  async fetch(req: Request, env: Env) {
    const url = new URL(req.url);

    // Return current default config (for UI/editor)
    if (url.pathname === "/config" && req.method === "GET") {
      // Lazy import to avoid side-effects on module load
      const { CONFIG } = await import("./config");
      return new Response(JSON.stringify(CONFIG), { headers: { "content-type": "application/json" } });
    }

    // WebSocket upgrade routed to the Room Durable Object
    if (url.pathname.startsWith("/ws/") && req.headers.get("Upgrade") === "websocket") {
      const roomId = url.pathname.split("/").pop()!;
      const id = env.ROOMS.idFromName(roomId);
      const stub = env.ROOMS.get(id);
      return stub.fetch(req);
    }

    // Helper function to create a new room
    const createNewRoom = async (req: Request) => {
      let overrides: any = undefined;
      try {
        const ct = req.headers.get('content-type') || '';
        if (ct.includes('application/json')) {
          const body = await req.json().catch(() => ({}));
          if (body && typeof body === 'object') overrides = body.overrides || body.config || undefined;
        }
      } catch {}

      const region = getRegionFromRequest(req);
      const roomId = `${region}-${crypto.randomUUID().slice(0, 6)}`;

      // If overrides provided, initialize the DO instance with them before returning
      if (overrides && typeof overrides === 'object') {
        try {
          const id = env.ROOMS.idFromName(roomId);
          const stub = env.ROOMS.get(id);
          await stub.fetch(new Request(`https://do/${roomId}/setup`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ overrides })
          }));
        } catch {}
      }
      return roomId;
    };

    // Mint a new room id with regional hint (API endpoint)
    if (url.pathname === "/create" && req.method === "POST") {
      const roomId = await createNewRoom(req);
      return new Response(JSON.stringify({ roomId }), { headers: { "content-type": "application/json" } });
    }

    // Upgrades API endpoint
    if (url.pathname === "/upgrades") {
      const { MODS } = await import("./upgrades");
      // Return only the data needed for the client
      const clientMods = MODS.map(mod => ({
        id: mod.id,
        name: mod.name,
        rarity: mod.rarity,
        desc: mod.desc,
        maxStacks: mod.maxStacks
      }));
      return Response.json(clientMods);
    }

    return new Response("Not found", { status: 404 });
  },
};

// Get region hint from CF headers or fallback
function getRegionFromRequest(req: Request): string {
  // Cloudflare provides colo (data center) in CF-Ray header
  const cfRay = req.headers.get('CF-Ray');
  if (cfRay) {
    const colo = cfRay.split('-')[1];
    if (colo) {
      // Map some common colos to regions
      const regionMap: Record<string, string> = {
        'LAX': 'us-west', 'SFO': 'us-west', 'SEA': 'us-west',
        'DFW': 'us-central', 'ORD': 'us-central', 'ATL': 'us-central',
        'IAD': 'us-east', 'EWR': 'us-east', 'MIA': 'us-east',
        'LHR': 'eu-west', 'CDG': 'eu-west', 'AMS': 'eu-west',
        'FRA': 'eu-central', 'WAW': 'eu-central',
        'NRT': 'asia-east', 'ICN': 'asia-east', 'HKG': 'asia-east',
        'SIN': 'asia-south', 'BOM': 'asia-south'
      };
      return regionMap[colo] || 'global';
    }
  }
  
  // Fallback to CF-IPCountry header
  const country = req.headers.get('CF-IPCountry');
  if (country) {
    const countryToRegion: Record<string, string> = {
      'US': 'us-central', 'CA': 'us-central',
      'GB': 'eu-west', 'DE': 'eu-central', 'FR': 'eu-west', 'NL': 'eu-west',
      'JP': 'asia-east', 'KR': 'asia-east', 'CN': 'asia-east',
      'SG': 'asia-south', 'IN': 'asia-south', 'AU': 'asia-south'
    };
    return countryToRegion[country] || 'global';
  }
  
  return 'global';
}

export { RoomDO };
