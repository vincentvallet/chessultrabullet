"use strict";

const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"];
const COLORS = ["white", "black"];
const MAIN_ROOM_ID = "main";
const COLOR_LABELS = { white: "Blancs", black: "Noirs", spectator: "Spectateur" };
const TURN_LABELS = { white: "Blancs", black: "Noirs" };
const AVATAR_OPTIONS = [
  { id: "cat", label: "Chat" },
  { id: "dog", label: "Chien" },
  { id: "fox", label: "Renard" },
  { id: "panda", label: "Panda" },
  { id: "owl", label: "Hibou" },
  { id: "tiger", label: "Tigre" }
];
const PROMOTION_OPTIONS = [
  { type: "Q", label: "Dame" },
  { type: "R", label: "Tour" },
  { type: "B", label: "Fou" },
  { type: "N", label: "Cavalier" }
];
const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
const PERFORMANCE_MODE = true;
const ENABLE_PERF_DIAGNOSTICS = false;
const effectivePerformanceMode = PERFORMANCE_MODE || isSafari;
const INTENT_MIN_INTERVAL_MS = 34;
const INTENT_MIN_DELTA = effectivePerformanceMode ? 0.004 : 0.003;
const TRAIL_POINT_LIMIT = effectivePerformanceMode ? 24 : 30;
const TRAIL_MAX_AGE_MS = effectivePerformanceMode ? 950 : 1050;
const TRAIL_POINT_MIN_INTERVAL_MS = 34;
const REMOTE_CURSOR_EASING = effectivePerformanceMode ? 0.46 : 0.52;
const CLOCK_DEFAULT_MS = 60000;
const BOARD_SIZE_MIN = 420;
const BOARD_SIZE_MAX = 860;
const NOTATION_SYMBOLS = {
  white: { K: "\u2654", Q: "\u2655", R: "\u2656", B: "\u2657", N: "\u2658", P: "" },
  black: { K: "\u265a", Q: "\u265b", R: "\u265c", B: "\u265d", N: "\u265e", P: "" }
};
const ARROW_COLORS = {
  green: "#45d483",
  red: "#ff5f72"
};
const ARROW_END_MARGIN_PERCENT = 3.2;
const ARROW_HEAD_LENGTH_PERCENT = 3.4;
const ARROW_HEAD_WIDTH_PERCENT = 2.5;
const PIECE_SYMBOLS = {
  white: { K: "♔", Q: "♕", R: "♖", B: "♗", N: "♘", P: "♙" },
  black: { K: "♚", Q: "♛", R: "♜", B: "♝", N: "♞", P: "♟" }
};

let socket = null;
let clientId = null;
let myRole = null;
let gameState = {
  board: {},
  turn: "white",
  moveHistory: [],
  lastMove: null,
  status: "playing",
  check: null,
  winner: null,
  gameOver: false,
  resultReason: null,
  halfmoveClock: 0,
  clock: createDefaultClockState(),
  ready: createDefaultReadyState(),
  countdown: createDefaultCountdownState(),
  createdAt: Date.now()
};
let playersState = { white: false, black: false, spectators: 0 };
let lobbyStateData = { rooms: [], challenges: [] };
let currentRoom = null;
let chatMessages = [];
let selectedAvatar = null;
let selectedName = "";
let remoteIntents = new Map();
let localIntent = createEmptyLocalIntent();
let selectedPiece = null;
let dragState = createEmptyDragState();
let boardOrientation = "white";
let premoveQueue = [];
let pendingPremoveAttempt = null;
let viewingMoveIndex = null;
let soundEnabled = true;
let audioContext = null;
let lastSoundMoveKey = null;
let lastConfettiKey = null;
let boardSize = 730;
let boardTheme = "classic";
let choosePromotion = false;
let pendingLocalMove = null;
let boardArrows = [];
let arrowDragState = createEmptyArrowDragState();
let takebackOffer = null;
let drawOffer = null;
let matchScore = createEmptyMatchScore();
let lastScoredGameKey = "";

const els = {};
let listenersAttached = false;
let lastIntentSentAt = 0;
let queuedIntent = null;
let intentTimer = 0;
let overlayFrame = 0;
let clockFrame = 0;
let countdownFrame = 0;
let errorTimer = 0;
let localHighlightState = { hover: null, target: null, origin: null };
let pendingPromotionResolve = null;
let lastSentIntentSnapshot = null;
let lastClockText = { white: "", black: "" };
let lastRenderedBoardKey = "";
let lastClockControlMode = "";
let lastCountdownSoundKey = "";
let lastCountdownGoKey = "";

const remoteDom = {
  cursors: new Map(),
  ghosts: new Map(),
  halos: new Map(),
  trails: new Map()
};
const perfStats = {
  intentsSent: 0,
  intentsReceived: 0,
  renderBoardCalls: 0,
  lastPointerMoveAt: 0,
  diagnosticsStarted: false
};

document.addEventListener("DOMContentLoaded", () => {
  cacheElements();
  document.body.classList.toggle("performance-mode", effectivePerformanceMode);
  document.body.classList.toggle("safari", isSafari);
  bindUi();
  startPerfDiagnostics();
  renderApp();
  connectWebSocket();
});

function connectWebSocket() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  setConnectionState("connecting");
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${protocol}://${location.host}`);

  socket.addEventListener("open", handleSocketOpen);
  socket.addEventListener("message", (event) => handleSocketMessage(event.data));
  socket.addEventListener("close", handleSocketClose);
  socket.addEventListener("error", (event) => {
    console.error("[ws] erreur", event);
    showError("Connexion perdue.");
  });
}

function handleSocketOpen() {
  console.log("[ws] connecté");
  setConnectionState("connected");
}

function handleSocketMessage(message) {
  let data = null;

  try {
    data = JSON.parse(message);
  } catch (error) {
    console.warn("[ws] message invalide", message);
    return;
  }

  if (!data || typeof data.type !== "string") return;
  if (data.type !== "intent") {
    console.log("[ws] reçu", data.type, data);
  }

  if (data.type === "welcome") {
    clientId = data.clientId;
    myRole = data.role;
    currentRoom = normalizeRoom(data.room);
    lobbyStateData = normalizeLobby(data.lobby);
    gameState = normalizeGameState(data.gameState);
    playersState = normalizePlayersState(data.players);
    chatMessages = normalizeChatMessages(data.chatMessages);
    boardArrows = normalizeArrows(data.arrows);
    if (Object.prototype.hasOwnProperty.call(data, "drawOffer")) {
      drawOffer = normalizeDrawOffer(data.drawOffer);
    }
    remoteIntents = new Map();
    clearRemoteOverlay();
    boardOrientation = myRole === "black" ? "black" : "white";
    selectedAvatar = currentProfileAvatar() || defaultAvatarForRole(myRole);
    selectedName = currentProfileName();
    syncMatchScorePair();
    resetLocalDrag();
    renderApp();
    sendMessage({ type: "profile", avatar: selectedAvatar, name: selectedName });
    showRoleMessage();
    return;
  }

  if (data.type === "players") {
    playersState = normalizePlayersState(data.players);
    selectedAvatar = currentProfileAvatar() || selectedAvatar;
    selectedName = currentProfileName();
    syncMatchScorePair();
    removeDisconnectedIntents();
    renderLayoutMode();
    renderStatus();
    renderReadyControls();
    renderProfiles();
    renderAvatarChoices();
    renderLobby();
    renderMatchScore();
    scheduleIntentRender();
    return;
  }

  if (data.type === "lobby") {
    lobbyStateData = normalizeLobby(data.lobby);
    if (data.room) currentRoom = normalizeRoom(data.room);
    renderLayoutMode();
    renderLobby();
    return;
  }

  if (data.type === "roomJoined") {
    myRole = data.role;
    currentRoom = normalizeRoom(data.room);
    lobbyStateData = normalizeLobby(data.lobby);
    gameState = normalizeGameState(data.gameState);
    playersState = normalizePlayersState(data.players);
    chatMessages = normalizeChatMessages(data.chatMessages);
    boardArrows = normalizeArrows(data.arrows);
    remoteIntents = new Map();
    clearRemoteOverlay();
    premoveQueue = [];
    pendingPremoveAttempt = null;
    pendingLocalMove = null;
    takebackOffer = null;
    drawOffer = normalizeDrawOffer(data.drawOffer);
    syncMatchScorePair();
    boardOrientation = myRole === "black" ? "black" : "white";
    renderApp();
    return;
  }

  if (data.type === "intent") {
    if (data.clientId && data.clientId !== clientId) {
      updateRemoteIntent(data.clientId, data);
    }
    return;
  }

  if (data.type === "arrows") {
    boardArrows = normalizeArrows(data.arrows);
    renderArrows();
    return;
  }

  if (data.type === "takebackOffer") {
    takebackOffer = normalizeTakebackOffer(data.offer);
    renderTakeback();
    return;
  }

  if (data.type === "takebackCleared") {
    takebackOffer = null;
    renderTakeback();
    return;
  }

  if (data.type === "drawOffer") {
    drawOffer = normalizeDrawOffer(data.offer);
    renderDrawOffer();
    return;
  }

  if (data.type === "drawOfferCleared") {
    drawOffer = null;
    renderDrawOffer();
    return;
  }

  if (data.type === "gameState" || data.type === "resetDone") {
    const previousState = gameState;
    const dragSnapshot = snapshotActiveDrag();
    pendingLocalMove = null;
    pendingPremoveAttempt = null;
    takebackOffer = null;
    if (Object.prototype.hasOwnProperty.call(data, "drawOffer")) {
      drawOffer = normalizeDrawOffer(data.drawOffer);
    }
    if (data.role && isPlayerRole(data.role)) {
      myRole = data.role;
    }
    if (data.room) {
      currentRoom = normalizeRoom(data.room);
    }
    if (data.players) {
      playersState = normalizePlayersState(data.players);
    }
    gameState = normalizeGameState(data.gameState);
    if (!hasGameStarted()) {
      premoveQueue = [];
      pendingPremoveAttempt = null;
      pendingLocalMove = null;
      viewingMoveIndex = null;
    }
    if (data.type === "resetDone") {
      remoteIntents = new Map();
      clearRemoteOverlay();
      premoveQueue = [];
      pendingPremoveAttempt = null;
      viewingMoveIndex = null;
      boardArrows = normalizeArrows(data.arrows);
      lastConfettiKey = null;
      lastSoundMoveKey = null;
      boardOrientation = myRole === "black" ? "black" : "white";
      selectedAvatar = currentProfileAvatar() || selectedAvatar;
      selectedName = currentProfileName();
      syncMatchScorePair();
    }
    const keepDrag = data.type !== "resetDone" && canKeepDragAfterState(dragSnapshot);
    if (keepDrag) {
      restoreDragAfterState(dragSnapshot);
    } else {
      resetLocalDrag();
    }
    if (!gameState.gameOver) {
      viewingMoveIndex = null;
    }
    renderApp();
    handleOfficialStateEffects(previousState, gameState, data.type === "resetDone");
    trySendNextPremove();
    if (data.type === "resetDone") {
      showError("Rematch lance.");
    }
    return;
  }

  if (data.type === "error") {
    if (pendingLocalMove) {
      pendingLocalMove = null;
      renderBoard();
    }
    if (pendingPremoveAttempt) {
      pendingPremoveAttempt = null;
      premoveQueue = [];
      renderBoard();
      renderPremoveList();
    }
    showError(data.message || "Erreur inconnue.");
    return;
  }

  if (data.type === "chat") {
    if (data.message) {
      const message = normalizeChatMessage(data.message);
      if (message) {
        chatMessages.push(message);
        if (chatMessages.length > 80) {
          chatMessages.splice(0, chatMessages.length - 80);
        }
        renderChat();
      }
    }
  }
}

function handleSocketClose() {
  console.warn("[ws] déconnecté");
  socket = null;
  setConnectionState("disconnected");
  resetLocalDrag();
  showError("Connexion perdue.");
}

function sendMessage(data) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    showError("Déconnecté — recharge la page.");
    return false;
  }

  socket.send(JSON.stringify(data));
  return true;
}

function startPerfDiagnostics() {
  if (!ENABLE_PERF_DIAGNOSTICS) return;
  if (perfStats.diagnosticsStarted) return;
  perfStats.diagnosticsStarted = true;

  window.setInterval(() => {
    console.log("[perf] intent received/sec", perfStats.intentsReceived);
    console.log("[perf] intent sent/sec", perfStats.intentsSent);
    console.log("[perf] renderBoard calls/sec", perfStats.renderBoardCalls);

    if (perfStats.renderBoardCalls > 4) {
      console.warn("[perf] renderBoard called often this second", perfStats.renderBoardCalls);
    }

    perfStats.intentsReceived = 0;
    perfStats.intentsSent = 0;
    perfStats.renderBoardCalls = 0;
  }, 1000);
}

function shouldSkipIntentPayload(payload) {
  const previous = queuedIntent || lastSentIntentSnapshot;
  if (!previous) return false;

  if (payload.state !== previous.state) return false;
  if (payload.hoveredSquare !== previous.hoveredSquare) return false;
  if (payload.fromSquare !== previous.fromSquare) return false;
  if (payload.targetSquare !== previous.targetSquare) return false;
  if (intentPieceSignature(payload.grabbedPiece) !== intentPieceSignature(previous.grabbedPiece)) return false;

  return Math.hypot(payload.nx - previous.nx, payload.ny - previous.ny) < INTENT_MIN_DELTA;
}

function intentPieceSignature(piece) {
  if (!piece) return "";
  return `${piece.color || ""}:${piece.type || ""}`;
}

function sendIntentThrottled(intent, immediate = false) {
  if (myRole !== "white" && myRole !== "black") return;

  const payload = {
    type: "intent",
    state: intent.state || "idle",
    nx: clamp(intent.nx, 0, 1),
    ny: clamp(intent.ny, 0, 1),
    hoveredSquare: intent.hoveredSquare || null,
    fromSquare: intent.fromSquare || null,
    targetSquare: intent.targetSquare || null,
    grabbedPiece: intent.grabbedPiece || null,
    orientation: boardOrientation,
    timestamp: Date.now()
  };

  if (!immediate && shouldSkipIntentPayload(payload)) {
    return;
  }

  queuedIntent = payload;

  if (immediate) {
    if (intentTimer) {
      window.clearTimeout(intentTimer);
      intentTimer = 0;
    }
    sendQueuedIntent();
    return;
  }

  const now = performance.now();
  const delay = Math.max(0, INTENT_MIN_INTERVAL_MS - (now - lastIntentSentAt));

  if (delay === 0) {
    sendQueuedIntent();
    return;
  }

  if (!intentTimer) {
    intentTimer = window.setTimeout(() => {
      intentTimer = 0;
      sendQueuedIntent();
    }, delay);
  }
}

function renderApp() {
  renderLayoutMode();
  renderStatus();
  renderReadyControls();
  renderCountdownOverlay();
  renderProfiles();
  renderAvatarChoices();
  renderLobby();
  renderBoard();
  renderHistory();
  renderChat();
  renderPremoveList();
  renderTakeback();
  renderDrawOffer();
  renderMatchScore();
  applyBoardPreferences();
  renderSoundToggle();
  renderPromotionMode();
  renderArrows();
  scheduleIntentRender();
  scheduleClockRender();
}

function renderLayoutMode() {
  document.body.classList.toggle("lobby-only", !shouldShowGameArea());
}

function shouldShowGameArea() {
  if (hasGameStarted() || gameState.gameOver || isCountdownActive()) return true;
  if (!currentRoom || currentRoom.id === MAIN_ROOM_ID) return false;
  return Boolean(playersState.white && playersState.black);
}

function renderBoard() {
  if (!els.board) return;

  perfStats.renderBoardCalls += 1;
  if (ENABLE_PERF_DIAGNOSTICS && dragState.active && perfStats.lastPointerMoveAt && performance.now() - perfStats.lastPointerMoveAt < 120) {
    console.warn("[perf] renderBoard called shortly after pointer movement");
  }

  const displayModel = currentDisplayModel();
  const displayBoard = displayModel.board;
  els.board.textContent = "";
  els.board.classList.toggle("readonly", myRole === "spectator" || !myRole);
  els.board.classList.toggle("reviewing", viewingMoveIndex !== null);
  els.board.dataset.orientation = boardOrientation;

  const fragment = document.createDocumentFragment();
  const displaySquares = getDisplaySquares();

  displaySquares.forEach((squareName, index) => {
    const square = document.createElement("div");
    square.className = `square ${squareShade(squareName)}`;
    square.dataset.square = squareName;
    square.setAttribute("role", "gridcell");
    square.setAttribute("aria-label", squareName);

    if (gameState.lastMove && gameState.lastMove.from === squareName) {
      square.classList.add("last-from");
    }

    if (gameState.lastMove && gameState.lastMove.to === squareName) {
      square.classList.add("last-to");
    }

    if (gameState.check && findKingSquare(gameState.check) === squareName) {
      square.classList.add("king-check");
    }

    if (dragState.active && dragState.fromSquare === squareName) {
      square.classList.add("local-origin");
    }

    if (dragState.active && dragState.targetSquare === squareName) {
      square.classList.add("local-target");
    }

    addCoordinates(square, squareName, index);
    fragment.appendChild(square);
  });

  els.board.appendChild(fragment);
  renderPieces(displayBoard, displayModel.underlays);
  renderPremoveHighlights();
  localHighlightState = {
    hover: null,
    target: dragState.active ? dragState.targetSquare : null,
    origin: dragState.active ? dragState.fromSquare : null
  };
}

function renderPieces(board = gameState.board || {}, underlays = {}) {

  for (const [squareName, piece] of Object.entries(board)) {
    const square = els.board.querySelector(`[data-square="${squareName}"]`);
    if (!square || !piece) continue;

    const underlay = underlays && underlays[squareName];
    if (underlay) {
      square.appendChild(createPieceElement(underlay, "premove-underlay-piece"));
    }

    const pieceEl = createPieceElement(piece, underlay ? "premove-overlay-piece" : "");

    if (gameState.lastMove && gameState.lastMove.to === squareName) {
      pieceEl.classList.add("just-moved");
    }

    if (dragState.active && dragState.fromSquare === squareName) {
      pieceEl.classList.add("source-drag-piece");
    }

    square.appendChild(pieceEl);
  }
}

function createPieceElement(piece, extraClass = "") {
  const img = document.createElement("img");
  img.className = `piece-img ${piece.color}-piece${extraClass ? ` ${extraClass}` : ""}`;
  img.src = pieceAssetPath(piece);
  img.alt = "";
  img.draggable = false;
  img.setAttribute("aria-hidden", "true");
  img.addEventListener("error", () => {
    img.replaceWith(createUnicodePieceElement(piece, extraClass));
  }, { once: true });
  return img;
}

function createUnicodePieceElement(piece, extraClass = "") {
  const pieceEl = document.createElement("span");
  pieceEl.className = `piece ${piece.color}-piece${extraClass ? ` ${extraClass}` : ""}`;
  pieceEl.textContent = piece.symbol;
  pieceEl.setAttribute("aria-hidden", "true");
  return pieceEl;
}

function pieceAssetPath(piece) {
  const prefix = piece.color === "white" ? "w" : "b";
  return `/pieces/${prefix}${piece.type}.svg`;
}

function setGhostPiece(element, piece) {
  const key = `${piece.color}-${piece.type}`;
  if (element.dataset.pieceKey === key) return;

  element.textContent = "";
  element.dataset.pieceKey = key;

  const img = document.createElement("img");
  img.className = "ghost-piece-img";
  img.src = pieceAssetPath(piece);
  img.alt = "";
  img.draggable = false;
  img.addEventListener("error", () => {
    element.textContent = piece.symbol;
  }, { once: true });
  element.appendChild(img);
}

function renderStatus() {
  const connected = socket && socket.readyState === WebSocket.OPEN;
  const roleText = roleLabel(myRole);
  const playersConnected = Number(Boolean(playersState.white)) + Number(Boolean(playersState.black));
  const spectators = Number(playersState.spectators || 0);

  setText(els.roleText, roleText);
  setText(els.connectionText, connected ? "Connecté" : connectionTextFromSocket());
  setText(els.whiteText, playersState.white ? "Connecté" : "Absent");
  setText(els.blackText, playersState.black ? "Connecté" : "Absent");
  setText(els.spectatorsText, String(spectators));
  setText(els.turnText, statusLabel());
  setText(els.turnBadge, statusLabel());
  setText(els.playersBadge, `Joueurs : ${playersConnected}/2 · Spectateurs : ${spectators}`);
  setText(els.roleBadge, roleText);

  els.roleBadge.className = `badge ${roleClass(myRole)}`;
  els.connectionBadge.className = connected ? "badge connected" : "badge danger";
  setText(els.connectionBadge, connected ? "Connecté" : connectionTextFromSocket());

  const status = computeShortStatus(connected);
  setText(els.shortStatus, status);

  if (els.chatInput) {
    els.chatInput.disabled = !canUseChat();
    els.chatInput.placeholder = shouldShowGameArea()
      ? "Message de partie"
      : "Message au salon";
  }

  renderClockControls();
  renderGameActionButton();
  renderClock();
}

function renderClockControls() {
  if (!els.clockInput) return;

  const mode = isAddTimeMode() ? "add" : "config";
  if (mode !== lastClockControlMode && document.activeElement !== els.clockInput) {
    els.clockInput.value = mode === "add"
      ? "10"
      : String(Math.round(((gameState.clock && gameState.clock.initialMs) || CLOCK_DEFAULT_MS) / 1000));
  } else if (mode === "config" && gameState.clock && document.activeElement !== els.clockInput) {
    els.clockInput.value = String(Math.round((gameState.clock.initialMs || CLOCK_DEFAULT_MS) / 1000));
  }

  lastClockControlMode = mode;

  setText(els.clockModeLabel, mode === "add" ? "Ajouter" : "");
  setText(els.clockUnitText, "s");
  setText(els.clockSubmitBtn, mode === "add" ? "Ajouter" : "Appliquer");

  if (els.clockTargetSelect) {
    els.clockTargetSelect.hidden = mode !== "add";
  }
}

function isAddTimeMode() {
  return Boolean(gameState.clock && gameState.clock.started && !gameState.gameOver);
}

function canUseChat() {
  return Boolean(socket && socket.readyState === WebSocket.OPEN);
}

function renderGameActionButton() {
  if (els.newGameBtn) {
    const canRematch = isPlayerRole(myRole) && gameState.gameOver;
    els.newGameBtn.hidden = !canRematch;
    els.newGameBtn.disabled = !canRematch;
    els.newGameBtn.textContent = "Rematch";
    els.newGameBtn.classList.toggle("rematch-pulse", canRematch);
  }
  if (els.returnLobbyBtn) {
    const awayFromSalon = Boolean(currentRoom && currentRoom.id !== MAIN_ROOM_ID);
    els.returnLobbyBtn.hidden = !awayFromSalon;
    els.returnLobbyBtn.disabled = !awayFromSalon;
  }

  const canUseGameActions = isPlayerRole(myRole) && !gameState.gameOver;
  if (els.takebackBtn) {
    els.takebackBtn.disabled = !canUseGameActions;
  }
  if (els.drawBtn) {
    els.drawBtn.disabled = !canUseGameActions;
  }
  if (els.resignBtn) {
    els.resignBtn.disabled = !canUseGameActions;
  }
}

function renderReadyControls() {
  if (!els.readyBtn || !els.readyStatus) return;

  const ready = gameState.ready || createDefaultReadyState();
  const countdownActive = isCountdownActive();
  const started = hasGameStarted();
  const bothPlayers = Boolean(playersState.white && playersState.black);
  const myReady = isPlayerRole(myRole) && Boolean(ready[myRole]);
  const readyCount = Number(Boolean(ready.white)) + Number(Boolean(ready.black));

  els.readyBtn.hidden = gameState.gameOver;
  els.readyBtn.disabled = !isPlayerRole(myRole) || gameState.gameOver || started || countdownActive;
  els.readyBtn.textContent = countdownActive
    ? "Depart..."
    : started
      ? "Partie lancee"
      : myReady
        ? "Pret"
        : "Pret a jouer";

  els.readyStatus.classList.toggle("is-ready", myReady);
  els.readyStatus.classList.toggle("is-countdown", countdownActive);

  if (!isPlayerRole(myRole)) {
    els.readyStatus.textContent = "Observation";
    return;
  }

  if (gameState.gameOver) {
    els.readyStatus.textContent = "Rematch disponible";
    return;
  }

  if (started) {
    els.readyStatus.textContent = "Partie en cours";
    return;
  }

  if (countdownActive) {
    els.readyStatus.textContent = `Depart dans ${countdownNumber()}`;
    return;
  }

  if (!bothPlayers) {
    els.readyStatus.textContent = myReady ? "Pret, adversaire attendu" : "Adversaire attendu";
    return;
  }

  els.readyStatus.textContent = `Prets : ${readyCount}/2`;
}

function renderCountdownOverlay() {
  if (!els.countdownOverlay || !els.countdownText) return;

  const visible = isCountdownActive() && !hasGameStarted() && !gameState.gameOver;
  els.countdownOverlay.hidden = !visible;

  if (!visible) {
    if (countdownFrame) {
      cancelAnimationFrame(countdownFrame);
      countdownFrame = 0;
    }
    return;
  }

  const number = countdownNumber();
  els.countdownText.textContent = String(number);
  playCountdownTickIfNeeded(number);
  scheduleCountdownRender();
}

function scheduleCountdownRender() {
  if (countdownFrame) return;

  countdownFrame = requestAnimationFrame(() => {
    countdownFrame = 0;
    renderReadyControls();
    renderCountdownOverlay();
  });
}

function isCountdownActive() {
  return Boolean(gameState.countdown && gameState.countdown.active);
}

function countdownRemainingMs() {
  const countdown = gameState.countdown || createDefaultCountdownState();
  if (!countdown.active || !countdown.endsAt) return 0;

  const serverNow = Number(countdown.serverNow) || Number(countdown.startedAt) || Date.now();
  const receivedAt = Number(countdown.receivedAt) || Date.now();
  const projectedNow = serverNow + Math.max(0, Date.now() - receivedAt);
  return Math.max(0, Number(countdown.endsAt) - projectedNow);
}

function countdownNumber() {
  if (!isCountdownActive()) return 0;
  return clamp(Math.ceil(countdownRemainingMs() / 1000), 1, 3);
}

function playCountdownTickIfNeeded(number) {
  const countdown = gameState.countdown || createDefaultCountdownState();
  const key = `${countdown.startedAt || ""}:${number}`;
  if (!countdown.active || key === lastCountdownSoundKey) return;
  lastCountdownSoundKey = key;
  playRaceStartSound(number);
}

function scheduleClockRender() {
  if (clockFrame) return;

  clockFrame = requestAnimationFrame(() => {
    clockFrame = 0;
    renderClock();

    const clock = currentClockState();
    if (clock.running && !gameState.gameOver) {
      scheduleClockRender();
    }
  });
}

function renderClock() {
  if (!els.whiteClock || !els.blackClock) return;

  applyClockOrder();

  const clock = currentClockState();
  const whiteText = formatClockMs(clock.whiteMs);
  const blackText = formatClockMs(clock.blackMs);

  if (whiteText !== lastClockText.white) {
    els.whiteClock.textContent = whiteText;
    lastClockText.white = whiteText;
  }

  if (blackText !== lastClockText.black) {
    els.blackClock.textContent = blackText;
    lastClockText.black = blackText;
  }

  if (els.whiteClockBox) {
    els.whiteClockBox.classList.toggle("active", clock.running && clock.activeColor === "white" && !gameState.gameOver);
    els.whiteClockBox.classList.toggle("danger", clock.whiteMs <= 500);
    setClockGauge(els.whiteClockBox, els.whiteClockGauge, clock.whiteMs, clock.initialMs);
  }

  if (els.blackClockBox) {
    els.blackClockBox.classList.toggle("active", clock.running && clock.activeColor === "black" && !gameState.gameOver);
    els.blackClockBox.classList.toggle("danger", clock.blackMs <= 500);
    setClockGauge(els.blackClockBox, els.blackClockGauge, clock.blackMs, clock.initialMs);
  }
}

function applyClockOrder() {
  const bottomColor = isPlayerRole(myRole) ? myRole : boardOrientation;
  if (els.whiteClockBox) {
    els.whiteClockBox.style.order = bottomColor === "white" ? "2" : "1";
  }
  if (els.blackClockBox) {
    els.blackClockBox.style.order = bottomColor === "black" ? "2" : "1";
  }
}

function setClockGauge(box, gauge, ms, initialMs) {
  const ratio = clamp(initialMs ? ms / initialMs : 0, 0, 1);
  const hue = Math.round(ratio * 120);
  const color = `hsl(${hue} 78% 52%)`;

  box.style.setProperty("--clock-color", color);
  box.style.setProperty("--clock-ratio", ratio.toFixed(4));

  if (gauge) {
    gauge.style.transform = `scaleX(${ratio})`;
    gauge.style.background = color;
  }
}

function currentClockState() {
  const clock = gameState.clock || createDefaultClockState();
  const state = {
    initialMs: Number(clock.initialMs) || CLOCK_DEFAULT_MS,
    whiteMs: Number(clock.whiteMs) || 0,
    blackMs: Number(clock.blackMs) || 0,
    activeColor: clock.activeColor === "black" ? "black" : "white",
    started: Boolean(clock.started),
    running: Boolean(clock.running),
    updatedAt: Number(clock.updatedAt) || Date.now(),
    serverNow: Number(clock.serverNow) || Number(clock.updatedAt) || Date.now(),
    receivedAt: Number(clock.receivedAt) || Date.now()
  };

  if (state.started && state.running && !gameState.gameOver) {
    const elapsedBeforeReceive = Math.max(0, state.serverNow - state.updatedAt);
    const elapsedAfterReceive = Math.max(0, Date.now() - state.receivedAt);
    const elapsed = elapsedBeforeReceive + elapsedAfterReceive;
    const activeKey = `${state.activeColor}Ms`;
    state[activeKey] = Math.max(0, state[activeKey] - elapsed);
  }

  return state;
}

function formatClockMs(ms) {
  const safeMs = Math.max(0, Math.floor(Number(ms) || 0));
  const totalSeconds = Math.floor(safeMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const milliseconds = safeMs % 1000;

  if (minutes >= 1) {
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}:${String(milliseconds).padStart(3, "0")}`;
  }

  return `${totalSeconds}.${String(milliseconds).padStart(3, "0")}`;
}

function submitClockConfig() {
  if (myRole === "spectator") {
    showError("Les spectateurs ne peuvent pas régler le chronomètre.");
    return;
  }

  if (!isPlayerRole(myRole)) {
    showError("Connexion au serveur...");
    return;
  }

  const seconds = Number(els.clockInput ? els.clockInput.value : 60);
  if (!Number.isFinite(seconds) || seconds < 1) {
    showError("Chronomètre invalide.");
    return;
  }

  if (isAddTimeMode()) {
    sendMessage({
      type: "addTime",
      seconds,
      target: els.clockTargetSelect ? els.clockTargetSelect.value : "opponent"
    });
    return;
  }

  sendMessage({ type: "clockConfig", seconds });
}

function submitProfile() {
  selectedName = sanitizeName(els.nameInput ? els.nameInput.value : selectedName);
  sendMessage({ type: "profile", avatar: selectedAvatar || defaultAvatarForRole(myRole), name: selectedName });
  renderProfiles();
}

function handleOfficialStateEffects(previousState, nextState, isReset) {
  if (isReset) return;

  const countdownJustFinished = previousState
    && previousState.countdown
    && previousState.countdown.active
    && (!nextState.countdown || !nextState.countdown.active)
    && nextState.clock
    && nextState.clock.started;
  if (countdownJustFinished) {
    const goKey = `${previousState.countdown.startedAt || ""}:go`;
    if (goKey !== lastCountdownGoKey) {
      lastCountdownGoKey = goKey;
      playRaceStartSound("go");
    }
  }

  const move = nextState.lastMove || null;
  const moveKey = move ? `${move.color}:${move.from}:${move.to}:${move.timestamp || nextState.moveHistory.length}` : "";
  if (move && moveKey && moveKey !== lastSoundMoveKey) {
    lastSoundMoveKey = moveKey;
    if (nextState.status === "checkmate") {
      playSound("mate");
    } else if (nextState.check) {
      playSound("check");
    } else if (move.special === "castling") {
      playSound("castle");
    } else {
      playSound("move");
    }
  }

  recordCompletedGame(nextState);

  if (nextState.gameOver && nextState.winner) {
    const confettiKey = `${nextState.status}:${nextState.winner}:${nextState.moveHistory.length}`;
    if (confettiKey !== lastConfettiKey) {
      lastConfettiKey = confettiKey;
      launchConfetti(nextState.winner);
    }
  }
}

function syncMatchScorePair() {
  const pair = currentMatchPair();
  if (!pair) return;

  const pairKey = pair.map((player) => player.id).sort().join("|");
  if (matchScore.pairKey !== pairKey) {
    matchScore = {
      pairKey,
      players: pair,
      games: []
    };
    lastScoredGameKey = "";
    return;
  }

  matchScore.players = pair;
}

function currentMatchPair() {
  const profiles = playersState.profiles || {};
  const white = profiles.white;
  const black = profiles.black;
  if (!white || !black || !white.clientId || !black.clientId || white.clientId === black.clientId) return null;

  return [
    {
      id: white.clientId,
      role: "white",
      label: profileTitle(white, "white")
    },
    {
      id: black.clientId,
      role: "black",
      label: profileTitle(black, "black")
    }
  ];
}

function recordCompletedGame(state) {
  if (!state || !state.gameOver) return;
  syncMatchScorePair();
  if (!matchScore.pairKey) return;

  const key = [
    currentRoom ? currentRoom.id : "",
    state.status || "",
    state.resultReason || "",
    state.winner || "draw",
    Array.isArray(state.moveHistory) ? state.moveHistory.length : 0,
    state.lastMove && state.lastMove.timestamp ? state.lastMove.timestamp : state.createdAt
  ].join(":");

  if (key === lastScoredGameKey) return;
  lastScoredGameKey = key;

  const profiles = playersState.profiles || {};
  const winnerId = state.winner && profiles[state.winner] ? profiles[state.winner].clientId : null;
  const isDraw = !winnerId;

  matchScore.games.push({
    key,
    winnerId,
    draw: isDraw,
    timestamp: Date.now()
  });

  if (matchScore.games.length > 24) {
    matchScore.games.splice(0, matchScore.games.length - 24);
  }

  renderMatchScore();
}

function renderMatchScore() {
  if (!els.matchScore) return;

  syncMatchScorePair();
  els.matchScore.textContent = "";

  if (!matchScore.pairKey || matchScore.players.length !== 2) {
    const empty = document.createElement("div");
    empty.className = "match-score-empty";
    empty.textContent = "Score rencontre : en attente de deux joueurs.";
    els.matchScore.appendChild(empty);
    return;
  }

  const totals = matchScoreTotals();
  const header = document.createElement("div");
  header.className = "match-score-head";
  const title = document.createElement("strong");
  title.textContent = "Score rencontre";
  const totalText = document.createElement("span");
  totalText.textContent = `${formatScorePoint(totals[matchScore.players[0].id])} - ${formatScorePoint(totals[matchScore.players[1].id])}`;
  header.appendChild(title);
  header.appendChild(totalText);
  els.matchScore.appendChild(header);

  const grid = document.createElement("div");
  grid.className = "match-score-grid";

  matchScore.players.forEach((player) => {
    const name = document.createElement("div");
    name.className = "match-score-name";
    name.textContent = player.label;

    const games = document.createElement("div");
    games.className = "match-score-games";
    if (!matchScore.games.length) {
      const dash = document.createElement("span");
      dash.className = "score-chip empty";
      dash.textContent = "-";
      games.appendChild(dash);
    } else {
      matchScore.games.forEach((game) => games.appendChild(createScoreChip(player.id, game)));
    }

    const total = document.createElement("div");
    total.className = "match-score-total";
    total.textContent = formatScorePoint(totals[player.id]);

    grid.appendChild(name);
    grid.appendChild(games);
    grid.appendChild(total);
  });

  els.matchScore.appendChild(grid);
}

function createScoreChip(playerId, game) {
  const chip = document.createElement("span");
  if (game.draw) {
    chip.className = "score-chip draw";
    chip.textContent = "1/2";
    return chip;
  }

  const won = game.winnerId === playerId;
  chip.className = `score-chip ${won ? "win" : "loss"}`;
  chip.textContent = won ? "1" : "0";
  return chip;
}

function matchScoreTotals() {
  const totals = {};
  matchScore.players.forEach((player) => {
    totals[player.id] = 0;
  });

  matchScore.games.forEach((game) => {
    if (game.draw) {
      matchScore.players.forEach((player) => {
        totals[player.id] += 0.5;
      });
      return;
    }

    if (game.winnerId && Object.prototype.hasOwnProperty.call(totals, game.winnerId)) {
      totals[game.winnerId] += 1;
    }
  });

  return totals;
}

function formatScorePoint(value) {
  const number = Number(value) || 0;
  return Number.isInteger(number) ? String(number) : number.toFixed(1);
}

function renderSoundToggle() {
  if (!els.soundToggleBtn) return;
  els.soundToggleBtn.textContent = soundEnabled ? "Sons actives" : "Sons coupes";
  els.soundToggleBtn.setAttribute("aria-pressed", soundEnabled ? "true" : "false");
}

function renderPromotionMode() {
  if (!els.promotionChoiceToggle) return;
  els.promotionChoiceToggle.checked = Boolean(choosePromotion);
}

function applyBoardPreferences() {
  const maxBoardSize = currentBoardSizeMax();
  boardSize = clamp(boardSize, BOARD_SIZE_MIN, maxBoardSize);

  if (els.boardWrap) {
    els.boardWrap.style.setProperty("--board-size", `${boardSize}px`);
  }

  document.body.dataset.boardTheme = boardTheme;
  if (els.boardSizeInput) {
    els.boardSizeInput.min = String(BOARD_SIZE_MIN);
    els.boardSizeInput.max = String(maxBoardSize);
  }
  if (els.boardSizeInput && Number(els.boardSizeInput.value) !== boardSize) {
    els.boardSizeInput.value = String(boardSize);
  }
  if (els.boardThemeSelect && els.boardThemeSelect.value !== boardTheme) {
    els.boardThemeSelect.value = boardTheme;
  }
}

function currentBoardSizeMax() {
  const layoutWidth = els.boardColumn
    ? els.boardColumn.getBoundingClientRect().width
    : BOARD_SIZE_MAX;
  const heightLimit = window.innerHeight ? window.innerHeight * 0.72 : BOARD_SIZE_MAX;
  const available = Math.floor(Math.min(
    BOARD_SIZE_MAX,
    layoutWidth || BOARD_SIZE_MAX,
    heightLimit || BOARD_SIZE_MAX
  ));

  return clamp(available, BOARD_SIZE_MIN, BOARD_SIZE_MAX);
}

function playSound(kind) {
  if (!soundEnabled) return;

  try {
    const context = ensureAudioContext();
    if (!context) return;
    const now = context.currentTime;
    const master = context.createGain();
    master.gain.setValueAtTime(0.0001, now);
    master.gain.exponentialRampToValueAtTime(0.055, now + 0.015);
    master.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);
    master.connect(context.destination);

    const notes = soundNotes(kind);
    notes.forEach((note, index) => {
      const osc = context.createOscillator();
      const gain = context.createGain();
      const start = now + index * 0.045;
      osc.type = kind === "mate" ? "triangle" : "sine";
      osc.frequency.setValueAtTime(note, start);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.7, start + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.16);
      osc.connect(gain).connect(master);
      osc.start(start);
      osc.stop(start + 0.18);
    });
  } catch (error) {
    console.warn("[audio] unavailable", error);
  }
}

function playRaceStartSound(step) {
  if (!soundEnabled) return;

  try {
    const context = ensureAudioContext();
    if (!context) return;
    const now = context.currentTime;
    const isGo = step === "go";
    const duration = isGo ? 0.52 : 0.18;
    const frequency = isGo ? 880 : 440;
    const master = context.createGain();
    master.gain.setValueAtTime(0.0001, now);
    master.gain.exponentialRampToValueAtTime(isGo ? 0.09 : 0.065, now + 0.018);
    master.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    master.connect(context.destination);

    const main = context.createOscillator();
    const body = context.createOscillator();
    main.type = "square";
    body.type = "sawtooth";
    main.frequency.setValueAtTime(frequency, now);
    body.frequency.setValueAtTime(frequency / 2, now);
    if (isGo) {
      main.frequency.exponentialRampToValueAtTime(980, now + duration * 0.72);
      body.frequency.exponentialRampToValueAtTime(540, now + duration * 0.72);
    }
    main.connect(master);
    body.connect(master);
    main.start(now);
    body.start(now);
    main.stop(now + duration);
    body.stop(now + duration);
  } catch (error) {
    console.warn("[audio] unavailable", error);
  }
}

function ensureAudioContext() {
  try {
    audioContext = audioContext || new (window.AudioContext || window.webkitAudioContext)();
    resumeAudioContext();
    return audioContext;
  } catch (error) {
    console.warn("[audio] unavailable", error);
    return null;
  }
}

function resumeAudioContext() {
  if (!audioContext) {
    try {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
    } catch (error) {
      return;
    }
  }

  if (audioContext.state === "suspended" && audioContext.resume) {
    audioContext.resume().catch(() => {});
  }
}

function soundNotes(kind) {
  if (kind === "castle") return [330, 392, 494];
  if (kind === "check") return [523, 392];
  if (kind === "mate") return [392, 523, 659, 784];
  return [440, 554];
}

function launchConfetti(winner) {
  if (!els.confettiLayer) return;

  els.confettiLayer.textContent = "";
  const colors = ["#4ce0e5", "#f6c453", "#36d399", "#ff6f8a", "#ffffff"];
  const winnerSide = winner === "white" ? "left" : "right";

  for (let i = 0; i < 72; i += 1) {
    const piece = document.createElement("span");
    const isWinnerPiece = i % 2 === 0;
    piece.className = `confetti ${isWinnerPiece ? "winner" : "loser"} ${isWinnerPiece ? winnerSide : oppositeSide(winnerSide)}`;
    piece.style.setProperty("--x", `${Math.random() * 82 + 8}%`);
    piece.style.setProperty("--delay", `${Math.random() * 0.45}s`);
    piece.style.setProperty("--spin", `${Math.random() * 540 - 270}deg`);
    piece.style.background = isWinnerPiece ? colors[i % colors.length] : "#030509";
    els.confettiLayer.appendChild(piece);
  }

  window.setTimeout(() => {
    if (els.confettiLayer) els.confettiLayer.textContent = "";
  }, 4200);
}

function oppositeSide(side) {
  return side === "left" ? "right" : "left";
}

function sanitizeName(name) {
  return String(name || "").replace(/\s+/g, " ").trim().slice(0, 20);
}

function profileTitle(profile, role) {
  if (profile && profile.name) return profile.name;
  return COLOR_LABELS[role] || "Joueur";
}

function renderProfiles() {
  const profiles = playersState.profiles || {};
  const whiteProfile = profiles.white || null;
  const blackProfile = profiles.black || null;

  setAvatarBubble(els.whiteAvatar, whiteProfile ? whiteProfile.avatar : "empty");
  setAvatarBubble(els.blackAvatar, blackProfile ? blackProfile.avatar : "empty");
  setText(els.whiteNameText, profileTitle(whiteProfile, "white"));
  setText(els.blackNameText, profileTitle(blackProfile, "black"));
  setText(els.whiteAvatarStatus, whiteProfile ? "Connecte" : "Absent");
  setText(els.blackAvatarStatus, blackProfile ? "Connecte" : "Absent");

  if (els.nameInput && document.activeElement !== els.nameInput) {
    els.nameInput.value = selectedName || "";
  }

  let opponentRole = null;
  if (myRole === "white") opponentRole = "black";
  if (myRole === "black") opponentRole = "white";

  if (opponentRole) {
    const opponentProfile = profiles[opponentRole] || null;
    setText(els.opponentTitle, opponentProfile && opponentProfile.name ? opponentProfile.name : `Adversaire ${COLOR_LABELS[opponentRole]}`);
    setText(els.opponentText, opponentProfile ? "Connecte en face" : `En attente des ${COLOR_LABELS[opponentRole]}`);
    setAvatarBubble(els.opponentAvatar, opponentProfile ? opponentProfile.avatar : "empty");
    return;
  }

  setText(els.opponentTitle, "Table observee");
  if (whiteProfile && blackProfile) {
    setText(els.opponentText, "Blancs et Noirs sont connectes");
    setAvatarBubble(els.opponentAvatar, "owl");
  } else {
    setText(els.opponentText, "En attente des deux joueurs");
    setAvatarBubble(els.opponentAvatar, "empty");
  }
}

function renderAvatarChoices() {
  if (!els.avatarChoices) return;

  els.avatarChoices.textContent = "";
  const activeAvatar = selectedAvatar || currentProfileAvatar() || defaultAvatarForRole(myRole);

  AVATAR_OPTIONS.forEach((option) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "avatar-choice";
    button.dataset.avatar = option.id;
    button.title = option.label;
    button.setAttribute("aria-label", `Avatar ${option.label}`);
    button.classList.toggle("is-selected", option.id === activeAvatar);

    const bubble = document.createElement("span");
    bubble.className = "avatar-bubble small";
    setAvatarBubble(bubble, option.id);
    button.appendChild(bubble);
    els.avatarChoices.appendChild(button);
  });
}

function renderLobby() {
  if (!els.tableList) return;

  renderLobbyStaticLabels();

  const waiting = isWaitingForOpponent();
  if (els.lobbyWaiting) {
    els.lobbyWaiting.hidden = !waiting;
    els.lobbyWaiting.textContent = "Table ouverte. En attente d'un adversaire.";
  }

  if (els.lobbyHomeBtn) {
    const awayFromLobby = Boolean(currentRoom && currentRoom.id !== MAIN_ROOM_ID);
    els.lobbyHomeBtn.hidden = !awayFromLobby;
    els.lobbyHomeBtn.textContent = "Retour au salon";
  }

  els.tableList.textContent = "";
  const tables = lobbyTableRows();

  if (!tables.length) {
    const empty = document.createElement("div");
    empty.className = "lobby-empty";
    empty.textContent = "Aucune table ouverte.";
    els.tableList.appendChild(empty);
    return;
  }

  tables.forEach((table) => {
    const row = document.createElement("div");
    row.className = "lobby-row table-row table-card";
    row.classList.toggle("is-current", table.creatorId === clientId || table.roomId === (currentRoom && currentRoom.id));

    const visual = createTableVisual(table);

    const info = document.createElement("div");
    info.className = "table-info";

    const header = document.createElement("div");
    header.className = "table-header";

    const cadence = document.createElement("strong");
    cadence.className = "table-cadence";
    cadence.textContent = `${table.seconds}s`;

    const color = document.createElement("span");
    color.className = "table-color";
    color.textContent = tableColorLabel(table);

    const players = document.createElement("span");
    players.className = "table-players";
    players.textContent = tablePlayerLine(table);

    header.appendChild(cadence);
    header.appendChild(color);
    info.appendChild(header);
    info.appendChild(players);

    const actions = document.createElement("div");
    actions.className = "table-actions";

    if (table.kind === "game") {
      actions.appendChild(createObserveButton(table));
    } else {
      if (table.creatorId === clientId) {
        const waitingButton = document.createElement("button");
        waitingButton.type = "button";
        waitingButton.textContent = "En attente";
        waitingButton.disabled = true;
        actions.appendChild(waitingButton);
      } else {
        const joinButton = document.createElement("button");
        joinButton.type = "button";
        joinButton.dataset.challengeId = table.id;
        joinButton.textContent = "Rejoindre";
        actions.appendChild(joinButton);
        actions.appendChild(createObserveButton(table));
      }
    }

    row.appendChild(visual);
    row.appendChild(info);
    row.appendChild(actions);
    els.tableList.appendChild(row);
  });
}

function createTableVisual(table) {
  const visual = document.createElement("div");
  visual.className = "table-visual";

  visual.appendChild(createTableSeat(table, "black"));

  const board = document.createElement("div");
  board.className = "table-mini-board";
  board.setAttribute("aria-hidden", "true");
  for (let index = 0; index < 64; index += 1) {
    const square = document.createElement("span");
    const row = Math.floor(index / 8);
    const col = index % 8;
    square.className = (row + col) % 2 === 0 ? "mini-light" : "mini-dark";
    if (row === 1 && tableSeatOccupied(table, "black")) square.classList.add("mini-black-piece");
    if (row === 6 && tableSeatOccupied(table, "white")) square.classList.add("mini-white-piece");
    board.appendChild(square);
  }
  visual.appendChild(board);

  visual.appendChild(createTableSeat(table, "white"));
  return visual;
}

function createTableSeat(table, role) {
  const occupied = tableSeatOccupied(table, role);
  const seat = document.createElement("div");
  seat.className = `table-seat ${role}-seat${occupied ? " is-occupied" : " is-free"}`;

  const color = document.createElement("span");
  color.textContent = COLOR_LABELS[role];

  const name = document.createElement("strong");
  name.textContent = occupied ? tableProfileName(table, role, table.creatorRole === role ? table.creatorName : "") : "S'asseoir";

  seat.appendChild(color);
  seat.appendChild(name);
  return seat;
}

function createObserveButton(table) {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.watchRoomId = table.roomId;
  button.className = "watch-button";
  button.setAttribute("aria-label", `Observer ${table.seconds}s ${tableColorLabel(table)}`);
  button.innerHTML = '<span class="watch-icon" aria-hidden="true">&#128301;</span><span>Observer</span>';
  return button;
}

function renderLobbyStaticLabels() {
  const submit = els.challengeForm ? els.challengeForm.querySelector('button[type="submit"]') : null;
  if (submit) submit.textContent = "S'asseoir";
}

function openLobbyTables() {
  const challenges = Array.isArray(lobbyStateData.challenges) ? lobbyStateData.challenges : [];
  return challenges
    .slice()
    .sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0));
}

function lobbyTableRows() {
  const openTables = openLobbyTables().map((challenge) => ({
    ...challenge,
    kind: "open"
  }));
  const openRoomIds = new Set(openTables.map((table) => table.roomId));
  const activeGames = (Array.isArray(lobbyStateData.rooms) ? lobbyStateData.rooms : [])
    .filter((room) => room && room.id !== MAIN_ROOM_ID && !openRoomIds.has(room.id))
    .filter((room) => room.players && room.players.white && room.players.black)
    .map((room) => ({
      id: room.id,
      roomId: room.id,
      kind: "game",
      seconds: Math.max(1, Math.round((room.initialMs || CLOCK_DEFAULT_MS) / 1000)),
      color: roomColorChoice(room),
      players: room.players,
      profiles: room.profiles,
      createdAt: Number(room.createdAt) || Date.now()
    }));

  return openTables.concat(activeGames)
    .sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0));
}

function roomColorChoice(room) {
  const name = String(room && room.name ? room.name : "").toLowerCase();
  if (name.includes("white")) return "white";
  if (name.includes("black")) return "black";
  if (name.includes("blanc")) return "white";
  if (name.includes("noir")) return "black";
  return "random";
}

function tablePlayerLine(table) {
  if (!table) return "";

  if (table.kind === "game") {
    const white = tableProfileName(table, "white");
    const black = tableProfileName(table, "black");
    return `${white} vs ${black}`;
  }

  const seatedRole = isPlayerRole(table.creatorRole)
    ? table.creatorRole
    : table.profiles && table.profiles.black
      ? "black"
      : "white";
  const waitingRole = isPlayerRole(table.opponentRole)
    ? table.opponentRole
    : seatedRole === "white"
      ? "black"
      : "white";
  const seatedName = tableProfileName(table, seatedRole, table.creatorName);
  return `${seatedName} attend ${COLOR_LABELS[waitingRole]}`;
}

function tableSeatOccupied(table, role) {
  if (!table || !isPlayerRole(role)) return false;
  if (table.profiles && table.profiles[role]) return true;
  if (table.players && table.players[role]) return true;
  return table.kind === "open" && table.creatorRole === role;
}

function tableProfileName(table, role, fallbackName = "") {
  const profile = table && table.profiles ? table.profiles[role] : null;
  const name = profile && profile.name ? profile.name : sanitizeName(fallbackName || "");
  return name || COLOR_LABELS[role] || "Joueur";
}

function tableColorLabel(table) {
  if (!table || table.color === "random") return "Aleatoire";
  return COLOR_LABELS[table.color] || "Aleatoire";
}

function isWaitingForOpponent() {
  if (!currentRoom || currentRoom.id === MAIN_ROOM_ID) return false;
  if (playersState.white && playersState.black) return false;
  return openLobbyTables().some((table) => table.creatorId === clientId && table.roomId === currentRoom.id);
}

function renderHistory() {
  const history = Array.isArray(gameState.moveHistory) ? gameState.moveHistory : [];
  setText(els.historyCount, String(history.length));
  els.moveHistory.textContent = "";

  if (!history.length) {
    const empty = document.createElement("li");
    empty.className = "move-empty";
    empty.textContent = "Aucun coup joué.";
    els.moveHistory.appendChild(empty);
    return;
  }

  const header = document.createElement("li");
  header.className = "move-header";
  header.innerHTML = "<span></span><span>Blancs</span><span>Noirs</span>";
  els.moveHistory.appendChild(header);

  groupMoveHistory(history).forEach((row) => {
    const entry = document.createElement("li");
    entry.className = "move-row";

    const number = document.createElement("span");
    number.className = "move-number";
    number.textContent = `${row.number}.`;

    entry.appendChild(number);
    entry.appendChild(createHistoryCell(row.white, row.whiteIndex));
    entry.appendChild(createHistoryCell(row.black, row.blackIndex));
    els.moveHistory.appendChild(entry);
  });
}

function groupMoveHistory(history) {
  const rows = [];

  history.forEach((move, index) => {
    const number = Number(move.number) || Math.floor(index / 2) + 1;
    let row = rows.find((candidate) => candidate.number === number);

    if (!row) {
      row = { number, white: null, whiteIndex: null, black: null, blackIndex: null };
      rows.push(row);
    }

    if (move.color === "black") {
      row.black = move;
      row.blackIndex = index + 1;
    } else {
      row.white = move;
      row.whiteIndex = index + 1;
    }
  });

  return rows;
}

function createHistoryCell(move, moveIndex) {
  const cell = document.createElement("span");
  cell.className = "move-cell";

  if (!move) {
    cell.textContent = "";
    return cell;
  }

  const button = document.createElement("button");
  button.type = "button";
  button.dataset.moveIndex = String(moveIndex);
  button.className = "move-jump";
  button.classList.toggle("is-selected", viewingMoveIndex === moveIndex);
  button.textContent = formatAlgebraicMove(move);
  cell.appendChild(button);
  return cell;
}

function renderChat() {
  if (!els.chatMessages) return;

  setText(els.chatCount, `${chatMessages.length} ${chatMessages.length > 1 ? "messages" : "message"}`);
  els.chatMessages.textContent = "";

  if (!chatMessages.length) {
    const empty = document.createElement("div");
    empty.className = "chat-empty";
    empty.textContent = "Aucun message.";
    els.chatMessages.appendChild(empty);
    return;
  }

  chatMessages.forEach((message) => {
    const entry = document.createElement("article");
    entry.className = `chat-message ${message.clientId === clientId ? "mine" : ""}`;

    const avatar = document.createElement("span");
    avatar.className = "avatar-bubble small";
    setAvatarBubble(avatar, message.avatar || defaultAvatarForRole(message.role));

    const body = document.createElement("div");
    const meta = document.createElement("div");
    meta.className = "chat-meta";

    const author = document.createElement("strong");
    author.textContent = message.clientId === clientId
      ? "Toi"
      : message.name || COLOR_LABELS[message.role] || "Spectateur";

    const time = document.createElement("time");
    time.dateTime = new Date(message.timestamp).toISOString();
    time.textContent = formatChatTime(message.timestamp);

    const text = document.createElement("div");
    text.className = "chat-text";
    text.textContent = message.text;

    meta.appendChild(author);
    meta.appendChild(time);
    body.appendChild(meta);
    body.appendChild(text);
    entry.appendChild(avatar);
    entry.appendChild(body);
    els.chatMessages.appendChild(entry);
  });

  els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
}

function renderRemoteCursors() {
  const activeIds = new Set();

  for (const [id, intent] of remoteIntents.entries()) {
    if (!intent || id === clientId || !isPlayerRole(intent.role)) continue;
    if (!playersState[intent.role]) continue;

    activeIds.add(id);
    const cursor = getOrCreateRemoteCursor(id, intent.role);

    if (!Number.isFinite(intent.nx) || !Number.isFinite(intent.ny)) {
      cursor.classList.remove("visible");
      continue;
    }

    const point = normalizedToBoardPoint(displayIntent(intent));
    cursor.style.transform = `translate3d(${point.x}px, ${point.y}px, 0)`;
    cursor.classList.toggle("dragging", intent.state === "dragging");
    cursor.classList.add("visible");
  }

  removeInactiveChildren(els.remoteCursors, activeIds, remoteDom.cursors);
}

function renderRemoteGhosts() {
  const activeIds = new Set();

  for (const [id, intent] of remoteIntents.entries()) {
    if (!intent || id === clientId || !isPlayerRole(intent.role)) continue;
    if (!playersState[intent.role]) continue;

    activeIds.add(id);
    renderRemoteGhost(id, intent);
    renderRemoteHalos(id, intent);
    renderRemoteTrail(id, intent);
  }

  removeInactiveChildren(els.remoteGhosts, activeIds, remoteDom.ghosts);
  removeInactiveHalos(activeIds);
  removeInactiveTrailPaths(activeIds);
}

function renderArrows() {
  if (!els.arrowSvg) return;

  els.arrowSvg.textContent = "";

  boardArrows.forEach((annotation) => appendBoardAnnotationElement(els.arrowSvg, annotation));

  if (arrowDragState.active && arrowDragState.fromSquare && arrowDragState.previewPoint) {
    appendArrowElement(els.arrowSvg, {
      from: arrowDragState.fromSquare,
      to: arrowDragState.toSquare,
      toPoint: arrowDragState.previewPoint,
      color: arrowDragState.color,
      preview: true
    });
  }
}

function appendBoardAnnotationElement(svg, annotation) {
  if (annotation && annotation.kind === "circle") {
    appendCircleElement(svg, annotation);
    return;
  }

  appendArrowElement(svg, annotation);
}

function appendArrowElement(svg, arrow) {
  if (!arrow || !isValidSquare(arrow.from)) return;

  const from = squareCenterPercent(arrow.from);
  const rawTo = arrow.toPoint || squareCenterPercent(arrow.to);
  if (!from || !rawTo) return;

  const distance = Math.hypot(rawTo.x - from.x, rawTo.y - from.y);
  if (distance < 0.1) return;

  const margin = arrow.toPoint ? 0 : ARROW_END_MARGIN_PERCENT;
  const to = shortenArrowEndpoint(from, rawTo, margin);

  const colorName = arrow.color === "red" ? "red" : "green";
  const color = ARROW_COLORS[colorName];
  const head = arrowHeadPoints(from, to);
  if (!head) return;

  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", `M ${from.x.toFixed(3)} ${from.y.toFixed(3)} L ${to.x.toFixed(3)} ${to.y.toFixed(3)}`);
  path.setAttribute("class", `board-arrow ${colorName}${arrow.preview ? " preview" : ""}`);
  path.setAttribute("stroke", color);
  svg.appendChild(path);

  const headPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
  headPath.setAttribute("d", [
    `M ${to.x.toFixed(3)} ${to.y.toFixed(3)} L ${head.left.x.toFixed(3)} ${head.left.y.toFixed(3)}`,
    `M ${to.x.toFixed(3)} ${to.y.toFixed(3)} L ${head.right.x.toFixed(3)} ${head.right.y.toFixed(3)}`
  ].join(" "));
  headPath.setAttribute("class", `board-arrow-head ${colorName}${arrow.preview ? " preview" : ""}`);
  headPath.setAttribute("stroke", color);
  svg.appendChild(headPath);
}

function appendCircleElement(svg, circle) {
  if (!circle || !isValidSquare(circle.square)) return;

  const center = squareCenterPercent(circle.square);
  const radius = squareRadiusPercent(circle.square);
  if (!center || !radius) return;

  const colorName = circle.color === "red" ? "red" : "green";
  const element = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  element.setAttribute("cx", center.x.toFixed(3));
  element.setAttribute("cy", center.y.toFixed(3));
  element.setAttribute("r", radius.toFixed(3));
  element.setAttribute("class", `board-circle ${colorName}`);
  element.setAttribute("stroke", ARROW_COLORS[colorName]);
  svg.appendChild(element);
}

function shortenArrowEndpoint(from, to, margin) {
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  if (!distance || distance <= margin) return to;

  const ratio = (distance - margin) / distance;
  return {
    x: from.x + (to.x - from.x) * ratio,
    y: from.y + (to.y - from.y) * ratio
  };
}

function arrowHeadPoints(from, tip) {
  const dx = tip.x - from.x;
  const dy = tip.y - from.y;
  const distance = Math.hypot(dx, dy);
  if (!distance) return null;

  const ux = dx / distance;
  const uy = dy / distance;
  const length = Math.min(ARROW_HEAD_LENGTH_PERCENT, distance * 0.42);
  const width = Math.min(ARROW_HEAD_WIDTH_PERCENT, distance * 0.3);
  const base = {
    x: tip.x - ux * length,
    y: tip.y - uy * length
  };
  const nx = -uy;
  const ny = ux;

  return {
    base,
    left: { x: base.x + nx * width / 2, y: base.y + ny * width / 2 },
    right: { x: base.x - nx * width / 2, y: base.y - ny * width / 2 }
  };
}

function squareCenterPercent(square) {
  const rect = squareRectPixels(square);
  const metrics = boardMetrics();
  if (!rect || !metrics.outerWidth || !metrics.outerHeight) return null;

  return {
    x: ((rect.x + rect.size / 2) / metrics.outerWidth) * 100,
    y: ((rect.y + rect.size / 2) / metrics.outerHeight) * 100
  };
}

function squareRadiusPercent(square) {
  const rect = squareRectPixels(square);
  const metrics = boardMetrics();
  if (!rect || !metrics.outerWidth) return null;
  return (rect.size / metrics.outerWidth) * 100 * 0.25;
}

function pointerPointPercent(pointer) {
  const metrics = boardMetrics();
  if (!metrics.outerWidth || !metrics.outerHeight) return null;

  return {
    x: (pointer.x / metrics.outerWidth) * 100,
    y: (pointer.y / metrics.outerHeight) * 100
  };
}

function squareFromPointer(event) {
  return pointerToNormalizedPosition(event).square;
}

function boardMetrics() {
  if (!els.board) {
    return {
      rect: { left: 0, top: 0, width: 0, height: 0 },
      left: 0,
      top: 0,
      width: 0,
      height: 0,
      outerWidth: 0,
      outerHeight: 0
    };
  }

  const rect = els.board.getBoundingClientRect();
  const left = els.board.clientLeft || 0;
  const top = els.board.clientTop || 0;
  const width = els.board.clientWidth || Math.max(0, rect.width - left * 2);
  const height = els.board.clientHeight || Math.max(0, rect.height - top * 2);

  return {
    rect,
    left,
    top,
    width,
    height,
    outerWidth: rect.width,
    outerHeight: rect.height
  };
}

function pointerToNormalizedPosition(event) {
  const metrics = boardMetrics();
  const rawX = event.clientX - metrics.rect.left - metrics.left;
  const rawY = event.clientY - metrics.rect.top - metrics.top;
  const contentX = clamp(rawX, 0, metrics.width);
  const contentY = clamp(rawY, 0, metrics.height);
  const x = metrics.left + contentX;
  const y = metrics.top + contentY;
  const nx = metrics.width ? contentX / metrics.width : 0;
  const ny = metrics.height ? contentY / metrics.height : 0;
  const inside = rawX >= 0 && rawX <= metrics.width && rawY >= 0 && rawY <= metrics.height;

  if (!inside) {
    return { x, y, nx, ny, square: null, inside };
  }

  const col = Math.min(7, Math.max(0, Math.floor(nx * 8)));
  const row = Math.min(7, Math.max(0, Math.floor(ny * 8)));

  return {
    x,
    y,
    nx,
    ny,
    square: squareFromDisplay(row, col),
    inside
  };
}

function handlePointerDown(event) {
  event.preventDefault();

  if (event.button === 2) {
    handleArrowPointerDown(event);
    return;
  }

  const initialPointer = pointerToNormalizedPosition(event);
  if (event.button === 0 && initialPointer.square && boardArrows.length) {
    clearBoardAnnotations();
  }

  if (viewingMoveIndex !== null) {
    viewingMoveIndex = null;
    renderBoard();
    renderHistory();
  }

  if (myRole === "spectator") {
    showError("Tu es spectateur.");
    return;
  }

  if (!isPlayerRole(myRole)) {
    showError("Connexion au serveur…");
    return;
  }

  if (gameState.gameOver) {
    showError("La partie est terminee.");
    return;
  }

  if (!hasGameStarted()) {
    showError("La partie n'est pas lancee.");
    return;
  }

  const pointer = initialPointer;
  const interactionBoard = currentInteractionBoard();
  const piece = pointer.square ? interactionBoard[pointer.square] : null;

  updateLocalIntent({
    state: piece ? "hover" : "idle",
    pointerId: event.pointerId,
    nx: pointer.nx,
    ny: pointer.ny,
    hoveredSquare: pointer.square,
    fromSquare: null,
    targetSquare: pointer.square,
    grabbedPiece: null
  });
  sendIntentThrottled(localIntent, true);

  if (!piece) {
    setLocalBoardHighlights({ hover: pointer.square, target: null, origin: null });
    return;
  }

  if (piece.color !== myRole) {
    setLocalBoardHighlights({ hover: pointer.square, target: null, origin: null });
    return;
  }

  /*
    showError("Cette pièce n’est pas à toi.");
    return;
  }

  */
  const isPremove = gameState.turn !== myRole;
  if (isPremove && !hasGameStarted()) {
    showError("Premove impossible avant le debut de la partie.");
    return;
  }

  selectedPiece = { square: pointer.square, piece };
  dragState = {
    active: true,
    premove: isPremove,
    pointerId: event.pointerId,
    fromSquare: pointer.square,
    targetSquare: pointer.square,
    grabbedPiece: piece,
    x: pointer.x,
    y: pointer.y,
    nx: pointer.nx,
    ny: pointer.ny
  };

  els.board.setPointerCapture(event.pointerId);
  document.body.classList.add("drag-lock");
  document.body.classList.toggle("premove-drag", isPremove);
  setSourceDragPiece(pointer.square, true);
  updateLocalDragGhost();
  setLocalBoardHighlights({ hover: pointer.square, target: pointer.square, origin: pointer.square });

  updateLocalIntent({
    state: "dragging",
    pointerId: event.pointerId,
    nx: pointer.nx,
    ny: pointer.ny,
    hoveredSquare: pointer.square,
    fromSquare: pointer.square,
    targetSquare: pointer.square,
    grabbedPiece: piece
  });
  sendIntentThrottled(localIntent, true);

  if (isPremove) {
    showError("Premove prepare.");
  }
}

function handlePointerMove(event) {
  event.preventDefault();

  if (arrowDragState.active) {
    handleArrowPointerMove(event);
    return;
  }

  const pointer = pointerToNormalizedPosition(event);

  if (!isPlayerRole(myRole)) return;

  perfStats.lastPointerMoveAt = performance.now();
  const piece = pointer.square ? gameState.board[pointer.square] : null;

  if (dragState.active) {
    if (dragState.pointerId !== event.pointerId) return;

    dragState.x = pointer.x;
    dragState.y = pointer.y;
    dragState.nx = pointer.nx;
    dragState.ny = pointer.ny;
    dragState.targetSquare = pointer.square;

    updateLocalDragGhost();
    setLocalBoardHighlights({
      hover: pointer.square,
      target: pointer.square,
      origin: dragState.fromSquare
    });

    updateLocalIntent({
      state: "dragging",
      pointerId: event.pointerId,
      nx: pointer.nx,
      ny: pointer.ny,
      hoveredSquare: pointer.square,
      fromSquare: dragState.fromSquare,
      targetSquare: pointer.square,
      grabbedPiece: dragState.grabbedPiece
    });
    sendIntentThrottled(localIntent);
    return;
  }

  updateLocalIntent({
    state: piece ? "hover" : "idle",
    pointerId: event.pointerId,
    nx: pointer.nx,
    ny: pointer.ny,
    hoveredSquare: pointer.square,
    fromSquare: null,
    targetSquare: pointer.square,
    grabbedPiece: null
  });
  setLocalBoardHighlights({ hover: pointer.square, target: null, origin: null });
  sendIntentThrottled(localIntent);
}

function handlePointerUp(event) {
  event.preventDefault();

  if (arrowDragState.active) {
    handleArrowPointerUp(event);
    return;
  }

  const pointer = pointerToNormalizedPosition(event);

  if (!dragState.active || dragState.pointerId !== event.pointerId) {
    return;
  }

  const from = dragState.fromSquare;
  const to = pointer.square;
  const wasDraggingPiece = dragState.grabbedPiece;
  const wasPremove = dragState.premove;

  if (els.board.hasPointerCapture(event.pointerId)) {
    els.board.releasePointerCapture(event.pointerId);
  }

  if (to === from) {
    setLocalBoardHighlights({ hover: pointer.square, target: null, origin: null });
  } else if (wasPremove && to && shouldAskPromotion(wasDraggingPiece, to)) {
    showPromotionDialog(wasDraggingPiece.color, to)
      .then((promotion) => enqueuePremove(from, to, promotion, wasDraggingPiece))
      .catch(() => showError("Promotion annulee."));
  } else if (wasPremove && to) {
    enqueuePremove(from, to, automaticPromotionFor(wasDraggingPiece, to), wasDraggingPiece);
  } else if (to && shouldAskPromotion(wasDraggingPiece, to)) {
    showPromotionDialog(wasDraggingPiece.color, to)
      .then((promotion) => requestMove(from, to, promotion))
      .catch(() => showError("Promotion annulee."));
  } else if (to) {
    requestMove(from, to, automaticPromotionFor(wasDraggingPiece, to));
  } else {
    showError("Coup impossible.");
  }

  resetLocalDrag();
  updateLocalIntent({
    state: "idle",
    pointerId: null,
    nx: pointer.nx,
    ny: pointer.ny,
    hoveredSquare: pointer.square,
    fromSquare: null,
    targetSquare: pointer.square,
    grabbedPiece: null
  });

  if (wasDraggingPiece) {
    sendIntentThrottled(localIntent, true);
  }
}

function handleArrowPointerDown(event) {
  const pointer = pointerToNormalizedPosition(event);
  if (!pointer.square) return;

  arrowDragState = {
    active: true,
    pointerId: event.pointerId,
    fromSquare: pointer.square,
    toSquare: pointer.square,
    color: event.ctrlKey ? "red" : "green",
    moved: false,
    startX: pointer.x,
    startY: pointer.y,
    previewPoint: pointerPointPercent(pointer)
  };

  try {
    els.board.setPointerCapture(event.pointerId);
  } catch (error) {
    console.warn("[arrow] capture impossible", error);
  }

  renderArrows();
}

function handleArrowPointerMove(event) {
  if (!arrowDragState.active || arrowDragState.pointerId !== event.pointerId) return;

  const pointer = pointerToNormalizedPosition(event);
  arrowDragState.toSquare = pointer.square || arrowDragState.toSquare;
  arrowDragState.previewPoint = pointerPointPercent(pointer) || arrowDragState.previewPoint;
  arrowDragState.moved = arrowDragState.moved
    || arrowDragState.toSquare !== arrowDragState.fromSquare
    || Math.hypot(pointer.x - arrowDragState.startX, pointer.y - arrowDragState.startY) > 4;
  renderArrows();
}

function handleArrowPointerUp(event) {
  if (!arrowDragState.active || arrowDragState.pointerId !== event.pointerId) return;

  const pointer = pointerToNormalizedPosition(event);
  const from = arrowDragState.fromSquare;
  const to = pointer.square || arrowDragState.toSquare;
  const color = arrowDragState.color;
  const moved = arrowDragState.moved && from && to && from !== to;

  try {
    if (els.board.hasPointerCapture(event.pointerId)) {
      els.board.releasePointerCapture(event.pointerId);
    }
  } catch (error) {
    console.warn("[arrow] release capture impossible", error);
  }

  arrowDragState = createEmptyArrowDragState();

  if (moved) {
    sendMessage({ type: "arrow", action: "add", from, to, color });
  } else if (from) {
    sendMessage({ type: "arrow", action: "add", kind: "circle", square: from, color });
  }

  renderArrows();
}

function clearBoardAnnotations() {
  boardArrows = [];
  renderArrows();
  sendMessage({ type: "arrow", action: "clearAll" });
}

function clearPremoves() {
  premoveQueue = [];
  pendingPremoveAttempt = null;
  renderBoard();
  renderPremoveList();
}

function requestMove(from, to, promotion = null) {
  if (!hasGameStarted()) {
    showError("La partie n'est pas lancee.");
    return;
  }

  beginPendingLocalMove(from, to, promotion);

  if (!sendMessage({ type: "move", from, to, promotion })) {
    pendingLocalMove = null;
    renderBoard();
  }
}

function beginPendingLocalMove(from, to, promotion = null) {
  if (!isValidSquare(from) || !isValidSquare(to) || from === to || gameState.turn !== myRole) return;

  const piece = gameState.board && gameState.board[from];
  if (!piece || piece.color !== myRole) return;

  pendingLocalMove = {
    from,
    to,
    promotion,
    piece: { color: piece.color, type: piece.type, symbol: piece.symbol },
    requestedAt: Date.now()
  };

  window.requestAnimationFrame(() => {
    if (pendingLocalMove && pendingLocalMove.from === from && pendingLocalMove.to === to) {
      renderBoard();
      scheduleIntentRender();
    }
  });
}

function enqueuePremove(from, to, promotion = null, piece = null) {
  const validation = validatePremoveRequest(from, to, promotion, piece);
  if (!validation.ok) {
    showError(validation.message);
    return;
  }

  premoveQueue.push({
    from,
    to,
    promotion,
    piece: piece ? { color: piece.color, type: piece.type, symbol: piece.symbol } : null
  });
  renderBoard();
  renderPremoveList();
  scheduleIntentRender();
  showError(`Premove ${from} -> ${to}`);
  trySendNextPremove();
}

function trySendNextPremove() {
  if (!premoveQueue.length) return;
  if (dragState.active) return;
  if (!isPlayerRole(myRole) || gameState.gameOver || gameState.turn !== myRole) return;
  if (!hasGameStarted()) return;

  const next = premoveQueue.shift();
  pendingPremoveAttempt = next;
  renderBoard();
  renderPremoveList();
  requestMove(next.from, next.to, next.promotion);
}

function validatePremoveRequest(from, to, promotion = null, piece = null) {
  if (!isPlayerRole(myRole) || gameState.gameOver) {
    return { ok: false, message: "Premove impossible." };
  }

  if (!hasGameStarted()) {
    return { ok: false, message: "Premove impossible avant le debut de la partie." };
  }

  if (!isValidSquare(from) || !isValidSquare(to) || from === to) {
    return { ok: false, message: "Premove impossible." };
  }

  const board = currentInteractionBoard();
  const movingPiece = piece || board[from] || (gameState.board && gameState.board[from]);
  if (!movingPiece || movingPiece.color !== myRole) {
    return { ok: false, message: "Premove impossible." };
  }

  if (promotion && !PROMOTION_OPTIONS.some((option) => option.type === promotion)) {
    return { ok: false, message: "Promotion impossible." };
  }

  if (!premovePieceCanReach(movingPiece, from, to, board)) {
    return { ok: false, message: "Deplacement de premove impossible." };
  }

  return { ok: true };
}

function hasGameStarted() {
  return Boolean(gameState.clock && gameState.clock.started)
    || (Array.isArray(gameState.moveHistory) && gameState.moveHistory.length > 0);
}

function premovePieceCanReach(piece, from, to, board) {
  if (!piece || !isValidSquare(from) || !isValidSquare(to)) return false;

  const fromPos = squareToPosition(from);
  const toPos = squareToPosition(to);
  const df = toPos.file - fromPos.file;
  const dr = toPos.rank - fromPos.rank;
  const absDf = Math.abs(df);
  const absDr = Math.abs(dr);

  if (piece.type === "P") {
    const direction = piece.color === "white" ? 1 : -1;
    const startRank = piece.color === "white" ? 2 : 7;

    if (df === 0 && dr === direction) {
      return true;
    }

    if (df === 0 && dr === direction * 2 && fromPos.rank === startRank) {
      const middleSquare = positionToSquare(fromPos.file, fromPos.rank + direction);
      return !board[middleSquare];
    }

    if (absDf === 1 && dr === direction) {
      return true;
    }

    return false;
  }

  if (piece.type === "N") {
    return (absDf === 1 && absDr === 2) || (absDf === 2 && absDr === 1);
  }

  if (piece.type === "B") {
    return absDf === absDr && isPathClearOnBoard(from, to, board);
  }

  if (piece.type === "R") {
    return (df === 0 || dr === 0) && isPathClearOnBoard(from, to, board);
  }

  if (piece.type === "Q") {
    return (absDf === absDr || df === 0 || dr === 0) && isPathClearOnBoard(from, to, board);
  }

  if (piece.type === "K") {
    if (absDf <= 1 && absDr <= 1) return true;
    return canPremoveCastle(piece, from, to, board);
  }

  return false;
}

function canPremoveCastle(piece, from, to, board) {
  const rank = piece.color === "white" ? 1 : 8;
  if (from !== `e${rank}` || ![`g${rank}`, `c${rank}`].includes(to)) return false;

  const clearSquares = to[0] === "g"
    ? [`f${rank}`, `g${rank}`]
    : [`d${rank}`, `c${rank}`, `b${rank}`];
  return clearSquares.every((square) => !board[square]);
}

function isPathClearOnBoard(from, to, board) {
  const fromPos = squareToPosition(from);
  const toPos = squareToPosition(to);
  const stepFile = Math.sign(toPos.file - fromPos.file);
  const stepRank = Math.sign(toPos.rank - fromPos.rank);
  let file = fromPos.file + stepFile;
  let rank = fromPos.rank + stepRank;

  while (file !== toPos.file || rank !== toPos.rank) {
    if (board[positionToSquare(file, rank)]) return false;
    file += stepFile;
    rank += stepRank;
  }

  return true;
}

function renderPremoveList() {
  if (!els.premoveList) return;

  els.premoveList.textContent = "";
  if (!premoveQueue.length) {
    els.premoveList.classList.remove("visible");
    return;
  }

  els.premoveList.classList.add("visible");
  const label = document.createElement("span");
  label.textContent = `${premoveQueue.length} premove${premoveQueue.length > 1 ? "s" : ""}`;
  els.premoveList.appendChild(label);

  const clearButton = document.createElement("button");
  clearButton.type = "button";
  clearButton.textContent = "Annuler";
  clearButton.addEventListener("click", () => {
    clearPremoves();
  });
  els.premoveList.appendChild(clearButton);
}

function renderTakeback() {
  if (!els.takebackBox) return;

  els.takebackBox.textContent = "";
  els.takebackBox.classList.remove("visible");

  if (!takebackOffer) return;

  els.takebackBox.classList.add("visible");
  const label = document.createElement("span");
  const requester = takebackOffer.requesterRole === "white" ? "Blancs" : "Noirs";

  if (takebackOffer.requesterId === clientId) {
    label.textContent = "Demande de reprise envoyee.";
    els.takebackBox.appendChild(label);
    return;
  }

  label.textContent = `${requester} propose de reprendre son dernier coup.`;
  els.takebackBox.appendChild(label);

  const accept = document.createElement("button");
  accept.type = "button";
  accept.dataset.takebackResponse = "accept";
  accept.textContent = "Accepter";

  const decline = document.createElement("button");
  decline.type = "button";
  decline.dataset.takebackResponse = "decline";
  decline.textContent = "Refuser";

  els.takebackBox.appendChild(accept);
  els.takebackBox.appendChild(decline);
}

function renderDrawOffer() {
  if (!els.drawBox) return;

  els.drawBox.textContent = "";
  els.drawBox.classList.remove("visible");

  if (!drawOffer || !isPlayerRole(myRole)) return;

  els.drawBox.classList.add("visible");
  const label = document.createElement("span");
  const requester = drawOffer.requesterRole === "white" ? "Blancs" : "Noirs";

  if (drawOffer.requesterId === clientId) {
    label.textContent = "Proposition de nulle envoyee.";
    els.drawBox.appendChild(label);
    return;
  }

  label.textContent = `${requester} propose nulle.`;
  els.drawBox.appendChild(label);

  const accept = document.createElement("button");
  accept.type = "button";
  accept.dataset.drawResponse = "accept";
  accept.textContent = "Accepter";

  const decline = document.createElement("button");
  decline.type = "button";
  decline.dataset.drawResponse = "decline";
  decline.textContent = "Refuser";

  els.drawBox.appendChild(accept);
  els.drawBox.appendChild(decline);
}

function renderPremoveHighlights() {
  if (!els.board) return;
  els.board.querySelectorAll(".premove-from, .premove-to").forEach((square) => {
    square.classList.remove("premove-from", "premove-to");
  });
}

function shouldAskPromotion(piece, to) {
  return choosePromotion && isPromotionTargetFor(piece, to);
}

function automaticPromotionFor(piece, to) {
  if (!isPromotionTargetFor(piece, to) || choosePromotion) return null;
  return "Q";
}

function isPromotionTargetFor(piece, to) {
  if (!piece || piece.type !== "P" || !isValidSquare(to)) return false;
  return (piece.color === "white" && to.endsWith("8")) || (piece.color === "black" && to.endsWith("1"));
}

function showPromotionDialog(color, targetSquare = null) {
  if (!els.promotionOverlay || !els.promotionChoices) {
    return Promise.resolve("Q");
  }

  els.promotionChoices.textContent = "";
  PROMOTION_OPTIONS.forEach((option) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "promotion-choice";
    button.dataset.promotion = option.type;

    const piece = { color, type: option.type, symbol: "" };
    const img = document.createElement("img");
    img.src = pieceAssetPath(piece);
    img.alt = "";
    img.draggable = false;

    const label = document.createElement("span");
    label.textContent = option.label;

    button.appendChild(img);
    button.appendChild(label);
    els.promotionChoices.appendChild(button);
  });

  els.promotionOverlay.hidden = false;
  positionPromotionDialog(targetSquare);

  return new Promise((resolve) => {
    pendingPromotionResolve = resolve;
  });
}

function positionPromotionDialog(targetSquare) {
  if (!els.promotionOverlay || !targetSquare || !els.board) {
    els.promotionOverlay.style.setProperty("--promotion-left", "50%");
    els.promotionOverlay.style.setProperty("--promotion-top", "50%");
    return;
  }

  const display = displayPositionForSquare(targetSquare);
  const metrics = boardMetrics();
  if (!display || !metrics.width || !metrics.height) return;

  const boardRect = els.board.getBoundingClientRect();
  const squareSize = metrics.width / 8;
  const rawLeft = boardRect.left + metrics.left + display.col * squareSize + squareSize / 2;
  const rawTop = boardRect.top + metrics.top + display.row * squareSize + squareSize / 2;
  const left = clamp(rawLeft, 110, Math.max(110, window.innerWidth - 110));
  const top = clamp(rawTop, 92, Math.max(92, window.innerHeight - 92));

  els.promotionOverlay.style.setProperty("--promotion-left", `${left}px`);
  els.promotionOverlay.style.setProperty("--promotion-top", `${top}px`);
}

function sendChatMessage() {
  const text = (els.chatInput.value || "").trim();
  if (!text) return;

  if (!canUseChat()) {
    showError("Connexion au serveur...");
    return;
  }

  if (sendMessage({ type: "chat", text })) {
    els.chatInput.value = "";
  }
}

function showError(message) {
  if (!els.errorBox) return;

  els.errorBox.textContent = message || "";
  els.errorBox.classList.toggle("visible", Boolean(message));

  if (errorTimer) {
    window.clearTimeout(errorTimer);
  }

  if (message) {
    errorTimer = window.setTimeout(() => {
      els.errorBox.textContent = "";
      els.errorBox.classList.remove("visible");
    }, 4200);
  }
}

function resetLocalDrag() {
  const previousSourceSquare = dragState.fromSquare;

  if (dragState.active && els.board && els.board.hasPointerCapture && dragState.pointerId !== null) {
    try {
      if (els.board.hasPointerCapture(dragState.pointerId)) {
        els.board.releasePointerCapture(dragState.pointerId);
      }
    } catch (error) {
      console.warn("[drag] release capture impossible", error);
    }
  }

  dragState = createEmptyDragState();
  selectedPiece = null;
  document.body.classList.remove("drag-lock");
  document.body.classList.remove("premove-drag");
  hideLocalDragGhost();
  setSourceDragPiece(previousSourceSquare, false);
  setLocalBoardHighlights({ hover: null, target: null, origin: null });
}

function snapshotActiveDrag() {
  if (!dragState.active || !dragState.grabbedPiece) return null;
  return {
    ...dragState,
    grabbedPiece: { ...dragState.grabbedPiece }
  };
}

function canKeepDragAfterState(snapshot) {
  if (!snapshot || !snapshot.active || !snapshot.grabbedPiece) return false;
  if (!isPlayerRole(myRole) || gameState.gameOver || !hasGameStarted()) return false;
  if (!isValidSquare(snapshot.fromSquare)) return false;

  const piece = gameState.board && gameState.board[snapshot.fromSquare];
  return Boolean(piece
    && piece.color === snapshot.grabbedPiece.color
    && piece.type === snapshot.grabbedPiece.type
    && piece.color === myRole);
}

function restoreDragAfterState(snapshot) {
  dragState = {
    ...snapshot,
    premove: gameState.turn !== myRole,
    grabbedPiece: { ...snapshot.grabbedPiece }
  };
  selectedPiece = {
    square: dragState.fromSquare,
    piece: dragState.grabbedPiece
  };
  document.body.classList.add("drag-lock");
  document.body.classList.toggle("premove-drag", dragState.premove);
  updateLocalDragGhost();
  setLocalBoardHighlights({
    hover: dragState.targetSquare,
    target: dragState.targetSquare,
    origin: dragState.fromSquare
  });
}

function flipOrientation() {
  resetLocalDrag();
  boardOrientation = boardOrientation === "white" ? "black" : "white";
  renderApp();
}

function cacheElements() {
  els.board = document.getElementById("board");
  els.boardWrap = document.getElementById("boardWrap");
  els.boardColumn = document.getElementById("boardColumn");
  els.localDragGhost = document.getElementById("localDragGhost");
  els.arrowSvg = document.getElementById("arrowSvg");
  els.trailSvg = document.getElementById("trailSvg");
  els.remoteHalos = document.getElementById("remoteHalos");
  els.remoteGhosts = document.getElementById("remoteGhosts");
  els.remoteCursors = document.getElementById("remoteCursors");
  els.connectionBadge = document.getElementById("connectionBadge");
  els.roleBadge = document.getElementById("roleBadge");
  els.turnBadge = document.getElementById("turnBadge");
  els.playersBadge = document.getElementById("playersBadge");
  els.shortStatus = document.getElementById("shortStatus");
  els.orientationBadge = document.getElementById("orientationBadge");
  els.errorBox = document.getElementById("errorBox");
  els.roleText = document.getElementById("roleText");
  els.connectionText = document.getElementById("connectionText");
  els.whiteText = document.getElementById("whiteText");
  els.blackText = document.getElementById("blackText");
  els.spectatorsText = document.getElementById("spectatorsText");
  els.turnText = document.getElementById("turnText");
  els.whiteClock = document.getElementById("whiteClock");
  els.blackClock = document.getElementById("blackClock");
  els.whiteClockBox = document.getElementById("whiteClockBox");
  els.blackClockBox = document.getElementById("blackClockBox");
  els.whiteClockGauge = document.getElementById("whiteClockGauge");
  els.blackClockGauge = document.getElementById("blackClockGauge");
  els.clockForm = document.getElementById("clockForm");
  els.clockInput = document.getElementById("clockInput");
  els.clockModeLabel = document.getElementById("clockModeLabel");
  els.clockTargetSelect = document.getElementById("clockTargetSelect");
  els.clockUnitText = document.getElementById("clockUnitText");
  els.clockSubmitBtn = document.getElementById("clockSubmitBtn");
  els.promotionChoiceToggle = document.getElementById("promotionChoiceToggle");
  els.soundToggleBtn = document.getElementById("soundToggleBtn");
  els.boardSizeInput = document.getElementById("boardSizeInput");
  els.boardThemeSelect = document.getElementById("boardThemeSelect");
  els.confettiLayer = document.getElementById("confettiLayer");
  els.premoveList = document.getElementById("premoveList");
  els.lobbyCard = document.querySelector(".lobby-card");
  els.roomText = document.getElementById("roomText");
  els.lobbyHint = document.getElementById("lobbyHint");
  els.lobbyWhiteSeat = document.getElementById("lobbyWhiteSeat");
  els.lobbyBlackSeat = document.getElementById("lobbyBlackSeat");
  els.lobbySpectatorSeat = document.getElementById("lobbySpectatorSeat");
  els.lobbyHomeBtn = document.getElementById("lobbyHomeBtn");
  els.lobbyWaiting = document.getElementById("lobbyWaiting");
  els.challengeForm = document.getElementById("challengeForm");
  els.challengeTimeInput = document.getElementById("challengeTimeInput");
  els.challengeColorSelect = document.getElementById("challengeColorSelect");
  els.challengeList = document.getElementById("challengeList");
  els.roomList = document.getElementById("roomList");
  els.tableList = document.getElementById("tableList");
  els.opponentAvatar = document.getElementById("opponentAvatar");
  els.opponentTitle = document.getElementById("opponentTitle");
  els.opponentText = document.getElementById("opponentText");
  els.whiteAvatar = document.getElementById("whiteAvatar");
  els.blackAvatar = document.getElementById("blackAvatar");
  els.whiteNameText = document.getElementById("whiteNameText");
  els.blackNameText = document.getElementById("blackNameText");
  els.whiteAvatarStatus = document.getElementById("whiteAvatarStatus");
  els.blackAvatarStatus = document.getElementById("blackAvatarStatus");
  els.avatarChoices = document.getElementById("avatarChoices");
  els.profileForm = document.getElementById("profileForm");
  els.nameInput = document.getElementById("nameInput");
  els.chatMessages = document.getElementById("chatMessages");
  els.chatCount = document.getElementById("chatCount");
  els.chatForm = document.getElementById("chatForm");
  els.chatInput = document.getElementById("chatInput");
  els.promotionOverlay = document.getElementById("promotionOverlay");
  els.promotionChoices = document.getElementById("promotionChoices");
  els.historyCount = document.getElementById("historyCount");
  els.moveHistory = document.getElementById("moveHistory");
  els.matchScore = document.getElementById("matchScore");
  els.newGameBtn = document.getElementById("newGameBtn");
  els.returnLobbyBtn = document.getElementById("returnLobbyBtn");
  els.readyBtn = document.getElementById("readyBtn");
  els.readyStatus = document.getElementById("readyStatus");
  els.countdownOverlay = document.getElementById("countdownOverlay");
  els.countdownText = document.getElementById("countdownText");
  els.takebackBtn = document.getElementById("takebackBtn");
  els.takebackBox = document.getElementById("takebackBox");
  els.drawBtn = document.getElementById("drawBtn");
  els.resignBtn = document.getElementById("resignBtn");
  els.drawBox = document.getElementById("drawBox");
  els.orientationBtn = document.getElementById("orientationBtn");
}

function bindUi() {
  if (listenersAttached) return;
  listenersAttached = true;

  els.board.addEventListener("pointerdown", handlePointerDown, { passive: false });
  els.board.addEventListener("pointermove", handlePointerMove, { passive: false });
  els.board.addEventListener("pointerup", handlePointerUp, { passive: false });
  els.board.addEventListener("pointercancel", handlePointerCancel, { passive: false });
  els.board.addEventListener("pointerleave", handlePointerLeave, { passive: false });
  els.board.addEventListener("contextmenu", (event) => event.preventDefault());

  if (els.newGameBtn) {
    els.newGameBtn.addEventListener("click", () => {
    if (myRole === "spectator") {
      showError("Les spectateurs ne peuvent pas réinitialiser la partie.");
      return;
    }

    if (!isPlayerRole(myRole)) {
      showError("Connexion au serveur…");
      return;
    }

      sendMessage({ type: "reset" });
    });
  }

  if (els.orientationBtn) {
    els.orientationBtn.addEventListener("click", flipOrientation);
  }

  if (els.returnLobbyBtn) {
    els.returnLobbyBtn.addEventListener("click", () => {
      sendMessage({ type: "watchRoom", roomId: MAIN_ROOM_ID, mode: "spectator" });
    });
  }

  els.readyBtn.addEventListener("click", () => {
    if (!isPlayerRole(myRole)) {
      showError(myRole === "spectator" ? "Les spectateurs ne peuvent pas lancer la partie." : "Connexion au serveur...");
      return;
    }

    resumeAudioContext();
    sendMessage({ type: "readyToPlay" });
  });

  if (els.takebackBtn) {
    els.takebackBtn.addEventListener("click", () => {
    if (!isPlayerRole(myRole)) {
      showError(myRole === "spectator" ? "Les spectateurs ne peuvent pas demander de reprise." : "Connexion au serveur...");
      return;
    }
      sendMessage({ type: "takebackRequest" });
    });
  }

  els.drawBtn.addEventListener("click", () => {
    if (!isPlayerRole(myRole)) {
      showError(myRole === "spectator" ? "Les spectateurs ne peuvent pas proposer nulle." : "Connexion au serveur...");
      return;
    }

    if (gameState.gameOver) {
      showError("La partie est terminee.");
      return;
    }

    sendMessage({ type: "drawOffer" });
  });

  els.resignBtn.addEventListener("click", () => {
    if (!isPlayerRole(myRole)) {
      showError(myRole === "spectator" ? "Les spectateurs ne peuvent pas abandonner." : "Connexion au serveur...");
      return;
    }

    if (gameState.gameOver) {
      showError("La partie est terminee.");
      return;
    }

    if (window.confirm("Abandonner la partie ?")) {
      sendMessage({ type: "resign" });
    }
  });

  els.avatarChoices.addEventListener("click", (event) => {
    const button = event.target.closest("[data-avatar]");
    if (!button) return;

    selectedAvatar = button.dataset.avatar;
    sendMessage({ type: "profile", avatar: selectedAvatar, name: selectedName });
    renderAvatarChoices();
    renderProfiles();
  });

  els.chatForm.addEventListener("submit", (event) => {
    event.preventDefault();
    sendChatMessage();
  });

  if (els.challengeForm) {
    els.challengeForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const seconds = Number(els.challengeTimeInput ? els.challengeTimeInput.value : 60);
      sendMessage({
        type: "createChallenge",
        seconds,
        color: els.challengeColorSelect ? els.challengeColorSelect.value : "random"
      });
    });
  }

  if (els.lobbyHomeBtn) {
    els.lobbyHomeBtn.addEventListener("click", () => {
      sendMessage({ type: "watchRoom", roomId: MAIN_ROOM_ID, mode: "spectator" });
    });
  }

  if (els.tableList) {
    els.tableList.addEventListener("click", (event) => {
      const button = event.target.closest("[data-challenge-id]");
      if (button) {
        sendMessage({ type: "acceptChallenge", challengeId: button.dataset.challengeId });
        return;
      }
      const watchButton = event.target.closest("[data-watch-room-id]");
      if (watchButton) {
        sendMessage({ type: "watchRoom", roomId: watchButton.dataset.watchRoomId, mode: "spectator" });
      }
    });
  }

  if (els.roomList) {
    els.roomList.addEventListener("click", (event) => {
    const button = event.target.closest("[data-room-id]");
    if (!button) return;
    sendMessage({ type: "watchRoom", roomId: button.dataset.roomId });
    });
  }

  if (els.clockForm) {
    els.clockForm.addEventListener("submit", (event) => {
      event.preventDefault();
      submitClockConfig();
    });
  }

  els.profileForm.addEventListener("submit", (event) => {
    event.preventDefault();
    submitProfile();
  });

  if (els.soundToggleBtn) {
    els.soundToggleBtn.addEventListener("click", () => {
    soundEnabled = !soundEnabled;
    if (soundEnabled) resumeAudioContext();
    renderSoundToggle();
    });
  }

  if (els.promotionChoiceToggle) {
    els.promotionChoiceToggle.addEventListener("change", () => {
      choosePromotion = Boolean(els.promotionChoiceToggle.checked);
      renderPromotionMode();
    });
  }

  els.boardSizeInput.addEventListener("input", () => {
    boardSize = clamp(Number(els.boardSizeInput.value), BOARD_SIZE_MIN, currentBoardSizeMax());
    applyBoardPreferences();
    scheduleIntentRender();
  });

  els.boardThemeSelect.addEventListener("change", () => {
    boardTheme = els.boardThemeSelect.value || "classic";
    applyBoardPreferences();
  });

  els.moveHistory.addEventListener("click", (event) => {
    const button = event.target.closest("[data-move-index]");
    if (!button) return;
    setViewingMoveIndex(Number(button.dataset.moveIndex));
  });

  els.takebackBox.addEventListener("click", (event) => {
    const button = event.target.closest("[data-takeback-response]");
    if (!button) return;
    sendMessage({ type: "takebackResponse", accept: button.dataset.takebackResponse === "accept" });
  });

  els.drawBox.addEventListener("click", (event) => {
    const button = event.target.closest("[data-draw-response]");
    if (!button) return;
    sendMessage({ type: "drawResponse", accept: button.dataset.drawResponse === "accept" });
  });

  els.promotionChoices.addEventListener("click", (event) => {
    const button = event.target.closest("[data-promotion]");
    if (!button || !pendingPromotionResolve) return;

    const resolve = pendingPromotionResolve;
    pendingPromotionResolve = null;
    els.promotionOverlay.hidden = true;
    resolve(button.dataset.promotion);
  });

  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && pendingPromotionResolve) {
      const resolve = pendingPromotionResolve;
      pendingPromotionResolve = null;
      els.promotionOverlay.hidden = true;
      resolve("Q");
    }

    if (gameState.gameOver && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      event.preventDefault();
      navigateHistory(event.key === "ArrowRight" ? 1 : -1);
    }
  });

  window.addEventListener("resize", () => {
    updateLocalDragGhost();
    scheduleIntentRender();
  });
}

function handlePointerCancel(event) {
  event.preventDefault();

  if (arrowDragState.active && arrowDragState.pointerId === event.pointerId) {
    arrowDragState = createEmptyArrowDragState();
    renderArrows();
    return;
  }

  if (dragState.active && dragState.pointerId === event.pointerId) {
    resetLocalDrag();
    updateLocalIntent({
      state: "idle",
      pointerId: null,
      grabbedPiece: null,
      fromSquare: null,
      targetSquare: null
    });
    sendIntentThrottled(localIntent, true);
  }
}

function handlePointerLeave(event) {
  if (dragState.active) return;

  if (isPlayerRole(myRole)) {
    const pointer = pointerToNormalizedPosition(event);
    updateLocalIntent({
      state: "idle",
      pointerId: null,
      nx: pointer.nx,
      ny: pointer.ny,
      hoveredSquare: null,
      fromSquare: null,
      targetSquare: null,
      grabbedPiece: null
    });
    setLocalBoardHighlights({ hover: null, target: null, origin: null });
    sendIntentThrottled(localIntent, true);
  }
}

function setConnectionState(state) {
  if (state === "connecting") {
    setText(els.connectionBadge, "Connexion au serveur…");
    setText(els.connectionText, "Connexion…");
    els.connectionBadge.className = "badge neutral";
  }

  if (state === "connected") {
    setText(els.connectionBadge, "Connecté");
    setText(els.connectionText, "Connecté");
    els.connectionBadge.className = "badge connected";
  }

  if (state === "disconnected") {
    setText(els.connectionBadge, "Déconnecté — recharge la page");
    setText(els.connectionText, "Déconnecté");
    els.connectionBadge.className = "badge danger";
  }
}

function sendQueuedIntent() {
  if (!queuedIntent) return;

  if (socket && socket.readyState === WebSocket.OPEN) {
    queuedIntent.timestamp = Date.now();
    socket.send(JSON.stringify(queuedIntent));
    lastIntentSentAt = performance.now();
    lastSentIntentSnapshot = queuedIntent;
    perfStats.intentsSent += 1;
  }

  queuedIntent = null;
}

function updateRemoteIntent(id, data) {
  perfStats.intentsReceived += 1;

  const previous = remoteIntents.get(id) || {
    clientId: id,
    role: data.role,
    trail: []
  };
  const now = performance.now();
  const nx = Number(data.nx);
  const ny = Number(data.ny);

  const next = {
    ...previous,
    clientId: id,
    role: data.role,
    state: data.state || "idle",
    nx: Number.isFinite(nx) ? clamp(nx, 0, 1) : previous.nx,
    ny: Number.isFinite(ny) ? clamp(ny, 0, 1) : previous.ny,
    displayNx: Number.isFinite(previous.displayNx) ? previous.displayNx : (Number.isFinite(nx) ? clamp(nx, 0, 1) : previous.nx),
    displayNy: Number.isFinite(previous.displayNy) ? previous.displayNy : (Number.isFinite(ny) ? clamp(ny, 0, 1) : previous.ny),
    hoveredSquare: data.hoveredSquare || null,
    fromSquare: data.fromSquare || null,
    targetSquare: data.targetSquare || null,
    grabbedPiece: data.grabbedPiece || null,
    orientation: data.orientation === "black" ? "black" : "white",
    timestamp: data.timestamp || Date.now(),
    lastSeen: now,
    trail: (previous.trail || []).filter((point) => now - point.t < TRAIL_MAX_AGE_MS)
  };

  if (Number.isFinite(next.nx) && Number.isFinite(next.ny)) {
    const last = next.trail[next.trail.length - 1];
    const farEnough = !last || Math.hypot(next.nx - last.nx, next.ny - last.ny) > INTENT_MIN_DELTA;
    const oldEnough = !last || now - last.t > TRAIL_POINT_MIN_INTERVAL_MS;

    if (farEnough || oldEnough) {
      next.trail.push({ nx: next.nx, ny: next.ny, t: now, orientation: next.orientation });
      if (next.trail.length > TRAIL_POINT_LIMIT) {
        next.trail.splice(0, next.trail.length - TRAIL_POINT_LIMIT);
      }
    }
  }

  remoteIntents.set(id, next);
  scheduleIntentRender();
}

function scheduleIntentRender() {
  if (overlayFrame) return;

  overlayFrame = requestAnimationFrame(() => {
    overlayFrame = 0;
    renderIntentOverlay();
  });
}

function renderIntentOverlay() {
  advanceRemoteIntentPositions();
  renderRemoteCursors();
  renderRemoteGhosts();

  if (hasLiveTrails() || hasRemoteCursorMotion()) {
    scheduleIntentRender();
  }
}

function advanceRemoteIntentPositions() {
  for (const intent of remoteIntents.values()) {
    if (!intent || !Number.isFinite(intent.nx) || !Number.isFinite(intent.ny)) continue;

    if (!Number.isFinite(intent.displayNx) || !Number.isFinite(intent.displayNy)) {
      intent.displayNx = intent.nx;
      intent.displayNy = intent.ny;
      continue;
    }

    intent.displayNx += (intent.nx - intent.displayNx) * REMOTE_CURSOR_EASING;
    intent.displayNy += (intent.ny - intent.displayNy) * REMOTE_CURSOR_EASING;

    if (Math.hypot(intent.nx - intent.displayNx, intent.ny - intent.displayNy) < 0.001) {
      intent.displayNx = intent.nx;
      intent.displayNy = intent.ny;
    }
  }
}

function hasRemoteCursorMotion() {
  for (const intent of remoteIntents.values()) {
    if (!intent || !Number.isFinite(intent.nx) || !Number.isFinite(intent.ny)) continue;
    if (!Number.isFinite(intent.displayNx) || !Number.isFinite(intent.displayNy)) return true;
    if (Math.hypot(intent.nx - intent.displayNx, intent.ny - intent.displayNy) >= 0.001) return true;
  }

  return false;
}

function renderRemoteGhost(id, intent) {
  const ghost = getOrCreateRemoteGhost(id);

  if (intent.state !== "dragging" || !intent.grabbedPiece || !Number.isFinite(intent.nx) || !Number.isFinite(intent.ny)) {
    ghost.classList.remove("visible");
    return;
  }

  const point = normalizedToBoardPoint(displayIntent(intent));
  setGhostPiece(ghost, intent.grabbedPiece);
  ghost.className = `remote-ghost visible ${intent.grabbedPiece.color}-piece`;
  ghost.dataset.clientId = id;
  ghost.style.transform = `translate3d(${point.x}px, ${point.y}px, 0) translate(-50%, -50%)`;
}

function renderRemoteHalos(id, intent) {
  const originHalo = getOrCreateRemoteHalo(id, "origin", intent.role);
  const targetHalo = getOrCreateRemoteHalo(id, "target", intent.role);
  const hoverHalo = getOrCreateRemoteHalo(id, "hover", intent.role);

  positionHalo(originHalo, intent.state === "dragging" ? intent.fromSquare : null);
  positionHalo(targetHalo, intent.state === "dragging" ? intent.targetSquare : null);
  positionHalo(hoverHalo, intent.state !== "dragging" ? intent.hoveredSquare : null);
}

function renderRemoteTrail(id, intent) {
  const path = getOrCreateTrailPath(id, intent.role);
  const now = performance.now();
  intent.trail = (intent.trail || []).filter((point) => now - point.t < TRAIL_MAX_AGE_MS);

  if (intent.trail.length < 2) {
    path.setAttribute("d", "");
    return;
  }

  const d = intent.trail
    .map((point, index) => {
      const normalizedPoint = normalizedToBoardPoint({
        nx: point.nx,
        ny: point.ny,
        orientation: point.orientation || intent.orientation,
        role: intent.role
      }, true);
      const command = index === 0 ? "M" : "L";
      return `${command} ${normalizedPoint.x.toFixed(2)} ${normalizedPoint.y.toFixed(2)}`;
    })
    .join(" ");

  path.setAttribute("d", d);
  path.style.opacity = String(Math.min(0.62, Math.max(0.14, intent.trail.length / TRAIL_POINT_LIMIT)));
}

function getOrCreateRemoteCursor(id, role) {
  let cursor = remoteDom.cursors.get(id);

  if (!cursor || !cursor.isConnected) {
    cursor = document.createElement("div");
    cursor.dataset.clientId = id;
    cursor.innerHTML = "<span class=\"cursor-shape\"></span>";
    els.remoteCursors.appendChild(cursor);
    remoteDom.cursors.set(id, cursor);
  }

  cursor.className = `remote-cursor ${role}`;
  return cursor;
}

function getOrCreateRemoteGhost(id) {
  let ghost = remoteDom.ghosts.get(id);

  if (!ghost || !ghost.isConnected) {
    ghost = document.createElement("div");
    ghost.dataset.clientId = id;
    els.remoteGhosts.appendChild(ghost);
    remoteDom.ghosts.set(id, ghost);
  }

  return ghost;
}

function getOrCreateRemoteHalo(id, kind, role) {
  const key = `${id}:${kind}`;
  let halo = remoteDom.halos.get(key);

  if (!halo || !halo.isConnected) {
    halo = document.createElement("div");
    halo.dataset.clientId = key;
    els.remoteHalos.appendChild(halo);
    remoteDom.halos.set(key, halo);
  }

  halo.className = `remote-halo ${kind} ${role}`;
  return halo;
}

function getOrCreateTrailPath(id, role) {
  let path = remoteDom.trails.get(id);

  if (!path || !path.isConnected) {
    path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.dataset.clientId = id;
    els.trailSvg.appendChild(path);
    remoteDom.trails.set(id, path);
  }

  path.setAttribute("class", `trail-path ${role}`);
  return path;
}

function positionHalo(halo, square) {
  const rect = squareRectPixels(square);

  if (!rect) {
    halo.classList.remove("visible");
    return;
  }

  halo.style.width = `${rect.size}px`;
  halo.style.height = `${rect.size}px`;
  halo.style.transform = `translate3d(${rect.x}px, ${rect.y}px, 0)`;
  halo.classList.add("visible");
}

function displayIntent(intent) {
  return {
    ...intent,
    nx: Number.isFinite(intent.displayNx) ? intent.displayNx : intent.nx,
    ny: Number.isFinite(intent.displayNy) ? intent.displayNy : intent.ny
  };
}

function normalizedToBoardPoint(intent, percent = false) {
  let nx = clamp(Number(intent.nx), 0, 1);
  let ny = clamp(Number(intent.ny), 0, 1);
  const sourceOrientation = intent.orientation || (intent.role === "black" ? "black" : "white");

  if (sourceOrientation !== boardOrientation) {
    nx = 1 - nx;
    ny = 1 - ny;
  }

  const metrics = boardMetrics();
  const x = metrics.left + nx * metrics.width;
  const y = metrics.top + ny * metrics.height;

  if (percent) {
    return {
      x: metrics.outerWidth ? (x / metrics.outerWidth) * 100 : nx * 100,
      y: metrics.outerHeight ? (y / metrics.outerHeight) * 100 : ny * 100
    };
  }

  return { x, y };
}

function squareRectPixels(square) {
  const display = displayPositionForSquare(square);
  if (!display || !els.board) return null;

  const metrics = boardMetrics();
  const size = metrics.width / 8;
  return {
    x: metrics.left + display.col * size,
    y: metrics.top + display.row * size,
    size
  };
}

function updateLocalIntent(next) {
  localIntent = { ...localIntent, ...next };
}

function updateLocalDragGhost() {
  if (!dragState.active || !dragState.grabbedPiece) {
    hideLocalDragGhost();
    return;
  }

  setGhostPiece(els.localDragGhost, dragState.grabbedPiece);
  els.localDragGhost.className = `local-drag-ghost visible ${dragState.grabbedPiece.color}-piece`;
  els.localDragGhost.style.transform = `translate3d(${dragState.x}px, ${dragState.y}px, 0) translate(-50%, -50%)`;
}

function hideLocalDragGhost() {
  if (els.localDragGhost) {
    els.localDragGhost.classList.remove("visible");
    els.localDragGhost.textContent = "";
    els.localDragGhost.dataset.pieceKey = "";
  }
}

function setLocalBoardHighlights(next) {
  setTrackedSquareClass(localHighlightState.hover, next.hover, "local-hover");
  setTrackedSquareClass(localHighlightState.target, next.target, "local-target");
  setTrackedSquareClass(localHighlightState.origin, next.origin, "local-origin");
  localHighlightState = {
    hover: next.hover || null,
    target: next.target || null,
    origin: next.origin || null
  };
}

function setSourceDragPiece(square, active) {
  if (!square || !els.board) return;

  const pieceEl = els.board.querySelector(`[data-square="${square}"] .premove-overlay-piece, [data-square="${square}"] .piece, [data-square="${square}"] .piece-img`);
  if (pieceEl) {
    pieceEl.classList.toggle("source-drag-piece", Boolean(active));
  }
}

function setTrackedSquareClass(previousSquare, nextSquare, className) {
  if (previousSquare && previousSquare !== nextSquare) {
    const previous = els.board.querySelector(`[data-square="${previousSquare}"]`);
    if (previous) previous.classList.remove(className);
  }

  if (nextSquare) {
    const next = els.board.querySelector(`[data-square="${nextSquare}"]`);
    if (next) next.classList.add(className);
  }

  if (!nextSquare && previousSquare) {
    const previous = els.board.querySelector(`[data-square="${previousSquare}"]`);
    if (previous) previous.classList.remove(className);
  }
}

function addCoordinates(square, squareName, index) {
  const row = Math.floor(index / 8);
  const col = index % 8;
  const display = displayPositionForSquare(squareName);

  if (display && col === 0) {
    const rank = document.createElement("span");
    rank.className = "coord rank";
    rank.textContent = squareName.slice(1);
    square.appendChild(rank);
  }

  if (display && row === 7) {
    const file = document.createElement("span");
    file.className = "coord file";
    file.textContent = squareName[0];
    square.appendChild(file);
  }
}

function getDisplaySquares() {
  const files = boardOrientation === "white" ? FILES : FILES.slice().reverse();
  const ranks = boardOrientation === "white" ? [8, 7, 6, 5, 4, 3, 2, 1] : [1, 2, 3, 4, 5, 6, 7, 8];
  const squares = [];

  ranks.forEach((rank) => {
    files.forEach((file) => squares.push(`${file}${rank}`));
  });

  return squares;
}

function currentDisplayBoard() {
  return currentDisplayModel().board;
}

function currentDisplayModel() {
  if (viewingMoveIndex === null) {
    const model = createDisplayModel(gameState.board || {});
    applyQueuedPremovesToDisplayModel(model);
    applyPendingLocalMove(model.board);
    return model;
  }

  return {
    board: boardAfterMoveIndex(viewingMoveIndex),
    underlays: {}
  };
}

function currentInteractionBoard() {
  const model = createDisplayModel(gameState.board || {});
  if (gameState.turn !== myRole) {
    applyQueuedPremovesToDisplayModel(model);
  }
  return model.board;
}

function createDisplayModel(board = {}) {
  return {
    board: cloneBoardForDisplay(board),
    underlays: {}
  };
}

function cloneBoardForDisplay(board) {
  const clone = {};

  for (const [square, piece] of Object.entries(board || {})) {
    if (piece) clone[square] = { ...piece };
  }

  return clone;
}

function applyPendingLocalMove(board) {
  if (!pendingLocalMove || !pendingLocalMove.from || !pendingLocalMove.to) {
    return board;
  }

  const piece = board[pendingLocalMove.from] || pendingLocalMove.piece;
  if (!piece) return board;

  delete board[pendingLocalMove.from];

  const finalPiece = pendingLocalMove.promotion
    ? createPiece(piece.color, pendingLocalMove.promotion)
    : { ...piece };

  board[pendingLocalMove.to] = finalPiece;
  applyPendingCastlingMove(board, pendingLocalMove.from, pendingLocalMove.to, piece);
  return board;
}

function applyQueuedPremovesToBoard(board) {
  const model = { board, underlays: {} };
  applyQueuedPremovesToDisplayModel(model);
  return model.board;
}

function applyQueuedPremovesToDisplayModel(model) {
  premoveQueue.forEach((move) => applyPlannedMoveToDisplayModel(model, move));
  return model;
}

function applyPlannedMoveToDisplayModel(model, move) {
  if (!move || !isValidSquare(move.from) || !isValidSquare(move.to)) return;

  const board = model.board || {};
  const underlays = model.underlays || {};
  const piece = board[move.from] || move.piece;
  if (!piece) return;

  delete board[move.from];
  if (underlays[move.from]) {
    board[move.from] = underlays[move.from];
    delete underlays[move.from];
  }

  const finalPiece = move.promotion
    ? createPiece(piece.color, move.promotion)
    : { ...piece };

  const target = board[move.to] || null;
  if (target && target.color === finalPiece.color) {
    if (!underlays[move.to]) {
      underlays[move.to] = { ...target };
    }
  } else {
    delete underlays[move.to];
  }

  board[move.to] = finalPiece;
  applyPendingCastlingMove(board, move.from, move.to, piece);
}

function applyPendingCastlingMove(board, from, to, piece) {
  if (!piece || piece.type !== "K") return;

  const fromFile = FILES.indexOf(from[0]);
  const toFile = FILES.indexOf(to[0]);
  if (Math.abs(toFile - fromFile) !== 2) return;

  const rank = from.slice(1);
  const kingSide = to[0] === "g";
  const rookFrom = `${kingSide ? "h" : "a"}${rank}`;
  const rookTo = `${kingSide ? "f" : "d"}${rank}`;
  const rook = board[rookFrom];

  if (rook && rook.type === "R" && rook.color === piece.color) {
    delete board[rookFrom];
    board[rookTo] = { ...rook };
  }
}

function boardAfterMoveIndex(index) {
  const board = createInitialBoard();
  const moves = Array.isArray(gameState.moveHistory) ? gameState.moveHistory.slice(0, index) : [];

  moves.forEach((move) => applyMoveToBoard(board, move));
  return board;
}

function createInitialBoard() {
  const board = {};
  const backRank = ["R", "N", "B", "Q", "K", "B", "N", "R"];

  FILES.forEach((file, index) => {
    board[`${file}1`] = createPiece("white", backRank[index]);
    board[`${file}2`] = createPiece("white", "P");
    board[`${file}7`] = createPiece("black", "P");
    board[`${file}8`] = createPiece("black", backRank[index]);
  });

  return board;
}

function createPiece(color, type) {
  return {
    color,
    type,
    symbol: PIECE_SYMBOLS[color][type]
  };
}

function applyMoveToBoard(board, move) {
  if (!move || !move.from || !move.to) return;

  const piece = board[move.from];
  if (!piece) return;

  delete board[move.from];
  if (move.capturedSquare && move.capturedSquare !== move.to) {
    delete board[move.capturedSquare];
  }

  board[move.to] = move.promotedPiece ? { ...move.promotedPiece } : piece;

  if (move.rookMove) {
    const rook = board[move.rookMove.from];
    delete board[move.rookMove.from];
    if (rook) board[move.rookMove.to] = rook;
  }
}

function setViewingMoveIndex(index) {
  const historyLength = Array.isArray(gameState.moveHistory) ? gameState.moveHistory.length : 0;
  viewingMoveIndex = clamp(Number(index), 0, historyLength);
  renderBoard();
  renderHistory();
}

function navigateHistory(delta) {
  const historyLength = Array.isArray(gameState.moveHistory) ? gameState.moveHistory.length : 0;
  const current = viewingMoveIndex === null ? historyLength : viewingMoveIndex;
  setViewingMoveIndex(current + delta);
}

function squareFromDisplay(row, col) {
  const fileIndex = boardOrientation === "white" ? col : 7 - col;
  const rank = boardOrientation === "white" ? 8 - row : row + 1;
  return `${FILES[fileIndex]}${rank}`;
}

function displayPositionForSquare(square) {
  if (!isValidSquare(square)) return null;

  const fileIndex = FILES.indexOf(square[0]);
  const rank = Number(square.slice(1));

  return {
    col: boardOrientation === "white" ? fileIndex : 7 - fileIndex,
    row: boardOrientation === "white" ? 8 - rank : rank - 1
  };
}

function squareToPosition(square) {
  return {
    file: FILES.indexOf(square[0]) + 1,
    rank: Number(square.slice(1))
  };
}

function positionToSquare(file, rank) {
  return `${FILES[file - 1]}${rank}`;
}

function squareShade(square) {
  const fileIndex = FILES.indexOf(square[0]);
  const rank = Number(square.slice(1));
  return (fileIndex + rank) % 2 === 0 ? "dark" : "light";
}

function normalizeGameState(state) {
  const safe = state && typeof state === "object" ? state : {};
  return {
    board: safe.board && typeof safe.board === "object" ? safe.board : {},
    turn: safe.turn === "black" ? "black" : "white",
    moveHistory: Array.isArray(safe.moveHistory) ? safe.moveHistory : [],
    lastMove: safe.lastMove || null,
    status: typeof safe.status === "string" ? safe.status : "playing",
    check: safe.check === "white" || safe.check === "black" ? safe.check : null,
    winner: safe.winner === "white" || safe.winner === "black" ? safe.winner : null,
    gameOver: Boolean(safe.gameOver),
    resultReason: typeof safe.resultReason === "string" ? safe.resultReason : null,
    halfmoveClock: Number(safe.halfmoveClock) || 0,
    clock: normalizeClockState(safe.clock),
    ready: normalizeReadyState(safe.ready),
    countdown: normalizeCountdownState(safe.countdown),
    createdAt: Number(safe.createdAt) || Date.now()
  };
}

function normalizeClockState(clock) {
  const safe = clock && typeof clock === "object" ? clock : {};
  const initialMs = clamp(Number(safe.initialMs) || CLOCK_DEFAULT_MS, 1000, 600000);

  return {
    initialMs,
    whiteMs: clamp(Number.isFinite(Number(safe.whiteMs)) ? Number(safe.whiteMs) : initialMs, 0, 600000),
    blackMs: clamp(Number.isFinite(Number(safe.blackMs)) ? Number(safe.blackMs) : initialMs, 0, 600000),
    activeColor: safe.activeColor === "black" ? "black" : "white",
    started: Boolean(safe.started),
    running: Boolean(safe.running),
    updatedAt: Number(safe.updatedAt) || Date.now(),
    serverNow: Number(safe.serverNow) || Number(safe.updatedAt) || Date.now(),
    receivedAt: Date.now()
  };
}

function normalizeReadyState(ready) {
  const safe = ready && typeof ready === "object" ? ready : {};
  return {
    white: Boolean(safe.white),
    black: Boolean(safe.black)
  };
}

function normalizeCountdownState(countdown) {
  const safe = countdown && typeof countdown === "object" ? countdown : {};
  const now = Date.now();
  return {
    active: Boolean(safe.active),
    startedAt: Number(safe.startedAt) || null,
    endsAt: Number(safe.endsAt) || null,
    serverNow: Number(safe.serverNow) || now,
    receivedAt: now
  };
}

function normalizePlayersState(players) {
  const safe = players && typeof players === "object" ? players : {};
  const profiles = safe.profiles && typeof safe.profiles === "object" ? safe.profiles : {};
  return {
    white: Boolean(safe.white),
    black: Boolean(safe.black),
    spectators: Number(safe.spectators) || 0,
    profiles: {
      white: normalizeProfile(profiles.white, "white"),
      black: normalizeProfile(profiles.black, "black")
    }
  };
}

function normalizeLobby(lobby) {
  const safe = lobby && typeof lobby === "object" ? lobby : {};
  return {
    rooms: Array.isArray(safe.rooms) ? safe.rooms.map(normalizeRoom).filter(Boolean) : [],
    challenges: Array.isArray(safe.challenges) ? safe.challenges.map(normalizeChallenge).filter(Boolean) : []
  };
}

function normalizeRoom(room) {
  if (!room || typeof room !== "object") return null;
  const players = room.players && typeof room.players === "object" ? room.players : {};
  const profiles = room.profiles && typeof room.profiles === "object" ? room.profiles : {};
  return {
    id: String(room.id || ""),
    name: String(room.name || "Table"),
    status: String(room.status || "waiting"),
    initialMs: Number(room.initialMs) || CLOCK_DEFAULT_MS,
    moveCount: Number(room.moveCount) || 0,
    players: {
      white: Boolean(players.white),
      black: Boolean(players.black),
      spectators: Number(players.spectators) || 0
    },
    profiles: {
      white: normalizeProfile(profiles.white, "white"),
      black: normalizeProfile(profiles.black, "black")
    },
    createdAt: Number(room.createdAt) || Date.now()
  };
}

function normalizeChallenge(challenge) {
  if (!challenge || typeof challenge !== "object") return null;
  const players = challenge.players && typeof challenge.players === "object" ? challenge.players : {};
  const profiles = challenge.profiles && typeof challenge.profiles === "object" ? challenge.profiles : {};
  return {
    id: String(challenge.id || ""),
    roomId: String(challenge.roomId || ""),
    seconds: Number(challenge.seconds) || 60,
    color: ["white", "black", "random"].includes(challenge.color) ? challenge.color : "random",
    creatorRole: isPlayerRole(challenge.creatorRole) ? challenge.creatorRole : null,
    opponentRole: isPlayerRole(challenge.opponentRole) ? challenge.opponentRole : null,
    creatorId: String(challenge.creatorId || ""),
    creatorName: sanitizeName(challenge.creatorName || ""),
    players: {
      white: Boolean(players.white),
      black: Boolean(players.black),
      spectators: Number(players.spectators) || 0
    },
    profiles: {
      white: normalizeProfile(profiles.white, "white"),
      black: normalizeProfile(profiles.black, "black")
    },
    createdAt: Number(challenge.createdAt) || Date.now()
  };
}

function normalizeProfile(profile, role) {
  if (!profile || typeof profile !== "object") return null;
  return {
    clientId: String(profile.clientId || ""),
    role,
    avatar: avatarExists(profile.avatar) ? profile.avatar : defaultAvatarForRole(role),
    name: sanitizeName(profile.name),
    connectedAt: Number(profile.connectedAt) || Date.now()
  };
}

function normalizeChatMessages(messages) {
  return Array.isArray(messages) ? messages.map(normalizeChatMessage).filter(Boolean) : [];
}

function normalizeArrows(arrows) {
  if (!Array.isArray(arrows)) return [];

  return arrows
    .map((arrow) => {
      if (!arrow || typeof arrow !== "object") return null;
      if (arrow.kind === "circle") {
        const square = String(arrow.square || "").trim().toLowerCase();
        if (!isValidSquare(square)) return null;
        return {
          id: String(arrow.id || `${square}-${Math.random()}`),
          kind: "circle",
          square,
          color: arrow.color === "red" ? "red" : "green",
          role: isPlayerRole(arrow.role) ? arrow.role : "spectator",
          clientId: String(arrow.clientId || "")
        };
      }

      const from = String(arrow.from || "").trim().toLowerCase();
      const to = String(arrow.to || "").trim().toLowerCase();
      if (!isValidSquare(from) || !isValidSquare(to) || from === to) return null;
      return {
        id: String(arrow.id || `${from}-${to}-${Math.random()}`),
        kind: "arrow",
        from,
        to,
        color: arrow.color === "red" ? "red" : "green",
        role: isPlayerRole(arrow.role) ? arrow.role : "spectator",
        clientId: String(arrow.clientId || "")
      };
    })
    .filter(Boolean);
}

function normalizeTakebackOffer(offer) {
  if (!offer || typeof offer !== "object") return null;

  return {
    id: String(offer.id || ""),
    requesterId: String(offer.requesterId || ""),
    requesterRole: offer.requesterRole === "black" ? "black" : "white",
    moveNumber: Number(offer.moveNumber) || 0
  };
}

function normalizeDrawOffer(offer) {
  if (!offer || typeof offer !== "object") return null;

  return {
    id: String(offer.id || ""),
    requesterId: String(offer.requesterId || ""),
    requesterRole: offer.requesterRole === "black" ? "black" : "white",
    moveNumber: Number(offer.moveNumber) || 0
  };
}

function normalizeChatMessage(message) {
  if (!message || typeof message !== "object") return null;
  return {
    id: String(message.id || `${Date.now()}-${Math.random()}`),
    clientId: String(message.clientId || ""),
    role: isPlayerRole(message.role) ? message.role : "spectator",
    avatar: avatarExists(message.avatar) ? message.avatar : defaultAvatarForRole(message.role),
    name: sanitizeName(message.name),
    text: String(message.text || "").slice(0, 240),
    timestamp: Number(message.timestamp) || Date.now()
  };
}

function removeDisconnectedIntents() {
  for (const [id, intent] of remoteIntents.entries()) {
    if (!intent || !playersState[intent.role]) {
      remoteIntents.delete(id);
    }
  }
}

function removeInactiveChildren(container, activeIds, cache = null) {
  if (cache) {
    for (const [id, child] of cache.entries()) {
      if (!activeIds.has(id) || !child.isConnected) {
        child.remove();
        cache.delete(id);
      }
    }
    return;
  }

  Array.from(container.children).forEach((child) => {
    if (!activeIds.has(child.dataset.clientId)) {
      child.remove();
    }
  });
}

function removeInactiveHalos(activeIds) {
  for (const [key, child] of remoteDom.halos.entries()) {
    const id = key.split(":")[0];
    if (!activeIds.has(id)) {
      child.remove();
      remoteDom.halos.delete(key);
    }
  }
}

function removeInactiveTrailPaths(activeIds) {
  for (const [id, path] of remoteDom.trails.entries()) {
    if (!activeIds.has(id) || !path.isConnected) {
      path.remove();
      remoteDom.trails.delete(id);
    }
  }
}

function clearRemoteOverlay() {
  els.remoteCursors.textContent = "";
  els.remoteGhosts.textContent = "";
  els.remoteHalos.textContent = "";
  Array.from(els.trailSvg.querySelectorAll(".trail-path")).forEach((path) => path.remove());
  remoteDom.cursors.clear();
  remoteDom.ghosts.clear();
  remoteDom.halos.clear();
  remoteDom.trails.clear();
}

function findChildByClientId(container, id) {
  return Array.from(container.children).find((child) => child.dataset.clientId === id) || null;
}

function hasLiveTrails() {
  const now = performance.now();

  for (const intent of remoteIntents.values()) {
    if ((intent.trail || []).some((point) => now - point.t < TRAIL_MAX_AGE_MS)) {
      return true;
    }
  }

  return false;
}

function intentChip(intent) {
  if (intent.state === "dragging" && intent.grabbedPiece) {
    return `saisit ${intent.grabbedPiece.symbol} ${intent.fromSquare || ""}`.trim();
  }

  if (intent.hoveredSquare) {
    return intent.hoveredSquare;
  }

  return "veille";
}

function computeShortStatus(connected) {
  if (!connected) return "Déconnecté — recharge la page";
  if (gameState.status === "checkmate") {
    return `Échec et mat. ${TURN_LABELS[gameState.winner]} gagne.`;
  }
  if (gameState.status === "timeout") {
    return `Temps écoulé. ${TURN_LABELS[gameState.winner]} gagne.`;
  }
  if (gameState.status === "resignation") {
    return `Abandon. ${TURN_LABELS[gameState.winner]} gagne.`;
  }
  if (gameState.status === "stalemate") return "Pat. Partie nulle.";
  if (gameState.status === "draw") return drawLabel();
  if (gameState.check) return `Échec au roi ${TURN_LABELS[gameState.check]}.`;
  if (myRole === "white" && !playersState.black) return "En attente des Noirs";
  if (myRole === "black" && !playersState.white) return "Blancs déconnectés";
  if (myRole === "spectator") return "Tu observes la partie en direct.";
  if (isCountdownActive()) return `Depart dans ${countdownNumber()}`;
  if (isPlayerRole(myRole) && !hasGameStarted()) return "En attente du lancement.";
  if (isPlayerRole(myRole) && gameState.turn === myRole) return "À toi de jouer.";
  if (isPlayerRole(myRole)) return `En attente du coup ${TURN_LABELS[gameState.turn].toLowerCase()}.`;
  return "Connexion au serveur…";
}

function statusLabel() {
  if (gameState.status === "checkmate") {
    return `Mat : ${TURN_LABELS[gameState.winner]} gagne`;
  }

  if (gameState.status === "timeout") {
    return `Temps : ${TURN_LABELS[gameState.winner]} gagne`;
  }

  if (gameState.status === "resignation") {
    return `Abandon : ${TURN_LABELS[gameState.winner]} gagne`;
  }

  if (gameState.status === "stalemate") {
    return "Pat : nulle";
  }

  if (gameState.status === "draw") {
    return "Nulle";
  }

  if (gameState.check) {
    return `Échec : ${TURN_LABELS[gameState.check]}`;
  }

  if (isCountdownActive()) {
    return `Depart : ${countdownNumber()}`;
  }

  if (!hasGameStarted()) {
    const ready = gameState.ready || createDefaultReadyState();
    const readyCount = Number(Boolean(ready.white)) + Number(Boolean(ready.black));
    return `Prets : ${readyCount}/2`;
  }

  return `Tour : ${TURN_LABELS[gameState.turn] || "Blancs"}`;
}

function drawLabel() {
  if (gameState.resultReason === "agreement") return "Nulle par accord.";
  if (gameState.resultReason === "insufficientMaterial") return "Nulle par matériel insuffisant.";
  if (gameState.resultReason === "fiftyMoveRule") return "Nulle par règle des 50 coups.";
  if (gameState.resultReason === "threefoldRepetition") return "Nulle par répétition triple.";
  return "Partie nulle.";
}

function findKingSquare(color) {
  for (const [square, piece] of Object.entries(gameState.board || {})) {
    if (piece && piece.color === color && piece.type === "K") {
      return square;
    }
  }

  return null;
}

function showRoleMessage() {
  if (myRole === "white") {
    showError(playersState.black ? "Tu es Blancs." : "Tu es Blancs. En attente des Noirs.");
    return;
  }

  if (myRole === "black") {
    showError("Tu es Noirs.");
    return;
  }

  if (myRole === "spectator") {
    showError("Tu es spectateur.");
  }
}

function roleLabel(role) {
  if (role === "white") return "Tu es Blancs";
  if (role === "black") return "Tu es Noirs";
  if (role === "spectator") return "Tu es Spectateur";
  return "Rôle en attente";
}

function roleClass(role) {
  if (role === "white") return "white-role";
  if (role === "black") return "black-role";
  if (role === "spectator") return "spectator-role";
  return "neutral";
}

function setAvatarBubble(element, avatar) {
  if (!element) return;

  const safeAvatar = avatarExists(avatar) ? avatar : "empty";
  element.dataset.avatar = safeAvatar;
  element.textContent = "";

  if (safeAvatar === "empty") {
    element.textContent = "?";
    return;
  }

  const face = document.createElement("span");
  face.className = "animal-face";
  face.innerHTML = [
    "<span class=\"animal-ear left\"></span>",
    "<span class=\"animal-ear right\"></span>",
    "<span class=\"animal-eye left\"></span>",
    "<span class=\"animal-eye right\"></span>",
    "<span class=\"animal-snout\"></span>",
    "<span class=\"animal-mark\"></span>"
  ].join("");
  element.appendChild(face);
}

function avatarOption(avatar) {
  return AVATAR_OPTIONS.find((option) => option.id === avatar) || AVATAR_OPTIONS[0];
}

function avatarExists(avatar) {
  return AVATAR_OPTIONS.some((option) => option.id === avatar);
}

function currentProfileAvatar() {
  if (!isPlayerRole(myRole)) return selectedAvatar;
  const profile = playersState.profiles && playersState.profiles[myRole];
  return profile ? profile.avatar : selectedAvatar;
}

function currentProfileName() {
  if (!isPlayerRole(myRole)) return selectedName;
  const profile = playersState.profiles && playersState.profiles[myRole];
  return profile && profile.name ? profile.name : selectedName;
}

function defaultAvatarForRole(role) {
  if (role === "white") return "cat";
  if (role === "black") return "fox";
  return "owl";
}

function formatChatTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString("fr-FR", {
    hour: "2-digit",
    minute: "2-digit"
  });
}

function connectionTextFromSocket() {
  if (!socket) return "Déconnecté — recharge la page";
  if (socket.readyState === WebSocket.CONNECTING) return "Connexion au serveur…";
  if (socket.readyState === WebSocket.OPEN) return "Connecté";
  return "Déconnecté — recharge la page";
}

function formatAlgebraicMove(move) {
  if (!move || !move.piece || !move.to) return "";

  if (move.special === "castling") {
    return move.to && move.to[0] === "c" ? "O-O-O" : "O-O";
  }

  const piece = move.piece;
  const capture = Boolean(move.captured || move.special === "enPassant");
  const promotion = move.promotedPiece || (move.promotion ? { color: piece.color, type: move.promotion } : null);

  let text = "";
  if (piece.type === "P") {
    text = capture ? `${move.from ? move.from[0] : ""}x${move.to}` : move.to;
  } else {
    text = `${notationPieceSymbol(piece)}${capture ? "x" : ""}${move.to}`;
  }

  if (promotion) {
    text += `=${notationPieceSymbol(promotion)}`;
  }

  return text;
}

function notationPieceSymbol(piece) {
  if (!piece || !piece.type) return "";
  const symbols = NOTATION_SYMBOLS[piece.color] || NOTATION_SYMBOLS.white;
  return symbols[piece.type] || "";
}

function formatMove(move) {
  if (!move || !move.piece) return "Coup joué.";
  const capture = move.captured ? ` × ${move.captured.symbol}` : "";
  const promotion = move.promotedPiece ? ` = ${move.promotedPiece.symbol}` : "";
  const pieceText = move.piece.type === "P" ? "" : `${move.piece.symbol} `;
  const special = move.special === "castling"
    ? " (roque)"
    : move.special === "enPassant"
      ? " e.p."
      : "";
  return `${move.number}. ${COLOR_LABELS[move.color]} : ${pieceText}${move.from} → ${move.to}${capture}${promotion}${special}`;
}

function createEmptyLocalIntent() {
  return {
    state: "idle",
    pointerId: null,
    nx: 0,
    ny: 0,
    hoveredSquare: null,
    fromSquare: null,
    targetSquare: null,
    grabbedPiece: null
  };
}

function createEmptyDragState() {
  return {
    active: false,
    premove: false,
    pointerId: null,
    fromSquare: null,
    targetSquare: null,
    grabbedPiece: null,
    x: 0,
    y: 0,
    nx: 0,
    ny: 0
  };
}

function createEmptyArrowDragState() {
  return {
    active: false,
    pointerId: null,
    fromSquare: null,
    toSquare: null,
    color: "green",
    moved: false,
    startX: 0,
    startY: 0,
    previewPoint: null
  };
}

function createEmptyMatchScore() {
  return {
    pairKey: "",
    players: [],
    games: []
  };
}

function createDefaultClockState() {
  const now = Date.now();

  return {
    initialMs: CLOCK_DEFAULT_MS,
    whiteMs: CLOCK_DEFAULT_MS,
    blackMs: CLOCK_DEFAULT_MS,
    activeColor: "white",
    started: false,
    running: false,
    updatedAt: now,
    serverNow: now,
    receivedAt: now
  };
}

function createDefaultReadyState() {
  return {
    white: false,
    black: false
  };
}

function createDefaultCountdownState() {
  const now = Date.now();
  return {
    active: false,
    startedAt: null,
    endsAt: null,
    serverNow: now,
    receivedAt: now
  };
}

function isValidSquare(square) {
  return typeof square === "string" && /^[a-h][1-8]$/.test(square);
}

function isPlayerRole(role) {
  return role === "white" || role === "black";
}

function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
}

function setText(element, text) {
  if (element) {
    element.textContent = text;
  }
}
