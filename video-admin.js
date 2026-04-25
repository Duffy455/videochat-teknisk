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
let latestParticipants = [];
let controlsBound = false;
let currentAttemptId = 0;
let adminAssignedSide = null;

const matchStore = createMatchStore(activeRoom, (state) => {
  renderMatchState({ state, countdownEl, bannerEl: winnerBanner, showPreselected: true });
});

function resetWinnerSelection() {
  document.querySelectorAll('input[name="preselect-winner"]').forEach((radio) => {
    radio.checked = false;
  });
}

function getPlayerParticipant(participants) {
  return participants.find((entry) => entry.role === "player");
}

function getAdminDisplaySide(participants) {
  const player = getPlayerParticipant(participants);
  if (!player) {
    return null;
  }

  return player.side === "blue" ? "green" : "blue";
}

function updateAdminSummary(participants) {
  const player = getPlayerParticipant(participants);
  adminAssignedSide = getAdminDisplaySide(participants);

  if (adminRole) {
    adminRole.textContent = player ? "Bruker er inne" : "Venter på bruker";
  }

  if (adminSide) {
    adminSide.textContent = player
      ? `Bruker er på ${player.side}. Admin er på ${adminAssignedSide}.`
      : "Admin får motsatt side når bruker kobler seg til.";
  }

  if (!player) {
    adminState.textContent = "Venter";
    adminCopy.textContent = "Admin er inne i rommet og venter på bruker.";
    return;
  }

  adminState.textContent = "Klar";
  adminCopy.textContent = "Begge er i rommet. Admin kan starte nedtelling.";
}

function updateAdminControls(participants) {
  const hasPlayer = Boolean(getPlayerParticipant(participants));

  document.querySelectorAll('[data-action], input[name="preselect-winner"]').forEach((element) => {
    element.disabled = !hasPlayer;
  });
}

function resolveAdminDisplaySide(participant) {
  if (participant.role === "admin") {
    return adminAssignedSide;
  }

  return participant.side;
}

function refreshAdminStage() {
  if (!roomApi) {
    return;
  }

  renderStageStreams({
    sideElements,
    participants: latestParticipants,
    roomApi,
    selfPeerId: peerId,
    selfDisplaySide: adminAssignedSide,
    resolveDisplaySide: resolveAdminDisplaySide,
  });
}

function applyParticipants(participants) {
  latestParticipants = participants;
  updateAdminSummary(participants);
  updateAdminControls(participants);
  refreshAdminStage();
}

function showAdminError(message) {
  adminState.textContent = "Ikke tilkoblet";
  adminCopy.textContent = message;
}

async function connectAdminRoom() {
  currentAttemptId += 1;
  const attemptId = currentAttemptId;

  adminState.textContent = "Kobler til";
  adminCopy.textContent = `Kobler admin til room ${activeRoom}.`;

  if (roomApi) {
    roomApi.disconnect();
    roomApi = null;
  }

  latestParticipants = [];
  adminAssignedSide = null;
  updateAdminControls([]);

  try {
    let pendingRoomApi = null;

    pendingRoomApi = await createVideoRoom({
      room: activeRoom,
      peerId,
      role: "admin",
      side: "admin",
      publishMedia: true,
      onStatus(message) {
        if (attemptId !== currentAttemptId) {
          return;
        }

        const player = getPlayerParticipant(latestParticipants);
        if (!player) {
          adminState.textContent = "Venter";
          adminCopy.textContent = "Admin er koblet til. Venter på bruker.";
          return;
        }

        adminState.textContent = "Tilkoblet";
        adminCopy.textContent = message;
      },
      onParticipantState(participants) {
        if (attemptId !== currentAttemptId) {
          return;
        }

        latestParticipants = participants;
        if (roomApi || pendingRoomApi) {
          applyParticipants(participants);
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
        getSelfSide: () => adminAssignedSide,
        onChange: () => refreshAdminStage(),
      });
      controlsBound = true;
    }

    applyParticipants(latestParticipants.length > 0 ? latestParticipants : roomApi.getParticipants());
  } catch (error) {
    if (attemptId !== currentAttemptId) {
      return;
    }

    showAdminError(error?.message || "Kunne ikke starte admin media.");
  }
}

window.addEventListener("error", (event) => {
  showAdminError(event.message || "JavaScript-feil på siden.");
});

window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason?.message || event.reason || "Ukjent feil under lasting.";
  showAdminError(String(reason));
});

setRoomLabel(roomLabel, activeRoom);
resetWinnerSelection();
updateAdminControls([]);
connectAdminRoom();

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
      resetWinnerSelection();
    }
  });
});

window.addEventListener("beforeunload", () => {
  currentAttemptId += 1;
  roomApi?.disconnect();
  matchStore.dispose();
});
