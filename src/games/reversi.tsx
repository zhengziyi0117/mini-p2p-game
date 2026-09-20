"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useGameChat } from "./game-chat";
import { GameShell, RoundResult, phaseLabelFor, phaseStatusFor, useRematch, type ShellStatus } from "./game-shell";
import { useP2PMatch, type MatchPhase, type P2PMatch, type PeerMessage, type SendLane } from "./use-p2p-match";
import {
  BOARD_SIZE,
  applyMove,
  countPieces,
  createInitialState,
  flipsFor,
  legalMoves,
  type PlayerColor,
  type ReversiState,
} from "./reversi-rules";

const CHAT_PANEL_ID = "reversi-chat-panel";

function describeWin(winner: PlayerColor | "draw" | null, myColor: PlayerColor | undefined) {
  if (winner === "draw") return "平局，谁也没占住棋盘";
  return winner === myColor ? "漂亮，你赢了" : "这局惜败，再来一盘";
}

export function ReversiGame({ onBack }: { onBack: () => void }) {
  const [state, setState] = useState<ReversiState>(() => createInitialState(1));
  const [round, setRound] = useState(1);

  const stateRef = useRef(state);
  const roundRef = useRef(1);
  const phaseRef = useRef<MatchPhase>("idle");
  const matchRef = useRef<P2PMatch | null>(null);
  const sendRef = useRef<(payload: PeerMessage, options?: { lane?: SendLane }) => boolean>(() => false);
  const noticeRef = useRef<(text: string) => void>(() => undefined);
  const swapColorRef = useRef<() => void>(() => undefined);
  const startNextRoundRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const chat = useGameChat({
    send: useCallback((payload: Record<string, unknown>) => sendRef.current({ ...payload, roundId: roundRef.current }), []),
    onNotice: useCallback((text: string) => noticeRef.current(text), []),
  });

  const resetBoard = useCallback(() => {
    const next = createInitialState(roundRef.current);
    stateRef.current = next;
    setState(next);
  }, []);

  const rematch = useRematch({
    send: useCallback((payload: PeerMessage) => sendRef.current(payload), []),
    onStart: useCallback(() => startNextRoundRef.current(), []),
  });

  /** Replays one move on this peer's board. Both sides hold the same move list
   *  and `applyMove` is deterministic, so the board never crosses the wire — and
   *  a duplicated or replayed packet is a no-op rather than a second move. */
  const applyLocalMove = useCallback((index: number, color: PlayerColor, broadcast: boolean) => {
    const previous = stateRef.current;
    const next = applyMove(previous, index, color);
    if (next === previous) return false;
    stateRef.current = next;
    setState(next);
    if (next.status === "playing" && next.turn === color) {
      // The turn came straight back, so the side that just moved again is us
      // when this packet came from the opponent, and them when we moved.
      noticeRef.current(color === matchRef.current?.color ? "对手没有可下的位置，跳过一回合。 " : "你没有可下的位置，本回合跳过。 ");
    }
    if (broadcast) sendRef.current({ type: "move", roundId: roundRef.current, index, color });
    return true;
  }, []);

  const startNextRound = useCallback(() => {
    roundRef.current += 1;
    setRound(roundRef.current);
    resetBoard();
    rematch.reset();
    swapColorRef.current();
    noticeRef.current("新一局开始，双方交换黑白。 ");
  }, [rematch.reset, resetBoard]);

  useEffect(() => {
    startNextRoundRef.current = startNextRound;
  }, [startNextRound]);

  const handlePeerMessage = useCallback(
    (message: PeerMessage) => {
      if (typeof message.roundId === "number" && message.roundId < roundRef.current) return;
      if (rematch.handleMessage(message)) return;
      const color = message.color;
      if (message.type === "move" && (color === "black" || color === "white")) {
        applyLocalMove(Number(message.index), color, false);
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
    [applyLocalMove, chat.receiveChat, chat.receiveEmoji, rematch],
  );

  const resetMatch = useCallback(() => {
    roundRef.current = 1;
    setRound(1);
    resetBoard();
    rematch.reset();
    chat.resetChat();
  }, [chat.resetChat, rematch.reset, resetBoard]);

  const p2p = useP2PMatch({
    gameId: "reversi",
    onMessage: handlePeerMessage,
    onConnected: chat.resetChat,
    onReset: resetMatch,
  });

  useEffect(() => {
    phaseRef.current = p2p.phase;
    sendRef.current = p2p.send;
    noticeRef.current = p2p.setMessage;
    swapColorRef.current = p2p.swapColor;
    matchRef.current = p2p.match;
  }, [p2p.phase, p2p.send, p2p.setMessage, p2p.swapColor, p2p.match]);

  const placeDisc = useCallback(
    (index: number) => {
      const color = matchRef.current?.color;
      if (phaseRef.current !== "playing" || !color) return;
      if (stateRef.current.turn !== color) return;
      if (!flipsFor(stateRef.current.board, index, color).length) return;
      applyLocalMove(index, color, true);
    },
    [applyLocalMove],
  );

  const currentMatch = p2p.match;
  const myColor = currentMatch?.color;
  const finished = state.status === "finished";
  const pieces = countPieces(state.board);
  const myTurn = Boolean(currentMatch && p2p.phase === "playing" && !finished && state.turn === myColor);
  const playable = useMemo(() => new Set(myTurn ? legalMoves(state.board, state.turn) : []), [myTurn, state.board, state.turn]);

  const status: ShellStatus = {
    label: finished ? describeWin(state.winner, myColor) : phaseStatusFor(p2p.phase),
    pillLabel: phaseLabelFor(p2p.phase, finished),
    turn: myTurn ? "轮到你落子" : `${currentMatch?.opponentName ?? "对手"}思考中`,
  };

  return (
    <GameShell
      onBack={onBack}
      title="黑白棋"
      headline="翻过来，就是你的。"
      tip="只能下在能夹住对方棋子的位置，无处可下时自动跳过。"
      footerNotes={["8 × 8 标准棋盘", "棋子多者获胜"]}
      chatPanelId={CHAT_PANEL_ID}
      status={status}
      p2p={p2p}
      chat={chat}
      round={round}
      finished={finished}
      connectHint="双方建立直连后，黑方先行。"
      board={
        <>
          <div className="board-rim">
            <div className="reversi-board">
              <div className="reversi-grid" role="grid" aria-label="黑白棋棋盘">
                {state.board.map((cell, index) => {
                  const row = Math.floor(index / BOARD_SIZE);
                  const column = index % BOARD_SIZE;
                  const isPlayable = playable.has(index);
                  const label = cell === "black" ? "黑子" : cell === "white" ? "白子" : "空位";
                  return (
                    <button
                      className={`reversi-cell ${cell ? `stone-${cell}` : ""} ${isPlayable ? "playable" : ""} ${state.lastMove === index ? "last-move" : ""}`}
                      key={index}
                      type="button"
                      role="gridcell"
                      aria-label={`第 ${row + 1} 行第 ${column + 1} 列，${label}`}
                      disabled={!isPlayable}
                      onClick={() => placeDisc(index)}
                    >
                      <span className="stone" aria-hidden="true" />
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
          <div className="reversi-score">
            <span>黑 <b>{pieces.black}</b></span>
            <span>白 <b>{pieces.white}</b></span>
          </div>
        </>
      }
      result={
        finished && currentMatch ? (
          <RoundResult
            round={round}
            headline={status.label}
            blurb={
              state.winner === "draw"
                ? "势均力敌，换手再试一次。"
                : state.winner === myColor
                  ? "棋盘还在，随时可以和同一位对手继续。"
                  : "不离开房间，下一局直接扳回来。"
            }
            tone={state.winner === "draw" ? "draw" : state.winner === myColor ? "win" : "loss"}
            isOnline={p2p.isOnline}
            rematch={rematch}
          />
        ) : null
      }
    />
  );
}
