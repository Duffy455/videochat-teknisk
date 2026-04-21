const rtcConfig = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

export function getMediaSupportStatus() {
  if (!window.isSecureContext) {
    return {
      ok: false,
      message: "Siden må kjøres fra localhost eller https for kamera og mikrofon.",
    };
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    return {
      ok: false,
      message: "Nettleseren støtter ikke kamera/mikrofon her.",
    };
  }

  return { ok: true, message: "" };
}

export function getRoomFromUrl() {
  const params = new URLSearchParams(window.location.search);
  return params.get("room") || "default-room";
}

export function setRoomLabel(element, room) {
  if (element) {
    element.textContent = `Room: ${room}`;
  }
}

function getSocketUrl() {
  if (!window.location.host) {
    throw new Error("Siden må kjøres via server, ikke som lokal fil.");
  }

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}`;
}

function sendSocketMessage(socket, payload) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function shouldInitiateConnection(selfRole, selfPeerId, participant) {
  if (selfRole === "player" && participant.role === "admin") {
    return true;
  }

  if (selfRole === "admin" && participant.role === "player") {
    return false;
  }

  if (selfRole === "player" && participant.role === "player") {
    return selfPeerId < participant.peerId;
  }

  if (selfRole === "admin" && participant.role === "admin") {
    return selfPeerId < participant.peerId;
  }

  return false;
}

export function createMatchStore(room, onState) {
  let socket;
  let disposed = false;
  let isConnected = false;
  const pendingActions = [];

  let state = {
    countdown: 30,
    phase: "idle",
    winner: null,
    preselectedWinner: null,
    updatedAt: Date.now(),
  };

  const notify = () => onState?.(state);

  const connect = () =>
    new Promise((resolve, reject) => {
      try {
        socket = new WebSocket(getSocketUrl());
      } catch (error) {
        reject(error);
        return;
      }

      socket.addEventListener("open", () => {
        isConnected = true;
        sendSocketMessage(socket, {
          type: "match-join",
          room,
        });
        while (pendingActions.length > 0) {
          sendSocketMessage(socket, pendingActions.shift());
        }
        resolve();
      });

      socket.addEventListener("message", (event) => {
        const message = JSON.parse(event.data);
        if (message.type !== "match-state") {
          return;
        }

        state = {
          countdown: 30,
          phase: "idle",
          winner: null,
          preselectedWinner: null,
          updatedAt: Date.now(),
          ...message.state,
        };
        notify();
      });

      socket.addEventListener("error", () => {
        if (!disposed) {
          reject(new Error("Kunne ikke koble til kampserveren."));
        }
      });

      socket.addEventListener("close", () => {
        isConnected = false;
      });
    });

  connect().catch(() => {
    state = {
      ...state,
      phase: "offline",
    };
    notify();
  });

  notify();

  const dispatch = (payload) => {
    const message = {
      type: "match-action",
      room,
      ...payload,
    };

    if (!socket) {
      return;
    }

    if (!isConnected || socket.readyState !== WebSocket.OPEN) {
      pendingActions.push(message);
      return;
    }

    sendSocketMessage(socket, message);
  };

  return {
    getState: () => state,
    setPreselectedWinner(winner) {
      dispatch({ action: "set-preselected", winner });
    },
    setWinner(winner) {
      dispatch({ action: "set-winner", winner });
    },
    reset() {
      dispatch({ action: "reset" });
    },
    startCountdown(seconds = 30) {
      dispatch({ action: "start-countdown", seconds });
    },
    dispose() {
      disposed = true;
      socket?.close();
    },
  };
}

export async function createVideoRoom({
  room,
  peerId,
  role,
  side,
  publishMedia = true,
  onStatus,
  onParticipantState,
}) {
  let localStream = null;
  if (publishMedia) {
    const mediaSupport = getMediaSupportStatus();
    if (!mediaSupport.ok) {
      throw new Error(mediaSupport.message);
    }

    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  }

  const mediaState = {
    mic: Boolean(localStream),
    cam: Boolean(localStream),
    speaker: true,
  };

  const signaling = new WebSocket(getSocketUrl());
  const peers = new Map();
  const remoteStreams = new Map();
  const serverParticipants = new Map();
  const pendingIceCandidates = new Map();

  const emitParticipants = () => {
    const participants = [
      {
        id: peerId,
        role,
        side,
        stream: localStream,
      },
      ...Array.from(serverParticipants.entries()).map(([id, value]) => ({
        id,
        role: value.role,
        side: value.side,
        stream: remoteStreams.get(id) || null,
      })),
    ];

    onParticipantState?.(participants);
  };

  const removePeer = (targetId) => {
    peers.get(targetId)?.close();
    peers.delete(targetId);
    remoteStreams.delete(targetId);
    serverParticipants.delete(targetId);
    pendingIceCandidates.delete(targetId);
    emitParticipants();
  };

  const flushPendingIceCandidates = async (targetId, connection) => {
    const pending = pendingIceCandidates.get(targetId) || [];
    for (const candidate of pending) {
      try {
        await connection.addIceCandidate(new RTCIceCandidate(candidate));
      } catch {
        onStatus?.("Venter på nettverkskandidat");
      }
    }
    pendingIceCandidates.delete(targetId);
  };

  const makePeerConnection = (targetId, metadata, isOfferer) => {
    if (peers.has(targetId)) {
      return peers.get(targetId);
    }

    const connection = new RTCPeerConnection(rtcConfig);
    peers.set(targetId, connection);
    serverParticipants.set(targetId, metadata);

    if (localStream) {
      localStream.getTracks().forEach((track) => connection.addTrack(track, localStream));
    }

    connection.ontrack = (event) => {
      const [stream] = event.streams;
      remoteStreams.set(targetId, stream);
      emitParticipants();
    };

    connection.onicecandidate = (event) => {
      if (!event.candidate) {
        return;
      }

      sendSocketMessage(signaling, {
        type: "signal",
        room,
        from: peerId,
        to: targetId,
        signalType: "ice-candidate",
        candidate: event.candidate.toJSON(),
      });
    };

    connection.onconnectionstatechange = () => {
      if (["failed", "disconnected", "closed"].includes(connection.connectionState)) {
        removePeer(targetId);
      }
    };

    if (isOfferer) {
      connection
        .createOffer()
        .then((offer) => connection.setLocalDescription(offer))
        .then(() => {
          sendSocketMessage(signaling, {
            type: "signal",
            room,
            from: peerId,
            to: targetId,
            signalType: "offer",
            description: {
              type: connection.localDescription?.type,
              sdp: connection.localDescription?.sdp,
            },
            metadata: { role, side },
          });
        })
        .catch(() => {
          onStatus?.("Kunne ikke starte video-forbindelse.");
        });
    }

    emitParticipants();
    return connection;
  };

  const syncParticipants = (participants) => {
    const nextIds = new Set();

    participants.forEach((participant) => {
      if (participant.peerId === peerId) {
        return;
      }

      nextIds.add(participant.peerId);
      serverParticipants.set(participant.peerId, participant);
    });

    Array.from(serverParticipants.keys()).forEach((targetId) => {
      if (!nextIds.has(targetId)) {
        removePeer(targetId);
      }
    });

    participants.forEach((participant) => {
      if (participant.peerId === peerId) {
        return;
      }

      if (!peers.has(participant.peerId) && shouldInitiateConnection(role, peerId, participant)) {
        makePeerConnection(participant.peerId, participant, true);
      }
    });

    emitParticipants();
  };

  await new Promise((resolve, reject) => {
    signaling.addEventListener("open", () => {
      sendSocketMessage(signaling, {
        type: "video-join",
        room,
        peerId,
        role,
        side,
      });
      onStatus?.("Media er klar");
      resolve();
    });

    signaling.addEventListener("message", async (event) => {
      const message = JSON.parse(event.data);

      if (message.type === "video-welcome" || message.type === "participants-update") {
        syncParticipants(message.participants || []);
        return;
      }

      if (message.type !== "signal" || message.to !== peerId) {
        return;
      }

      if (message.signalType === "offer") {
        const connection = makePeerConnection(message.from, message.metadata || {}, false);
        await connection.setRemoteDescription(new RTCSessionDescription(message.description));
        await flushPendingIceCandidates(message.from, connection);
        const answer = await connection.createAnswer();
        await connection.setLocalDescription(answer);
        sendSocketMessage(signaling, {
          type: "signal",
          room,
          from: peerId,
          to: message.from,
          signalType: "answer",
          description: {
            type: connection.localDescription?.type,
            sdp: connection.localDescription?.sdp,
          },
        });
        return;
      }

      if (message.signalType === "answer") {
        const connection = peers.get(message.from);
        if (!connection) {
          return;
        }

        await connection.setRemoteDescription(new RTCSessionDescription(message.description));
        await flushPendingIceCandidates(message.from, connection);
        return;
      }

      if (message.signalType === "ice-candidate") {
        const connection = peers.get(message.from);
        if (connection?.remoteDescription) {
          await connection.addIceCandidate(new RTCIceCandidate(message.candidate));
          return;
        }

        const pending = pendingIceCandidates.get(message.from) || [];
        pending.push(message.candidate);
        pendingIceCandidates.set(message.from, pending);
      }
    });

    signaling.addEventListener("error", () => {
      reject(new Error("Kunne ikke koble til videoserveren."));
    });

    signaling.addEventListener("close", () => {
      onStatus?.("Forbindelsen til serveren ble brutt");
    });
  });

  emitParticipants();

  return {
    localStream,
    getParticipants: () => [
      {
        id: peerId,
        role,
        side,
        stream: localStream,
      },
      ...Array.from(serverParticipants.entries()).map(([id, value]) => ({
        id,
        role: value.role,
        side: value.side,
        stream: remoteStreams.get(id) || null,
      })),
    ],
    getMediaState() {
      return { ...mediaState };
    },
    toggleMic() {
      if (!localStream) {
        return false;
      }

      mediaState.mic = !mediaState.mic;
      localStream.getAudioTracks().forEach((track) => {
        track.enabled = mediaState.mic;
      });
      return mediaState.mic;
    },
    toggleCam() {
      if (!localStream) {
        return false;
      }

      mediaState.cam = !mediaState.cam;
      localStream.getVideoTracks().forEach((track) => {
        track.enabled = mediaState.cam;
      });
      return mediaState.cam;
    },
    toggleSpeaker(videos) {
      mediaState.speaker = !mediaState.speaker;
      videos.forEach((video) => {
        video.muted = !mediaState.speaker;
      });
      return mediaState.speaker;
    },
    disconnect() {
      peers.forEach((peer) => peer.close());
      peers.clear();
      localStream?.getTracks().forEach((track) => track.stop());
      signaling.close();
    },
  };
}

export function createPeerId() {
  return `peer-${Math.random().toString(36).slice(2, 10)}`;
}

export function bindMediaButtons({ root = document, roomApi, remoteVideos }) {
  root.querySelectorAll("[data-control]").forEach((button) => {
    button.addEventListener("click", () => {
      const control = button.dataset.control;
      let enabled = true;

      if (control === "mic") {
        enabled = roomApi.toggleMic();
      }
      if (control === "cam") {
        enabled = roomApi.toggleCam();
      }
      if (control === "speaker") {
        enabled = roomApi.toggleSpeaker(remoteVideos);
      }

      root.querySelectorAll(`[data-control="${control}"]`).forEach((matchingButton) => {
        matchingButton.setAttribute("aria-pressed", String(enabled));
      });
    });
  });
}

export function renderStageStreams({
  sideElements,
  participants,
  currentSide,
  roomApi,
  selfPeerId = null,
  resolveDisplaySide = null,
}) {
  const mediaState = roomApi?.getMediaState?.() || { speaker: true };

  ["blue", "green"].forEach((side) => {
    const slot = sideElements[side];
    if (!slot) {
      return;
    }

    const { video, empty, copy } = slot;
    const participant = participants.find((entry) => {
      const displaySide = resolveDisplaySide ? resolveDisplaySide(entry) : entry.side;
      return displaySide === side && entry.stream;
    });

    if (participant?.stream) {
      if (video.srcObject !== participant.stream) {
        video.srcObject = participant.stream;
      }

      const isLocalParticipant = selfPeerId ? participant.id === selfPeerId : participant.side === currentSide;
      video.muted = isLocalParticipant ? true : !mediaState.speaker;
      empty.classList.add("hidden");
      copy.textContent = isLocalParticipant ? "Du er tilkoblet" : "Spiller tilkoblet";
    } else {
      video.srcObject = null;
      empty.classList.remove("hidden");
      copy.textContent = "Venter på tilkobling";
    }
  });

  if (roomApi) {
    document.querySelectorAll(".icon-btn").forEach((button) => {
      button.classList.toggle("active-side", button.getAttribute("aria-pressed") === "true");
    });
  }
}

export function renderMatchState({ state, countdownEl, bannerEl }) {
  countdownEl.textContent = String(state.countdown ?? 30);

  if (state.winner) {
    bannerEl.textContent = `${capitalize(state.winner)} wins`;
    bannerEl.classList.remove("hidden");
    bannerEl.style.color = state.winner === "blue" ? "#89daff" : "#9dffd5";
    return;
  }

  if (state.preselectedWinner && state.phase === "ready") {
    bannerEl.textContent = `Preselected: ${capitalize(state.preselectedWinner)}`;
    bannerEl.classList.remove("hidden");
    bannerEl.style.color = state.preselectedWinner === "blue" ? "#89daff" : "#9dffd5";
    return;
  }

  bannerEl.classList.add("hidden");
  bannerEl.textContent = "";
}

function capitalize(value) {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : "";
}
