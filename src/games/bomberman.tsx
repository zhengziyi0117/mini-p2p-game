"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  ArrowLeft,
  Bomb,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  KeyRound,
  LoaderCircle,
  LogOut,
  MessageCircle,
  RotateCcw,
  Send,
  SmilePlus,
  Swords,
  Users,
} from "lucide-react";
import { useP2PMatch, type PeerMessage, type PlayerColor } from "./use-p2p-match";

const GRID_WIDTH = 13;
const GRID_HEIGHT = 11;
const QUICK_EMOJIS = ["👏", "😂", "😮", "👍", "🤔", "🔥", "🎉", "🙏"];

type Direction = "up" | "down" | "left" | "right";
type InputState = Record<Direction, boolean> & { placeBomb: boolean };
type PowerupKind = "bomb" | "flame" | "speed" | "shield";
type PlayerState = {
  x: number;
  y: number;
  alive: boolean;
  maxBombs: number;
  bombsAvailable: number;
  flameLength: number;
  speedLevel: number;
  shield: boolean;
  nextMoveAt: number;
};
type BombState = {
  id: string;
  owner: PlayerColor;
  x: number;
  y: number;
  explodeAt: number;
};
type ExplosionState = {
  cells: number[];
  expiresAt: number;
};
type PowerupState = {
  id: string;
  kind: PowerupKind;
  x: number;
  y: number;
};
type BomberState = {
  version: 2;
  roundId: number;
  seed: number;
  tick: number;
  status: "waiting" | "playing" | "finished";
  winner: PlayerColor | "draw" | null;
  blocks: number[];
  bombs: BombState[];
  explosions: ExplosionState[];
  powerups: PowerupState[];
  players: Record<PlayerColor, PlayerState>;
};
type ChatMessage = { id: string; sender: "self" | "opponent"; text: string };
type GuestPrediction = { x: number; y: number; nextMoveAt: number; lastInputAt: number };

const EMPTY_INPUT: InputState = { up: false, down: false, left: false, right: false, placeBomb: false };
const POWERUP_GLYPHS: Record<PowerupKind, string> = { bomb: "💣", flame: "🔥", speed: "⚡", shield: "🛡️" };
const POWERUP_LABELS: Record<PowerupKind, string> = { bomb: "炸弹 +1", flame: "火焰 +1", speed: "速度提升", shield: "护盾" };

function cellIndex(x: number, y: number) {
  return y * GRID_WIDTH + x;
}

function isWall(x: number, y: number) {
  return x <= 0 || y <= 0 || x >= GRID_WIDTH - 1 || y >= GRID_HEIGHT - 1 || (x % 2 === 0 && y % 2 === 0);
}

function isSpawnSafe(x: number, y: number) {
  return (
    (x <= 2 && y <= 2) ||
    (x >= GRID_WIDTH - 3 && y >= GRID_HEIGHT - 3)
  );
}

function createInitialState(seed: number, roundId: number): BomberState {
  let randomSeed = seed >>> 0;
  const random = () => {
    randomSeed = (randomSeed * 1664525 + 1013904223) >>> 0;
    return randomSeed / 4294967296;
  };
  const blocks: number[] = [];
  for (let y = 1; y < GRID_HEIGHT - 1; y += 1) {
    for (let x = 1; x < GRID_WIDTH - 1; x += 1) {
      if (isWall(x, y) || isSpawnSafe(x, y)) continue;
      if (random() < 0.42) blocks.push(cellIndex(x, y));
    }
  }
  return {
    version: 2,
    roundId,
    seed,
    tick: 0,
    status: "playing",
    winner: null,
    blocks,
    bombs: [],
    explosions: [],
    powerups: [],
    players: {
      black: { x: 1, y: 1, alive: true, maxBombs: 1, bombsAvailable: 1, flameLength: 2, speedLevel: 1, shield: false, nextMoveAt: 0 },
      white: { x: GRID_WIDTH - 2, y: GRID_HEIGHT - 2, alive: true, maxBombs: 1, bombsAvailable: 1, flameLength: 2, speedLevel: 1, shield: false, nextMoveAt: 0 },
    },
  };
}

function createWaitingState(roundId: number) {
  const state = createInitialState(1, roundId);
  return { ...state, status: "waiting" as const, blocks: [] };
}

function hasBlock(state: BomberState, index: number) {
  return state.blocks.includes(index);
}

function hasBomb(state: BomberState, index: number) {
  return state.bombs.some((bomb) => cellIndex(bomb.x, bomb.y) === index);
}

function moveIntervalFor(player: PlayerState) {
  if (player.speedLevel >= 3) return 65;
  if (player.speedLevel === 2) return 82;
  return 105;
}

function powerupDrop(seed: number, index: number): PowerupKind | null {
  let value = (seed ^ Math.imul(index + 1, 0x9e3779b9)) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x85ebca6b) >>> 0;
  value ^= value >>> 13;
  if (value % 100 >= 32) return null;
  return (["bomb", "flame", "speed", "shield"] as const)[value % 4];
}

function applyPowerup(player: PlayerState, kind: PowerupKind) {
  if (kind === "bomb") {
    player.maxBombs = Math.min(3, player.maxBombs + 1);
    player.bombsAvailable = Math.min(player.maxBombs, player.bombsAvailable + 1);
  }
  if (kind === "flame") player.flameLength = Math.min(5, player.flameLength + 1);
  if (kind === "speed") player.speedLevel = Math.min(3, player.speedLevel + 1);
  if (kind === "shield") player.shield = true;
}

function canWalkTo(state: BomberState, color: PlayerColor, x: number, y: number) {
  if (isWall(x, y) || hasBlock(state, cellIndex(x, y)) || hasBomb(state, cellIndex(x, y))) return false;
  const opponent = color === "black" ? state.players.white : state.players.black;
  return !opponent.alive || opponent.x !== x || opponent.y !== y;
}

function directionForInput(input: InputState): [number, number] | null {
  if (input.up) return [0, -1];
  if (input.down) return [0, 1];
  if (input.left) return [-1, 0];
  if (input.right) return [1, 0];
  return null;
}

function blastCells(state: BomberState, bomb: BombState, flameLength: number) {
  const cells = [cellIndex(bomb.x, bomb.y)];
  const directions = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (const [dx, dy] of directions) {
    for (let distance = 1; distance <= flameLength; distance += 1) {
      const x = bomb.x + dx * distance;
      const y = bomb.y + dy * distance;
      if (isWall(x, y)) break;
      const index = cellIndex(x, y);
      cells.push(index);
      if (hasBlock(state, index)) break;
    }
  }
  return cells;
}

function stepHostState(current: BomberState, localInput: InputState, remoteInput: InputState, now: number): BomberState {
  if (current.status !== "playing") return current;
  const next: BomberState = {
    ...current,
    tick: current.tick + 1,
    blocks: [...current.blocks],
    bombs: current.bombs.map((bomb) => ({ ...bomb })),
    explosions: current.explosions.filter((explosion) => explosion.expiresAt > now).map((explosion) => ({ ...explosion, cells: [...explosion.cells] })),
    players: {
      black: { ...current.players.black },
      white: { ...current.players.white },
    },
    powerups: current.powerups.map((powerup) => ({ ...powerup })),
  };

  for (const color of ["black", "white"] as const) {
    const player = next.players[color];
    const input = color === "black" ? localInput : remoteInput;
    if (!player.alive) continue;
    const direction = directionForInput(input);
    if (direction && now >= player.nextMoveAt) {
      const nextX = player.x + direction[0];
      const nextY = player.y + direction[1];
      if (canWalkTo(next, color, nextX, nextY)) {
        player.x = nextX;
        player.y = nextY;
      }
      player.nextMoveAt = now + moveIntervalFor(player);
    }
    if (input.placeBomb && player.bombsAvailable > 0 && !hasBomb(next, cellIndex(player.x, player.y))) {
      next.bombs.push({
        id: `${color}-${next.tick}`,
        owner: color,
        x: player.x,
        y: player.y,
        explodeAt: now + 1800,
      });
      player.bombsAvailable -= 1;
    }
  }

  const exploding = next.bombs.filter((bomb) => bomb.explodeAt <= now);
  next.bombs = next.bombs.filter((bomb) => bomb.explodeAt > now);
  const blast = new Set<number>();
  for (const bomb of exploding) {
    const cells = blastCells(next, bomb, next.players[bomb.owner].flameLength);
    cells.forEach((index) => blast.add(index));
    next.players[bomb.owner].bombsAvailable = Math.min(next.players[bomb.owner].maxBombs, next.players[bomb.owner].bombsAvailable + 1);
    const destroyedBlocks = next.blocks.filter((index) => cells.includes(index));
    next.blocks = next.blocks.filter((index) => !cells.includes(index));
    for (const index of destroyedBlocks) {
      const kind = powerupDrop(next.seed, index);
      if (kind) next.powerups.push({ id: `${next.roundId}-${index}`, kind, x: index % GRID_WIDTH, y: Math.floor(index / GRID_WIDTH) });
    }
    next.explosions.push({ cells, expiresAt: now + 500 });
  }

  if (blast.size > 0) {
    for (const color of ["black", "white"] as const) {
      const player = next.players[color];
      if (player.alive && blast.has(cellIndex(player.x, player.y))) {
        if (player.shield) player.shield = false;
        else player.alive = false;
      }
    }
  }

  for (const color of ["black", "white"] as const) {
    const player = next.players[color];
    if (!player.alive) continue;
    const pickupIndex = next.powerups.findIndex((powerup) => powerup.x === player.x && powerup.y === player.y);
    if (pickupIndex >= 0) {
      const [pickup] = next.powerups.splice(pickupIndex, 1);
      applyPowerup(player, pickup.kind);
    }
  }

  const alive = (["black", "white"] as const).filter((color) => next.players[color].alive);
  if (alive.length === 1) {
    next.status = "finished";
    next.winner = alive[0];
  } else if (alive.length === 0 && exploding.length > 0) {
    next.status = "finished";
    next.winner = "draw";
  }
  return next;
}

function normalizeInput(value: unknown): InputState {
  if (!value || typeof value !== "object") return { ...EMPTY_INPUT };
  const input = value as Partial<InputState>;
  return {
    up: Boolean(input.up),
    down: Boolean(input.down),
    left: Boolean(input.left),
    right: Boolean(input.right),
    placeBomb: Boolean(input.placeBomb),
  };
}

function isBomberState(value: unknown): value is BomberState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<BomberState>;
  return state.version === 2 && Array.isArray(state.players) === false && Boolean(state.players?.black) && Boolean(state.players?.white) && Array.isArray(state.blocks) && Array.isArray(state.bombs) && Array.isArray(state.explosions) && Array.isArray(state.powerups);
}

function formatResult(state: BomberState, color: PlayerColor | undefined) {
  if (state.winner === "draw") return "同归于尽，平局";
  return state.winner === color ? "漂亮，你赢了" : "被炸飞了，再来一局";
}

function displayPhase(phase: string, state: BomberState) {
  if (state.status === "finished") return "已结束";
  if (phase === "room-waiting") return "等人加入";
  if (phase === "matching") return "匹配中";
  if (phase === "connecting") return "连接中";
  if (phase === "error") return "需要重试";
  if (phase === "playing" && state.status === "playing") return "对局中";
  return "等待开始";
}

export function BombermanGame({ onBack }: { onBack: () => void }) {
  const [nickname, setNickname] = useState(() => (typeof window === "undefined" ? "" : window.localStorage.getItem("bomberman-nickname") ?? ""));
  const [mode, setMode] = useState<"quick" | "room">("quick");
  const [roomCode, setRoomCode] = useState("");
  const [state, setState] = useState<BomberState>(() => createWaitingState(1));
  const [round, setRound] = useState(1);
  const [chatOpen, setChatOpen] = useState(true);
  const [chatInput, setChatInput] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [unreadChat, setUnreadChat] = useState(0);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [lastEmoji, setLastEmoji] = useState<{ emoji: string; sender: "self" | "opponent" } | null>(null);
  const [rematchPending, setRematchPending] = useState<"outgoing" | "incoming" | null>(null);
  const [guestPosition, setGuestPosition] = useState<{ x: number; y: number } | null>(null);

  const stateRef = useRef(state);
  const roundRef = useRef(round);
  const isHostRef = useRef(false);
  const guestColorRef = useRef<PlayerColor | null>(null);
  const localInputRef = useRef<InputState>({ ...EMPTY_INPUT });
  const remoteInputRef = useRef<InputState>({ ...EMPTY_INPUT });
  const inputSequenceRef = useRef(0);
  const remoteInputSequenceRef = useRef(0);
  const remoteInputReceivedAtRef = useRef(0);
  const remoteBombQueuedRef = useRef(false);
  const guestPredictionRef = useRef<GuestPrediction | null>(null);
  const sendRef = useRef<(message: PeerMessage) => boolean>(() => false);
  const setP2PMessageRef = useRef<(message: string) => void>(() => undefined);
  const startNewRoundRef = useRef<() => void>(() => undefined);
  const chatOpenRef = useRef(true);
  const emojiTimerRef = useRef<number | null>(null);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    roundRef.current = round;
  }, [round]);

  useEffect(() => {
    chatOpenRef.current = chatOpen;
  }, [chatOpen]);

  const showEmoji = useCallback((emoji: string, sender: "self" | "opponent") => {
    setLastEmoji({ emoji, sender });
    if (emojiTimerRef.current) window.clearTimeout(emojiTimerRef.current);
    emojiTimerRef.current = window.setTimeout(() => {
      setLastEmoji(null);
      emojiTimerRef.current = null;
    }, 1800);
  }, []);

  const resetLocalGame = useCallback(() => {
    stateRef.current = createWaitingState(roundRef.current);
    setState(stateRef.current);
    localInputRef.current = { ...EMPTY_INPUT };
    remoteInputRef.current = { ...EMPTY_INPUT };
    inputSequenceRef.current = 0;
    remoteInputSequenceRef.current = 0;
    remoteInputReceivedAtRef.current = 0;
    remoteBombQueuedRef.current = false;
    guestPredictionRef.current = null;
    setGuestPosition(null);
    setRematchPending(null);
  }, []);

  const setPrediction = useCallback((prediction: GuestPrediction | null) => {
    guestPredictionRef.current = prediction;
    setGuestPosition(prediction ? { x: prediction.x, y: prediction.y } : null);
  }, []);

  const handlePeerMessage = useCallback((message: PeerMessage) => {
    if (message.roundId !== undefined && message.roundId < roundRef.current) return;
    if (message.type === "bomberman-input" && isHostRef.current) {
      const payload = message.payload as { input?: unknown } | undefined;
      const sequence = typeof message.seq === "number" ? message.seq : remoteInputSequenceRef.current + 1;
      if (!Number.isSafeInteger(sequence) || sequence <= remoteInputSequenceRef.current) return;
      remoteInputSequenceRef.current = sequence;
      remoteInputReceivedAtRef.current = Date.now();
      remoteInputRef.current = normalizeInput(payload?.input);
      return;
    }
    if (message.type === "bomberman-bomb" && isHostRef.current) {
      remoteBombQueuedRef.current = true;
      return;
    }
    if (message.type === "bomberman-state" && !isHostRef.current) {
      const payload = message.payload;
      if (!isBomberState(payload) || payload.roundId !== roundRef.current) return;
      const current = stateRef.current;
      if (payload.tick < current.tick || (payload.tick === current.tick && payload.status === current.status)) return;
      const guestColor = guestColorRef.current;
      if (guestColor) {
        const serverPlayer = payload.players[guestColor];
        const prediction = guestPredictionRef.current;
        if (!serverPlayer.alive || payload.status !== "playing") {
          setPrediction(null);
        } else if (!prediction) {
          setPrediction({ x: serverPlayer.x, y: serverPlayer.y, nextMoveAt: 0, lastInputAt: Date.now() });
        } else {
          const distance = Math.abs(prediction.x - serverPlayer.x) + Math.abs(prediction.y - serverPlayer.y);
          const isMoving = directionForInput(localInputRef.current) !== null;
          const releaseHasSettled = !isMoving && Date.now() - prediction.lastInputAt > 160;
          if (distance === 0 || distance > 3 || releaseHasSettled) {
            setPrediction({ ...prediction, x: serverPlayer.x, y: serverPlayer.y });
          }
        }
      }
      stateRef.current = payload;
      setState(payload);
      return;
    }
    if (message.type === "chat" && typeof message.text === "string") {
      const text = message.text.slice(0, 120);
      setChatMessages((current) => [...current, { id: `opponent-${Date.now()}`, sender: "opponent", text }]);
      if (!chatOpenRef.current) setUnreadChat((current) => current + 1);
      return;
    }
    if (message.type === "emoji" && typeof message.emoji === "string" && QUICK_EMOJIS.includes(message.emoji)) {
      showEmoji(message.emoji, "opponent");
      return;
    }
    if (message.type === "bomberman-rematch-request" && stateRef.current.status === "finished") {
      if (rematchPending === "outgoing") {
        sendRef.current({ type: "bomberman-rematch-response", roundId: roundRef.current, accepted: true });
        startNewRoundRef.current();
      } else {
        setRematchPending("incoming");
        setP2PMessageRef.current("对手邀请你再来一局。 ");
      }
      return;
    }
    if (message.type === "bomberman-rematch-response" && rematchPending === "outgoing") {
      if (message.accepted === true) startNewRoundRef.current();
      else {
        setRematchPending(null);
        setP2PMessageRef.current("对手暂时不想继续这一局。 ");
      }
    }
  }, [rematchPending, setPrediction, showEmoji]);

  const handleConnected = useCallback(() => {
    setChatMessages([]);
    setUnreadChat(0);
  }, []);

  const p2p = useP2PMatch({
    gameId: "bomberman",
    onMessage: handlePeerMessage,
    onConnected: handleConnected,
    onReset: resetLocalGame,
  });
  const isHost = p2p.isHost;
  const isOnline = p2p.isOnline;
  const currentMatch = p2p.match;
  const activeRoomCode = p2p.activeRoomCode;
  const send = p2p.send;
  const setMessage = p2p.setMessage;
  const myColor = currentMatch?.color;

  useEffect(() => {
    isHostRef.current = isHost;
    guestColorRef.current = myColor ?? null;
    sendRef.current = send;
    setP2PMessageRef.current = setMessage;
  }, [isHost, myColor, send, setMessage]);

  const startNewRound = useCallback(() => {
    const nextRound = roundRef.current + 1;
    roundRef.current = nextRound;
    setRound(nextRound);
    resetLocalGame();
    setMessage(isHost ? "新一局准备中，你是房主。 " : "新一局准备中，等待房主同步地图。 ");
  }, [isHost, resetLocalGame, setMessage]);

  useEffect(() => {
    startNewRoundRef.current = startNewRound;
  }, [startNewRound]);

  useEffect(() => {
    if (!isOnline || !isHost || !currentMatch) return;
    const initial = createInitialState(Math.floor(Math.random() * 0xffffffff), roundRef.current);
    stateRef.current = initial;
    setState(initial);
    remoteInputSequenceRef.current = 0;
    remoteInputReceivedAtRef.current = 0;
    remoteBombQueuedRef.current = false;
    setMessage("地图已生成，移动起来，别把自己炸了。 ");
    sendRef.current({ type: "bomberman-state", roundId: initial.roundId, payload: initial });
    const timer = window.setInterval(() => {
      const previous = stateRef.current;
      const now = Date.now();
      const remoteInput = now - remoteInputReceivedAtRef.current <= 220
        ? { ...remoteInputRef.current, placeBomb: remoteBombQueuedRef.current }
        : { ...EMPTY_INPUT, placeBomb: remoteBombQueuedRef.current };
      const next = stepHostState(previous, localInputRef.current, remoteInput, now);
      localInputRef.current = { ...localInputRef.current, placeBomb: false };
      remoteInputRef.current = { ...remoteInputRef.current, placeBomb: false };
      remoteBombQueuedRef.current = false;
      stateRef.current = next;
      setState(next);
      sendRef.current({ type: "bomberman-state", roundId: next.roundId, payload: next });
      if (next.status === "finished" && previous.status !== "finished") setMessage(formatResult(next, currentMatch.color));
    }, 50);
    return () => window.clearInterval(timer);
  }, [currentMatch, isHost, isOnline, round, setMessage]);

  const sendGuestInput = useCallback((input: InputState) => {
    inputSequenceRef.current += 1;
    sendRef.current({
      type: "bomberman-input",
      roundId: roundRef.current,
      seq: inputSequenceRef.current,
      payload: { input: { ...input, placeBomb: false } },
    });
  }, []);

  const updateInput = useCallback((patch: Partial<InputState>) => {
    const next = { ...localInputRef.current, ...patch };
    localInputRef.current = next;
    if (guestPredictionRef.current) guestPredictionRef.current.lastInputAt = Date.now();
    if (!isHostRef.current) {
      sendGuestInput(next);
    }
  }, [sendGuestInput]);

  const triggerBomb = useCallback(() => {
    if (!isOnline || stateRef.current.status !== "playing") return;
    if (isHostRef.current) updateInput({ placeBomb: true });
    else sendRef.current({ type: "bomberman-bomb", roundId: roundRef.current });
  }, [isOnline, updateInput]);

  useEffect(() => {
    if (!isOnline || isHost) return;
    const heartbeat = window.setInterval(() => {
      sendGuestInput(localInputRef.current);
    }, 50);
    return () => window.clearInterval(heartbeat);
  }, [isHost, isOnline, sendGuestInput]);

  useEffect(() => {
    if (!isOnline || isHost || !myColor || state.status !== "playing") return;
    const predictionTimer = window.setInterval(() => {
      const currentState = stateRef.current;
      const color = guestColorRef.current;
      const direction = directionForInput(localInputRef.current);
      const prediction = guestPredictionRef.current;
      if (!color || currentState.status !== "playing" || !currentState.players[color].alive) return;
      const now = Date.now();
      if (!prediction) {
        const serverPlayer = currentState.players[color];
        setPrediction({ x: serverPlayer.x, y: serverPlayer.y, nextMoveAt: 0, lastInputAt: now });
        return;
      }
      if (!direction) return;
      if (now < prediction.nextMoveAt) return;
      const nextX = prediction.x + direction[0];
      const nextY = prediction.y + direction[1];
      const canMove = canWalkTo(currentState, color, nextX, nextY);
      const nextPrediction = {
        ...prediction,
        x: canMove ? nextX : prediction.x,
        y: canMove ? nextY : prediction.y,
        nextMoveAt: now + moveIntervalFor(currentState.players[color]),
      };
      setPrediction(nextPrediction);
    }, 16);
    return () => window.clearInterval(predictionTimer);
  }, [isHost, isOnline, myColor, setPrediction, state.status]);

  useEffect(() => {
    const keyMap: Record<string, Direction> = { ArrowUp: "up", w: "up", W: "up", ArrowDown: "down", s: "down", S: "down", ArrowLeft: "left", a: "left", A: "left", ArrowRight: "right", d: "right", D: "right" };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === " " || event.code === "Space") {
        event.preventDefault();
        triggerBomb();
        return;
      }
      const direction = keyMap[event.key];
      if (!direction || !isOnline) return;
      event.preventDefault();
      updateInput({ [direction]: true });
    };
    const onKeyUp = (event: KeyboardEvent) => {
      const direction = keyMap[event.key];
      if (!direction) return;
      event.preventDefault();
      updateInput({ [direction]: false });
    };
    const onWindowBlur = () => updateInput({ up: false, down: false, left: false, right: false, placeBomb: false });
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onWindowBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, [isOnline, triggerBomb, updateInput]);

  const sendChat = useCallback(() => {
    const text = chatInput.trim().replace(/\s+/g, " ").slice(0, 120);
    if (!text || !isOnline) return;
    setChatMessages((current) => [...current, { id: `self-${Date.now()}`, sender: "self", text }]);
    setChatInput("");
    send({ type: "chat", roundId: roundRef.current, text });
  }, [chatInput, isOnline, send]);

  const sendEmoji = useCallback((emoji: string) => {
    if (!isOnline) return;
    showEmoji(emoji, "self");
    send({ type: "emoji", roundId: roundRef.current, emoji });
    setEmojiOpen(false);
  }, [isOnline, send, showEmoji]);

  const requestRematch = useCallback(() => {
    if (!isOnline || stateRef.current.status !== "finished" || rematchPending) return;
    setRematchPending("outgoing");
    setMessage("已邀请对手再来一局，等待确认… ");
    send({ type: "bomberman-rematch-request", roundId: roundRef.current });
  }, [isOnline, rematchPending, send, setMessage]);

  const respondRematch = useCallback((accepted: boolean) => {
    if (rematchPending !== "incoming") return;
    send({ type: "bomberman-rematch-response", roundId: roundRef.current, accepted });
    if (accepted) startNewRound();
    else {
      setRematchPending(null);
      setMessage("已拒绝再来一局的邀请。 ");
    }
  }, [rematchPending, send, setMessage, startNewRound]);

  const holdDirection = useCallback((direction: Direction, active: boolean) => {
    updateInput({ [direction]: active });
  }, [updateInput]);

  const opponentLabel = p2p.match?.opponentName ?? "等待玩家";
  const myPlayer = myColor ? state.players[myColor] : null;
  const phaseLabel = displayPhase(p2p.phase, state);
  const isBusy = p2p.phase === "matching" || p2p.phase === "room-waiting" || p2p.phase === "connecting";
  const canPlay = p2p.isOnline && state.status === "playing";
  const boardCells = useMemo(() => Array.from({ length: GRID_WIDTH * GRID_HEIGHT }, (_, index) => index), []);
  const blocks = useMemo(() => new Set(state.blocks), [state.blocks]);
  const bombs = useMemo(() => new Map(state.bombs.map((bomb) => [cellIndex(bomb.x, bomb.y), bomb])), [state.bombs]);
  const explosions = useMemo(() => new Set(state.explosions.flatMap((explosion) => explosion.cells)), [state.explosions]);
  const powerups = useMemo(() => new Map(state.powerups.map((powerup) => [cellIndex(powerup.x, powerup.y), powerup])), [state.powerups]);
  const blackPosition = !isHost && myColor === "black" && guestPosition ? guestPosition : state.players.black;
  const whitePosition = !isHost && myColor === "white" && guestPosition ? guestPosition : state.players.white;

  const copyRoomCode = useCallback(async () => {
    if (!activeRoomCode) return;
    try {
      await navigator.clipboard.writeText(activeRoomCode);
      setMessage("房间号已复制，发给朋友就可以开始。 ");
    } catch {
      setMessage(`请手动复制房间号：${activeRoomCode} `);
    }
  }, [activeRoomCode, setMessage]);

  return (
    <main className="gomoku-shell bomberman-shell">
      <header className="topbar">
        <div className="topbar-left">
          <button className="back-to-hub" type="button" onClick={onBack}><ArrowLeft size={16} /> 游戏大厅</button>
          <div className="brand-lockup">
            <div className="brand-mark" aria-hidden="true"><span /><span /><span /></div>
            <div><p className="brand-name">P2P 游戏游廊</p><p className="brand-caption">BOMBERMAN · REALTIME P2P</p></div>
          </div>
        </div>
        <div className="topbar-note"><span className="live-dot" /><span>房主权威 · 双人实时</span></div>
      </header>

      <section className="game-layout bomberman-layout">
        <div className="board-column">
          <div className="eyebrow-row">
            <div><p className="eyebrow">BOMBERMAN · ROUND {round}</p><h1>一起炸出一条路。</h1></div>
            <div className={`phase-pill phase-${p2p.phase}`}><span className="phase-dot" />{phaseLabel}</div>
          </div>

          <div className="bomberman-stage">
            <div className="bomberman-grid" role="grid" aria-label="双人炸弹人地图" style={{ gridTemplateColumns: `repeat(${GRID_WIDTH}, 1fr)` }}>
              {boardCells.map((index) => {
                const x = index % GRID_WIDTH;
                const y = Math.floor(index / GRID_WIDTH);
                const bomb = bombs.get(index);
                const powerup = powerups.get(index);
                const exploding = explosions.has(index);
                const block = blocks.has(index);
                const wall = isWall(x, y);
                return <div className={`bomber-cell ${wall ? "is-wall" : block ? "is-block" : "is-floor"} ${exploding ? "is-explosion" : ""}`} key={index} role="gridcell" aria-label={`${x + 1}列${y + 1}行${powerup ? `，${POWERUP_LABELS[powerup.kind]}` : ""}`}>
                  {powerup && <span className={`bomber-powerup powerup-${powerup.kind}`} title={POWERUP_LABELS[powerup.kind]}>{POWERUP_GLYPHS[powerup.kind]}</span>}
                  {bomb && <span className="bomber-bomb"><Bomb size={20} /></span>}
                </div>;
              })}
              <div className="bomberman-actors" aria-hidden="true">
                {state.players.black.alive && <span className="bomber-player player-black" style={{ "--actor-x": blackPosition.x, "--actor-y": blackPosition.y } as CSSProperties}><i>{myColor === "black" ? "你" : "对"}</i></span>}
                {state.players.white.alive && <span className="bomber-player player-white" style={{ "--actor-x": whitePosition.x, "--actor-y": whitePosition.y } as CSSProperties}><i>{myColor === "white" ? "你" : "对"}</i></span>}
              </div>
            </div>
            {!p2p.isOnline && (
              <div className="bomberman-overlay">
                <LoaderCircle className={p2p.phase === "connecting" || p2p.phase === "matching" ? "spin" : ""} size={23} />
                <strong>{p2p.message}</strong>
                <span>{p2p.phase === "room-waiting" ? <>把房间号 <b>{p2p.activeRoomCode}</b> 发给朋友。</> : "两位玩家连上后，房主地图会同步过来。"}</span>
              </div>
            )}
            {lastEmoji && <div className={`emoji-burst emoji-${lastEmoji.sender}`} aria-live="polite"><span>{lastEmoji.emoji}</span><small>{lastEmoji.sender === "self" ? "你" : opponentLabel}</small></div>}
          </div>

          <div className="bomberman-hud" aria-label="道具状态">
            <span><b>💣</b> {myPlayer?.bombsAvailable ?? 1}/{myPlayer?.maxBombs ?? 1}</span>
            <span><b>🔥</b> {myPlayer?.flameLength ?? 2}</span>
            <span><b>⚡</b> {myPlayer?.speedLevel ?? 1}</span>
            <span className={myPlayer?.shield ? "has-powerup" : ""}><b>🛡️</b> {myPlayer?.shield ? "有" : "无"}</span>
          </div>

          <div className="bomberman-controls" aria-label="移动控制">
            <div className="d-pad">
              <button type="button" aria-label="向上移动" onPointerDown={() => holdDirection("up", true)} onPointerUp={() => holdDirection("up", false)} onPointerCancel={() => holdDirection("up", false)} onPointerLeave={() => holdDirection("up", false)}>↑</button>
              <button type="button" aria-label="向左移动" onPointerDown={() => holdDirection("left", true)} onPointerUp={() => holdDirection("left", false)} onPointerCancel={() => holdDirection("left", false)} onPointerLeave={() => holdDirection("left", false)}>←</button>
              <button type="button" aria-label="向下移动" onPointerDown={() => holdDirection("down", true)} onPointerUp={() => holdDirection("down", false)} onPointerCancel={() => holdDirection("down", false)} onPointerLeave={() => holdDirection("down", false)}>↓</button>
              <button type="button" aria-label="向右移动" onPointerDown={() => holdDirection("right", true)} onPointerUp={() => holdDirection("right", false)} onPointerCancel={() => holdDirection("right", false)} onPointerLeave={() => holdDirection("right", false)}>→</button>
            </div>
            <button className="bomb-control" type="button" disabled={!canPlay} onClick={triggerBomb}><Bomb size={18} /> 放炸弹 <kbd>Space</kbd></button>
          </div>

          {state.status === "finished" && p2p.match && (
            <section className={`round-result ${state.winner === "draw" ? "result-draw" : state.winner === myColor ? "result-win" : "result-loss"}`} aria-live="polite">
              <div className="round-result-copy"><span className="result-icon"><Bomb size={19} /></span><div><p>第 {round} 局结束</p><h2>{formatResult(state, myColor)}</h2><span>不离开房间，和同一个朋友继续下一局。</span></div></div>
              <div className="round-result-actions">
                {rematchPending === "incoming" ? <><button className="result-secondary" type="button" onClick={() => respondRematch(false)}>稍后</button><button className="result-primary" type="button" onClick={() => respondRematch(true)}>接受再来一局</button></> : <button className="result-primary" type="button" disabled={!p2p.isOnline || rematchPending === "outgoing"} onClick={requestRematch}><RotateCcw size={16} />{rematchPending === "outgoing" ? "等待对手确认" : "和同一位对手再来一局"}</button>}
              </div>
            </section>
          )}

          <div className="board-footer"><span>13 × 11 固定地图</span><span className="footer-separator">·</span><span>{p2p.isOnline ? "WebRTC 直连" : "等待连接"}</span><span className="footer-separator">·</span><span>方向键移动 · Space 放炸弹</span></div>
        </div>

        <div className="game-sidebar">
          <aside className="control-panel">
            <div className="panel-heading"><div><p className="eyebrow">MATCH ROOM</p><h2>准备开炸</h2></div><div className="panel-icon"><Users size={17} /></div></div>
            <div className="mode-switch" role="tablist" aria-label="匹配方式">
              <button className={`mode-tab ${mode === "quick" ? "active" : ""}`} type="button" role="tab" aria-selected={mode === "quick"} disabled={isBusy || p2p.phase === "playing"} onClick={() => setMode("quick")}>随机匹配</button>
              <button className={`mode-tab ${mode === "room" ? "active" : ""}`} type="button" role="tab" aria-selected={mode === "room"} disabled={isBusy || p2p.phase === "playing"} onClick={() => setMode("room")}>房间对战</button>
            </div>
            {mode === "room" && <div className="room-tools"><label className="room-input-label"><span>房间号</span><input aria-label="房间号" value={roomCode} maxLength={8} placeholder="输入 4–8 位房间号" disabled={isBusy || p2p.phase === "playing"} onChange={(event) => setRoomCode(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8))} /></label><div className="room-actions"><button className="room-action room-create" type="button" disabled={isBusy || p2p.phase === "playing"} onClick={() => p2p.createRoom(nickname)}><KeyRound size={16} /> 创建房间</button><button className="room-action room-join" type="button" disabled={isBusy || p2p.phase === "playing" || roomCode.trim().length < 4} onClick={() => p2p.joinRoom(nickname, roomCode)}><Users size={16} /> 加入房间</button></div>{p2p.activeRoomCode && <div className="room-code-card"><div className="room-code-copy"><span><Check size={14} /> 房间已就绪</span><strong>{p2p.activeRoomCode}</strong></div><button className="copy-button" type="button" onClick={copyRoomCode} aria-label="复制房间号"><Copy size={15} /> 复制</button></div>}</div>}
            <div className="player-card self-card"><div className="player-avatar avatar-self">{nickname.trim().slice(0, 1).toUpperCase() || "你"}</div><div className="player-copy"><span className="player-label">我的昵称</span><input aria-label="我的昵称" value={nickname} maxLength={18} placeholder="比如：长安" disabled={isBusy || p2p.phase === "playing"} onChange={(event) => setNickname(event.target.value)} /></div><span className="color-chip chip-neutral">{myColor === "black" ? "房主" : myColor === "white" ? "玩家 2" : "—"}</span></div>
            <div className="versus-row"><span /><strong>VS</strong><span /></div>
            <div className="player-card opponent-card"><div className="player-avatar avatar-opponent">{p2p.match ? opponentLabel.slice(0, 1).toUpperCase() : "?"}</div><div className="player-copy"><span className="player-label">对手</span><strong>{opponentLabel}</strong></div><span className="color-chip chip-neutral">{p2p.match ? p2p.isHost ? "玩家 2" : "房主" : "—"}</span></div>
            <div className="turn-card"><div className="turn-stone black" aria-hidden="true" /><div><span className="player-label">当前状态</span><strong>{state.status === "finished" ? formatResult(state, myColor) : canPlay ? myPlayer?.alive ? "小心爆炸" : "已出局" : p2p.message}</strong></div><span className={`connection-label ${p2p.isOnline ? "online" : ""}`}><span />{p2p.isOnline ? "已直连" : "未连接"}</span></div>
            {mode === "quick" && p2p.phase !== "playing" && <button className="primary-button" type="button" disabled={isBusy} onClick={() => p2p.startMatching(nickname)}>{p2p.phase === "error" ? <RotateCcw size={18} /> : <Swords size={18} />}{p2p.phase === "error" ? "重新匹配" : "开始匹配"}</button>}
            {isBusy && <button className="secondary-button" type="button" onClick={p2p.cancel}>{p2p.phase === "room-waiting" ? "关闭房间" : "取消匹配"}</button>}
            {(p2p.phase === "playing" || state.status === "finished") && <button className="secondary-button" type="button" onClick={p2p.cancel}><LogOut size={16} /> 离开当前房间</button>}
            <p className="status-message" aria-live="polite">{p2p.message}</p>
            <div className="trust-note"><Bomb size={17} /><span>房主推进地图，游戏状态通过 WebRTC 直连同步。</span></div>
            <p className="tip-note"><span>TIP</span> 方向键 / WASD 移动，Space 放炸弹；手机用下方方向盘。</p>
          </aside>

          <section className={`chat-dock independent-chat ${chatOpen ? "chat-open" : ""}`} aria-label="对局聊天">
            <div className="chat-card-heading"><div className="chat-title-group"><span className="chat-title-icon"><MessageCircle size={17} /></span><div><strong>对局聊天</strong><span>{p2p.isOnline ? `正在和 ${opponentLabel} 直连聊天` : "匹配成功后即可发送消息"}</span></div></div><div className="chat-heading-actions"><span className={`chat-status ${p2p.isOnline ? "online" : ""}`}><i />{p2p.isOnline ? "在线" : "离线"}</span>{unreadChat > 0 && <b className="chat-unread">{unreadChat > 9 ? "9+" : unreadChat}</b>}<button className="chat-collapse" type="button" aria-label={chatOpen ? "收起聊天" : "展开聊天"} aria-expanded={chatOpen} onClick={() => { const next = !chatOpen; chatOpenRef.current = next; setChatOpen(next); if (next) setUnreadChat(0); }}>{chatOpen ? <ChevronUp size={17} /> : <ChevronDown size={17} />}</button></div></div>
            {chatOpen && <div className="chat-panel"><div className="chat-messages" aria-live="polite">{chatMessages.length === 0 ? <div className="chat-empty"><MessageCircle size={20} /><p>{p2p.isOnline ? "已经连上了，先给对手发个表情吧。" : "对局建立后，消息和表情都会通过 P2P 发送。"}</p></div> : chatMessages.map((item) => <div className={`chat-message ${item.sender === "self" ? "from-self" : "from-opponent"}`} key={item.id}><small>{item.sender === "self" ? "你" : opponentLabel}</small><span>{item.text}</span></div>)}</div><div className="emoji-toolbar"><button className={`emoji-toggle ${emojiOpen ? "active" : ""}`} type="button" disabled={!p2p.isOnline} onClick={() => setEmojiOpen((open) => !open)}><SmilePlus size={15} /> 快捷表情</button>{emojiOpen && <div className="emoji-picker" aria-label="快捷表情">{QUICK_EMOJIS.map((emoji) => <button type="button" key={emoji} aria-label={`发送${emoji}`} onClick={() => sendEmoji(emoji)}>{emoji}</button>)}</div>}</div><form className="chat-compose" onSubmit={(event) => { event.preventDefault(); sendChat(); }}><input aria-label="聊天消息" value={chatInput} maxLength={120} disabled={!p2p.isOnline} placeholder={p2p.isOnline ? "输入消息，按回车发送" : "等待建立 P2P 连接"} onChange={(event) => setChatInput(event.target.value)} /><button type="submit" aria-label="发送消息" disabled={!p2p.isOnline || !chatInput.trim()}><Send size={16} /></button></form></div>}
          </section>
        </div>
      </section>

      <footer className="page-footer"><span>固定地图 · 房主权威 · 双人实时</span><span><span className="footer-key">P2P</span> · 无需注册 · 即开即玩</span></footer>
    </main>
  );
}
