const rtcConfig = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

const MEDIA_REQUEST_TIMEOUT_MS = 12000;

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

function createDefaultMatchState() {
  return {
    countdown: 30,
    phase: "idle",
    winner: null,
    preselectedWinner: null,
    updatedAt: Date.now(),
  };
}

function shouldInitiateConnection(selfRole, selfPeerId, participant) {
  if (selfRole === "player" && participant.role === "admin") {
    return true;
  }

  if (selfRole === "admin" && participant.role === "player") {
    return false;
  }

  return selfPeerId < participant.peerId;
}

async function requestLocalMedia() {
  const mediaPromise = navigator.mediaDevices.getUserMedia({ video: true, audio: true });

  const timeoutPromise = new Promise((_, reject) => {
    window.setTimeout(() => {
      reject(
        new Error(
          "Kamera/mikrofon svarte ikke. Godkjenn tilgang i nettleseren, eller sjekk at siden kjører på https."
        )
      );
    }, MEDIA_REQUEST_TIMEOUT_MS);
  });

  try {
    return await Promise.race([mediaPromise, timeoutPromise]);
  } catch (error) {
    const errorName = error?.name || "";
    const message = String(error?.message || error || "");

    if (errorName === "NotAllowedError" || /denied|permission/i.test(message)) {
      throw new Error("Kamera/mikrofon ble blokkert. Tillat tilgang i nettleseren og prøv igjen.");
    }

    if (errorName === "NotFoundError" || errorName === "DevicesNotFoundError") {
      throw new Error("Fant ikke kamera eller mikrofon på enheten.");
    }

    if (errorName === "NotReadableError" || errorName === "TrackStartError") {
      throw new Error("Kamera eller mikrofon er opptatt i en annen app.");
    }

    throw error;
  }
}

export function createMatchStore(room, onState) {
  let socket;
  let disposed = false;
  let isConnected = false;
  const pendingActions = [];
  let state = createDefaultMatchState();

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
        sendSocketMessage(socket, { type: "match-join", room });

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
          ...createDefaultMatchState(),
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

    localStream = await requestLocalMedia();
  }

  const mediaState = {
    mic: Boolean(localStream),
    cam: Boolean(localStream),
  };

  const panelState = {
    blue: { speaker: true, video: true },
    green: { speaker: true, video: true },
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
        onStatus?.("Venter på nettverkskandidat.");
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
      onStatus?.("Media er klar.");
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
      onStatus?.("Forbindelsen til serveren ble brutt.");
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
    getPanelState(sideName) {
      return { ...(panelState[sideName] || { speaker: true, video: true }) };
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
    togglePanelSpeaker(sideName) {
      if (!panelState[sideName]) {
        return true;
      }

      panelState[sideName].speaker = !panelState[sideName].speaker;
      return panelState[sideName].speaker;
    },
    togglePanelVideo(sideName) {
      if (!panelState[sideName]) {
        return true;
      }

      panelState[sideName].video = !panelState[sideName].video;
      return panelState[sideName].video;
    },
    disconnect() {
      peers.forEach((peer) => peer.close());
      peers.clear();
      localStream?.getTracks().forEach((track) => track.stop());
      signaling.close();
    },
  };
}

export function bindMediaButtons({ root = document, roomApi, getSelfSide, onChange }) {
  root.querySelectorAll("[data-slot] [data-control]").forEach((button) => {
    button.addEventListener("click", () => {
      const slot = button.closest("[data-slot]")?.dataset.slot;
      const control = button.dataset.control;
      const selfSide = getSelfSide?.();
      const isSelfSlot = slot && selfSide && slot === selfSide;

      if (!slot || !control) {
        return;
      }

      if (control === "mic") {
        if (!isSelfSlot) {
          return;
        }
        roomApi.toggleMic();
      }

      if (control === "cam") {
        if (isSelfSlot) {
          roomApi.toggleCam();
        } else {
          roomApi.togglePanelVideo(slot);
        }
      }

      if (control === "speaker") {
        roomApi.togglePanelSpeaker(slot);
      }

      onChange?.();
    });
  });
}

export function renderStageStreams({
  sideElements,
  participants,
  roomApi,
  selfPeerId = null,
  selfDisplaySide = null,
  resolveDisplaySide = null,
}) {
  ["blue", "green"].forEach((sideName) => {
    const slot = sideElements[sideName];
    if (!slot) {
      return;
    }

    const { video, empty, copy } = slot;
    const panelState = roomApi?.getPanelState(sideName) || { speaker: true, video: true };
    const participant = participants.find((entry) => {
      const displaySide = resolveDisplaySide ? resolveDisplaySide(entry) : entry.side;
      return displaySide === sideName && entry.stream;
    });

    const isLocalParticipant = participant ? participant.id === selfPeerId : false;
    const hasVisibleVideo = Boolean(participant?.stream && panelState.video);

    if (hasVisibleVideo) {
      if (video.srcObject !== participant.stream) {
        video.srcObject = participant.stream;
      }
      video.muted = isLocalParticipant ? true : !panelState.speaker;
      empty?.classList.add("hidden");
    } else {
      video.srcObject = null;
      empty?.classList.remove("hidden");
    }

    if (copy) {
      if (!participant) {
        copy.textContent = "Venter på deltaker";
      } else if (isLocalParticipant) {
        copy.textContent = "Du er tilkoblet";
      } else {
        copy.textContent = "Deltaker tilkoblet";
      }
    }

    if (empty) {
      if (!participant) {
        empty.textContent = "Ingen deltaker ennå";
      } else if (!panelState.video) {
        empty.textContent = "Kamera skjult";
      } else {
        empty.textContent = "Ingen video ennå";
      }
    }

    const controlsRoot = document.querySelector(`[data-slot="${sideName}"]`);
    if (!controlsRoot) {
      return;
    }

    const mediaState = roomApi?.getMediaState?.() || { mic: false, cam: false };
    const isSelfSlot = sideName === selfDisplaySide;

    controlsRoot.querySelectorAll("[data-control]").forEach((button) => {
      const control = button.dataset.control;
      let enabled = false;
      let disabled = false;

      if (control === "mic") {
        enabled = isSelfSlot && mediaState.mic;
        disabled = !isSelfSlot;
      }

      if (control === "cam") {
        enabled = isSelfSlot ? mediaState.cam : panelState.video;
      }

      if (control === "speaker") {
        enabled = panelState.speaker;
      }

      button.disabled = disabled;
      button.setAttribute("aria-pressed", String(enabled));
    });
  });
}

export function renderMatchState({ state, countdownEl, bannerEl, showPreselected = false }) {
  countdownEl.textContent = String(state.countdown ?? 30);

  if (state.winner) {
    bannerEl.textContent = `${capitalize(state.winner)} wins`;
    bannerEl.classList.remove("hidden");
    bannerEl.style.color = state.winner === "blue" ? "#89daff" : "#9dffd5";
    return;
  }

  if (showPreselected && state.preselectedWinner && state.phase === "ready") {
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
