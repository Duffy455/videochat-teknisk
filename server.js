import express from "express";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const port = Number(process.env.PORT || 8080);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const rooms = new Map();

const defaultMatchState = () => ({
  countdown: 30,
  phase: "idle",
  winner: null,
  preselectedWinner: null,
  updatedAt: Date.now(),
});

app.use(express.static(__dirname));

app.get("/", (_req, res) => {
  res.redirect("/video-join.html");
});

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      participants: new Map(),
      matchClients: new Set(),
      matchState: defaultMatchState(),
      countdownTimer: null,
    });
  }

  return rooms.get(roomId);
}

function listParticipants(room) {
  return Array.from(room.participants.entries()).map(([peerId, participant]) => ({
    peerId,
    role: participant.role,
    side: participant.side,
    joinedAt: participant.joinedAt,
  }));
}

function sendJson(socket, payload) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function broadcastParticipants(roomId) {
  const room = rooms.get(roomId);
  if (!room) {
    return;
  }

  const participants = listParticipants(room);
  room.participants.forEach((participant) => {
    sendJson(participant.socket, {
      type: "participants-update",
      participants,
    });
  });
}

function broadcastMatchState(roomId) {
  const room = rooms.get(roomId);
  if (!room) {
    return;
  }

  const payload = {
    type: "match-state",
    state: room.matchState,
  };

  room.matchClients.forEach((socket) => sendJson(socket, payload));
}

function clearCountdown(room) {
  if (room.countdownTimer) {
    clearInterval(room.countdownTimer);
    room.countdownTimer = null;
  }
}

function writeMatchState(roomId, patch) {
  const room = getRoom(roomId);
  room.matchState = {
    ...room.matchState,
    ...patch,
    updatedAt: Date.now(),
  };
  broadcastMatchState(roomId);
}

function startCountdown(roomId, seconds = 30) {
  const room = getRoom(roomId);
  clearCountdown(room);

  let remaining = seconds;
  writeMatchState(roomId, {
    countdown: seconds,
    phase: "countdown",
    winner: null,
  });

  room.countdownTimer = setInterval(() => {
    remaining -= 1;

    if (remaining <= 0) {
      clearCountdown(room);
      const winner = room.matchState.preselectedWinner;
      writeMatchState(roomId, {
        countdown: 0,
        phase: winner ? "winner" : "done",
        winner: winner || null,
      });
      return;
    }

    writeMatchState(roomId, {
      countdown: remaining,
      phase: "countdown",
    });
  }, 1000);
}

function resetMatch(roomId) {
  const room = getRoom(roomId);
  clearCountdown(room);
  room.matchState = defaultMatchState();
  broadcastMatchState(roomId);
}

function cleanupRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room) {
    return;
  }

  if (room.participants.size === 0 && room.matchClients.size === 0) {
    clearCountdown(room);
    rooms.delete(roomId);
  }
}

function handleVideoJoin(socket, message) {
  const room = getRoom(message.room);
  const existing = room.participants.get(message.peerId);

  if (existing?.socket && existing.socket !== socket) {
    existing.socket.close();
  }

  socket.data = {
    kind: "video",
    roomId: message.room,
    peerId: message.peerId,
  };

  room.participants.set(message.peerId, {
    socket,
    role: message.role,
    side: message.side,
    joinedAt: Date.now(),
  });

  sendJson(socket, {
    type: "video-welcome",
    participants: listParticipants(room),
  });

  broadcastParticipants(message.room);
}

function handleSignal(socket, message) {
  const room = rooms.get(socket.data?.roomId);
  if (!room) {
    return;
  }

  const target = room.participants.get(message.to);
  if (!target) {
    return;
  }

  sendJson(target.socket, {
    type: "signal",
    signalType: message.signalType,
    from: message.from,
    to: message.to,
    description: message.description || null,
    candidate: message.candidate || null,
    metadata: message.metadata || null,
  });
}

function handleMatchJoin(socket, message) {
  const room = getRoom(message.room);
  socket.data = {
    kind: "match",
    roomId: message.room,
  };

  room.matchClients.add(socket);
  sendJson(socket, {
    type: "match-state",
    state: room.matchState,
  });
}

function handleMatchAction(socket, message) {
  const roomId = socket.data?.roomId;
  if (!roomId) {
    return;
  }

  if (message.action === "set-preselected") {
    writeMatchState(roomId, {
      preselectedWinner: message.winner || null,
      winner: null,
      phase: "ready",
    });
    return;
  }

  if (message.action === "set-winner") {
    clearCountdown(getRoom(roomId));
    writeMatchState(roomId, {
      winner: message.winner || null,
      phase: "winner",
    });
    return;
  }

  if (message.action === "start-countdown") {
    startCountdown(roomId, Number(message.seconds || 30));
    return;
  }

  if (message.action === "reset") {
    resetMatch(roomId);
  }
}

function handleDisconnect(socket) {
  const roomId = socket.data?.roomId;
  if (!roomId) {
    return;
  }

  const room = rooms.get(roomId);
  if (!room) {
    return;
  }

  if (socket.data.kind === "video" && socket.data.peerId) {
    room.participants.delete(socket.data.peerId);
    broadcastParticipants(roomId);
  }

  if (socket.data.kind === "match") {
    room.matchClients.delete(socket);
  }

  cleanupRoom(roomId);
}

wss.on("connection", (socket) => {
  socket.data = null;

  socket.on("message", (raw) => {
    let message;

    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }

    if (message.type === "video-join") {
      handleVideoJoin(socket, message);
      return;
    }

    if (message.type === "signal") {
      handleSignal(socket, message);
      return;
    }

    if (message.type === "match-join") {
      handleMatchJoin(socket, message);
      return;
    }

    if (message.type === "match-action") {
      handleMatchAction(socket, message);
      return;
    }
  });

  socket.on("close", () => {
    handleDisconnect(socket);
  });
});

server.listen(port, () => {
  console.log(`Video server running on http://localhost:${port}`);
});
