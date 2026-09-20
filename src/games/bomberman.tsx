"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  ArrowLeft,
  Bomb,
  Check,
  Copy,
  KeyRound,
  LoaderCircle,
  LogOut,
  RotateCcw,
  Swords,
  Users,
} from "lucide-react";
import {
  EMPTY_INPUT,
  GRID_HEIGHT,
  GRID_WIDTH,
  SCORE_TO_WIN,
  SUDDEN_DEATH_TICKS,
  canWalkTo,
  cellIndex,
  createInitialState,
  createWaitingState,
  directionForInput,
  isBomberState,
  isWall,
  moveIntervalFor,
  normalizeInput,
  stepHostState,
  type BomberState,
  type Direction,
  type InputState,
  type PlayerColor,
  type PowerupKind,
} from "./bomberman-rules";
import { GameChat, useGameChat } from "./game-chat";
import { useP2PMatch, type PeerMessage } from "./use-p2p-match";

const HOST_TICK_MS = 25;
const STATE_BROADCAST_TICKS = 2;
const MAX_PREDICTION_LEAD = 2;
const IDLE_RECONCILE_MS = 650;
const NICKNAME_KEY = "p2p-nickname";

const POWERUP_GLYPHS: Record<PowerupKind, string> = { bomb: "💣", flame: "🔥", speed: "⚡", shield: "🛡️" };
const POWERUP_LABELS: Record<PowerupKind, string> = { bomb: "炸弹 +1", flame: "火焰 +1", speed: "速度提升", shield: "护盾" };

type GuestPrediction = { x: number; y: number; nextMoveAt: number; lastInputAt: number };

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

/** Seconds until the map starts collapsing, or null once it already has. */
function collapseCountdown(state: BomberState) {
  if (state.suddenDeath) return null;
  return Math.max(0, Math.ceil(((SUDDEN_DEATH_TICKS - state.tick) * HOST_TICK_MS) / 1000));
}

export function BombermanGame({ onBack }: { onBack: () => void }) {
  const [nickname, setNickname] = useState(() => (typeof window === "undefined" ? "" : window.localStorage.getItem(NICKNAME_KEY) ?? ""));
  const [mode, setMode] = useState<"quick" | "room">("quick");
  const [roomCode, setRoomCode] = useState("");
  const [state, setState] = useState<BomberState>(() => createWaitingState(1));
  const [round, setRound] = useState(1);
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

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    roundRef.current = round;
  }, [round]);

  const chat = useGameChat({
    send: useCallback((payload: Record<string, unknown>) => sendRef.current({ ...payload, roundId: roundRef.current }), []),
    onNotice: useCallback((text: string) => setP2PMessageRef.current(text), []),
  });

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
          const direction = directionForInput(localInputRef.current);
          const isMoving = direction !== null;
          const releaseHasSettled = !isMoving && Date.now() - prediction.lastInputAt > IDLE_RECONCILE_MS;
          const serverIsAhead = direction !== null
            && (serverPlayer.x - prediction.x) * direction[0] + (serverPlayer.y - prediction.y) * direction[1] > 0;
          const sameMovementAxis = direction !== null
            && (direction[0] === 0 ? serverPlayer.x === prediction.x : serverPlayer.y === prediction.y);
          // Do not pull the guest backwards toward an older host snapshot while
          // movement is held. Reconcile forward immediately, or settle once the
          // input has been released and the host has had time to catch up.
          if ((serverIsAhead && sameMovementAxis) || (distance > 0 && releaseHasSettled)) {
            setPrediction({ ...prediction, x: serverPlayer.x, y: serverPlayer.y });
          }
        }
      }
      stateRef.current = payload;
      setState(payload);
      return;
    }
    if (message.type === "chat") {
      chat.receiveChat(message.text);
      return;
    }
    if (message.type === "emoji") {
      chat.receiveEmoji(message.emoji);
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
  }, [chat.receiveChat, chat.receiveEmoji, rematchPending, setPrediction]);

  const p2p = useP2PMatch({
    gameId: "bomberman",
    onMessage: handlePeerMessage,
    onConnected: chat.resetChat,
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
    // Carry the running match score across rounds; only the host decides it.
    const initial = createInitialState(Math.floor(Math.random() * 0xffffffff), roundRef.current, stateRef.current.scores);
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
      if (next !== previous) setState(next);
      if (next.tick !== previous.tick && (next.tick % STATE_BROADCAST_TICKS === 0 || next.status !== previous.status)) {
        sendRef.current({ type: "bomberman-state", roundId: next.roundId, payload: next });
      }
      if (next.status === "finished" && previous.status !== "finished") setMessage(formatResult(next, currentMatch.color));
    }, HOST_TICK_MS);
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
      const serverPlayer = currentState.players[color];
      const predictionLead = Math.abs(prediction.x - serverPlayer.x) + Math.abs(prediction.y - serverPlayer.y);
      if (predictionLead >= MAX_PREDICTION_LEAD) return;
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
  const myScore = myColor === "white" ? state.scores.white : state.scores.black;
  const theirScore = myColor === "white" ? state.scores.black : state.scores.white;
  const matchDecided = myScore >= SCORE_TO_WIN || theirScore >= SCORE_TO_WIN;
  const collapseIn = collapseCountdown(state);

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
            <div>
              <p className="eyebrow">BOMBERMAN · ROUND {round}</p>
              <h1>一起炸出一条路。</h1>
              <div className="bomberman-scoreline">
                <span className={`score-mine ${myColor ? "" : "is-idle"}`}>你 {myScore}</span>
                <b>:</b>
                <span className={`score-theirs ${myColor ? "" : "is-idle"}`}>{theirScore} 对手</span>
                <span className="score-target">先到 {SCORE_TO_WIN} 分</span>
                {state.status === "playing" && (state.suddenDeath
                  ? <span className="hazard is-active">地图塌方中</span>
                  : collapseIn !== null && <span className="hazard">塌方倒计时 {collapseIn}s</span>)}
              </div>
            </div>
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
                <span className={`bomber-player player-black ${state.players.black.alive ? "" : "is-out"}`} style={{ "--actor-x": blackPosition.x, "--actor-y": blackPosition.y } as CSSProperties}><i>{myColor === "black" ? "你" : "对"}</i></span>
                <span className={`bomber-player player-white ${state.players.white.alive ? "" : "is-out"}`} style={{ "--actor-x": whitePosition.x, "--actor-y": whitePosition.y } as CSSProperties}><i>{myColor === "white" ? "你" : "对"}</i></span>
              </div>
            </div>
            {!p2p.isOnline && (
              <div className="bomberman-overlay">
                <LoaderCircle className={p2p.phase === "connecting" || p2p.phase === "matching" ? "spin" : ""} size={23} />
                <strong>{p2p.message}</strong>
                <span>{p2p.phase === "room-waiting" ? <>把房间号 <b>{p2p.activeRoomCode}</b> 发给朋友。</> : "两位玩家连上后，房主地图会同步过来。"}</span>
              </div>
            )}
            {chat.lastEmoji && <div className={`emoji-burst emoji-${chat.lastEmoji.sender}`} aria-live="polite"><span>{chat.lastEmoji.emoji}</span><small>{chat.lastEmoji.sender === "self" ? "你" : opponentLabel}</small></div>}
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
              <div className="round-result-copy"><span className="result-icon"><Bomb size={19} /></span><div><p>第 {round} 局结束</p><h2>{formatResult(state, myColor)}</h2><span>{matchDecided ? myScore >= SCORE_TO_WIN ? `这一场你已经先到 ${SCORE_TO_WIN} 分，随时可以收工。` : `这一场对手先到 ${SCORE_TO_WIN} 分，再来一局就扳回来。` : `当前比分 你 ${myScore} : ${theirScore} 对手，先到 ${SCORE_TO_WIN} 分。`}</span></div></div>
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

          <GameChat panelId="bomberman-chat-panel" isOnline={p2p.isOnline} opponentLabel={opponentLabel} chat={chat} />
        </div>
      </section>

      <footer className="page-footer"><span>固定地图 · 房主权威 · 双人实时</span><span><span className="footer-key">P2P</span> · 无需注册 · 即开即玩</span></footer>
    </main>
  );
}
