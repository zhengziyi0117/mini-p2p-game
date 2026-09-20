"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  Bomb,
  Check,
  CircleHelp,
  Contrast,
  Copy,
  Gamepad2,
  Grid2X2,
  Grid3X3,
  KeyRound,
  LoaderCircle,
  LogOut,
  MoveVertical,
  Radio,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  SquareStack,
  Swords,
  Undo2,
  Users,
} from "lucide-react";
import { BombermanGame } from "./games/bomberman";
import { Connect4Game } from "./games/connect4";
import { G2048Game } from "./games/g2048";
import { PongGame } from "./games/pong";
import { ReversiGame } from "./games/reversi";
import { GameChat, useGameChat } from "./games/game-chat";
import { useP2PMatch, type MatchPhase, type P2PMatch, type PeerMessage, type SendLane } from "./games/use-p2p-match";

type Color = "black" | "white";
type Cell = Color | null;
type MatchMode = "quick" | "room";
type GameId = "gomoku" | "bomberman" | "reversi" | "connect4" | "pong" | "g2048";
type MoveRecord = { index: number; color: Color };
type PendingState = "outgoing" | "incoming" | null;

const BOARD_SIZE = 15;
const BOARD_CELLS = BOARD_SIZE * BOARD_SIZE;
const NICKNAME_KEY = "p2p-nickname";

type ModelToolContext = {
  registerTool: (
    tool: {
      name: string;
      title?: string;
      description: string;
      inputSchema: Record<string, unknown>;
      annotations?: Record<string, boolean>;
      execute: (input: unknown) => unknown | Promise<unknown>;
    },
    options?: { signal?: AbortSignal },
  ) => void | Promise<void>;
};

declare global {
  interface Document {
    modelContext?: ModelToolContext;
  }
}

function blankBoard(): Cell[] {
  return Array.from({ length: BOARD_CELLS }, () => null);
}

function resultForMove(board: Cell[], index: number, color: Color): Color | "draw" | null {
  const row = Math.floor(index / BOARD_SIZE);
  const column = index % BOARD_SIZE;
  const directions = [
    [1, 0],
    [0, 1],
    [1, 1],
    [1, -1],
  ];

  for (const [dr, dc] of directions) {
    let count = 1;
    for (const direction of [-1, 1]) {
      let nextRow = row + dr * direction;
      let nextColumn = column + dc * direction;
      while (
        nextRow >= 0 &&
        nextRow < BOARD_SIZE &&
        nextColumn >= 0 &&
        nextColumn < BOARD_SIZE &&
        board[nextRow * BOARD_SIZE + nextColumn] === color
      ) {
        count += 1;
        nextRow += dr * direction;
        nextColumn += dc * direction;
      }
    }
    if (count >= 5) return color;
  }

  return board.every(Boolean) ? "draw" : null;
}

function gomokuStatus(phase: MatchPhase, match: P2PMatch | null, turn: Color, winner: Color | "draw" | null) {
  if (winner === "draw") return "棋盘已满，和棋";
  if (winner) return winner === match?.color ? "漂亮，你赢了" : "这局惜败，再来一盘";
  if (phase === "idle") return "准备好就开始匹配";
  if (phase === "matching") return "正在寻找对手…";
  if (phase === "room-waiting") return "房间已创建，等待加入";
  if (phase === "connecting") return "对手已找到，建立直连…";
  if (phase === "error") return "连接中断了";
  return turn === match?.color ? "轮到你落子" : "等待对手落子";
}

function GomokuGame({ onBack }: { onBack: () => void }) {
  const [nickname, setNickname] = useState(() => (typeof window === "undefined" ? "" : window.localStorage.getItem(NICKNAME_KEY) ?? ""));
  const [mode, setMode] = useState<MatchMode>("quick");
  const [roomCode, setRoomCode] = useState("");
  const [board, setBoard] = useState<Cell[]>(blankBoard);
  const [moveHistory, setMoveHistory] = useState<MoveRecord[]>([]);
  const [turn, setTurn] = useState<Color>("black");
  const [winner, setWinner] = useState<Color | "draw" | null>(null);
  const [opponentHover, setOpponentHover] = useState<number | null>(null);
  const [undoPending, setUndoPending] = useState<PendingState>(null);
  const [rematchPending, setRematchPending] = useState<PendingState>(null);
  const [round, setRound] = useState(1);

  const phaseRef = useRef<MatchPhase>("idle");
  const boardRef = useRef<Cell[]>(blankBoard());
  const moveHistoryRef = useRef<MoveRecord[]>([]);
  const turnRef = useRef<Color>("black");
  const winnerRef = useRef<Color | "draw" | null>(null);
  const roundRef = useRef(1);
  const matchRef = useRef<P2PMatch | null>(null);
  const undoPendingRef = useRef<PendingState>(null);
  const rematchPendingRef = useRef<PendingState>(null);
  const sendRef = useRef<(payload: PeerMessage, options?: { lane?: SendLane }) => boolean>(() => false);
  const noticeRef = useRef<(text: string) => void>(() => undefined);
  const swapColorRef = useRef<() => void>(() => undefined);
  const startMatchingRef = useRef<(() => Promise<void>) | null>(null);
  const placeStoneRef = useRef<((index: number) => { ok: boolean; reason?: string }) | null>(null);

  useEffect(() => {
    boardRef.current = board;
  }, [board]);

  useEffect(() => {
    turnRef.current = turn;
  }, [turn]);

  useEffect(() => {
    winnerRef.current = winner;
  }, [winner]);

  useEffect(() => {
    roundRef.current = round;
  }, [round]);

  const setUndoState = useCallback((nextState: PendingState) => {
    undoPendingRef.current = nextState;
    setUndoPending(nextState);
  }, []);

  const setRematchState = useCallback((nextState: PendingState) => {
    rematchPendingRef.current = nextState;
    setRematchPending(nextState);
  }, []);

  const chat = useGameChat({
    send: useCallback((payload: Record<string, unknown>) => sendRef.current({ ...payload, roundId: roundRef.current }), []),
    onNotice: useCallback((text: string) => noticeRef.current(text), []),
  });

  const resetRound = useCallback(() => {
    const nextBoard = blankBoard();
    boardRef.current = nextBoard;
    moveHistoryRef.current = [];
    turnRef.current = "black";
    winnerRef.current = null;
    setBoard(nextBoard);
    setMoveHistory([]);
    setTurn("black");
    setWinner(null);
    setUndoState(null);
    setRematchState(null);
    setOpponentHover(null);
  }, [setRematchState, setUndoState]);

  const resetMatch = useCallback(() => {
    resetRound();
    chat.resetChat();
    roundRef.current = 1;
    setRound(1);
  }, [chat.resetChat, resetRound]);

  const applyMove = useCallback((index: number, color: Color, send: boolean) => {
    if (
      index < 0 ||
      index >= BOARD_CELLS ||
      boardRef.current[index] !== null ||
      winnerRef.current ||
      undoPendingRef.current ||
      turnRef.current !== color ||
      phaseRef.current !== "playing"
    ) {
      return false;
    }

    const nextBoard = boardRef.current.slice();
    nextBoard[index] = color;
    boardRef.current = nextBoard;
    const nextHistory = [...moveHistoryRef.current, { index, color }];
    moveHistoryRef.current = nextHistory;
    setBoard(nextBoard);
    setMoveHistory(nextHistory);

    const result = resultForMove(nextBoard, index, color);
    if (result) {
      winnerRef.current = result;
      setWinner(result);
    } else {
      const nextTurn = color === "black" ? "white" : "black";
      turnRef.current = nextTurn;
      setTurn(nextTurn);
    }

    if (send) sendRef.current({ type: "move", roundId: roundRef.current, index, color });
    return true;
  }, []);

  const undoLastMove = useCallback(() => {
    const history = moveHistoryRef.current;
    const lastMove = history[history.length - 1];
    if (!lastMove) return false;

    const nextBoard = boardRef.current.slice();
    nextBoard[lastMove.index] = null;
    const nextHistory = history.slice(0, -1);
    boardRef.current = nextBoard;
    moveHistoryRef.current = nextHistory;
    winnerRef.current = null;
    turnRef.current = lastMove.color;
    setBoard(nextBoard);
    setMoveHistory(nextHistory);
    setWinner(null);
    setTurn(lastMove.color);
    setUndoState(null);
    return true;
  }, [setUndoState]);

  const requestUndo = useCallback(() => {
    if (phaseRef.current !== "playing" || undoPendingRef.current || !moveHistoryRef.current.length) return;
    setUndoState("outgoing");
    noticeRef.current("已发出悔棋请求，等待对方确认… ");
    sendRef.current({ type: "undo-request", roundId: roundRef.current });
  }, [setUndoState]);

  const respondToUndo = useCallback(
    (accepted: boolean) => {
      if (undoPendingRef.current !== "incoming") return;
      sendRef.current({ type: "undo-response", roundId: roundRef.current, accepted });
      if (accepted) {
        undoLastMove();
        noticeRef.current("已同意悔棋，回到上一步。 ");
      } else {
        setUndoState(null);
        noticeRef.current("已拒绝对方的悔棋请求。 ");
      }
    },
    [setUndoState, undoLastMove],
  );

  const startRematch = useCallback(() => {
    if (!matchRef.current) return;
    roundRef.current += 1;
    setRound(roundRef.current);
    resetRound();
    swapColorRef.current();
    noticeRef.current("新一局开始，双方交换黑白。 ");
  }, [resetRound]);

  const requestRematch = useCallback(() => {
    if (phaseRef.current !== "playing" || !winnerRef.current || rematchPendingRef.current) return;
    setRematchState("outgoing");
    noticeRef.current("已邀请对手再来一局，等待对方确认… ");
    sendRef.current({ type: "rematch-request", roundId: roundRef.current });
  }, [setRematchState]);

  const respondToRematch = useCallback(
    (accepted: boolean) => {
      if (rematchPendingRef.current !== "incoming") return;
      sendRef.current({ type: "rematch-response", roundId: roundRef.current, accepted });
      if (accepted) startRematch();
      else {
        setRematchState(null);
        noticeRef.current("已拒绝再来一局的邀请。 ");
      }
    },
    [setRematchState, startRematch],
  );

  const sendHover = useCallback((index: number | null) => {
    if (phaseRef.current !== "playing") return;
    // Cursor position is disposable: losing a sample is invisible, but letting
    // it queue behind a move on the reliable lane is not.
    sendRef.current({ type: "hover", roundId: roundRef.current, index }, { lane: "input" });
  }, []);

  const handlePeerMessage = useCallback(
    (message: PeerMessage) => {
      if (typeof message.roundId === "number" && message.roundId < roundRef.current) return;
      const color = message.color;
      if (message.type === "move" && (color === "black" || color === "white")) {
        applyMove(Number(message.index), color, false);
        return;
      }
      if (message.type === "hover") {
        const hoverIndex = message.index;
        setOpponentHover(
          typeof hoverIndex === "number" && Number.isInteger(hoverIndex) && hoverIndex >= 0 && hoverIndex < BOARD_CELLS ? hoverIndex : null,
        );
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
      if (message.type === "undo-request") {
        setUndoState("incoming");
        noticeRef.current(`${matchRef.current?.opponentName ?? "对手"} 请求悔棋，请选择是否同意。 `);
        return;
      }
      if (message.type === "undo-response") {
        if (message.accepted) {
          undoLastMove();
          noticeRef.current("对方同意悔棋，回到上一步。 ");
        } else {
          setUndoState(null);
          noticeRef.current("对方拒绝了悔棋请求。 ");
        }
        return;
      }
      if (message.type === "rematch-request" && winnerRef.current) {
        if (rematchPendingRef.current === "outgoing") {
          sendRef.current({ type: "rematch-response", roundId: roundRef.current, accepted: true });
          startRematch();
        } else {
          setRematchState("incoming");
          noticeRef.current(`${matchRef.current?.opponentName ?? "对手"} 邀请你再来一局。 `);
        }
        return;
      }
      if (message.type === "rematch-response" && rematchPendingRef.current === "outgoing") {
        if (message.accepted) startRematch();
        else {
          setRematchState(null);
          noticeRef.current("对手暂时不想继续这一局。 ");
        }
      }
    },
    [applyMove, chat.receiveChat, chat.receiveEmoji, setRematchState, setUndoState, startRematch, undoLastMove],
  );

  const p2p = useP2PMatch({
    gameId: "gomoku",
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

  const startMatching = useCallback(async () => {
    const cleanName = nickname.trim().replace(/\s+/g, " ").slice(0, 18);
    if (!cleanName) {
      p2p.setMessage("先给自己取一个昵称吧。 ");
      return;
    }
    window.localStorage.setItem(NICKNAME_KEY, cleanName);
    setNickname(cleanName);
    await p2p.startMatching(cleanName);
  }, [nickname, p2p]);

  useEffect(() => {
    startMatchingRef.current = startMatching;
  }, [startMatching]);

  const createRoom = useCallback(async () => {
    const cleanName = nickname.trim().replace(/\s+/g, " ").slice(0, 18);
    if (!cleanName) {
      p2p.setMessage("先给自己取一个昵称吧。 ");
      return;
    }
    window.localStorage.setItem(NICKNAME_KEY, cleanName);
    setNickname(cleanName);
    await p2p.createRoom(cleanName);
  }, [nickname, p2p]);

  const joinRoom = useCallback(async () => {
    const cleanName = nickname.trim().replace(/\s+/g, " ").slice(0, 18);
    if (!cleanName) {
      p2p.setMessage("先给自己取一个昵称吧。 ");
      return;
    }
    window.localStorage.setItem(NICKNAME_KEY, cleanName);
    setNickname(cleanName);
    await p2p.joinRoom(cleanName, roomCode);
  }, [nickname, p2p, roomCode]);

  const copyRoomCode = useCallback(async () => {
    if (!p2p.activeRoomCode) return;
    try {
      await navigator.clipboard.writeText(p2p.activeRoomCode);
      p2p.setMessage("房间号已复制，发给朋友就可以开始。 ");
    } catch {
      p2p.setMessage(`请手动复制房间号：${p2p.activeRoomCode} `);
    }
  }, [p2p]);

  const placeStone = useCallback(
    (index: number) => {
      const currentMatch = matchRef.current;
      if (!currentMatch) return { ok: false, reason: "还没有匹配到对手。" };
      if (phaseRef.current !== "playing") return { ok: false, reason: "当前还不能落子。" };
      if (turnRef.current !== currentMatch.color) return { ok: false, reason: "现在是对手的回合。" };
      return applyMove(index, currentMatch.color, true) ? { ok: true } : { ok: false, reason: "这个位置不能落子。" };
    },
    [applyMove],
  );

  useEffect(() => {
    placeStoneRef.current = placeStone;
  }, [placeStone]);

  useEffect(() => {
    const context = document.modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    void Promise.resolve(
      context.registerTool(
        {
          name: "start_gomoku_match",
          title: "开始五子棋匹配",
          description: "使用当前昵称加入在线五子棋匹配，并在匹配成功后进入对局。",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
          annotations: { readOnlyHint: false, untrustedContentHint: false },
          execute: async () => {
            await startMatchingRef.current?.();
            return { status: phaseRef.current };
          },
        },
        { signal: lifecycle.signal },
      ),
    ).catch(() => undefined);
    void Promise.resolve(
      context.registerTool(
        {
          name: "place_gomoku_stone",
          title: "在五子棋棋盘落子",
          description: "在指定的 0 到 224 号棋盘位置落子；只有轮到当前玩家时才会成功。",
          inputSchema: {
            type: "object",
            properties: { index: { type: "integer", minimum: 0, maximum: 224 } },
            required: ["index"],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: false, untrustedContentHint: false },
          execute: async (input) => {
            const index = Number((input as { index?: number })?.index);
            return placeStoneRef.current?.(index) ?? { ok: false, reason: "页面还没有准备好。" };
          },
        },
        { signal: lifecycle.signal },
      ),
    ).catch(() => undefined);
    return () => lifecycle.abort();
  }, []);

  const currentMatch = p2p.match;
  const isFinished = winner !== null;
  const isBusy = p2p.phase === "matching" || p2p.phase === "room-waiting" || p2p.phase === "connecting";
  const locked = isBusy || p2p.phase === "playing";
  const myTurn = Boolean(currentMatch && p2p.phase === "playing" && !isFinished && turn === currentMatch.color && !undoPending);
  const shownStatus = gomokuStatus(p2p.phase, currentMatch, turn, winner);
  const opponentLabel = currentMatch?.opponentName ?? "等待对手";
  const phaseLabel =
    isFinished ? "已结束"
      : p2p.phase === "playing" ? "对局中"
        : p2p.phase === "matching" ? "匹配中"
          : p2p.phase === "room-waiting" ? "等人加入"
            : p2p.phase === "connecting" ? "连接中"
              : p2p.phase === "error" ? "需要重试" : "等待开始";

  return (
    <main className="gomoku-shell">
      <header className="topbar">
        <div className="topbar-left">
          <button className="back-to-hub" type="button" onClick={onBack}>
            <ArrowLeft size={16} />
            游戏大厅
          </button>
          <div className="brand-lockup">
            <div className="brand-mark" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
            <div>
              <p className="brand-name">五子棋</p>
              <p className="brand-caption">P2P GAME ARCADE</p>
            </div>
          </div>
        </div>
        <div className="topbar-note">
          <span className="live-dot" />
          <span>棋局不经过服务器</span>
        </div>
      </header>

      <section className="game-layout">
        <div className="board-column">
          <div className="eyebrow-row">
            <div>
              <p className="eyebrow">ONLINE MATCH · ROUND {round}</p>
              <h1>落一子，见真章。</h1>
            </div>
            <div className={`phase-pill phase-${isFinished ? "finished" : p2p.phase}`}>
              <span className="phase-dot" />
              {phaseLabel}
            </div>
          </div>

          <div className="board-stage">
            <div className="board-rim">
              <div className="board-grid" role="grid" aria-label="五子棋棋盘">
                <div className="board-lines" aria-hidden="true" />
                <div className="board-cells">
                  {board.map((cell, index) => {
                    const row = Math.floor(index / BOARD_SIZE);
                    const column = index % BOARD_SIZE;
                    return (
                      <button
                        className={`board-cell ${cell ? `stone-${cell}` : ""} ${myTurn && !cell ? "cell-available" : ""} ${opponentHover === index && p2p.phase === "playing" ? "opponent-hover" : ""}`}
                        key={index}
                        type="button"
                        role="gridcell"
                        aria-label={`${row + 1} 行，第${column + 1} 列${cell ? `，${cell === "black" ? "黑子" : "白子"}` : "，空位"}`}
                        disabled={!myTurn || Boolean(cell) || isFinished}
                        style={{ left: `${(column / (BOARD_SIZE - 1)) * 100}%`, top: `${(row / (BOARD_SIZE - 1)) * 100}%` }}
                        onMouseEnter={() => sendHover(index)}
                        onMouseLeave={() => sendHover(null)}
                        onClick={() => placeStone(index)}
                      >
                        <span className="stone" aria-hidden="true" />
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
            {chat.lastEmoji && (
              <div className={`emoji-burst emoji-${chat.lastEmoji.sender}`} aria-live="polite">
                <span>{chat.lastEmoji.emoji}</span>
                <small>{chat.lastEmoji.sender === "self" ? "你" : opponentLabel}</small>
              </div>
            )}
            {(p2p.phase === "idle" || p2p.phase === "matching" || p2p.phase === "room-waiting" || p2p.phase === "connecting" || p2p.phase === "error") && (
              <div className={`board-overlay overlay-${p2p.phase}`}>
                {p2p.phase === "idle" && <Sparkles size={20} />}
                {p2p.phase === "matching" && <LoaderCircle className="spin" size={22} />}
                {p2p.phase === "room-waiting" && <KeyRound className="pulse" size={21} />}
                {p2p.phase === "connecting" && <Radio className="pulse" size={22} />}
                {p2p.phase === "error" && <CircleHelp size={21} />}
                <strong>{shownStatus}</strong>
                <span>
                  {p2p.phase === "idle"
                    ? "先输入昵称，再点击右侧开始匹配。"
                    : p2p.phase === "matching"
                      ? "遇到另一位棋手后会自动进入对局。"
                      : p2p.phase === "room-waiting"
                        ? <>把房间号 <b className="overlay-room-code">{p2p.activeRoomCode}</b> 发给朋友。</>
                        : p2p.phase === "connecting"
                          ? "双方建立直连后，黑方先行。"
                          : p2p.phase === "error"
                            ? "换个网络或重新匹配试试。"
                            : ""}
                </span>
              </div>
            )}
          </div>

          {isFinished && currentMatch && (
            <section className={`round-result ${winner === "draw" ? "result-draw" : winner === currentMatch.color ? "result-win" : "result-loss"}`} aria-live="polite">
              <div className="round-result-copy">
                <span className="result-icon"><Swords size={19} /></span>
                <div>
                  <p>第 {round} 局结束</p>
                  <h2>{shownStatus}</h2>
                  <span>{winner === "draw" ? "势均力敌，换手再试一次。" : winner === currentMatch.color ? "棋盘保留着，随时可以和同一位对手继续。" : "不离开房间，下一局直接扳回来。"}</span>
                </div>
              </div>
              <div className="round-result-actions">
                {rematchPending === "incoming" ? (
                  <>
                    <button className="result-secondary" type="button" onClick={() => respondToRematch(false)}>稍后</button>
                    <button className="result-primary" type="button" onClick={() => respondToRematch(true)}>接受再来一局</button>
                  </>
                ) : (
                  <button className="result-primary" type="button" disabled={!p2p.isOnline || rematchPending === "outgoing"} onClick={requestRematch}>
                    <RotateCcw size={16} />
                    {rematchPending === "outgoing" ? "等待对手确认" : "和同一位对手再来一局"}
                  </button>
                )}
              </div>
            </section>
          )}

          <div className="board-footer">
            <span>15 × 15 标准棋盘</span>
            <span className="footer-separator">·</span>
            <span>{p2p.isOnline ? "WebRTC 直连" : "等待连接"}</span>
            <span className="footer-separator">·</span>
            <span>先连成五子</span>
          </div>
        </div>

        <div className="game-sidebar">
        <aside className="control-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">MATCH ROOM</p>
              <h2>准备开局</h2>
            </div>
            <div className="panel-icon"><Users size={17} /></div>
          </div>

          <div className="mode-switch" role="tablist" aria-label="匹配方式">
            <button
              className={`mode-tab ${mode === "quick" ? "active" : ""}`}
              type="button"
              role="tab"
              aria-selected={mode === "quick"}
              disabled={locked}
              onClick={() => setMode("quick")}
            >
              随机匹配
            </button>
            <button
              className={`mode-tab ${mode === "room" ? "active" : ""}`}
              type="button"
              role="tab"
              aria-selected={mode === "room"}
              disabled={locked}
              onClick={() => setMode("room")}
            >
              房间对战
            </button>
          </div>

          {mode === "room" && (
            <div className="room-tools">
              <label className="room-input-label">
                <span>房间号</span>
                <input
                  aria-label="房间号"
                  value={roomCode}
                  maxLength={8}
                  placeholder="输入 4–8 位房间号"
                  disabled={locked}
                  onChange={(event) => setRoomCode(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8))}
                />
              </label>
              <div className="room-actions">
                <button className="room-action room-create" type="button" disabled={locked} onClick={createRoom}>
                  <KeyRound size={16} /> 创建房间
                </button>
                <button className="room-action room-join" type="button" disabled={locked || roomCode.trim().length < 4} onClick={joinRoom}>
                  <Users size={16} /> 加入房间
                </button>
              </div>
              {p2p.activeRoomCode && (
                <div className="room-code-card">
                  <div className="room-code-copy">
                    <span><Check size={14} /> 房间已就绪</span>
                    <strong>{p2p.activeRoomCode}</strong>
                  </div>
                  <button className="copy-button" type="button" onClick={copyRoomCode} aria-label="复制房间号">
                    <Copy size={15} /> 复制
                  </button>
                </div>
              )}
            </div>
          )}

          <div className="player-card self-card">
            <div className="player-avatar avatar-self">{nickname.trim().slice(0, 1).toUpperCase() || "你"}</div>
            <div className="player-copy">
              <span className="player-label">我的昵称</span>
              <input
                aria-label="我的昵称"
                value={nickname}
                maxLength={18}
                placeholder="比如：长安"
                disabled={locked}
                onChange={(event) => setNickname(event.target.value)}
              />
            </div>
            <span className="color-chip chip-neutral">{currentMatch?.color === "black" ? "黑" : currentMatch?.color === "white" ? "白" : "—"}</span>
          </div>

          <div className="versus-row">
            <span />
            <strong>VS</strong>
            <span />
          </div>

          <div className="player-card opponent-card">
            <div className="player-avatar avatar-opponent">{currentMatch ? opponentLabel.slice(0, 1).toUpperCase() : "?"}</div>
            <div className="player-copy">
              <span className="player-label">对手</span>
              <strong>{opponentLabel}</strong>
            </div>
            <span className={`color-chip ${currentMatch ? currentMatch.color === "black" ? "chip-white" : "chip-black" : "chip-neutral"}`}>
              {currentMatch?.color === "black" ? "白" : currentMatch?.color === "white" ? "黑" : "—"}
            </span>
          </div>

          <div className="turn-card">
            <div className={`turn-stone ${turn}`} aria-hidden="true" />
            <div>
              <span className="player-label">当前回合</span>
              <strong>{p2p.phase === "playing" && !isFinished ? myTurn ? "轮到你" : "等待对手" : shownStatus}</strong>
            </div>
            <span className={`connection-label ${p2p.isOnline ? "online" : ""}`}>
              <span />
              {p2p.isOnline ? "已直连" : "未连接"}
            </span>
          </div>

          {mode === "quick" && !isFinished && (
            <button className="primary-button" type="button" disabled={locked} onClick={startMatching}>
              {p2p.phase === "error" ? <RotateCcw size={18} /> : <Swords size={18} />}
              {p2p.phase === "error" ? "重新匹配" : "开始匹配"}
            </button>
          )}
          {isBusy && (
            <button className="secondary-button" type="button" onClick={p2p.cancel}>
              {p2p.phase === "room-waiting" ? "关闭房间" : "取消匹配"}
            </button>
          )}
          {p2p.phase === "playing" && (
            <button className="secondary-button" type="button" onClick={p2p.cancel}>
              <LogOut size={16} /> 离开当前房间
            </button>
          )}

          {p2p.phase === "playing" && currentMatch && (
            <div className="undo-area">
              {undoPending === "incoming" ? (
                <div className="undo-prompt">
                  <span>{currentMatch.opponentName} 请求悔棋</span>
                  <div className="undo-actions">
                    <button className="undo-accept" type="button" onClick={() => respondToUndo(true)}>同意</button>
                    <button className="undo-reject" type="button" onClick={() => respondToUndo(false)}>拒绝</button>
                  </div>
                </div>
              ) : (
                <button className="secondary-button undo-button" type="button" disabled={!moveHistory.length || !p2p.isOnline || Boolean(undoPending)} onClick={requestUndo}>
                  <Undo2 size={16} />
                  {undoPending === "outgoing" ? "等待对方确认" : "请求悔棋"}
                </button>
              )}
              <span className="undo-hint">{moveHistory.length ? "悔棋需要对手确认" : "落子后可以请求悔棋"}</span>
            </div>
          )}

          <p className="status-message" aria-live="polite">{p2p.message}</p>

          <div className="trust-note">
            <ShieldCheck size={17} />
            <span>只用信令服务器撮合，落子通过 WebRTC 端到端传输。</span>
          </div>
          <p className="tip-note"><span>TIP</span> 黑方先手；点击棋盘交叉点落子。</p>
        </aside>

        <GameChat panelId="gomoku-chat-panel" isOnline={p2p.isOnline} opponentLabel={opponentLabel} chat={chat} />
        </div>
      </section>

      <footer className="page-footer">
        <span>一个房间，只留两位棋手。</span>
        <span><span className="footer-key">P2P</span> · 无需注册 · 即开即玩</span>
      </footer>
    </main>
  );
}

const GAME_ICONS: Record<GameId, ReactNode> = {
  gomoku: <Grid3X3 size={20} />,
  bomberman: <Bomb size={20} />,
  reversi: <Contrast size={20} />,
  connect4: <Grid2X2 size={20} />,
  pong: <MoveVertical size={20} />,
  g2048: <SquareStack size={20} />,
};

function GameCardArt({ id }: { id: GameId }) {
  if (id === "gomoku") {
    return (
      <div className="gomoku-mini-board">
        <span className="mini-stone mini-black stone-one" />
        <span className="mini-stone mini-white stone-two" />
        <span className="mini-stone mini-black stone-three" />
        <span className="mini-stone mini-white stone-four" />
        <span className="mini-stone mini-black stone-five" />
      </div>
    );
  }
  if (id === "reversi") {
    // The opening four, so the card reads as Othello at a glance.
    return (
      <div className="reversi-mini-board">
        <span className="mini-stone mini-black stone-six" />
        <span className="mini-stone mini-white stone-seven" />
        <span className="mini-stone mini-white stone-eight" />
        <span className="mini-stone mini-black stone-nine" />
      </div>
    );
  }
  if (id === "connect4") {
    return (
      <div className="connect4-mini-board">
        {["", "", "", "", "", "", "black", "white", "black", "white", "black", "white"].map((color, cell) => (
          <span className={color} key={cell} />
        ))}
      </div>
    );
  }
  if (id === "pong") {
    return <div className="pong-mini-field"><span /><span /><i /></div>;
  }
  if (id === "g2048") {
    return (
      <div className="g2048-mini-board">
        {["tile-2", "tile-4", "tile-8", "tile-16", "tile-empty", "tile-32", "tile-empty", "tile-64", "tile-empty"].map((tile, cell) => (
          <span className={tile} key={cell} />
        ))}
      </div>
    );
  }
  return <div className="bomberman-mini-map"><span /><span /><span /><span /><Bomb size={34} /></div>;
}

const GAME_CATALOG = [
  {
    id: "gomoku" as const,
    name: "五子棋",
    description: "15 × 15 标准棋盘，支持随机匹配、房间对战和连续再战。",
    players: "2 人",
    status: "可游玩",
    available: true,
  },
  {
    id: "bomberman" as const,
    name: "双人炸弹人",
    description: "固定地图实时对战，移动、放置炸弹，和朋友一起找出口。",
    players: "2 人",
    status: "可游玩",
    available: true,
  },
  {
    id: "reversi" as const,
    name: "黑白棋",
    description: "8 × 8 标准棋盘，夹住就翻面，棋子多的一方获胜。",
    players: "2 人",
    status: "可游玩",
    available: true,
  },
  {
    id: "connect4" as const,
    name: "四子棋",
    description: "7 × 6 棋盘，把棋子丢进列里，先连成四个的一方获胜。",
    players: "2 人",
    status: "可游玩",
    available: true,
  },
  {
    id: "pong" as const,
    name: "乒乓",
    description: "实时对打的经典乒乓，先拿五分的一方获胜。",
    players: "2 人",
    status: "可游玩",
    available: true,
  },
  {
    id: "g2048" as const,
    name: "2048 竞速",
    description: "双方拿到同一副牌，各自拼数字，先到 2048 的人赢。",
    players: "2 人",
    status: "可游玩",
    available: true,
  },
  {
    id: "tic-tac-toe",
    name: "井字棋",
    description: "更轻量的好友房间小游戏。",
    players: "2 人",
    status: "即将加入",
    available: false,
  },
];

function GameHub({ onSelect }: { onSelect: (game: GameId) => void }) {
  return (
    <main className="arcade-shell">
      <header className="topbar hub-topbar">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <div>
            <p className="brand-name">P2P 游戏游廊</p>
            <p className="brand-caption">MINI GAME ARCADE</p>
          </div>
        </div>
        <div className="topbar-note">
          <span className="live-dot" />
          <span>打开即玩，无需注册</span>
        </div>
      </header>

      <section className="hub-hero">
        <div className="hub-hero-copy">
          <p className="eyebrow">CHOOSE A GAME</p>
          <h1>找个人，开一局。</h1>
          <p>每个小游戏共用 P2P 匹配、好友房间和直连通信能力。选中游戏后，再决定随机匹配或邀请朋友。</p>
        </div>
        <div className="hub-summary" aria-label="游戏平台信息">
          <div><strong>{GAME_CATALOG.filter((game) => game.available).length}</strong><span>款可游玩</span></div>
          <div><strong>P2P</strong><span>对局直连</span></div>
          <div><strong>0</strong><span>注册步骤</span></div>
        </div>
      </section>

      <section className="game-catalog" aria-label="小游戏列表">
        {GAME_CATALOG.map((game) => game.available ? (
          <button className="game-card game-card-available" type="button" key={game.id} onClick={() => onSelect(game.id as GameId)}>
            <div className={`game-card-visual ${game.id}-card-visual`} aria-hidden="true">
              <GameCardArt id={game.id as GameId} />
              <span className="available-badge"><span />在线</span>
            </div>
            <div className="game-card-content">
              <div className="game-card-title">
                <span className="game-icon">{GAME_ICONS[game.id as GameId]}</span>
                <div><strong>{game.name}</strong><span>{game.status}</span></div>
              </div>
              <p>{game.description}</p>
              <div className="game-card-meta"><span>{game.players}</span><span>进入游戏 <span aria-hidden="true">→</span></span></div>
            </div>
          </button>
        ) : (
          <article className="game-card game-card-coming" key={game.id}>
            <div className="game-card-visual coming-card-visual" aria-hidden="true"><Gamepad2 size={34} /></div>
            <div className="game-card-content">
              <div className="game-card-title">
                <span className="game-icon"><Gamepad2 size={20} /></span>
                <div><strong>{game.name}</strong><span>{game.status}</span></div>
              </div>
              <p>{game.description}</p>
              <div className="game-card-meta"><span>{game.players}</span><span>开发中</span></div>
            </div>
          </article>
        ))}
      </section>

      <section className="hub-extension-note">
        <Gamepad2 size={20} />
        <div><strong>统一游戏外壳</strong><span>后续新增游戏只需要接入游戏组件，房间、通信和聊天体验可以继续复用。</span></div>
      </section>

      <footer className="page-footer hub-footer">
        <span>小游戏逐步加入中。</span>
        <span><span className="footer-key">P2P</span> · 房间对战 · 跨端可玩</span>
      </footer>
    </main>
  );
}

export default function Home() {
  const [selectedGame, setSelectedGame] = useState<GameId | null>(null);

  useEffect(() => {
    const syncRoute = () => {
      if (window.location.hash === "#gomoku") setSelectedGame("gomoku");
      else if (window.location.hash === "#bomberman") setSelectedGame("bomberman");
      else if (window.location.hash === "#reversi") setSelectedGame("reversi");
      else if (window.location.hash === "#connect4") setSelectedGame("connect4");
      else if (window.location.hash === "#pong") setSelectedGame("pong");
      else if (window.location.hash === "#g2048") setSelectedGame("g2048");
      else setSelectedGame(null);
    };
    syncRoute();
    window.addEventListener("hashchange", syncRoute);
    return () => window.removeEventListener("hashchange", syncRoute);
  }, []);

  const openGame = useCallback((game: GameId) => {
    window.location.hash = game;
    setSelectedGame(game);
  }, []);

  const backToHub = useCallback(() => {
    window.history.pushState(null, "", `${window.location.pathname}${window.location.search}`);
    setSelectedGame(null);
  }, []);

  if (selectedGame === "gomoku") return <GomokuGame onBack={backToHub} />;
  if (selectedGame === "bomberman") return <BombermanGame onBack={backToHub} />;
  if (selectedGame === "reversi") return <ReversiGame onBack={backToHub} />;
  if (selectedGame === "connect4") return <Connect4Game onBack={backToHub} />;
  if (selectedGame === "pong") return <PongGame onBack={backToHub} />;
  if (selectedGame === "g2048") return <G2048Game onBack={backToHub} />;
  return <GameHub onSelect={openGame} />;
}
