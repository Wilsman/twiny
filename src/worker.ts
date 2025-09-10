import { RoomDO } from "./room";

export interface Env {
  ROOMS: DurableObjectNamespace;
  TARKOV_NAMES: string;
}

export default {
  async fetch(req: Request, env: Env) {
    const url = new URL(req.url);

    // WebSocket upgrade routed to the Room Durable Object
    if (url.pathname.startsWith("/ws/") && req.headers.get("Upgrade") === "websocket") {
      const roomId = url.pathname.split("/").pop()!;
      const id = env.ROOMS.idFromName(roomId);
      const stub = env.ROOMS.get(id);
      return stub.fetch(req);
    }

    // Mint a new room id
    if (url.pathname === "/create" && req.method === "POST") {
      const roomId = crypto.randomUUID().slice(0, 6);
      return new Response(JSON.stringify({ roomId }), { headers: { "content-type": "application/json" } });
    }

    // Simple health
    if (url.pathname === "/health") return new Response("ok");

    return new Response("Not found", { status: 404 });
  },
};

// Required for binding discovery in some setups
export { RoomDO };
