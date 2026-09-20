"use client";

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useGameChat } from "./game-chat";
import { GameShell, RoundResult, phaseLabelFor, phaseStatusFor, useRematch, type ShellStatus } from "./game-shell";
import { useP2PMatch, type MatchPhase, type PeerMessage } from "./use-p2p-match";
import {
  BOARD_CELLS,
  WINNING_TILE,
  applyMove,
  createInitialState,
  largestTile,
  type Direction,
  type G2048State,
} from "./g2048-rules";

const CHAT_PANEL_ID = "g2048-chat-panel";
const SWIPE_THRESHOLD = 24;

type Outcome = "me" | "opponent" | "draw";
/** What the other side last told us about their board. */
type Rival = { grid: number[]; score: number; won: boolean };

const EMPTY_RIVAL_GRID = Array.from({ length: BOARD_CELLS }, () => 0);

function tileClass(tile: number) {
  if (!tile) return "tile-empty";
  return tile <= 2048 ? `tile-${tile}` : "tile-super";
}

function describeOutcome(outcome: Outcome | null) {
  if (outcome === "draw") return "分数一样，平局";
  return outcome === "me" ? "漂亮，这局你赢了" : "这局输了，再来一局";
}

export function G2048Game({ onBack }: { onBack: () => void }) {
  const [state, setState] = useState<G2048State>(() => createInitialState(1, 1));
  const [rival, setRival] = useState<Rival | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [round, setRound] = useState(1);

  const stateRef = useRef(state);
  const rivalRef = useRef<Rival | null>(null);
  const outcomeRef = useRef<Outcome | null>(null);
  const roundRef = useRef(1);
  const phaseRef = useRef<MatchPhase>("idle");
  const sendRef = useRef<(message: PeerMessage) => boolean>(() => false);
  const setMessageRef = useRef<(message: string) => void>(() => undefined);
  const startNextRoundRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const chat = useGameChat({
    send: useCallback((payload: Record<string, unknown>) => sendRef.current({ ...payload, roundId: roundRef.current }), []),
    onNotice: useCallback((text: string) => setMessageRef.current(text), []),
  });

  const setRivalState = useCallback((next: Rival | null) => {
    rivalRef.current = next;
    setRival(next);
  }, []);

  const setOutcomeState = useCallback((next: Outcome | null) => {
    outcomeRef.current = next;
    setOutcome(next);
  }, []);

  const resetBoard = useCallback(() => {
    setRivalState(null);
    setOutcomeState(null);
  }, [setOutcomeState, setRivalState]);

  const rematch = useRematch({
    send: useCallback((payload: PeerMessage) => sendRef.current(payload), []),
    onStart: useCallback(() => startNextRoundRef.current(), []),
  });

  /** Whoever reaches 2048 takes it outright; if nobody did, the board ends the
   *  round and the higher score wins. Both sides run this on the same two
   *  numbers, so they reach the same verdict without a referee. */
  const settle = useCallback(
    (myScore: number, myWon: boolean, theirScore: number, theirWon: boolean) => {
      if (outcomeRef.current) return;
      const winner: Outcome =
        myWon && !theirWon ? "me"
          : theirWon && !myWon ? "opponent"
            : myScore === theirScore ? "draw"
              : myScore > theirScore ? "me" : "opponent";
      setOutcomeState(winner);
      setMessageRef.current(winner === "draw" ? "分数一样，平局。 " : winner === "me" ? "你先冲到了。 " : "对手先冲到了。 ");
    },
    [setOutcomeState],
  );

  const publish = useCallback((next: G2048State) => {
    // Disposable: the rival board is decoration, so it rides the lossy lane.
    sendRef.current({
      type: "g2048-progress",
      roundId: roundRef.current,
      payload: { grid: next.grid, score: next.score, won: next.status === "won" },
    });
  }, []);

  const handlePeerMessage = useCallback(
    (message: PeerMessage) => {
      if (typeof message.roundId === "number" && message.roundId < roundRef.current) return;
      if (rematch.handleMessage(message)) return;

      if (message.type === "g2048-seed") {
        const seed = Number((message.payload as { seed?: number } | undefined)?.seed);
        if (!Number.isSafeInteger(seed)) return;
        const initial = createInitialState(seed, roundRef.current);
        stateRef.current = initial;
        setState(initial);
        resetBoard();
        setMessageRef.current("同一副牌发好了，开始冲 2048。 ");
        return;
      }

      if (message.type === "g2048-progress") {
        const payload = message.payload as { grid?: unknown; score?: unknown; won?: unknown } | undefined;
        if (!Array.isArray(payload?.grid) || payload.grid.length !== BOARD_CELLS) return;
        const grid = payload.grid.map((tile) => (typeof tile === "number" && Number.isFinite(tile) ? tile : 0));
        const next: Rival = { grid, score: Number(payload.score) || 0, won: payload.won === true };
        setRivalState(next);
        // Their board ending is our cue too, in case their "done" is slower.
        if (next.won) settle(stateRef.current.score, stateRef.current.status === "won", next.score, true);
        return;
      }

      if (message.type === "g2048-done") {
        const payload = message.payload as { score?: unknown; won?: unknown } | undefined;
        settle(stateRef.current.score, stateRef.current.status === "won", Number(payload?.score) || 0, payload?.won === true);
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
    [chat.receiveChat, chat.receiveEmoji, rematch, resetBoard, setRivalState, settle],
  );

  const p2p = useP2PMatch({
    gameId: "g2048",
    onMessage: handlePeerMessage,
    onConnected: chat.resetChat,
    onReset: resetBoard,
  });

  const isHost = p2p.isHost;
  const isOnline = p2p.isOnline;
  const currentMatch = p2p.match;

  useEffect(() => {
    phaseRef.current = p2p.phase;
    sendRef.current = p2p.send;
    setMessageRef.current = p2p.setMessage;
  }, [p2p.phase, p2p.send, p2p.setMessage]);

  const startNextRound = useCallback(() => {
    roundRef.current += 1;
    setRound(roundRef.current);
    resetBoard();
    rematch.reset();
    setMessageRef.current("新一局准备中，等房主发牌。 ");
  }, [rematch.reset, resetBoard]);

  useEffect(() => {
    startNextRoundRef.current = startNextRound;
  }, [startNextRound]);

  // --- the host deals: one seed, both boards -------------------------------
  useEffect(() => {
    if (!isOnline || !isHost || !currentMatch) return;
    const seed = Math.floor(Math.random() * 0xffffffff);
    const initial = createInitialState(seed, roundRef.current);
    stateRef.current = initial;
    setState(initial);
    resetBoard();
    sendRef.current({ type: "g2048-seed", roundId: initial.roundId, payload: { seed } });
    setMessageRef.current("同一副牌发好了，开始冲 2048。 ");
  }, [currentMatch, isHost, isOnline, resetBoard, round]);

  const swipe = useCallback(
    (direction: Direction) => {
      if (phaseRef.current !== "playing" || outcomeRef.current) return;
      const previous = stateRef.current;
      const next = applyMove(previous, direction);
      if (next === previous) return;
      stateRef.current = next;
      setState(next);
      publish(next);
      if (next.status !== "playing") {
        const theirScore = rivalRef.current?.score ?? 0;
        const theirWon = rivalRef.current?.won === true;
        sendRef.current({ type: "g2048-done", roundId: roundRef.current, payload: { score: next.score, won: next.status === "won" } });
        settle(next.score, next.status === "won", theirScore, theirWon);
      }
    },
    [publish, settle],
  );

  useEffect(() => {
    const keyMap: Record<string, Direction> = {
      ArrowUp: "up", w: "up", W: "up",
      ArrowDown: "down", s: "down", S: "down",
      ArrowLeft: "left", a: "left", A: "left",
      ArrowRight: "right", d: "right", D: "right",
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const direction = keyMap[event.key];
      if (!direction) return;
      event.preventDefault();
      swipe(direction);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [swipe]);

  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    dragStartRef.current = { x: event.clientX, y: event.clientY };
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = dragStartRef.current;
    dragStartRef.current = null;
    if (!start) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE_THRESHOLD) return;
    if (Math.abs(dx) > Math.abs(dy)) swipe(dx > 0 ? "right" : "left");
    else swipe(dy > 0 ? "down" : "up");
  };

  const finished = outcome !== null;
  const myLargest = largestTile(state.grid);
  const status: ShellStatus = {
    label: finished ? describeOutcome(outcome) : phaseStatusFor(p2p.phase),
    pillLabel: phaseLabelFor(p2p.phase, finished),
    turn: state.status === "lost" ? "没位置了" : `当前 ${state.score} 分`,
  };

  return (
    <GameShell
      onBack={onBack}
      title="2048 竞速"
      headline="同一副牌，看谁先到 2048。"
      tip="方向键、WASD 或直接在棋盘上滑动。双方拿到的方块顺序完全一样。"
      footerNotes={[`目标 ${WINNING_TILE}`, "塞满且无法合并即出局"]}
      chatPanelId={CHAT_PANEL_ID}
      status={status}
      p2p={p2p}
      chat={chat}
      round={round}
      finished={finished}
      connectHint="双方建立直连后，房主发牌。"
      board={
        <div
          className="board-rim g2048-rim"
          role="grid"
          aria-label="2048 棋盘，用方向键或滑动操作"
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
          onPointerCancel={() => {
            dragStartRef.current = null;
          }}
        >
          <div className="g2048-grid">
            {state.grid.map((tile, index) => (
              <div className={`g2048-cell ${tileClass(tile)}`} role="gridcell" key={index} aria-label={tile ? String(tile) : "空"}>
                {tile || ""}
              </div>
            ))}
          </div>
        </div>
      }
      panelExtras={
        <div className="g2048-rival">
          <div className="g2048-rival-head">
            <span>对手棋盘</span>
            <b>{rival ? `${rival.score} 分` : "等待同步"}</b>
          </div>
          <div className="g2048-rival-grid" aria-hidden="true">
            {(rival?.grid ?? EMPTY_RIVAL_GRID).map((tile, index) => (
              <span className={`g2048-mini ${tileClass(tile)}`} key={index}>{tile || ""}</span>
            ))}
          </div>
        </div>
      }
      result={
        finished && currentMatch ? (
          <RoundResult
            round={round}
            headline={describeOutcome(outcome)}
            blurb={
              outcome === "draw"
                ? `两边都拿到了 ${state.score} 分。`
                : state.status === "won"
                  ? `你把 ${myLargest} 拼出来了，对手停在 ${rival?.score ?? 0} 分。`
                  : `你拿到 ${state.score} 分，再来一局试试。`
            }
            tone={outcome === "draw" ? "draw" : outcome === "me" ? "win" : "loss"}
            isOnline={p2p.isOnline}
            rematch={rematch}
          />
        ) : null
      }
    />
  );
}
