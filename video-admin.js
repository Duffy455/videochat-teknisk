import {
  bindMediaButtons,
  createMatchStore,
  createPeerId,
  createVideoRoom,
  getRoomFromUrl,
  renderMatchState,
  renderStageStreams,
  setRoomLabel,
} from "./video-core.js";

const peerId = createPeerId();
const activeRoom = getRoomFromUrl();
const roomLabel = document.querySelector("[data-admin-room]");
const adminState = document.querySelector("[data-admin-state]");
const adminCopy = document.querySelector("[data-admin-copy]");
const adminRole = document.querySelector("[data-admin-role]");
const adminSide = document.querySelector("[data-admin-side]");
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

let roomApi;
let controlsBound = false;
let playerConnected = false;
let adminAssignedSide = null;

function resolveAdminDisplaySide(participant) {
  if (participant.role === "admin") {
    return adminAssignedSide;
  }

  return participant.side;
}

const matchStore = createMatchStore(activeRoom, (state) => {
  renderMatchState({ state, countdownEl, bannerEl: winnerBanner });
});

function showAdminError(message) {
  adminState.textContent = "Ikke tilkoblet";
  adminCopy.textContent = message;
}

adminState.textContent = "Laster";
adminCopy.textContent = "Starter admin-siden.";

window.addEventListener("error", (event) => {
  showAdminError(event.message || "JavaScript-feil på siden.");
});

window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason?.message || event.reason || "Ukjent feil under lasting.";
  showAdminError(String(reason));
});

setRoomLabel(roomLabel, activeRoom);

function updateAdminControls() {
  if (adminRole) {
    adminRole.textContent = playerConnected ? "Bruker er inne" : "Venter på bruker";
  }

  if (adminSide) {
    adminSide.textContent = adminAssignedSide
      ? `Admin har side ${adminAssignedSide}.`
      : "Admin får motsatt side når bruker kobler seg til.";
  }

  document.querySelectorAll('[data-action], input[name="preselect-winner"]').forEach((element) => {
    element.disabled = !playerConnected;
  });
}

async function connectAdminRoom() {
  adminState.textContent = "Kobler til";
  adminCopy.textContent = `Starter admin i room ${activeRoom}.`;

  try {
    roomApi = await createVideoRoom({
      room: activeRoom,
      peerId,
      role: "admin",
      side: "admin",
      publishMedia: true,
      onStatus(message) {
        adminState.textContent = "Tilkoblet";
        adminCopy.textContent = message;
      },
      onParticipantState(participants) {
        const player = participants.find((entry) => entry.role === "player");
        playerConnected = Boolean(player);
        adminAssignedSide = player ? (player.side === "blue" ? "green" : "blue") : null;
        updateAdminControls();
        renderStageStreams({
          sideElements,
          participants,
          currentSide: adminAssignedSide,
          roomApi,
          selfPeerId: peerId,
          resolveDisplaySide: resolveAdminDisplaySide,
        });
      },
    });

    if (!controlsBound) {
      bindMediaButtons({
        roomApi,
        remoteVideos: [sideElements.blue.video, sideElements.green.video],
      });
      controlsBound = true;
    }

    renderStageStreams({
      sideElements,
      participants: roomApi.getParticipants(),
      currentSide: adminAssignedSide,
      roomApi,
      selfPeerId: peerId,
      resolveDisplaySide: resolveAdminDisplaySide,
    });

    adminState.textContent = "Tilkoblet";
    adminCopy.textContent = `Admin er koblet til room ${activeRoom}.`;
    updateAdminControls();
  } catch (error) {
    showAdminError(error?.message || "Kunne ikke starte admin media.");
  }
}

document.querySelectorAll('input[name="preselect-winner"]').forEach((radio) => {
  radio.addEventListener("change", () => {
    if (radio.checked && !radio.disabled) {
      matchStore.setPreselectedWinner(radio.value);
    }
  });
});

document.querySelectorAll("[data-action]").forEach((button) => {
  button.addEventListener("click", () => {
    if (button.disabled) {
      return;
    }

    const action = button.dataset.action;

    if (action === "start") {
      matchStore.startCountdown(30);
      return;
    }

    if (action === "blue-win") {
      matchStore.setWinner("blue");
      return;
    }

    if (action === "green-win") {
      matchStore.setWinner("green");
      return;
    }

    if (action === "reset") {
      matchStore.reset();
      document.querySelectorAll('input[name="preselect-winner"]').forEach((radio) => {
        radio.checked = false;
      });
    }
  });
});

connectAdminRoom();

window.addEventListener("beforeunload", () => {
  roomApi?.disconnect();
  matchStore.dispose();
});
