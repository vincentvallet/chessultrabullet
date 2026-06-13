"use strict";

const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"];
const COLORS = ["white", "black"];
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
const NOTATION_SYMBOLS = {
  white: { K: "\u2654", Q: "\u2655", R: "\u2656", B: "\u2657", N: "\u2658", P: "" },
  black: { K: "\u265a", Q: "\u265b", R: "\u265c", B: "\u265d", N: "\u265e", P: "" }
};
const ARROW_COLORS = {
  green: "#45d483",
  red: "#ff5f72"
};
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
let pendingLocalMove = null;
let boardArrows = [];
let arrowDragState = createEmptyArrowDragState();
let takebackOffer = null;

const els = {};
let listenersAttached = false;
let lastIntentSentAt = 0;
let queuedIntent = null;
let intentTimer = 0;
let overlayFrame = 0;
let clockFrame = 0;
let errorTimer = 0;
let localHighlightState = { hover: null, target: null, origin: null };
let pendingPromotionResolve = null;
let lastSentIntentSnapshot = null;
let lastClockText = { white: "", black: "" };
let lastRenderedBoardKey = "";
let lastClockControlMode = "";

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
    remoteIntents = new Map();
    clearRemoteOverlay();
    boardOrientation = myRole === "black" ? "black" : "white";
    selectedAvatar = currentProfileAvatar() || defaultAvatarForRole(myRole);
    selectedName = currentProfileName();
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
    removeDisconnectedIntents();
    renderStatus();
    renderProfiles();
    renderAvatarChoices();
    scheduleIntentRender();
    return;
  }

  if (data.type === "lobby") {
    lobbyStateData = normalizeLobby(data.lobby);
    if (data.room) currentRoom = normalizeRoom(data.room);
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

  if (data.type === "gameState" || data.type === "resetDone") {
    const previousState = gameState;
    pendingLocalMove = null;
    pendingPremoveAttempt = null;
    takebackOffer = null;
    gameState = normalizeGameState(data.gameState);
    if (data.type === "resetDone") {
      remoteIntents = new Map();
      clearRemoteOverlay();
      premoveQueue = [];
      pendingPremoveAttempt = null;
      viewingMoveIndex = null;
      boardArrows = normalizeArrows(data.arrows);
      lastConfettiKey = null;
      lastSoundMoveKey = null;
    }
    resetLocalDrag();
    if (!gameState.gameOver) {
      viewingMoveIndex = null;
    }
    renderApp();
    handleOfficialStateEffects(previousState, gameState, data.type === "resetDone");
    trySendNextPremove();
    if (data.type === "resetDone") {
      showError("Nouvelle partie lancée.");
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
  renderStatus();
  renderProfiles();
  renderAvatarChoices();
  renderLobby();
  renderBoard();
  renderHistory();
  renderChat();
  renderPremoveList();
  renderTakeback();
  applyBoardPreferences();
  renderSoundToggle();
  renderArrows();
  scheduleIntentRender();
  scheduleClockRender();
}

function renderBoard() {
  if (!els.board) return;

  perfStats.renderBoardCalls += 1;
  if (ENABLE_PERF_DIAGNOSTICS && dragState.active && perfStats.lastPointerMoveAt && performance.now() - perfStats.lastPointerMoveAt < 120) {
    console.warn("[perf] renderBoard called shortly after pointer movement");
  }

  const displayBoard = currentDisplayBoard();
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
  renderPieces(displayBoard);
  renderPremoveHighlights();
  localHighlightState = {
    hover: null,
    target: dragState.active ? dragState.targetSquare : null,
    origin: dragState.active ? dragState.fromSquare : null
  };
}

function renderPieces(board = gameState.board || {}) {

  for (const [squareName, piece] of Object.entries(board)) {
    const square = els.board.querySelector(`[data-square="${squareName}"]`);
    if (!square || !piece) continue;

    const pieceEl = createPieceElement(piece);

    if (gameState.lastMove && gameState.lastMove.to === squareName) {
      pieceEl.classList.add("just-moved");
    }

    if (dragState.active && dragState.fromSquare === squareName) {
      pieceEl.classList.add("source-drag-piece");
    }

    square.appendChild(pieceEl);
  }
}

function createPieceElement(piece) {
  const img = document.createElement("img");
  img.className = `piece-img ${piece.color}-piece`;
  img.src = pieceAssetPath(piece);
  img.alt = "";
  img.draggable = false;
  img.setAttribute("aria-hidden", "true");
  img.addEventListener("error", () => {
    img.replaceWith(createUnicodePieceElement(piece));
  }, { once: true });
  return img;
}

function createUnicodePieceElement(piece) {
  const pieceEl = document.createElement("span");
  pieceEl.className = `piece ${piece.color}-piece`;
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
    els.chatInput.disabled = !isPlayerRole(myRole);
    els.chatInput.placeholder = myRole === "spectator"
      ? "Spectateur : lecture seule"
      : "Message a l’adversaire";
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

  setText(els.clockModeLabel, mode === "add" ? "Ajouter" : "Temps initial");
  setText(els.clockUnitText, "s");
  setText(els.clockSubmitBtn, mode === "add" ? "Ajouter" : "Appliquer");

  if (els.clockTargetSelect) {
    els.clockTargetSelect.hidden = mode !== "add";
  }
}

function isAddTimeMode() {
  return Boolean(gameState.clock && gameState.clock.started && !gameState.gameOver);
}

function renderGameActionButton() {
  if (!els.newGameBtn) return;
  els.newGameBtn.textContent = isAddTimeMode() ? "Ajouter du temps" : "Nouvelle partie";
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

  if (nextState.gameOver && nextState.winner) {
    const confettiKey = `${nextState.status}:${nextState.winner}:${nextState.moveHistory.length}`;
    if (confettiKey !== lastConfettiKey) {
      lastConfettiKey = confettiKey;
      launchConfetti(nextState.winner);
    }
  }
}

function renderSoundToggle() {
  if (!els.soundToggleBtn) return;
  els.soundToggleBtn.textContent = soundEnabled ? "Sons actives" : "Sons coupes";
  els.soundToggleBtn.setAttribute("aria-pressed", soundEnabled ? "true" : "false");
}

function applyBoardPreferences() {
  if (els.boardWrap) {
    els.boardWrap.style.setProperty("--board-size", `${boardSize}px`);
  }

  document.body.dataset.boardTheme = boardTheme;
  if (els.boardSizeInput && Number(els.boardSizeInput.value) !== boardSize) {
    els.boardSizeInput.value = String(boardSize);
  }
  if (els.boardThemeSelect && els.boardThemeSelect.value !== boardTheme) {
    els.boardThemeSelect.value = boardTheme;
  }
}

function playSound(kind) {
  if (!soundEnabled) return;

  try {
    audioContext = audioContext || new (window.AudioContext || window.webkitAudioContext)();
    const now = audioContext.currentTime;
    const master = audioContext.createGain();
    master.gain.setValueAtTime(0.0001, now);
    master.gain.exponentialRampToValueAtTime(0.055, now + 0.015);
    master.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);
    master.connect(audioContext.destination);

    const notes = soundNotes(kind);
    notes.forEach((note, index) => {
      const osc = audioContext.createOscillator();
      const gain = audioContext.createGain();
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
  if (!els.challengeList || !els.roomList) return;

  setText(els.roomText, currentRoom ? currentRoom.name : "Lobby");
  els.challengeList.textContent = "";
  els.roomList.textContent = "";

  const challenges = Array.isArray(lobbyStateData.challenges) ? lobbyStateData.challenges : [];
  const rooms = Array.isArray(lobbyStateData.rooms) ? lobbyStateData.rooms : [];

  if (!challenges.length) {
    const empty = document.createElement("div");
    empty.className = "lobby-empty";
    empty.textContent = "Aucun defi.";
    els.challengeList.appendChild(empty);
  } else {
    challenges.forEach((challenge) => {
      const row = document.createElement("div");
      row.className = "lobby-row";

      const text = document.createElement("span");
      text.textContent = `${challenge.seconds}s - ${challenge.color === "random" ? "aleatoire" : challenge.color}`;

      const button = document.createElement("button");
      button.type = "button";
      button.dataset.challengeId = challenge.id;
      button.textContent = "Jouer";
      button.disabled = challenge.creatorId === clientId;

      row.appendChild(text);
      row.appendChild(button);
      els.challengeList.appendChild(row);
    });
  }

  rooms.forEach((room) => {
    const row = document.createElement("div");
    row.className = "lobby-row";
    row.classList.toggle("is-current", currentRoom && room.id === currentRoom.id);

    const text = document.createElement("span");
    const white = room.players && room.players.white ? "B" : "-";
    const black = room.players && room.players.black ? "N" : "-";
    const spectators = room.players ? room.players.spectators : 0;
    text.textContent = `${room.name} (${white}/${black}, ${spectators} obs.)`;

    const button = document.createElement("button");
    button.type = "button";
    button.dataset.roomId = room.id;
    button.textContent = currentRoom && room.id === currentRoom.id ? "Ici" : "Regarder";
    button.disabled = currentRoom && room.id === currentRoom.id;

    row.appendChild(text);
    row.appendChild(button);
    els.roomList.appendChild(row);
  });
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
  appendArrowDefs(els.arrowSvg);

  boardArrows.forEach((arrow) => appendArrowElement(els.arrowSvg, arrow));

  if (arrowDragState.active && arrowDragState.fromSquare && arrowDragState.toSquare && arrowDragState.fromSquare !== arrowDragState.toSquare) {
    appendArrowElement(els.arrowSvg, {
      from: arrowDragState.fromSquare,
      to: arrowDragState.toSquare,
      color: arrowDragState.color,
      preview: true
    });
  }
}

function appendArrowDefs(svg) {
  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  Object.entries(ARROW_COLORS).forEach(([name, color]) => {
    const marker = document.createElementNS("http://www.w3.org/2000/svg", "marker");
    marker.setAttribute("id", `arrowHead-${name}`);
    marker.setAttribute("viewBox", "0 0 10 10");
    marker.setAttribute("refX", "8.5");
    marker.setAttribute("refY", "5");
    marker.setAttribute("markerWidth", "4.2");
    marker.setAttribute("markerHeight", "4.2");
    marker.setAttribute("orient", "auto-start-reverse");

    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M 0 0 L 10 5 L 0 10 z");
    path.setAttribute("fill", color);
    marker.appendChild(path);
    defs.appendChild(marker);
  });
  svg.appendChild(defs);
}

function appendArrowElement(svg, arrow) {
  if (!arrow || !isValidSquare(arrow.from) || !isValidSquare(arrow.to) || arrow.from === arrow.to) return;

  const from = squareCenterPercent(arrow.from);
  const to = squareCenterPercent(arrow.to);
  if (!from || !to) return;

  const colorName = arrow.color === "red" ? "red" : "green";
  const color = ARROW_COLORS[colorName];
  const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
  line.setAttribute("x1", from.x.toFixed(3));
  line.setAttribute("y1", from.y.toFixed(3));
  line.setAttribute("x2", to.x.toFixed(3));
  line.setAttribute("y2", to.y.toFixed(3));
  line.setAttribute("class", `board-arrow ${colorName}${arrow.preview ? " preview" : ""}`);
  line.setAttribute("stroke", color);
  line.setAttribute("marker-end", `url(#arrowHead-${colorName})`);
  svg.appendChild(line);
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

  const pointer = pointerToNormalizedPosition(event);
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
    showError("Cette pièce n’est pas à toi.");
    return;
  }

  const isPremove = gameState.turn !== myRole;

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

  if (!isPlayerRole(myRole)) return;

  perfStats.lastPointerMoveAt = performance.now();
  const pointer = pointerToNormalizedPosition(event);
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

  if (!dragState.active || dragState.pointerId !== event.pointerId) {
    return;
  }

  const pointer = pointerToNormalizedPosition(event);
  const from = dragState.fromSquare;
  const to = pointer.square;
  const wasDraggingPiece = dragState.grabbedPiece;
  const wasPremove = dragState.premove;

  if (els.board.hasPointerCapture(event.pointerId)) {
    els.board.releasePointerCapture(event.pointerId);
  }

  if (wasPremove && to && shouldAskPromotion(wasDraggingPiece, to)) {
    showPromotionDialog(wasDraggingPiece.color)
      .then((promotion) => enqueuePremove(from, to, promotion, wasDraggingPiece))
      .catch(() => showError("Promotion annulee."));
  } else if (wasPremove && to) {
    enqueuePremove(from, to, null, wasDraggingPiece);
  } else if (to && shouldAskPromotion(wasDraggingPiece, to)) {
    showPromotionDialog(wasDraggingPiece.color)
      .then((promotion) => requestMove(from, to, promotion))
      .catch(() => showError("Promotion annulee."));
  } else if (to) {
    requestMove(from, to);
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
    moved: false
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
  arrowDragState.moved = arrowDragState.moved || arrowDragState.toSquare !== arrowDragState.fromSquare;
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
  } else {
    clearPremoves();
    sendMessage({ type: "arrow", action: "clear" });
  }

  renderArrows();
}

function clearPremoves() {
  premoveQueue = [];
  pendingPremoveAttempt = null;
  renderBoard();
  renderPremoveList();
}

function requestMove(from, to, promotion = null) {
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
  if (!from || !to || from === to) {
    showError("Premove impossible.");
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
  if (!isPlayerRole(myRole) || gameState.gameOver || gameState.turn !== myRole) return;

  const next = premoveQueue.shift();
  pendingPremoveAttempt = next;
  renderBoard();
  renderPremoveList();
  requestMove(next.from, next.to, next.promotion);
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

function renderPremoveHighlights() {
  if (!els.board) return;
  els.board.querySelectorAll(".premove-from, .premove-to").forEach((square) => {
    square.classList.remove("premove-from", "premove-to");
  });
}

function shouldAskPromotion(piece, to) {
  if (!piece || piece.type !== "P" || !isValidSquare(to)) return false;
  return (piece.color === "white" && to.endsWith("8")) || (piece.color === "black" && to.endsWith("1"));
}

function showPromotionDialog(color) {
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

  return new Promise((resolve) => {
    pendingPromotionResolve = resolve;
  });
}

function sendChatMessage() {
  const text = (els.chatInput.value || "").trim();
  if (!text) return;

  if (!isPlayerRole(myRole)) {
    showError(myRole === "spectator" ? "Les spectateurs peuvent lire le chat mais pas ecrire." : "Connexion au serveur...");
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

function flipOrientation() {
  resetLocalDrag();
  boardOrientation = boardOrientation === "white" ? "black" : "white";
  renderApp();
}

function cacheElements() {
  els.board = document.getElementById("board");
  els.boardWrap = document.getElementById("boardWrap");
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
  els.soundToggleBtn = document.getElementById("soundToggleBtn");
  els.boardSizeInput = document.getElementById("boardSizeInput");
  els.boardThemeSelect = document.getElementById("boardThemeSelect");
  els.confettiLayer = document.getElementById("confettiLayer");
  els.premoveList = document.getElementById("premoveList");
  els.roomText = document.getElementById("roomText");
  els.challengeForm = document.getElementById("challengeForm");
  els.challengeTimeInput = document.getElementById("challengeTimeInput");
  els.challengeColorSelect = document.getElementById("challengeColorSelect");
  els.challengeList = document.getElementById("challengeList");
  els.roomList = document.getElementById("roomList");
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
  els.newGameBtn = document.getElementById("newGameBtn");
  els.takebackBtn = document.getElementById("takebackBtn");
  els.takebackBox = document.getElementById("takebackBox");
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

  els.newGameBtn.addEventListener("click", () => {
    if (isAddTimeMode()) {
      submitClockConfig();
      return;
    }

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

  els.orientationBtn.addEventListener("click", flipOrientation);

  els.takebackBtn.addEventListener("click", () => {
    if (!isPlayerRole(myRole)) {
      showError(myRole === "spectator" ? "Les spectateurs ne peuvent pas demander de reprise." : "Connexion au serveur...");
      return;
    }
    sendMessage({ type: "takebackRequest" });
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

  els.challengeForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const seconds = Number(els.challengeTimeInput ? els.challengeTimeInput.value : 60);
    sendMessage({
      type: "createChallenge",
      seconds,
      color: els.challengeColorSelect ? els.challengeColorSelect.value : "random"
    });
  });

  els.challengeList.addEventListener("click", (event) => {
    const button = event.target.closest("[data-challenge-id]");
    if (!button) return;
    sendMessage({ type: "acceptChallenge", challengeId: button.dataset.challengeId });
  });

  els.roomList.addEventListener("click", (event) => {
    const button = event.target.closest("[data-room-id]");
    if (!button) return;
    sendMessage({ type: "watchRoom", roomId: button.dataset.roomId });
  });

  els.clockForm.addEventListener("submit", (event) => {
    event.preventDefault();
    submitClockConfig();
  });

  els.profileForm.addEventListener("submit", (event) => {
    event.preventDefault();
    submitProfile();
  });

  els.soundToggleBtn.addEventListener("click", () => {
    soundEnabled = !soundEnabled;
    renderSoundToggle();
  });

  els.boardSizeInput.addEventListener("input", () => {
    boardSize = clamp(Number(els.boardSizeInput.value), 420, 860);
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

  const pieceEl = els.board.querySelector(`[data-square="${square}"] .piece, [data-square="${square}"] .piece-img`);
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
  if (viewingMoveIndex === null) {
    const board = cloneBoardForDisplay(gameState.board || {});
    applyQueuedPremovesToBoard(board);
    return applyPendingLocalMove(board);
  }

  return boardAfterMoveIndex(viewingMoveIndex);
}

function currentInteractionBoard() {
  const board = cloneBoardForDisplay(gameState.board || {});
  if (gameState.turn !== myRole) {
    applyQueuedPremovesToBoard(board);
  }
  return board;
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
  premoveQueue.forEach((move) => applyPlannedMoveToBoard(board, move));
  return board;
}

function applyPlannedMoveToBoard(board, move) {
  if (!move || !isValidSquare(move.from) || !isValidSquare(move.to)) return;

  const piece = board[move.from] || move.piece;
  if (!piece) return;

  delete board[move.from];

  const finalPiece = move.promotion
    ? createPiece(piece.color, move.promotion)
    : { ...piece };

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
    createdAt: Number(room.createdAt) || Date.now()
  };
}

function normalizeChallenge(challenge) {
  if (!challenge || typeof challenge !== "object") return null;
  return {
    id: String(challenge.id || ""),
    roomId: String(challenge.roomId || ""),
    seconds: Number(challenge.seconds) || 60,
    color: ["white", "black", "random"].includes(challenge.color) ? challenge.color : "random",
    creatorId: String(challenge.creatorId || ""),
    creatorName: sanitizeName(challenge.creatorName || ""),
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
      const from = String(arrow.from || "").trim().toLowerCase();
      const to = String(arrow.to || "").trim().toLowerCase();
      if (!isValidSquare(from) || !isValidSquare(to) || from === to) return null;
      return {
        id: String(arrow.id || `${from}-${to}-${Math.random()}`),
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
  if (gameState.status === "stalemate") return "Pat. Partie nulle.";
  if (gameState.status === "draw") return drawLabel();
  if (gameState.check) return `Échec au roi ${TURN_LABELS[gameState.check]}.`;
  if (myRole === "white" && !playersState.black) return "En attente des Noirs";
  if (myRole === "black" && !playersState.white) return "Blancs déconnectés";
  if (myRole === "spectator") return "Tu observes la partie en direct.";
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

  if (gameState.status === "stalemate") {
    return "Pat : nulle";
  }

  if (gameState.status === "draw") {
    return "Nulle";
  }

  if (gameState.check) {
    return `Échec : ${TURN_LABELS[gameState.check]}`;
  }

  return `Tour : ${TURN_LABELS[gameState.turn] || "Blancs"}`;
}

function drawLabel() {
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
    moved: false
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
