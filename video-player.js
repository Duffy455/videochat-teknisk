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

const matchStore = createMatchStore(room, (state) => {
  renderMatchState({ state, countdownEl, bannerEl: winnerBanner });
});

function showConnectionError(message) {
  connectionState.textContent = "Ikke tilkoblet";
  connectionCopy.textContent = message;
}

connectionState.textContent = "Laster";
connectionCopy.textContent = "Starter video-siden.";

window.addEventListener("error", (event) => {
  showConnectionError(event.message || "JavaScript-feil på siden.");
});

window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason?.message || event.reason || "Ukjent feil under lasting.";
  showConnectionError(String(reason));
});

const mediaSupport = getMediaSupportStatus();
if (!mediaSupport.ok) {
  showConnectionError(mediaSupport.message);
}

async function connectSelectedSide() {
  if (!mediaSupport.ok) {
    return;
  }

  connectionState.textContent = "Kobler til";
  connectionCopy.textContent = `Starter ${selectedSide}-siden i room ${room}.`;

  try {
    roomApi = await createVideoRoom({
      room,
      peerId,
      role: "player",
      side: selectedSide,
      onStatus(message) {
        connectionState.textContent = "Tilkoblet";
        connectionCopy.textContent = message;
      },
      onParticipantState(participants) {
        renderStageStreams({
          sideElements,
          participants,
          currentSide: selectedSide,
          roomApi,
        });
      },
    });

    renderStageStreams({
      sideElements,
      participants: roomApi.getParticipants(),
      currentSide: selectedSide,
      roomApi,
    });

    if (!controlsBound) {
      bindMediaButtons({
        roomApi,
        remoteVideos: [sideElements.blue.video, sideElements.green.video],
      });
      controlsBound = true;
    }

    connectionState.textContent = "Tilkoblet";
    connectionCopy.textContent = `Du er koblet til som ${selectedSide}.`;
  } catch (error) {
    showConnectionError(error?.message || "Kunne ikke starte kamera og mikrofon.");
  }
}

connectSelectedSide();

window.addEventListener("beforeunload", () => {
  roomApi?.disconnect();
  matchStore.dispose();
});
