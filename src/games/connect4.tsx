"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useGameChat } from "./game-chat";
import { GameShell, RoundResult, phaseLabelFor, phaseStatusFor, useRematch, type ShellStatus } from "./game-shell";
import { useP2PMatch, type MatchPhase, type P2PMatch, type PeerMessage, type SendLane } from "./use-p2p-match";
import {
  COLUMNS,
  ROWS,
  applyMove,
  cellIndex,
  createInitialState,
  dropRow,
  type Connect4State,
  type PlayerColor,
} from "./connect4-rules";

const CHAT_PANEL_ID = "connect4-chat-panel";
const COLUMN_LABELS = ["一", "二", "三", "四", "五", "六", "七"];

function describeWin(winner: PlayerColor | "draw" | null, myColor: PlayerColor | undefined) {
  if (winner === "draw") return "棋盘下满了，谁也没连成";
  return winner === myColor ? "漂亮，你连成四个了" : "被连成四个了，再来一局";
}

export function Connect4Game({ onBack }: { onBack: () => void }) {
  const [state, setState] = useState<Connect4State>(() => createInitialState(1));
  const [round, setRound] = useState(1);
  const [hoverColumn, setHoverColumn] = useState<number | null>(null);

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
    setHoverColumn(null);
  }, []);

  const rematch = useRematch({
    send: useCallback((payload: PeerMessage) => sendRef.current(payload), []),
    onStart: useCallback(() => startNextRoundRef.current(), []),
  });

  /** Only the column travels over the wire; gravity does the rest, and both
   *  peers replay the same list so the grid never has to be sent. */
  const applyLocalMove = useCallback((column: number, color: PlayerColor, broadcast: boolean) => {
    const previous = stateRef.current;
    const next = applyMove(previous, column, color);
    if (next === previous) return false;
    stateRef.current = next;
    setState(next);
    if (broadcast) sendRef.current({ type: "move", roundId: roundRef.current, column, color });
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
        applyLocalMove(Number(message.column), color, false);
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
    gameId: "connect4",
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
    (column: number) => {
      const color = matchRef.current?.color;
      if (phaseRef.current !== "playing" || !color) return;
      if (stateRef.current.turn !== color) return;
      applyLocalMove(column, color, true);
    },
    [applyLocalMove],
  );

  const currentMatch = p2p.match;
  const myColor = currentMatch?.color;
  const finished = state.status === "finished";
  const myTurn = Boolean(currentMatch && p2p.phase === "playing" && !finished && state.turn === myColor);
  const landingRow = myTurn && hoverColumn !== null ? dropRow(state.board, hoverColumn) : -1;

  const status: ShellStatus = {
    label: finished ? describeWin(state.winner, myColor) : phaseStatusFor(p2p.phase),
    pillLabel: phaseLabelFor(p2p.phase, finished),
    turn: myTurn ? "轮到你落子" : `${currentMatch?.opponentName ?? "对手"}思考中`,
  };

  return (
    <GameShell
      onBack={onBack}
      title="四子棋"
      headline="四个连成线，就赢了。"
      tip="点一列把棋子丢下去，横、竖、斜连成四个就赢。"
      footerNotes={["7 × 6 标准棋盘", "先连成四子"]}
      chatPanelId={CHAT_PANEL_ID}
      status={status}
      p2p={p2p}
      chat={chat}
      round={round}
      finished={finished}
      connectHint="双方建立直连后，黑方先行。"
      board={
        <div className="board-rim">
          <div className="connect4-board">
            <div className="connect4-grid" role="grid" aria-label="四子棋棋盘">
              {Array.from({ length: COLUMNS }, (_, column) => {
                const full = dropRow(state.board, column) < 0;
                return (
                  <button
                    className="connect4-column"
                    key={column}
                    type="button"
                    role="gridcell"
                    aria-label={`第${COLUMN_LABELS[column]}列${full ? "，已满" : ""}`}
                    disabled={!myTurn || full}
                    onMouseEnter={() => setHoverColumn(column)}
                    onMouseLeave={() => setHoverColumn(null)}
                    onFocus={() => setHoverColumn(column)}
                    onBlur={() => setHoverColumn(null)}
                    onClick={() => placeDisc(column)}
                  >
                    {Array.from({ length: ROWS }, (_, row) => {
                      const index = cellIndex(column, row);
                      const cell = state.board[index];
                      const classes = [
                        "connect4-hole",
                        cell ? `stone-${cell}` : "",
                        !cell && landingRow === row && hoverColumn === column ? "drop-target" : "",
                        state.winningCells.includes(index) ? "winning" : "",
                      ].filter(Boolean).join(" ");
                      return (
                        <span className={classes} key={row}>
                          <span className="stone" aria-hidden="true" />
                        </span>
                      );
                    })}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      }
      result={
        finished && currentMatch ? (
          <RoundResult
            round={round}
            headline={status.label}
            blurb={
              state.winner === "draw"
                ? "格子用完了，换手再试一次。"
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
