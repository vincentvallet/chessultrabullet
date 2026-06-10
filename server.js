"use strict";

const crypto = require("crypto");
const express = require("express");
const http = require("http");
const path = require("path");
const { WebSocketServer, WebSocket } = require("ws");

const PORT = Number(process.env.PORT || 3000);
const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"];
const COLORS = ["white", "black"];
const INTENT_STATES = new Set(["idle", "hover", "dragging"]);
const AVATAR_IDS = new Set(["cat", "dog", "fox", "panda", "owl", "tiger"]);
const PROMOTION_TYPES = new Set(["Q", "R", "B", "N"]);
const CHAT_HISTORY_LIMIT = 80;
const CHAT_TEXT_MAX = 240;
const PLAYER_NAME_MAX = 20;
const DEFAULT_CLOCK_MS = 15000;
const MIN_CLOCK_MS = 1000;
const MAX_CLOCK_MS = 600000;
const SERVER_INTENT_MIN_INTERVAL_MS = 80;
const INTENT_BUFFER_DROP_BYTES = 64 * 1024;
const PIECES = {
  white: { K: "♔", Q: "♕", R: "♖", B: "♗", N: "♘", P: "♙" },
  black: { K: "♚", Q: "♛", R: "♜", B: "♝", N: "♞", P: "♟" }
};
const COLOR_LABELS = { white: "Blancs", black: "Noirs" };
const chatMessages = [];

const gameState = {
  board: createInitialBoard(),
  turn: "white",
  moveHistory: [],
  lastMove: null,
  status: "playing",
  check: null,
  winner: null,
  gameOver: false,
  resultReason: null,
  castlingRights: createInitialCastlingRights(),
  halfmoveClock: 0,
  clock: createInitialClock(),
  createdAt: Date.now()
};

const clients = new Map();
const positionCounts = new Map();
recordCurrentPosition();

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use("/pieces", express.static(path.join(__dirname, "..", "pieces")));
app.use(express.static(path.join(__dirname, "public")));

wss.on("connection", (ws) => {
  const role = assignRole();
  const client = {
    id: createClientId(),
    ws,
    role,
    avatar: defaultAvatarForRole(role),
    name: "",
    connectedAt: Date.now(),
    lastIntent: null,
    lastBroadcastIntent: null,
    lastIntentBroadcastAt: 0,
    pendingIntent: null,
    intentFlushTimer: null,
    isAlive: true
  };

  clients.set(client.id, client);
  const clockChanged = syncClockRunningState();
  console.log(`[ws] client connected ${client.id} as ${client.role}`);

  send(client, {
    type: "welcome",
    clientId: client.id,
    role: client.role,
    gameState: serializeGameState(),
    players: getPlayersState(),
    chatMessages: chatMessages.map(cloneChatMessage)
  });
  sendExistingIntents(client);
  broadcast({ type: "players", players: getPlayersState() });
  if (clockChanged) {
    broadcast({ type: "gameState", gameState: serializeGameState() });
  }

  ws.on("pong", () => {
    client.isAlive = true;
  });

  ws.on("message", (raw) => {
    const message = safeJsonParse(raw);

    if (!message || typeof message.type !== "string") {
      console.warn(`[ws] invalid message from ${client.id}`);
      send(client, { type: "error", message: "Message WebSocket invalide." });
      return;
    }

    if (message.type === "intent") {
      handleIntent(client, message);
      return;
    }

    if (message.type === "move") {
      const result = tryMovePiece(client, message.from, message.to, message.promotion);
      if (!result.ok) {
        if (result.stateChanged) {
          broadcast({ type: "gameState", gameState: serializeGameState() });
        }
        console.warn(`[move] refused for ${client.id}: ${result.message}`);
        send(client, { type: "error", message: result.message });
        return;
      }

      broadcast({ type: "gameState", gameState: serializeGameState() });
      return;
    }

    if (message.type === "profile") {
      handleProfile(client, message);
      return;
    }

    if (message.type === "chat") {
      handleChat(client, message);
      return;
    }

    if (message.type === "reset") {
      if (client.role === "spectator") {
        send(client, {
          type: "error",
          message: "Les spectateurs ne peuvent pas réinitialiser la partie."
        });
        return;
      }

      resetGame();
      syncClockRunningState();
      broadcast({ type: "resetDone", gameState: serializeGameState() });
      return;
    }

    if (message.type === "clockConfig") {
      handleClockConfig(client, message);
      return;
    }

    send(client, { type: "error", message: "Type de message inconnu." });
  });

  ws.on("error", (error) => {
    console.error(`[ws] error for ${client.id}`, error.message);
  });

  ws.on("close", () => {
    cleanupClient(client.id);
  });
});

const heartbeat = setInterval(() => {
  for (const client of clients.values()) {
    if (client.isAlive === false) {
      client.ws.terminate();
      cleanupClient(client.id);
      continue;
    }

    client.isAlive = false;
    try {
      client.ws.ping();
    } catch (error) {
      console.error(`[ws] ping failed for ${client.id}`, error.message);
    }
  }
}, 30000);

const clockWatcher = setInterval(() => {
  if (updateClockNow(true)) {
    broadcast({ type: "gameState", gameState: serializeGameState() });
  }
}, 50);

wss.on("close", () => {
  clearInterval(heartbeat);
  clearInterval(clockWatcher);
});

server.listen(PORT, () => {
  console.log(`Chess UltraBullet listening on http://localhost:${PORT}`);
});

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
    symbol: PIECES[color][type]
  };
}

function createInitialCastlingRights() {
  return {
    white: { kingSide: true, queenSide: true },
    black: { kingSide: true, queenSide: true }
  };
}

function createInitialClock(initialMs = DEFAULT_CLOCK_MS) {
  const safeInitialMs = clampNumber(initialMs, MIN_CLOCK_MS, MAX_CLOCK_MS, DEFAULT_CLOCK_MS);

  return {
    initialMs: safeInitialMs,
    whiteMs: safeInitialMs,
    blackMs: safeInitialMs,
    activeColor: "white",
    started: false,
    running: false,
    updatedAt: Date.now()
  };
}

function isValidSquare(square) {
  return typeof square === "string" && /^[a-h][1-8]$/.test(square);
}

function assignRole() {
  const rolesTaken = new Set(Array.from(clients.values()).map((client) => client.role));

  if (!rolesTaken.has("white")) return "white";
  if (!rolesTaken.has("black")) return "black";
  return "spectator";
}

function getPlayersState() {
  let white = false;
  let black = false;
  let spectators = 0;
  const profiles = {
    white: null,
    black: null
  };

  for (const client of clients.values()) {
    if (client.role === "white") {
      white = true;
      profiles.white = publicClientProfile(client);
    }
    if (client.role === "black") {
      black = true;
      profiles.black = publicClientProfile(client);
    }
    if (client.role === "spectator") spectators += 1;
  }

  return { white, black, spectators, profiles };
}

function serializeGameState() {
  return {
    board: cloneBoard(gameState.board),
    turn: gameState.turn,
    moveHistory: gameState.moveHistory.map(cloneMove),
    lastMove: gameState.lastMove ? cloneMove(gameState.lastMove) : null,
    status: gameState.status,
    check: gameState.check,
    winner: gameState.winner,
    gameOver: gameState.gameOver,
    resultReason: gameState.resultReason,
    castlingRights: cloneCastlingRights(gameState.castlingRights),
    halfmoveClock: gameState.halfmoveClock,
    clock: serializeClock(),
    createdAt: gameState.createdAt
  };
}

function broadcast(message, exceptClientId = null) {
  for (const client of clients.values()) {
    if (client.id === exceptClientId) continue;
    send(client, message);
  }
}

function send(client, message) {
  if (!client || client.ws.readyState !== WebSocket.OPEN) return;

  try {
    client.ws.send(JSON.stringify(message));
  } catch (error) {
    console.error(`[ws] send failed for ${client.id}`, error.message);
  }
}

function serializeClock() {
  const now = Date.now();
  const projected = projectClock(now);
  return {
    ...projected,
    serverNow: now
  };
}

function projectClock(now = Date.now()) {
  const clock = gameState.clock || createInitialClock();
  const projected = {
    initialMs: clock.initialMs,
    whiteMs: clock.whiteMs,
    blackMs: clock.blackMs,
    activeColor: clock.activeColor === "black" ? "black" : "white",
    started: Boolean(clock.started),
    running: Boolean(clock.running),
    updatedAt: clock.updatedAt || now
  };

  if (projected.running && !gameState.gameOver) {
    const elapsed = Math.max(0, now - projected.updatedAt);
    projected[`${projected.activeColor}Ms`] = Math.max(0, projected[`${projected.activeColor}Ms`] - elapsed);
  }

  return projected;
}

function updateClockNow(detectTimeout = false) {
  if (!gameState.clock) {
    gameState.clock = createInitialClock();
  }

  const now = Date.now();
  const clock = gameState.clock;
  let changed = false;

  if (clock.running && !gameState.gameOver) {
    const elapsed = Math.max(0, now - clock.updatedAt);
    if (elapsed > 0) {
      const key = `${clock.activeColor}Ms`;
      clock[key] = Math.max(0, clock[key] - elapsed);
      clock.updatedAt = now;
      changed = true;
    }

    if (detectTimeout && clock[`${clock.activeColor}Ms`] <= 0) {
      finishByTimeout(clock.activeColor);
      changed = true;
    }
  } else {
    clock.updatedAt = now;
  }

  return changed && gameState.gameOver;
}

function finishByTimeout(loserColor) {
  gameState.status = "timeout";
  gameState.check = null;
  gameState.gameOver = true;
  gameState.winner = opposite(loserColor);
  gameState.resultReason = "timeout";
  gameState.clock.running = false;
  gameState.clock.updatedAt = Date.now();
}

function syncClockRunningState(now = Date.now()) {
  if (!gameState.clock) {
    gameState.clock = createInitialClock();
  }

  updateClockNow(false);

  const shouldRun = Boolean(gameState.clock.started)
    && !gameState.gameOver
    && hasConnectedRole("white")
    && hasConnectedRole("black");
  const previousRunning = gameState.clock.running;
  const previousActive = gameState.clock.activeColor;

  gameState.clock.running = shouldRun;
  gameState.clock.activeColor = gameState.turn === "black" ? "black" : "white";
  gameState.clock.updatedAt = now;

  return previousRunning !== gameState.clock.running || previousActive !== gameState.clock.activeColor;
}

function resetClock(initialMs = gameState.clock ? gameState.clock.initialMs : DEFAULT_CLOCK_MS) {
  gameState.clock = createInitialClock(initialMs);
}

function handleClockConfig(client, message) {
  if (!client || client.role === "spectator") {
    send(client, { type: "error", message: "Les spectateurs ne peuvent pas régler le chronomètre." });
    return;
  }

  const seconds = Number(message.seconds);
  if (!Number.isFinite(seconds)) {
    send(client, { type: "error", message: "Chronomètre invalide." });
    return;
  }

  const initialMs = clampNumber(Math.round(seconds * 1000), MIN_CLOCK_MS, MAX_CLOCK_MS, DEFAULT_CLOCK_MS);
  resetClock(initialMs);
  gameState.clock.started = gameState.moveHistory.length > 0;
  syncClockRunningState();
  broadcast({ type: "gameState", gameState: serializeGameState() });
}

function hasConnectedRole(role) {
  for (const client of clients.values()) {
    if (client.role === role) return true;
  }

  return false;
}

function tryMovePiece(client, from, to, promotion) {
  if (!client || client.role === "spectator") {
    return { ok: false, message: "Tu es spectateur." };
  }

  if (updateClockNow(true)) {
    return { ok: false, message: "Temps écoulé.", stateChanged: true };
  }

  if (gameState.gameOver) {
    return { ok: false, message: "La partie est terminee." };
  }

  const source = normalizeSquare(from);
  const target = normalizeSquare(to);

  if (!isValidSquare(source) || !isValidSquare(target) || source === target) {
    return { ok: false, message: "Coup impossible." };
  }

  const piece = gameState.board[source];
  const captured = gameState.board[target] || null;

  if (!piece) {
    return { ok: false, message: "Coup impossible." };
  }

  if (piece.color !== client.role) {
    return { ok: false, message: "Cette pièce n’est pas à toi." };
  }

  if (gameState.turn !== client.role) {
    return { ok: false, message: "Ce n’est pas ton tour." };
  }

  if (captured && captured.color === client.role) {
    return { ok: false, message: "Coup impossible." };
  }

  if (captured && captured.type === "K") {
    return { ok: false, message: "On ne peut pas capturer le roi." };
  }

  const validation = validateLegalMove(client.role, source, target, promotion);
  if (!validation.ok) {
    return validation;
  }

  const finalPiece = validation.promotion
    ? createPiece(client.role, validation.promotion)
    : piece;

  const move = {
    number: Math.floor(gameState.moveHistory.length / 2) + 1,
    color: client.role,
    piece: clonePiece(piece),
    from: source,
    to: target,
    captured: validation.captured ? clonePiece(validation.captured) : null,
    capturedSquare: validation.capturedSquare || null,
    special: validation.special || null,
    promotion: validation.promotion || null,
    promotedPiece: validation.promotion ? clonePiece(finalPiece) : null,
    rookMove: validation.rookMove || null,
    timestamp: Date.now()
  };

  delete gameState.board[source];

  if (validation.capturedSquare && validation.capturedSquare !== target) {
    delete gameState.board[validation.capturedSquare];
  }

  gameState.board[target] = finalPiece;

  if (validation.rookMove) {
    const rook = gameState.board[validation.rookMove.from];
    delete gameState.board[validation.rookMove.from];
    gameState.board[validation.rookMove.to] = rook;
  }

  if (!gameState.clock.started && client.role === "white" && gameState.moveHistory.length === 0) {
    gameState.clock.started = true;
    gameState.clock.updatedAt = Date.now();
  }

  gameState.turn = opposite(client.role);
  move.label = formatMove(move);
  gameState.lastMove = move;
  gameState.moveHistory.push(move);
  updateCastlingRights(move);
  updateHalfmoveClock(move);
  recordCurrentPosition();
  updateGameStatus();
  syncClockRunningState();

  console.log(`[move] ${move.label}`);
  return { ok: true, move };
}

function validateLegalMove(color, from, to, promotion) {
  const target = gameState.board[to] || null;
  if (target && target.type === "K") {
    return { ok: false, message: "On ne peut pas capturer le roi." };
  }

  const validation = validateMove(color, from, to, promotion);
  if (!validation.ok) return validation;

  const simulatedBoard = simulateBoardMove(gameState.board, color, from, to, validation);
  if (isKingInCheck(color, simulatedBoard)) {
    return { ok: false, message: "Ton roi resterait en echec." };
  }

  return validation;
}

function validateMove(color, from, to, promotion) {
  const piece = gameState.board[from];
  const target = gameState.board[to] || null;
  const fromPos = squareToPosition(from);
  const toPos = squareToPosition(to);
  const df = toPos.file - fromPos.file;
  const dr = toPos.rank - fromPos.rank;
  const absDf = Math.abs(df);
  const absDr = Math.abs(dr);

  if (!piece || piece.color !== color) {
    return { ok: false, message: "Coup impossible." };
  }

  if (target && target.color === color) {
    return { ok: false, message: "Coup impossible." };
  }

  if (piece.type === "P") {
    return validatePawnMove(color, from, to, promotion);
  }

  if (piece.type === "N") {
    if (!((absDf === 1 && absDr === 2) || (absDf === 2 && absDr === 1))) {
      return { ok: false, message: "Coup impossible." };
    }
    return { ok: true, captured: target };
  }

  if (piece.type === "B") {
    if (absDf !== absDr || !isPathClear(from, to)) {
      return { ok: false, message: "Coup impossible." };
    }
    return { ok: true, captured: target };
  }

  if (piece.type === "R") {
    if (!((df === 0 || dr === 0) && isPathClear(from, to))) {
      return { ok: false, message: "Coup impossible." };
    }
    return { ok: true, captured: target };
  }

  if (piece.type === "Q") {
    const diagonal = absDf === absDr;
    const straight = df === 0 || dr === 0;
    if (!(diagonal || straight) || !isPathClear(from, to)) {
      return { ok: false, message: "Coup impossible." };
    }
    return { ok: true, captured: target };
  }

  if (piece.type === "K") {
    if (absDf === 2 && dr === 0) {
      return validateCastling(color, from, to);
    }

    if (absDf > 1 || absDr > 1) {
      return { ok: false, message: "Coup impossible." };
    }
    return { ok: true, captured: target };
  }

  return { ok: false, message: "Coup impossible." };
}

function validatePawnMove(color, from, to, promotion) {
  const target = gameState.board[to] || null;
  const fromPos = squareToPosition(from);
  const toPos = squareToPosition(to);
  const df = toPos.file - fromPos.file;
  const dr = toPos.rank - fromPos.rank;
  const direction = color === "white" ? 1 : -1;
  const startRank = color === "white" ? 2 : 7;
  const promotionRank = color === "white" ? 8 : 1;
  const promotionType = sanitizePromotion(promotion);
  let captured = target;
  let capturedSquare = target ? to : null;
  let isLegal = false;
  let special = null;

  if (df === 0 && dr === direction && !target) {
    isLegal = true;
  }

  if (df === 0 && dr === direction * 2 && fromPos.rank === startRank && !target) {
    const middleSquare = positionToSquare(fromPos.file, fromPos.rank + direction);
    isLegal = !gameState.board[middleSquare];
  }

  if (Math.abs(df) === 1 && dr === direction && target && target.color !== color) {
    isLegal = true;
  }

  if (Math.abs(df) === 1 && dr === direction && !target) {
    const enPassant = getEnPassantCapture(color, from, to);
    if (enPassant) {
      isLegal = true;
      special = "enPassant";
      captured = enPassant.captured;
      capturedSquare = enPassant.square;
    }
  }

  if (!isLegal) {
    return { ok: false, message: "Coup impossible." };
  }

  if (toPos.rank === promotionRank) {
    if (!promotionType) {
      return { ok: false, message: "Choisis une piece de promotion." };
    }

    return {
      ok: true,
      captured,
      capturedSquare,
      special: special || "promotion",
      promotion: promotionType
    };
  }

  return { ok: true, captured, capturedSquare, special };
}

function validateCastling(color, from, to) {
  const rank = color === "white" ? 1 : 8;
  const kingStart = `e${rank}`;
  const kingSide = to === `g${rank}`;
  const queenSide = to === `c${rank}`;

  if (from !== kingStart || (!kingSide && !queenSide)) {
    return { ok: false, message: "Coup impossible." };
  }

  const side = kingSide ? "kingSide" : "queenSide";
  if (!gameState.castlingRights[color] || !gameState.castlingRights[color][side]) {
    return { ok: false, message: "Roque impossible." };
  }

  const rookFrom = kingSide ? `h${rank}` : `a${rank}`;
  const rookTo = kingSide ? `f${rank}` : `d${rank}`;
  const rook = gameState.board[rookFrom];

  if (!rook || rook.color !== color || rook.type !== "R") {
    return { ok: false, message: "Roque impossible." };
  }

  const clearSquares = kingSide ? [`f${rank}`, `g${rank}`] : [`d${rank}`, `c${rank}`, `b${rank}`];
  if (clearSquares.some((square) => gameState.board[square])) {
    return { ok: false, message: "Roque impossible." };
  }

  const enemy = opposite(color);
  const safeSquares = kingSide ? [`e${rank}`, `f${rank}`, `g${rank}`] : [`e${rank}`, `d${rank}`, `c${rank}`];
  if (safeSquares.some((square) => isSquareAttacked(square, enemy, gameState.board))) {
    return { ok: false, message: "Roque impossible." };
  }

  return {
    ok: true,
    captured: null,
    special: "castling",
    rookMove: { from: rookFrom, to: rookTo }
  };
}

function getEnPassantCapture(color, from, to) {
  const lastMove = gameState.lastMove;
  if (!lastMove || !lastMove.piece || lastMove.piece.type !== "P") return null;
  if (lastMove.color === color || lastMove.special === "enPassant") return null;

  const lastFrom = squareToPosition(lastMove.from);
  const lastTo = squareToPosition(lastMove.to);
  if (Math.abs(lastTo.rank - lastFrom.rank) !== 2) return null;

  const fromPos = squareToPosition(from);
  const toPos = squareToPosition(to);
  const capturedSquare = positionToSquare(toPos.file, fromPos.rank);
  const captured = gameState.board[capturedSquare];

  if (lastMove.to !== capturedSquare) return null;
  if (!captured || captured.color === color || captured.type !== "P") return null;

  return { square: capturedSquare, captured };
}

function isSquareAttacked(square, byColor, board = gameState.board) {
  return Object.entries(board).some(([from, piece]) => {
    if (!piece || piece.color !== byColor) return false;
    return attacksSquare(piece, from, square, board);
  });
}

function attacksSquare(piece, from, to, board = gameState.board) {
  const fromPos = squareToPosition(from);
  const toPos = squareToPosition(to);
  const df = toPos.file - fromPos.file;
  const dr = toPos.rank - fromPos.rank;
  const absDf = Math.abs(df);
  const absDr = Math.abs(dr);

  if (piece.type === "P") {
    const direction = piece.color === "white" ? 1 : -1;
    return absDf === 1 && dr === direction;
  }

  if (piece.type === "N") {
    return (absDf === 1 && absDr === 2) || (absDf === 2 && absDr === 1);
  }

  if (piece.type === "B") {
    return absDf === absDr && isPathClear(from, to, board);
  }

  if (piece.type === "R") {
    return (df === 0 || dr === 0) && isPathClear(from, to, board);
  }

  if (piece.type === "Q") {
    return (absDf === absDr || df === 0 || dr === 0) && isPathClear(from, to, board);
  }

  if (piece.type === "K") {
    return absDf <= 1 && absDr <= 1;
  }

  return false;
}

function isPathClear(from, to, board = gameState.board) {
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

function hasMovedFrom(color, type, square) {
  return gameState.moveHistory.some((move) => {
    return move.color === color && move.piece && move.piece.type === type && move.from === square;
  });
}

function sanitizePromotion(promotion) {
  const type = typeof promotion === "string" ? promotion.trim().toUpperCase() : "";
  return PROMOTION_TYPES.has(type) ? type : null;
}

function simulateBoardMove(board, color, from, to, validation) {
  const nextBoard = cloneBoard(board);
  const movingPiece = nextBoard[from];
  const finalPiece = validation.promotion
    ? createPiece(color, validation.promotion)
    : movingPiece;

  delete nextBoard[from];

  if (validation.capturedSquare && validation.capturedSquare !== to) {
    delete nextBoard[validation.capturedSquare];
  }

  nextBoard[to] = clonePiece(finalPiece);

  if (validation.rookMove) {
    const rook = nextBoard[validation.rookMove.from];
    delete nextBoard[validation.rookMove.from];
    if (rook) nextBoard[validation.rookMove.to] = rook;
  }

  return nextBoard;
}

function findKingSquare(color, board = gameState.board) {
  for (const [square, piece] of Object.entries(board)) {
    if (piece && piece.color === color && piece.type === "K") {
      return square;
    }
  }

  return null;
}

function isKingInCheck(color, board = gameState.board) {
  const kingSquare = findKingSquare(color, board);
  if (!kingSquare) return true;
  return isSquareAttacked(kingSquare, opposite(color), board);
}

function getLegalMoves(color) {
  const moves = [];
  const squares = allSquares();

  for (const [from, piece] of Object.entries(gameState.board)) {
    if (!piece || piece.color !== color) continue;

    for (const to of squares) {
      if (from === to) continue;

      const promotions = isPromotionTarget(piece, to)
        ? Array.from(PROMOTION_TYPES)
        : [null];

      for (const promotion of promotions) {
        const result = validateLegalMove(color, from, to, promotion);
        if (result.ok) {
          moves.push({ from, to, promotion, special: result.special || null });
        }
      }
    }
  }

  return moves;
}

function updateGameStatus() {
  const checkedColor = gameState.turn;
  const check = isKingInCheck(checkedColor, gameState.board);
  const legalMoves = getLegalMoves(checkedColor);

  gameState.check = check ? checkedColor : null;
  gameState.gameOver = false;
  gameState.winner = null;
  gameState.resultReason = null;
  gameState.status = check ? "check" : "playing";

  if (!legalMoves.length && check) {
    gameState.status = "checkmate";
    gameState.gameOver = true;
    gameState.winner = opposite(checkedColor);
    gameState.resultReason = "checkmate";
    return;
  }

  if (!legalMoves.length && !check) {
    gameState.status = "stalemate";
    gameState.gameOver = true;
    gameState.resultReason = "stalemate";
    return;
  }

  if (hasInsufficientMaterial()) {
    gameState.status = "draw";
    gameState.gameOver = true;
    gameState.resultReason = "insufficientMaterial";
    return;
  }

  if (gameState.halfmoveClock >= 100) {
    gameState.status = "draw";
    gameState.gameOver = true;
    gameState.resultReason = "fiftyMoveRule";
    return;
  }

  if ((positionCounts.get(currentPositionKey()) || 0) >= 3) {
    gameState.status = "draw";
    gameState.gameOver = true;
    gameState.resultReason = "threefoldRepetition";
  }
}

function resetGameStatus() {
  gameState.status = "playing";
  gameState.check = null;
  gameState.winner = null;
  gameState.gameOver = false;
  gameState.resultReason = null;
}

function updateHalfmoveClock(move) {
  if (move.piece.type === "P" || move.captured) {
    gameState.halfmoveClock = 0;
    return;
  }

  gameState.halfmoveClock += 1;
}

function updateCastlingRights(move) {
  if (!move || !move.piece) return;

  const color = move.color;
  if (move.piece.type === "K") {
    gameState.castlingRights[color].kingSide = false;
    gameState.castlingRights[color].queenSide = false;
  }

  if (move.piece.type === "R") {
    disableRookCastlingRight(color, move.from);
  }

  if (move.captured && move.captured.type === "R") {
    disableRookCastlingRight(move.captured.color, move.capturedSquare || move.to);
  }
}

function disableRookCastlingRight(color, square) {
  if (!gameState.castlingRights[color]) return;

  if (square === "h1") gameState.castlingRights.white.kingSide = false;
  if (square === "a1") gameState.castlingRights.white.queenSide = false;
  if (square === "h8") gameState.castlingRights.black.kingSide = false;
  if (square === "a8") gameState.castlingRights.black.queenSide = false;
}

function isPromotionTarget(piece, square) {
  if (!piece || piece.type !== "P") return false;
  return (piece.color === "white" && square.endsWith("8"))
    || (piece.color === "black" && square.endsWith("1"));
}

function allSquares() {
  const squares = [];
  for (let rank = 1; rank <= 8; rank += 1) {
    for (const file of FILES) {
      squares.push(`${file}${rank}`);
    }
  }
  return squares;
}

function recordCurrentPosition() {
  const key = currentPositionKey();
  positionCounts.set(key, (positionCounts.get(key) || 0) + 1);
}

function currentPositionKey() {
  const pieces = Object.entries(gameState.board)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([square, piece]) => `${square}:${piece.color[0]}${piece.type}`)
    .join("|");

  const rights = [
    gameState.castlingRights.white.kingSide ? "K" : "",
    gameState.castlingRights.white.queenSide ? "Q" : "",
    gameState.castlingRights.black.kingSide ? "k" : "",
    gameState.castlingRights.black.queenSide ? "q" : ""
  ].join("") || "-";

  return `${gameState.turn}|${pieces}|${rights}|${currentEnPassantTargetForKey()}`;
}

function currentEnPassantTargetForKey() {
  const lastMove = gameState.lastMove;
  if (!lastMove || !lastMove.piece || lastMove.piece.type !== "P") return "-";

  const fromPos = squareToPosition(lastMove.from);
  const toPos = squareToPosition(lastMove.to);
  if (Math.abs(toPos.rank - fromPos.rank) !== 2) return "-";

  const targetSquare = positionToSquare(fromPos.file, (fromPos.rank + toPos.rank) / 2);
  const capturingColor = gameState.turn;
  const direction = capturingColor === "white" ? 1 : -1;
  const targetPos = squareToPosition(targetSquare);
  const sourceRank = targetPos.rank - direction;

  for (const fileDelta of [-1, 1]) {
    const sourceFile = targetPos.file + fileDelta;
    if (sourceFile < 1 || sourceFile > 8) continue;
    const sourceSquare = positionToSquare(sourceFile, sourceRank);
    const pawn = gameState.board[sourceSquare];
    if (pawn && pawn.color === capturingColor && pawn.type === "P") {
      return targetSquare;
    }
  }

  return "-";
}

function hasInsufficientMaterial(board = gameState.board) {
  const entries = Object.entries(board);
  const pieces = entries.map(([square, piece]) => ({ square, ...piece }));
  const nonKings = pieces.filter((piece) => piece.type !== "K");

  if (!nonKings.length) return true;

  if (nonKings.length === 1 && ["B", "N"].includes(nonKings[0].type)) {
    return true;
  }

  if (nonKings.every((piece) => piece.type === "B")) {
    const colors = new Set(nonKings.map((piece) => squareColor(piece.square)));
    return colors.size === 1;
  }

  return false;
}

function squareColor(square) {
  const pos = squareToPosition(square);
  return (pos.file + pos.rank) % 2 === 0 ? "dark" : "light";
}

function resetGame() {
  const initialClockMs = gameState.clock ? gameState.clock.initialMs : DEFAULT_CLOCK_MS;

  gameState.board = createInitialBoard();
  gameState.turn = "white";
  gameState.moveHistory = [];
  gameState.lastMove = null;
  resetGameStatus();
  gameState.castlingRights = createInitialCastlingRights();
  gameState.halfmoveClock = 0;
  resetClock(initialClockMs);
  positionCounts.clear();
  recordCurrentPosition();
  gameState.createdAt = Date.now();

  for (const client of clients.values()) {
    client.lastIntent = null;
    client.lastBroadcastIntent = null;
    client.pendingIntent = null;
    if (client.intentFlushTimer) {
      clearTimeout(client.intentFlushTimer);
      client.intentFlushTimer = null;
    }
  }

  console.log("[game] reset");
}

function cleanupClient(clientId) {
  const client = clients.get(clientId);
  if (!client) return;

  if (client.intentFlushTimer) {
    clearTimeout(client.intentFlushTimer);
    client.intentFlushTimer = null;
  }

  updateClockNow(false);
  clients.delete(clientId);
  const clockChanged = syncClockRunningState();
  console.log(`[ws] client disconnected ${client.id} (${client.role})`);

  broadcast({ type: "players", players: getPlayersState() });
  if (clockChanged) {
    broadcast({ type: "gameState", gameState: serializeGameState() });
  }

  if (client.role === "white") {
    broadcast({ type: "error", message: "Blancs déconnectés." });
  }

  if (client.role === "black") {
    broadcast({ type: "error", message: "Noirs déconnectés." });
  }
}

function safeJsonParse(raw) {
  try {
    return JSON.parse(String(raw));
  } catch (error) {
    return null;
  }
}

function handleProfile(client, message) {
  if (Object.prototype.hasOwnProperty.call(message, "avatar")) {
    const avatar = sanitizeAvatar(message.avatar);
    if (!avatar) {
      send(client, { type: "error", message: "Avatar inconnu." });
      return;
    }

    client.avatar = avatar;
  }

  if (Object.prototype.hasOwnProperty.call(message, "name")) {
    client.name = sanitizePlayerName(message.name);
  }

  broadcast({ type: "players", players: getPlayersState() });
}

function handleChat(client, message) {
  if (client.role === "spectator") {
    send(client, { type: "error", message: "Les spectateurs peuvent lire le chat mais pas ecrire." });
    return;
  }

  const text = sanitizeChatText(message.text);
  if (!text) return;

  const chatMessage = {
    id: createClientId(),
    clientId: client.id,
    role: client.role,
    avatar: client.avatar,
    name: client.name,
    text,
    timestamp: Date.now()
  };

  chatMessages.push(chatMessage);
  if (chatMessages.length > CHAT_HISTORY_LIMIT) {
    chatMessages.splice(0, chatMessages.length - CHAT_HISTORY_LIMIT);
  }

  broadcast({ type: "chat", message: cloneChatMessage(chatMessage) });
}

function handleIntent(client, message) {
  if (client.role === "spectator") return;

  const intent = sanitizeIntent(client, message);
  const urgent = isUrgentIntent(client.lastBroadcastIntent, intent);
  client.lastIntent = intent;
  client.pendingIntent = intent;
  scheduleIntentFlush(client, urgent);
}

function scheduleIntentFlush(client, immediate = false) {
  if (!client || !client.pendingIntent) return;

  if (immediate) {
    flushPendingIntent(client);
    return;
  }

  const now = Date.now();
  const elapsed = now - (client.lastIntentBroadcastAt || 0);
  const delay = Math.max(0, SERVER_INTENT_MIN_INTERVAL_MS - elapsed);

  if (delay === 0) {
    flushPendingIntent(client);
    return;
  }

  if (!client.intentFlushTimer) {
    client.intentFlushTimer = setTimeout(() => {
      client.intentFlushTimer = null;
      flushPendingIntent(client);
    }, delay);
  }
}

function flushPendingIntent(client) {
  if (!client || !client.pendingIntent) return;

  if (client.intentFlushTimer) {
    clearTimeout(client.intentFlushTimer);
    client.intentFlushTimer = null;
  }

  const intent = client.pendingIntent;
  client.pendingIntent = null;
  client.lastBroadcastIntent = intent;
  client.lastIntentBroadcastAt = Date.now();
  broadcastIntent(client, intent);
}

function broadcastIntent(sourceClient, intent) {
  const message = {
    type: "intent",
    clientId: sourceClient.id,
    role: sourceClient.role,
    ...intent
  };

  for (const client of clients.values()) {
    if (client.id === sourceClient.id) continue;
    if (client.ws.readyState !== WebSocket.OPEN) continue;
    if (client.ws.bufferedAmount > INTENT_BUFFER_DROP_BYTES) continue;
    send(client, message);
  }
}

function isUrgentIntent(previous, next) {
  if (!previous) return true;
  if (previous.state !== next.state) return true;
  if (previous.fromSquare !== next.fromSquare) return true;
  if (pieceSignature(previous.grabbedPiece) !== pieceSignature(next.grabbedPiece)) return true;
  return false;
}

function pieceSignature(piece) {
  if (!piece) return "";
  return `${piece.color}:${piece.type}`;
}

function sanitizeIntent(client, message) {
  const state = INTENT_STATES.has(message.state) ? message.state : "idle";
  const fromSquare = normalizeSquare(message.fromSquare);
  const targetSquare = normalizeSquare(message.targetSquare);
  const hoveredSquare = normalizeSquare(message.hoveredSquare);
  const grabbedPiece = state === "dragging" && isValidSquare(fromSquare)
    ? clonePiece(gameState.board[fromSquare])
    : null;

  return {
    state,
    nx: clampNumber(message.nx, 0, 1, 0),
    ny: clampNumber(message.ny, 0, 1, 0),
    hoveredSquare: isValidSquare(hoveredSquare) ? hoveredSquare : null,
    fromSquare: isValidSquare(fromSquare) ? fromSquare : null,
    targetSquare: isValidSquare(targetSquare) ? targetSquare : null,
    grabbedPiece: grabbedPiece && grabbedPiece.color === client.role ? grabbedPiece : null,
    orientation: message.orientation === "black" ? "black" : "white",
    timestamp: Number.isFinite(Number(message.timestamp)) ? Number(message.timestamp) : Date.now()
  };
}

function sendExistingIntents(newClient) {
  for (const client of clients.values()) {
    if (client.id === newClient.id || !client.lastIntent) continue;

    send(newClient, {
      type: "intent",
      clientId: client.id,
      role: client.role,
      ...client.lastIntent
    });
  }
}

function createClientId() {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function defaultAvatarForRole(role) {
  if (role === "white") return "cat";
  if (role === "black") return "fox";
  return "owl";
}

function sanitizeAvatar(avatar) {
  const value = typeof avatar === "string" ? avatar.trim().toLowerCase() : "";
  return AVATAR_IDS.has(value) ? value : null;
}

function sanitizeChatText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, CHAT_TEXT_MAX);
}

function sanitizePlayerName(name) {
  return String(name || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, PLAYER_NAME_MAX);
}

function publicClientProfile(client) {
  return {
    clientId: client.id,
    role: client.role,
    avatar: client.avatar,
    name: client.name,
    connectedAt: client.connectedAt
  };
}

function cloneChatMessage(message) {
  return {
    id: message.id,
    clientId: message.clientId,
    role: message.role,
    avatar: message.avatar,
    name: message.name,
    text: message.text,
    timestamp: message.timestamp
  };
}

function normalizeSquare(square) {
  return typeof square === "string" ? square.trim().toLowerCase() : null;
}

function opposite(color) {
  return color === "white" ? "black" : "white";
}

function formatMove(move) {
  const captureText = move.captured ? ` × ${move.captured.symbol}` : "";
  const promotionText = move.promotedPiece ? ` = ${move.promotedPiece.symbol}` : "";
  const pieceText = move.piece && move.piece.type === "P" ? "" : `${move.piece.symbol} `;
  const specialText = move.special === "castling"
    ? " (roque)"
    : move.special === "enPassant"
      ? " e.p."
      : "";
  return `${move.number}. ${COLOR_LABELS[move.color]} : ${pieceText}${move.from} → ${move.to}${captureText}${promotionText}${specialText}`;
}

function cloneBoard(board) {
  const clone = {};

  for (const [square, piece] of Object.entries(board)) {
    clone[square] = clonePiece(piece);
  }

  return clone;
}

function clonePiece(piece) {
  if (!piece) return null;
  return {
    color: piece.color,
    type: piece.type,
    symbol: piece.symbol
  };
}

function cloneMove(move) {
  return {
    number: move.number,
    color: move.color,
    piece: clonePiece(move.piece),
    from: move.from,
    to: move.to,
    captured: move.captured ? clonePiece(move.captured) : null,
    capturedSquare: move.capturedSquare || null,
    special: move.special || null,
    promotion: move.promotion || null,
    promotedPiece: move.promotedPiece ? clonePiece(move.promotedPiece) : null,
    rookMove: move.rookMove || null,
    timestamp: move.timestamp,
    label: move.label
  };
}

function cloneCastlingRights(rights) {
  return {
    white: {
      kingSide: Boolean(rights && rights.white && rights.white.kingSide),
      queenSide: Boolean(rights && rights.white && rights.white.queenSide)
    },
    black: {
      kingSide: Boolean(rights && rights.black && rights.black.kingSide),
      queenSide: Boolean(rights && rights.black && rights.black.queenSide)
    }
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

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}
