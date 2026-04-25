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
let latestParticipants = [];
let controlsBound = false;
let isConnecting = false;
let currentAttemptId = 0;

const matchStore = createMatchStore(room, (state) => {
  renderMatchState({ state, countdownEl, bannerEl: winnerBanner, showPreselected: false });
});

function updateOverlay(title, copy) {
  if (overlayTitle) {
    overlayTitle.textContent = title;
  }

  if (overlayCopy) {
    overlayCopy.textContent = copy;
  }
}

function resetOverlay() {
  updateOverlay("Velg side", "Trykk på Blue eller Green for å koble deg til rommet.");
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

function refreshStage() {
  if (!roomApi) {
    return;
  }

  renderStageStreams({
    sideElements,
    participants: latestParticipants,
    roomApi,
    selfPeerId: peerId,
    selfDisplaySide: selectedSide,
    resolveDisplaySide(entry) {
      if (entry.role === "admin") {
        return selectedSide === "blue" ? "green" : "blue";
      }

      return entry.side;
    },
  });
}

function updateParticipantStatus(participants) {
  const adminParticipant = participants.find((entry) => entry.role === "admin");
  const waitingForAdmin = !adminParticipant;

  connectionState.textContent = waitingForAdmin ? "Venter" : "Klar";
  connectionCopy.textContent = waitingForAdmin
    ? "Du er inne i rommet og venter på admin."
    : `Admin er tilkoblet. Du er på ${selectedSide}.`;
}

function showConnectionError(message) {
  connectionState.textContent = "Ikke tilkoblet";
  connectionCopy.textContent = message;
  entryOverlay?.classList.remove("hidden");
  resetOverlay();
  isConnecting = false;
  updateSideButtons();
}

function beginConnectionState() {
  connectionState.textContent = "Kobler til";
  connectionCopy.textContent = `Kobler ${selectedSide}-siden til room ${room}.`;
  updateOverlay(
    `Kobler til ${selectedSide === "blue" ? "Blue" : "Green"}`,
    "Godkjenn kamera og mikrofon hvis nettleseren spør."
  );
  entryOverlay?.classList.remove("hidden");
}

async function connectSelectedSide() {
  if (isConnecting) {
    return;
  }

  const mediaSupport = getMediaSupportStatus();
  if (!mediaSupport.ok) {
    showConnectionError(mediaSupport.message);
    return;
  }

  currentAttemptId += 1;
  const attemptId = currentAttemptId;
  isConnecting = true;
  updateSideButtons();
  beginConnectionState();

  if (roomApi) {
    roomApi.disconnect();
    roomApi = null;
  }

  latestParticipants = [];

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

        latestParticipants = participants;
        if (roomApi || pendingRoomApi) {
          refreshStage();
          updateParticipantStatus(participants);
        }
      },
    });

    if (attemptId !== currentAttemptId) {
      pendingRoomApi.disconnect();
      return;
    }

    roomApi = pendingRoomApi;

    if (!controlsBound) {
      bindMediaButtons({
        roomApi,
        getSelfSide: () => selectedSide,
        onChange: () => refreshStage(),
      });
      controlsBound = true;
    }

    refreshStage();
    updateParticipantStatus(latestParticipants.length > 0 ? latestParticipants : roomApi.getParticipants());
    entryOverlay?.classList.add("hidden");
    resetOverlay();
    isConnecting = false;
    updateSideButtons();
  } catch (error) {
    if (attemptId !== currentAttemptId) {
      return;
    }

    roomApi?.disconnect();
    roomApi = null;
    latestParticipants = [];
    showConnectionError(error?.message || "Kunne ikke starte kamera og mikrofon.");
  }
}

window.addEventListener("error", (event) => {
  showConnectionError(event.message || "JavaScript-feil på siden.");
});

window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason?.message || event.reason || "Ukjent feil under lasting.";
  showConnectionError(String(reason));
});

sideSelectButtons.forEach((button) => {
  button.addEventListener("click", () => {
    setSelectedSide(button.dataset.sideSelect || "blue");
    connectSelectedSide();
  });
});

resetOverlay();
updateSideButtons();
connectionState.textContent = "Velg side";
connectionCopy.textContent = "Velg Blue eller Green for å gå inn i rommet.";

if (initialSide === "blue" || initialSide === "green") {
  setSelectedSide(initialSide);
  connectSelectedSide();
}

window.addEventListener("beforeunload", () => {
  currentAttemptId += 1;
  roomApi?.disconnect();
  matchStore.dispose();
});
