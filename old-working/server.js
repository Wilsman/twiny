import express from "express";
import http from "http";
import { Server } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve static files from /public
app.use(express.static(path.join(__dirname, "public")));

io.on("connection", (socket) => {
  console.log("player connected:", socket.id);

  // Tell the new client its id
  socket.emit("welcome", { id: socket.id });

  // Let others know a player joined
  socket.broadcast.emit("player:join", { id: socket.id });

  // Relay movement to everyone else
  socket.on("player:move", (pos) => {
    // pos: { x, y }
    socket.broadcast.emit("player:move", { id: socket.id, ...pos });
  });

  socket.on("disconnect", () => {
    console.log("player disconnected:", socket.id);
    socket.broadcast.emit("player:leave", { id: socket.id });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`➡️  Open http://localhost:${PORT}`));

