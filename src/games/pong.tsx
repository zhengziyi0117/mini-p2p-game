"use client";

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useGameChat } from "./game-chat";
import { GameShell, RoundResult, phaseLabelFor, phaseStatusFor, useRematch, type ShellStatus } from "./game-shell";
import { useP2PMatch, type PeerMessage } from "./use-p2p-match";
import {
  BALL_RADIUS,
  EMPTY_PONG_INPUT,
  FIELD_HEIGHT,
  FIELD_WIDTH,
  PADDLE_HEIGHT,
  PADDLE_MARGIN,
  PADDLE_WIDTH,
  SCORE_TO_WIN,
  TICK_MS,
  createInitialState,
  isPongState,
  normalizePongInput,
  stepHostState,
  type PlayerColor,
  type PongInput,
  type PongState,
} from "./pong-rules";

const CHAT_PANEL_ID = "pong-chat-panel";
/** Snapshot cadence: every 2 ticks is ~31 Hz, and the view's CSS transition is
 *  set to exactly this long so the gap is invisible without any prediction. */
const STATE_BROADCAST_TICKS = 2;
const INPUT_HEARTBEAT_MS = 50;
/** Remote input older than this is dropped, so a lost packet cannot pin a paddle. */
const INPUT_STALE_MS = 220;

function describeWin(winner: PlayerColor | "draw" | null, myColor: PlayerColor | undefined) {
  if (winner === "draw") return "打平了";
  return winner === myColor ? `漂亮，${SCORE_TO_WIN} 分拿下` : "这局输了，再来一局";
}

function percentX(value: number) {
  return `${(value / FIELD_WIDTH) * 100}%`;
}

function percentY(value: number) {
  return `${(value / FIELD_HEIGHT) * 100}%`;
}

export function PongGame({ onBack }: { onBack: () => void }) {
  const [state, setState] = useState<PongState>(() => createInitialState(1, 1));
  const [round, setRound] = useState(1);

  const stateRef = useRef(state);
  const roundRef = useRef(1);
  const isHostRef = useRef(false);
  const localInputRef = useRef<PongInput>({ ...EMPTY_PONG_INPUT });
  const remoteInputRef = useRef<PongInput>({ ...EMPTY_PONG_INPUT });
  const inputSequenceRef = useRef(0);
  const remoteInputSequenceRef = useRef(0);
  const remoteInputReceivedAtRef = useRef(0);
  const sendRef = useRef<(message: PeerMessage) => boolean>(() => false);
  const setMessageRef = useRef<(message: string) => void>(() => undefined);
  const startNewRoundRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const chat = useGameChat({
    send: useCallback((payload: Record<string, unknown>) => sendRef.current({ ...payload, roundId: roundRef.current }), []),
    onNotice: useCallback((text: string) => setMessageRef.current(text), []),
  });

  const rematch = useRematch({
    send: useCallback((payload: PeerMessage) => sendRef.current(payload), []),
    onStart: useCallback(() => startNewRoundRef.current(), []),
  });

  const handlePeerMessage = useCallback(
    (message: PeerMessage) => {
      if (typeof message.roundId === "number" && message.roundId < roundRef.current) return;
      if (rematch.handleMessage(message)) return;

      if (message.type === "pong-input" && isHostRef.current) {
        const sequence = typeof message.seq === "number" ? message.seq : remoteInputSequenceRef.current + 1;
        if (!Number.isSafeInteger(sequence) || sequence <= remoteInputSequenceRef.current) return;
        remoteInputSequenceRef.current = sequence;
        remoteInputReceivedAtRef.current = Date.now();
        remoteInputRef.current = normalizePongInput((message.payload as { input?: unknown } | undefined)?.input);
        return;
      }

      if (message.type === "pong-state" && !isHostRef.current) {
        const payload = message.payload;
        if (!isPongState(payload) || payload.roundId !== roundRef.current) return;
        // Only ever move forward: a reordered snapshot must not rewind the field.
        if (payload.tick < stateRef.current.tick) return;
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
      }
    },
    [chat.receiveChat, chat.receiveEmoji, rematch],
  );

  const resetLocalGame = useCallback(() => {
    const next = createInitialState(1, roundRef.current);
    stateRef.current = next;
    setState(next);
    localInputRef.current = { ...EMPTY_PONG_INPUT };
    remoteInputRef.current = { ...EMPTY_PONG_INPUT };
    inputSequenceRef.current = 0;
    remoteInputSequenceRef.current = 0;
    remoteInputReceivedAtRef.current = 0;
    rematch.reset();
  }, [rematch.reset]);

  const p2p = useP2PMatch({
    gameId: "pong",
    onMessage: handlePeerMessage,
    onConnected: chat.resetChat,
    onReset: resetLocalGame,
  });

  const isHost = p2p.isHost;
  const isOnline = p2p.isOnline;
  const currentMatch = p2p.match;
  const myColor = currentMatch?.color;

  useEffect(() => {
    isHostRef.current = isHost;
    sendRef.current = p2p.send;
    setMessageRef.current = p2p.setMessage;
  }, [isHost, p2p.send, p2p.setMessage]);

  const startNewRound = useCallback(() => {
    roundRef.current += 1;
    setRound(roundRef.current);
    resetLocalGame();
    setMessageRef.current(isHostRef.current ? "新一局准备中，你是房主。 " : "新一局准备中，等待房主开局。 ");
  }, [resetLocalGame]);

  useEffect(() => {
    startNewRoundRef.current = startNewRound;
  }, [startNewRound]);

  // --- host: fixed tick, authoritative state, periodic snapshot ------------
  useEffect(() => {
    if (!isOnline || !isHost || !currentMatch) return;
    const initial = createInitialState(Math.floor(Math.random() * 0xffffffff), roundRef.current);
    stateRef.current = initial;
    setState(initial);
    remoteInputSequenceRef.current = 0;
    remoteInputReceivedAtRef.current = 0;
    setMessageRef.current("开球了，接住。 ");
    sendRef.current({ type: "pong-state", roundId: initial.roundId, payload: initial });

    const timer = window.setInterval(() => {
      const previous = stateRef.current;
      const now = Date.now();
      // A paddle that stops hearing from its player coasts to a halt rather
      // than sticking on the last key it saw.
      const remoteInput = now - remoteInputReceivedAtRef.current <= INPUT_STALE_MS
        ? remoteInputRef.current
        : EMPTY_PONG_INPUT;
      const next = stepHostState(previous, localInputRef.current, remoteInput);
      stateRef.current = next;
      if (next !== previous) setState(next);
      if (next.tick !== previous.tick && (next.tick % STATE_BROADCAST_TICKS === 0 || next.status !== previous.status)) {
        sendRef.current({ type: "pong-state", roundId: next.roundId, payload: next });
      }
      if (next.status === "finished" && previous.status !== "finished") {
        setMessageRef.current(describeWin(next.winner, currentMatch.color));
      }
    }, TICK_MS);
    return () => window.clearInterval(timer);
  }, [currentMatch, isHost, isOnline, round]);

  const sendGuestInput = useCallback((input: PongInput) => {
    inputSequenceRef.current += 1;
    sendRef.current({
      type: "pong-input",
      roundId: roundRef.current,
      seq: inputSequenceRef.current,
      payload: { input: { ...input } },
    });
  }, []);

  const updateInput = useCallback(
    (patch: Partial<PongInput>) => {
      const next = { ...localInputRef.current, ...patch };
      localInputRef.current = next;
      if (!isHostRef.current) sendGuestInput(next);
    },
    [sendGuestInput],
  );

  useEffect(() => {
    if (!isOnline || isHost) return;
    const heartbeat = window.setInterval(() => sendGuestInput(localInputRef.current), INPUT_HEARTBEAT_MS);
    return () => window.clearInterval(heartbeat);
  }, [isHost, isOnline, sendGuestInput]);

  useEffect(() => {
    const keyMap: Record<string, keyof PongInput> = {
      ArrowUp: "up", w: "up", W: "up",
      ArrowDown: "down", s: "down", S: "down",
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const key = keyMap[event.key];
      if (!key || !isOnline) return;
      event.preventDefault();
      updateInput({ [key]: true });
    };
    const onKeyUp = (event: KeyboardEvent) => {
      const key = keyMap[event.key];
      if (!key) return;
      event.preventDefault();
      updateInput({ [key]: false });
    };
    const onBlur = () => updateInput({ up: false, down: false });
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [isOnline, updateInput]);

  const finished = state.status === "finished";
  const status: ShellStatus = {
    label: finished ? describeWin(state.winner, myColor) : phaseStatusFor(p2p.phase),
    pillLabel: phaseLabelFor(p2p.phase, finished),
    turn: isOnline ? "上下移动球拍" : "等待连接",
  };

  const holdProps = (key: keyof PongInput) => ({
    onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => {
      event.preventDefault();
      updateInput({ [key]: true });
    },
    onPointerUp: () => updateInput({ [key]: false }),
    onPointerLeave: () => updateInput({ [key]: false }),
    onPointerCancel: () => updateInput({ [key]: false }),
  });

  const paddle = (color: PlayerColor) => (
    <span
      className={`pong-paddle pong-paddle-${color}`}
      style={{
        left: percentX(color === "black" ? PADDLE_MARGIN : FIELD_WIDTH - PADDLE_MARGIN - PADDLE_WIDTH),
        top: percentY(state.paddles[color] - PADDLE_HEIGHT / 2),
        width: percentX(PADDLE_WIDTH),
        height: percentY(PADDLE_HEIGHT),
      }}
    />
  );

  return (
    <GameShell
      onBack={onBack}
      title="乒乓"
      headline="先到五分的人赢。"
      tip="上下键或屏幕按钮移动球拍，球拍哪个位置碰到球，球就往哪边飞。"
      footerNotes={["先得 5 分获胜", "球拍边缘改变反弹角度"]}
      chatPanelId={CHAT_PANEL_ID}
      status={status}
      p2p={p2p}
      chat={chat}
      round={round}
      finished={finished}
      connectHint="双方建立直连后开球。"
      board={
        <>
          <div className="board-rim pong-rim">
            <div className="pong-field">
              <span className="pong-net" aria-hidden="true" />
              <span className="pong-score" aria-hidden="true">
                <b className={myColor === "black" ? "mine" : ""}>{state.scores.black}</b>
                <b className={myColor === "white" ? "mine" : ""}>{state.scores.white}</b>
              </span>
              {paddle("black")}
              {paddle("white")}
              <span
                className="pong-ball"
                key={`${state.roundId}-${state.rally}`}
                style={{
                  left: percentX(state.ball.x - BALL_RADIUS),
                  top: percentY(state.ball.y - BALL_RADIUS),
                  width: percentX(BALL_RADIUS * 2),
                  height: percentY(BALL_RADIUS * 2),
                }}
              />
            </div>
          </div>
          <div className="pong-controls">
            <button type="button" aria-label="球拍上移" disabled={!isOnline} {...holdProps("up")}>▲ 上</button>
            <button type="button" aria-label="球拍下移" disabled={!isOnline} {...holdProps("down")}>▼ 下</button>
          </div>
        </>
      }
      result={
        finished && currentMatch ? (
          <RoundResult
            round={round}
            headline={status.label}
            blurb={
              state.winner === myColor
                ? "手感还在，随时可以和同一位对手继续。"
                : "不离开房间，下一局直接扳回来。"
            }
            tone={state.winner === myColor ? "win" : "loss"}
            isOnline={p2p.isOnline}
            rematch={rematch}
          />
        ) : null
      }
    />
  );
}
