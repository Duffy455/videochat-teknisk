import {
  bindMediaButtons,
  createMatchStore,
  createPeerId,
  createVideoRoom,
  getMediaSupportStatus,
  getRoomFromUrl,
  renderMatchState,
  renderStageStreams,
  setRoomLabel,
} from "./video-core.js";

const room = getRoomFromUrl();
const peerId = createPeerId();
const params = new URLSearchParams(window.location.search);
const initialSide = params.get("side");

const roomLabel = document.querySelector("[data-room-label]");
const connectionState = document.querySelector("[data-connection-state]");
const connectionCopy = document.querySelector("[data-connection-copy]");
const countdownEl = document.querySelector("[data-countdown]");
const winnerBanner = document.querySelector("[data-winner-banner]");
const entryOverlay = document.querySelector("[data-entry-overlay]");
const overlayTitle = entryOverlay?.querySelector(".join-title");
const overlayCopy = entryOverlay?.querySelector(".join-copy");
const sideSelectButtons = document.querySelectorAll("[data-side-select]");

const sideElements = {
  blue: {
    video: document.querySelector('[data-video="blue"]'),
    empty: document.querySelector('[data-empty="blue"]'),
    copy: document.querySelector('[data-status-copy="blue"]'),
  },
  green: {
    video: document.querySelector('[data-video="green"]'),
    empty: document.querySelector('[data-empty="green"]'),
    copy: document.querySelector('[data-status-copy="green"]'),
  },
};

setRoomLabel(roomLabel, room);

let selectedSide = initialSide === "green" ? "green" : "blue";
let roomApi;
let controlsBound = false;
let isConnecting = false;
let currentAttemptId = 0;
let permissionHintTimer = null;

const matchStore = createMatchStore(room, (state) => {
  renderMatchState({ state, countdownEl, bannerEl: winnerBanner, showPreselected: false });
});

function capitalize(value) {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : "";
}

function clearPermissionHintTimer() {
  if (permissionHintTimer) {
    window.clearTimeout(permissionHintTimer);
    permissionHintTimer = null;
  }
}

function setOverlayContent(title, copy) {
  if (overlayTitle) {
    overlayTitle.textContent = title;
  }

  if (overlayCopy) {
    overlayCopy.textContent = copy;
  }
}

function resetOverlayContent() {
  setOverlayContent("Velg side", "Trykk på Blue eller Green for å koble deg til rommet.");
}

function showConnectionError(message) {
  clearPermissionHintTimer();
  connectionState.textContent = "Ikke tilkoblet";
  connectionCopy.textContent = message;
  resetOverlayContent();
  entryOverlay?.classList.remove("hidden");
  isConnecting = false;
  updateSideButtons();
}

function updateSideButtons() {
  sideSelectButtons.forEach((button) => {
    const isActive = button.dataset.sideSelect === selectedSide;
    button.setAttribute("aria-pressed", String(isActive));
    button.disabled = isConnecting;
  });
}

function setSelectedSide(side) {
  selectedSide = side === "green" ? "green" : "blue";
  const nextUrl = new URL(window.location.href);
  nextUrl.searchParams.set("side", selectedSide);
  window.history.replaceState({}, "", nextUrl);
  updateSideButtons();
}

connectionState.textContent = "Laster";
connectionCopy.textContent = "Velg side for å starte.";

window.addEventListener("error", (event) => {
  showConnectionError(event.message || "JavaScript-feil på siden.");
});

window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason?.message || event.reason || "Ukjent feil under lasting.";
  showConnectionError(String(reason));
});

const mediaSupport = getMediaSupportStatus();
const canUseMedia = mediaSupport.ok;
if (!mediaSupport.ok) {
  showConnectionError(mediaSupport.message);
}

function lockOpponentControls() {
  const lockedSide = selectedSide === "blue" ? "green" : "blue";

  document.querySelectorAll(`[data-slot="${lockedSide}"] [data-control]`).forEach((button) => {
    button.disabled = true;
    button.setAttribute("aria-pressed", "false");
  });

  document.querySelectorAll(`[data-slot="${selectedSide}"] [data-control]`).forEach((button) => {
    button.disabled = false;
  });
}

function resetPlayerControls() {
  document.querySelectorAll("[data-slot] [data-control]").forEach((button) => {
    button.disabled = true;
    button.setAttribute("aria-pressed", "false");
  });
}

function resolvePlayerDisplaySide(participant) {
  if (participant.role === "admin") {
    return selectedSide === "blue" ? "green" : "blue";
  }

  return participant.side;
}

function clearPlayerStage() {
  Object.values(sideElements).forEach(({ video, empty, copy }) => {
    if (video) {
      video.srcObject = null;
    }

    empty?.classList.remove("hidden");

    if (copy) {
      copy.textContent = "Venter på tilkobling";
    }
  });
}

function beginConnectionState() {
  const readableSide = capitalize(selectedSide);
  connectionState.textContent = "Kobler til";
  connectionCopy.textContent = `Starter ${selectedSide}-siden i room ${room}.`;
  setOverlayContent(
    `Kobler til ${readableSide}`,
    "Tillat kamera og mikrofon i nettleseren. Hvis du ikke ser et spørsmål, sjekk adressefeltet."
  );
  entryOverlay?.classList.remove("hidden");
  clearPermissionHintTimer();
  permissionHintTimer = window.setTimeout(() => {
    if (!isConnecting) {
      return;
    }

    connectionCopy.textContent = "Venter på svar fra kamera/mikrofon eller nettleseren.";
    setOverlayContent(
      `Venter på ${readableSide}`,
      "Siden jobber fortsatt. Godkjenn kamera/mikrofon hvis nettleseren spør. Hvis ikke, last siden på nytt og prøv igjen."
    );
  }, 2500);
}

async function connectSelectedSide() {
  if (!canUseMedia || isConnecting) {
    return;
  }

  currentAttemptId += 1;
  const attemptId = currentAttemptId;
  isConnecting = true;
  updateSideButtons();

  if (roomApi) {
    roomApi.disconnect();
    roomApi = null;
    clearPlayerStage();
  }

  resetPlayerControls();
  beginConnectionState();

  try {
    let pendingRoomApi = null;

    pendingRoomApi = await createVideoRoom({
      room,
      peerId,
      role: "player",
      side: selectedSide,
      onStatus(message) {
        if (attemptId !== currentAttemptId) {
          return;
        }

        connectionState.textContent = "Tilkoblet";
        connectionCopy.textContent = message;
      },
      onParticipantState(participants) {
        if (attemptId !== currentAttemptId) {
          return;
        }

        const activeRoomApi = roomApi || pendingRoomApi;
        if (!activeRoomApi) {
          return;
        }

        renderStageStreams({
          sideElements,
          participants,
          currentSide: selectedSide,
          roomApi: activeRoomApi,
          selfPeerId: peerId,
          resolveDisplaySide: resolvePlayerDisplaySide,
        });
      },
    });

    const nextRoomApi = pendingRoomApi;

    if (attemptId !== currentAttemptId) {
      nextRoomApi.disconnect();
      return;
    }

    roomApi = nextRoomApi;

    renderStageStreams({
      sideElements,
      participants: roomApi.getParticipants(),
      currentSide: selectedSide,
      roomApi,
      selfPeerId: peerId,
      resolveDisplaySide: resolvePlayerDisplaySide,
    });

    if (!controlsBound) {
      bindMediaButtons({
        roomApi,
        remoteVideos: [sideElements.blue.video, sideElements.green.video],
      });
      controlsBound = true;
    }

    clearPermissionHintTimer();
    lockOpponentControls();
    connectionState.textContent = "Tilkoblet";
    connectionCopy.textContent = `Du er koblet til som ${selectedSide}.`;
    resetOverlayContent();
    entryOverlay?.classList.add("hidden");
    isConnecting = false;
    updateSideButtons();
  } catch (error) {
    if (attemptId !== currentAttemptId) {
      return;
    }

    roomApi?.disconnect();
    roomApi = null;
    clearPlayerStage();
    resetPlayerControls();
    showConnectionError(error?.message || "Kunne ikke starte kamera og mikrofon.");
  }
}

sideSelectButtons.forEach((button) => {
  button.addEventListener("click", () => {
    setSelectedSide(button.dataset.sideSelect || "blue");
    connectSelectedSide();
  });
});

resetPlayerControls();
updateSideButtons();
resetOverlayContent();

if (!canUseMedia) {
  sideSelectButtons.forEach((button) => {
    button.disabled = true;
  });
} else if (initialSide === "blue" || initialSide === "green") {
  setSelectedSide(initialSide);
  connectSelectedSide();
} else {
  connectionState.textContent = "Velg side";
  connectionCopy.textContent = "Trykk Blue eller Green for å koble til.";
}

window.addEventListener("beforeunload", () => {
  clearPermissionHintTimer();
  currentAttemptId += 1;
  roomApi?.disconnect();
  matchStore.dispose();
});
