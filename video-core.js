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

export function createMatchStore(room, onState) {
  const key = `video-match-state:${room}`;
  const channel = new BroadcastChannel(`video-match:${room}`);
  let countdownTimer = null;

  const defaultState = {
    countdown: 30,
    phase: "idle",
    winner: null,
    preselectedWinner: null,
    updatedAt: Date.now(),
  };

  const read = () => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? { ...defaultState, ...JSON.parse(raw) } : defaultState;
    } catch {
      return defaultState;
    }
  };

  let state = read();

  const notify = () => onState?.(state);

  const write = (next) => {
    state = { ...state, ...next, updatedAt: Date.now() };
    localStorage.setItem(key, JSON.stringify(state));
    channel.postMessage({ type: "match-state", state });
    notify();
  };

  channel.onmessage = (event) => {
    if (event.data?.type === "match-state") {
      state = { ...defaultState, ...event.data.state };
      notify();
    }
  };

  window.addEventListener("storage", (event) => {
    if (event.key === key && event.newValue) {
      state = { ...defaultState, ...JSON.parse(event.newValue) };
      notify();
    }
  });

  notify();

  return {
    getState: () => state,
    setPreselectedWinner(winner) {
      write({ preselectedWinner: winner, winner: null, phase: "ready" });
    },
    setWinner(winner) {
      if (countdownTimer) {
        window.clearInterval(countdownTimer);
        countdownTimer = null;
      }
      write({ winner, phase: "winner" });
    },
    reset() {
      if (countdownTimer) {
        window.clearInterval(countdownTimer);
        countdownTimer = null;
      }
      write({ countdown: 30, phase: "idle", winner: null, preselectedWinner: null });
    },
    startCountdown(seconds = 30) {
      if (countdownTimer) {
        window.clearInterval(countdownTimer);
      }
      write({ countdown: seconds, phase: "countdown", winner: null });
      let remaining = seconds;
      countdownTimer = window.setInterval(() => {
        remaining -= 1;
        if (remaining <= 0) {
          window.clearInterval(countdownTimer);
          countdownTimer = null;
          const winner = this.getState().preselectedWinner;
          write({
            countdown: 0,
            phase: winner ? "winner" : "done",
            winner: winner || null,
          });
          return;
        }

        write({ countdown: remaining, phase: "countdown" });
      }, 1000);
    },
    dispose() {
      if (countdownTimer) {
        window.clearInterval(countdownTimer);
      }
      channel.close();
    },
  };
}

export async function createVideoRoom({ room, peerId, role, side, onStatus, onParticipantState }) {
  const mediaSupport = getMediaSupportStatus();
  if (!mediaSupport.ok) {
    throw new Error(mediaSupport.message);
  }

  const localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  const mediaState = {
    mic: true,
    cam: true,
    speaker: true,
  };
  const signaling = new BroadcastChannel(`video-signal:${room}`);
  const peers = new Map();
  const remoteStreams = new Map();
  const pendingIceCandidates = new Map();

  const participants = new Map();
  participants.set(peerId, { role, side, joinedAt: Date.now() });

  const notifyParticipants = () => {
    onParticipantState?.(Array.from(participants.entries()).map(([id, value]) => ({ id, ...value })));
  };

  const makePeerConnection = (targetId, metadata, isOfferer) => {
    if (peers.has(targetId)) {
      return peers.get(targetId);
    }

    const connection = new RTCPeerConnection(rtcConfig);
    peers.set(targetId, connection);
    participants.set(targetId, metadata);
    notifyParticipants();

    localStream.getTracks().forEach((track) => connection.addTrack(track, localStream));

    connection.ontrack = (event) => {
      const [stream] = event.streams;
      remoteStreams.set(targetId, stream);
      onStatus?.(`Tilkoblet ${metadata.side || metadata.role}`);
      onParticipantState?.(
        Array.from(participants.entries()).map(([id, value]) => ({
          id,
          ...value,
          stream: id === peerId ? localStream : remoteStreams.get(id) || null,
        })),
      );
    };

    connection.onicecandidate = (event) => {
      if (event.candidate) {
        signaling.postMessage({
          type: "ice-candidate",
          from: peerId,
          to: targetId,
          candidate: event.candidate.toJSON(),
        });
      }
    };

    connection.onconnectionstatechange = () => {
      if (["failed", "disconnected", "closed"].includes(connection.connectionState)) {
        peers.delete(targetId);
        remoteStreams.delete(targetId);
        participants.delete(targetId);
        notifyParticipants();
      }
    };

    if (isOfferer) {
      connection
        .createOffer()
        .then((offer) => connection.setLocalDescription(offer))
        .then(() => {
          signaling.postMessage({
            type: "offer",
            from: peerId,
            to: targetId,
            description: {
              type: connection.localDescription?.type,
              sdp: connection.localDescription?.sdp,
            },
            metadata: { role, side },
          });
        });
    }

    return connection;
  };

  const flushPendingIceCandidates = async (targetId, connection) => {
    const pending = pendingIceCandidates.get(targetId) || [];
    for (const candidate of pending) {
      try {
        await connection.addIceCandidate(new RTCIceCandidate(candidate));
      } catch {
        onStatus?.("Ventet pÃ¥ nettverkskandidat");
      }
    }
    pendingIceCandidates.delete(targetId);
  };

  const emitParticipants = () => {
    onParticipantState?.(
      Array.from(participants.entries()).map(([id, value]) => ({
        id,
        ...value,
        stream: id === peerId ? localStream : remoteStreams.get(id) || null,
      })),
    );
  };

  signaling.onmessage = async (event) => {
    const message = event.data;
    if (!message || (message.to && message.to !== peerId) || message.from === peerId) {
      return;
    }

    if (message.type === "join") {
      const connection = makePeerConnection(message.from, message.metadata, true);
      participants.set(message.from, message.metadata);
      emitParticipants();
      return connection;
    }

    if (message.type === "offer") {
      const connection = makePeerConnection(message.from, message.metadata, false);
      await connection.setRemoteDescription(new RTCSessionDescription(message.description));
      await flushPendingIceCandidates(message.from, connection);
      const answer = await connection.createAnswer();
      await connection.setLocalDescription(answer);
      signaling.postMessage({
        type: "answer",
        from: peerId,
        to: message.from,
        description: {
          type: connection.localDescription?.type,
          sdp: connection.localDescription?.sdp,
        },
      });
      return;
    }

    if (message.type === "answer") {
      const connection = peers.get(message.from);
      if (connection) {
        await connection.setRemoteDescription(new RTCSessionDescription(message.description));
        await flushPendingIceCandidates(message.from, connection);
      }
      return;
    }

    if (message.type === "ice-candidate") {
      const connection = peers.get(message.from);
      if (connection) {
        if (connection.remoteDescription) {
          await connection.addIceCandidate(new RTCIceCandidate(message.candidate));
        } else {
          const pending = pendingIceCandidates.get(message.from) || [];
          pending.push(message.candidate);
          pendingIceCandidates.set(message.from, pending);
        }
      }
      return;
    }

    if (message.type === "leave") {
      peers.get(message.from)?.close();
      peers.delete(message.from);
      remoteStreams.delete(message.from);
      participants.delete(message.from);
      emitParticipants();
    }
  };

  signaling.postMessage({
    type: "join",
    from: peerId,
    metadata: { role, side },
  });

  emitParticipants();
  onStatus?.("Media er klar");

  return {
    localStream,
    getParticipants: () =>
      Array.from(participants.entries()).map(([id, value]) => ({
        id,
        ...value,
        stream: id === peerId ? localStream : remoteStreams.get(id) || null,
      })),
    getMediaState() {
      return { ...mediaState };
    },
    toggleMic() {
      mediaState.mic = !mediaState.mic;
      localStream.getAudioTracks().forEach((track) => {
        track.enabled = mediaState.mic;
      });
      return mediaState.mic;
    },
    toggleCam() {
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
      signaling.postMessage({ type: "leave", from: peerId });
      peers.forEach((peer) => peer.close());
      peers.clear();
      localStream.getTracks().forEach((track) => track.stop());
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

export function renderStageStreams({ sideElements, participants, currentSide, roomApi }) {
  const mediaState = roomApi?.getMediaState?.() || { speaker: true };

  ["blue", "green"].forEach((side) => {
    const slot = sideElements[side];
    if (!slot) {
      return;
    }

    const { video, empty, copy } = slot;
    const participant = participants.find((entry) => entry.side === side && entry.stream);

    if (participant?.stream) {
      if (video.srcObject !== participant.stream) {
        video.srcObject = participant.stream;
      }
      const isLocalParticipant = participant.side === currentSide;
      video.muted = isLocalParticipant ? true : !mediaState.speaker;
      empty.classList.add("hidden");
      copy.textContent = participant.side === currentSide ? "Du er tilkoblet" : "Spiller tilkoblet";
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
