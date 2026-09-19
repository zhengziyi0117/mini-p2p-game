"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronUp,
  CircleHelp,
  Copy,
  Gamepad2,
  Grid3X3,
  KeyRound,
  LoaderCircle,
  LogOut,
  MessageCircle,
  Radio,
  RotateCcw,
  Send,
  ShieldCheck,
  Sparkles,
  Swords,
  SmilePlus,
  Undo2,
  Users,
} from "lucide-react";

type Color = "black" | "white";
type Cell = Color | null;
type Phase = "idle" | "matching" | "room-waiting" | "connecting" | "playing" | "finished" | "error";
type MatchMode = "quick" | "room";
type GameId = "gomoku";
type MoveRecord = { index: number; color: Color };
type ChatMessage = { id: string; sender: "self" | "opponent"; text: string; sentAt: number };
type EmojiSender = "self" | "opponent";
type RematchState = "outgoing" | "incoming" | null;
type MatchInfo = {
  matchId: string;
  playerId: string;
  opponentId: string;
  opponentName: string;
  color: Color;
  roomCode?: string;
};

const BOARD_SIZE = 15;
const BOARD_CELLS = BOARD_SIZE * BOARD_SIZE;
const QUICK_EMOJIS = ["👏", "😂", "😮", "👍", "🤔", "🔥", "🎉", "🙏"];
const STUN_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun.cloudflare.com:3478" },
];

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

  interface Window {
    __P2P_SIGNAL_ORIGIN__?: string;
  }
}

function blankBoard(): Cell[] {
  return Array.from({ length: BOARD_CELLS }, () => null);
}

function makePlayerId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `player-${Math.random().toString(36).slice(2)}-${Date.now()}`;
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

function delay(milliseconds: number) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function apiUrl(path: string) {
  if (typeof window === "undefined") return path;
  const origin = window.__P2P_SIGNAL_ORIGIN__?.replace(/\/$/, "") ?? "";
  return `${origin}${path}`;
}

function statusCopy(phase: Phase, match: MatchInfo | null, turn: Color, winner: Color | "draw" | null) {
  if (phase === "idle") return "准备好就开始匹配";
  if (phase === "matching") return "正在寻找对手…";
  if (phase === "room-waiting") return "房间已创建，等待加入";
  if (phase === "connecting") return "对手已找到，建立直连…";
  if (phase === "finished") {
    if (winner === "draw") return "棋盘已满，和棋";
    return winner === match?.color ? "漂亮，你赢了" : "这局惜败，再来一盘";
  }
  if (phase === "error") return "连接中断了";
  return turn === match?.color ? "轮到你落子" : "等待对手落子";
}

function readableError(error: unknown) {
  return error instanceof Error ? error.message : "请求没有完成，请稍后重试。";
}

function GomokuGame({ onBack }: { onBack: () => void }) {
  const [nickname, setNickname] = useState(() => (typeof window === "undefined" ? "" : window.localStorage.getItem("gomoku-nickname") ?? ""));
  const [mode, setMode] = useState<MatchMode>("quick");
  const [roomCode, setRoomCode] = useState("");
  const [activeRoomCode, setActiveRoomCode] = useState("");
  const [board, setBoard] = useState<Cell[]>(blankBoard);
  const [moveHistory, setMoveHistory] = useState<MoveRecord[]>([]);
  const [turn, setTurn] = useState<Color>("black");
  const [winner, setWinner] = useState<Color | "draw" | null>(null);
  const [phase, setPhaseState] = useState<Phase>("idle");
  const [match, setMatch] = useState<MatchInfo | null>(null);
  const [message, setMessage] = useState("输入昵称，和下一位棋手来一盘。 ");
  const [isOnline, setIsOnline] = useState(false);
  const [undoPending, setUndoPending] = useState<"outgoing" | "incoming" | null>(null);
  const [chatOpen, setChatOpen] = useState(true);
  const [chatInput, setChatInput] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [unreadChat, setUnreadChat] = useState(0);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [opponentHover, setOpponentHover] = useState<number | null>(null);
  const [lastEmoji, setLastEmoji] = useState<{ emoji: string; sender: EmojiSender } | null>(null);
  const [rematchPending, setRematchPending] = useState<RematchState>(null);
  const [round, setRound] = useState(1);

  const playerIdRef = useRef("");
  const phaseRef = useRef<Phase>("idle");
  const boardRef = useRef<Cell[]>(blankBoard());
  const moveHistoryRef = useRef<MoveRecord[]>([]);
  const turnRef = useRef<Color>("black");
  const winnerRef = useRef<Color | "draw" | null>(null);
  const matchRef = useRef<MatchInfo | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const channelRef = useRef<RTCDataChannel | null>(null);
  const signalCursorRef = useRef(0);
  const stopSignalPollingRef = useRef(false);
  const matchPollingRef = useRef(false);
  const undoPendingRef = useRef<"outgoing" | "incoming" | null>(null);
  const rematchPendingRef = useRef<RematchState>(null);
  const chatOpenRef = useRef(true);
  const emojiTimerRef = useRef<number | null>(null);
  const startMatchingRef = useRef<(() => Promise<void>) | null>(null);
  const placeStoneRef = useRef<((index: number) => { ok: boolean; reason?: string }) | null>(null);

  useEffect(() => {
    const nextPlayerId = window.sessionStorage.getItem("gomoku-player-id") ?? makePlayerId();
    window.sessionStorage.setItem("gomoku-player-id", nextPlayerId);
    playerIdRef.current = nextPlayerId;
  }, []);

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

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
    matchRef.current = match;
  }, [match]);

  useEffect(() => {
    chatOpenRef.current = chatOpen;
  }, [chatOpen]);

  const setPhase = useCallback((nextPhase: Phase) => {
    phaseRef.current = nextPhase;
    setPhaseState(nextPhase);
  }, []);

  const setUndoState = useCallback((nextState: "outgoing" | "incoming" | null) => {
    undoPendingRef.current = nextState;
    setUndoPending(nextState);
  }, []);

  const setRematchState = useCallback((nextState: RematchState) => {
    rematchPendingRef.current = nextState;
    setRematchPending(nextState);
  }, []);

  const showEmoji = useCallback((emoji: string, sender: EmojiSender) => {
    setLastEmoji({ emoji, sender });
    if (emojiTimerRef.current) window.clearTimeout(emojiTimerRef.current);
    emojiTimerRef.current = window.setTimeout(() => {
      setLastEmoji(null);
      emojiTimerRef.current = null;
    }, 1800);
  }, []);

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
    setEmojiOpen(false);
    setOpponentHover(null);
    setLastEmoji(null);
  }, [setRematchState, setUndoState]);

  const resetBoard = useCallback(() => {
    resetRound();
    setChatMessages([]);
    setChatInput("");
    setUnreadChat(0);
    setChatOpen(true);
    setRound(1);
  }, [resetRound]);

  const closeConnection = useCallback(() => {
    stopSignalPollingRef.current = true;
    setIsOnline(false);
    channelRef.current?.close();
    peerRef.current?.close();
    channelRef.current = null;
    peerRef.current = null;
    setOpponentHover(null);
  }, []);

  const sendPeerMessage = useCallback((payload: Record<string, unknown>) => {
    const channel = channelRef.current;
    if (channel?.readyState === "open") channel.send(JSON.stringify(payload));
  }, []);

  const sendHover = useCallback(
    (index: number | null) => {
      if (!matchRef.current || !isOnline || phaseRef.current !== "playing") return;
      sendPeerMessage({ type: "hover", index });
    },
    [isOnline, sendPeerMessage],
  );

  const sendChat = useCallback(() => {
    const text = chatInput.trim().replace(/\s+/g, " ").slice(0, 120);
    if (!text) return;
    if (!matchRef.current || !isOnline) {
      setMessage("建立直连后才能聊天。 ");
      return;
    }
    setChatMessages((current) => [
      ...current,
      { id: `self-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, sender: "self", text, sentAt: Date.now() },
    ]);
    setChatInput("");
    sendPeerMessage({ type: "chat", text });
  }, [chatInput, isOnline, sendPeerMessage]);

  const sendEmoji = useCallback(
    (emoji: string) => {
      if (!matchRef.current || !isOnline) {
        setMessage("建立直连后才能发送表情。 ");
        return;
      }
      showEmoji(emoji, "self");
      sendPeerMessage({ type: "emoji", emoji });
      setEmojiOpen(false);
    },
    [isOnline, sendPeerMessage, showEmoji],
  );

  const applyMove = useCallback(
    (index: number, color: Color, send: boolean) => {
      if (
        index < 0 ||
        index >= BOARD_CELLS ||
        boardRef.current[index] !== null ||
        winnerRef.current ||
        undoPendingRef.current ||
        turnRef.current !== color ||
        (phaseRef.current !== "playing" && phaseRef.current !== "finished")
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
        setPhase("finished");
        stopSignalPollingRef.current = true;
      } else {
        const nextTurn = color === "black" ? "white" : "black";
        turnRef.current = nextTurn;
        setTurn(nextTurn);
      }

      if (send) sendPeerMessage({ type: "move", index, color });
      return true;
    },
    [sendPeerMessage, setPhase],
  );

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
    stopSignalPollingRef.current = true;
    setPhase("playing");
    return true;
  }, [setPhase, setUndoState]);

  const requestUndo = useCallback(() => {
    if (!matchRef.current || !isOnline || !moveHistoryRef.current.length) return;
    if (phaseRef.current !== "playing" && phaseRef.current !== "finished") return;
    if (undoPendingRef.current) return;
    setUndoState("outgoing");
    setMessage("已发出悔棋请求，等待对方确认… ");
    sendPeerMessage({ type: "undo-request" });
  }, [isOnline, sendPeerMessage, setUndoState]);

  const respondToUndo = useCallback(
    (accepted: boolean) => {
      if (undoPendingRef.current !== "incoming") return;
      sendPeerMessage({ type: "undo-response", accepted });
      if (accepted) {
        undoLastMove();
        setMessage("已同意悔棋，回到上一步。 ");
      } else {
        setUndoState(null);
        setMessage("已拒绝对方的悔棋请求。 ");
      }
    },
    [sendPeerMessage, setUndoState, undoLastMove],
  );

  const startRematch = useCallback(() => {
    const currentMatch = matchRef.current;
    if (!currentMatch) return;
    const nextMatch: MatchInfo = {
      ...currentMatch,
      color: currentMatch.color === "black" ? "white" : "black",
    };
    matchRef.current = nextMatch;
    setMatch(nextMatch);
    resetRound();
    setRound((current) => current + 1);
    setPhase("playing");
    setMessage(nextMatch.color === "black" ? "新一局开始，你执黑先行。 " : "新一局开始，对手执黑先行。 ");
  }, [resetRound, setPhase]);

  const requestRematch = useCallback(() => {
    if (!matchRef.current || !isOnline || phaseRef.current !== "finished" || rematchPendingRef.current) return;
    setRematchState("outgoing");
    setMessage("已邀请对手再来一局，等待对方确认… ");
    sendPeerMessage({ type: "rematch-request" });
  }, [isOnline, sendPeerMessage, setRematchState]);

  const respondToRematch = useCallback(
    (accepted: boolean) => {
      if (rematchPendingRef.current !== "incoming") return;
      sendPeerMessage({ type: "rematch-response", accepted });
      if (accepted) {
        startRematch();
      } else {
        setRematchState(null);
        setMessage("已拒绝再来一局的邀请。 ");
      }
    },
    [sendPeerMessage, setRematchState, startRematch],
  );

  const attachChannel = useCallback(
    (channel: RTCDataChannel, matchId: string) => {
      channelRef.current = channel;
      channel.onopen = () => {
        if (matchRef.current?.matchId !== matchId) return;
        setIsOnline(true);
        setPhase("playing");
        setMessage("直连已建立，黑方先行。落子后棋盘会实时同步。 ");
        stopSignalPollingRef.current = true;
      };
      channel.onmessage = (event) => {
        try {
          const payload = JSON.parse(String(event.data)) as {
            type?: string;
            index?: number | null;
            color?: Color;
            accepted?: boolean;
            text?: string;
            emoji?: string;
          };
          if (payload.type === "move" && (payload.color === "black" || payload.color === "white")) {
            applyMove(Number(payload.index), payload.color, false);
          }
          if (payload.type === "hover") {
            const hoverIndex = payload.index;
            setOpponentHover(typeof hoverIndex === "number" && Number.isInteger(hoverIndex) && hoverIndex >= 0 && hoverIndex < BOARD_CELLS ? hoverIndex : null);
          }
          if (payload.type === "chat" && typeof payload.text === "string") {
            const incomingText = payload.text.slice(0, 120);
            setChatMessages((current) => [
              ...current,
              {
                id: `opponent-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                sender: "opponent",
                text: incomingText,
                sentAt: Date.now(),
              },
            ]);
            if (!chatOpenRef.current) setUnreadChat((current) => current + 1);
          }
          if (payload.type === "emoji" && typeof payload.emoji === "string" && QUICK_EMOJIS.includes(payload.emoji)) {
            showEmoji(payload.emoji, "opponent");
          }
          if (payload.type === "undo-request") {
            setUndoState("incoming");
            setMessage(`${matchRef.current?.opponentName ?? "对手"} 请求悔棋，请选择是否同意。 `);
          }
          if (payload.type === "undo-response") {
            if (payload.accepted) {
              undoLastMove();
              setMessage("对方同意悔棋，回到上一步。 ");
            } else {
              setUndoState(null);
              setMessage("对方拒绝了悔棋请求。 ");
            }
          }
          if (payload.type === "rematch-request" && phaseRef.current === "finished") {
            if (rematchPendingRef.current === "outgoing") {
              sendPeerMessage({ type: "rematch-response", accepted: true });
              startRematch();
            } else {
              setRematchState("incoming");
              setMessage(`${matchRef.current?.opponentName ?? "对手"} 邀请你再来一局。 `);
            }
          }
          if (payload.type === "rematch-response" && rematchPendingRef.current === "outgoing") {
            if (payload.accepted) {
              startRematch();
            } else {
              setRematchState(null);
              setMessage("对手暂时不想继续这一局。 ");
            }
          }
        } catch {
          setMessage("收到了一条无法识别的对局消息。 ");
        }
      };
      channel.onclose = () => {
        if (matchRef.current?.matchId === matchId && (phaseRef.current === "playing" || phaseRef.current === "finished")) {
          setIsOnline(false);
          setPhase("error");
          setMessage("对手的连接已断开，可以重新匹配。 ");
        }
      };
      channel.onerror = () => {
        if (matchRef.current?.matchId === matchId) {
          setIsOnline(false);
          setPhase("error");
          setMessage("P2P 连接失败，可能是当前网络限制了直连。 ");
        }
      };
    },
    [applyMove, sendPeerMessage, setPhase, setRematchState, setUndoState, showEmoji, startRematch, undoLastMove],
  );

  const sendSignal = useCallback(async (nextMatch: MatchInfo, type: "offer" | "answer", description: RTCSessionDescriptionInit) => {
    const result = await fetch(apiUrl("/api/signal"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        matchId: nextMatch.matchId,
        playerId: playerIdRef.current,
        type,
        payload: JSON.stringify(description),
      }),
    });
    if (!result.ok) throw new Error("信令消息没有送达。 ");
  }, []);

  const waitForIce = useCallback((peer: RTCPeerConnection) => {
    if (peer.iceGatheringState === "complete") return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timeout = window.setTimeout(resolve, 5000);
      const onStateChange = () => {
        if (peer.iceGatheringState === "complete") {
          window.clearTimeout(timeout);
          peer.removeEventListener("icegatheringstatechange", onStateChange);
          resolve();
        }
      };
      peer.addEventListener("icegatheringstatechange", onStateChange);
    });
  }, []);

  const connectToMatch = useCallback(
    async (nextMatch: MatchInfo) => {
      closeConnection();
      setPhase("connecting");
      setMatch(nextMatch);
      matchRef.current = nextMatch;
      if (nextMatch.roomCode) setActiveRoomCode(nextMatch.roomCode);
      signalCursorRef.current = 0;
      stopSignalPollingRef.current = false;
      setMessage(`已匹配到 ${nextMatch.opponentName}，正在建立安全直连… `);

      const peer = new RTCPeerConnection({ iceServers: STUN_SERVERS });
      peerRef.current = peer;
      peer.onconnectionstatechange = () => {
        if (["failed", "closed"].includes(peer.connectionState) && phaseRef.current === "connecting") {
          setPhase("error");
          setMessage("没有建立起 P2P 直连，请重新匹配。 ");
        }
      };

      if (nextMatch.color === "black") {
        attachChannel(peer.createDataChannel("gomoku"), nextMatch.matchId);
      } else {
        peer.ondatachannel = (event) => attachChannel(event.channel, nextMatch.matchId);
      }

      let handledOffer = false;
      let handledAnswer = false;

      const handleSignal = async (signal: { type: string; payload: string }) => {
        const description = JSON.parse(signal.payload) as RTCSessionDescriptionInit;
        if (signal.type === "offer" && nextMatch.color === "white" && !handledOffer) {
          handledOffer = true;
          await peer.setRemoteDescription(description);
          const answer = await peer.createAnswer();
          await peer.setLocalDescription(answer);
          await waitForIce(peer);
          if (peer.localDescription) await sendSignal(nextMatch, "answer", peer.localDescription);
        }
        if (signal.type === "answer" && nextMatch.color === "black" && !handledAnswer) {
          handledAnswer = true;
          await peer.setRemoteDescription(description);
        }
      };

      const pollSignals = async () => {
        while (!stopSignalPollingRef.current && phaseRef.current === "connecting") {
          try {
            const result = await fetch(
              apiUrl(`/api/signal?matchId=${encodeURIComponent(nextMatch.matchId)}&playerId=${encodeURIComponent(playerIdRef.current)}&after=${signalCursorRef.current}`),
              { cache: "no-store" },
            );
            if (result.ok) {
              const data = (await result.json()) as {
                signals?: Array<{ id: number; type: string; payload: string }>;
              };
              for (const signal of data.signals ?? []) {
                signalCursorRef.current = Math.max(signalCursorRef.current, signal.id);
                await handleSignal(signal);
              }
            }
          } catch {
            // A later poll can recover from a transient network failure.
          }
          if (!stopSignalPollingRef.current) await delay(850);
        }
      };
      void pollSignals();

      if (nextMatch.color === "black") {
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        await waitForIce(peer);
        if (peer.localDescription) await sendSignal(nextMatch, "offer", peer.localDescription);
      }
    },
    [attachChannel, closeConnection, sendSignal, setPhase, waitForIce],
  );

  const monitorMatch = useCallback(
    async (nextPlayerId: string) => {
      matchPollingRef.current = true;
      try {
        while (matchPollingRef.current && (phaseRef.current === "matching" || phaseRef.current === "room-waiting")) {
          const result = await fetch(apiUrl(`/api/match?playerId=${encodeURIComponent(nextPlayerId)}`), { cache: "no-store" });
          if (!result.ok) throw new Error("匹配服务暂时不可用。 ");
          const data = (await result.json()) as { status?: string; match?: MatchInfo };
          if (data.match) {
            matchPollingRef.current = false;
            await connectToMatch(data.match);
            return;
          }
          await delay(1200);
        }
      } catch (error) {
        matchPollingRef.current = false;
        setPhase("error");
        setMessage(readableError(error));
      }
    },
    [connectToMatch, setPhase],
  );

  const startMatching = useCallback(async () => {
    if (!playerIdRef.current) return;
    const cleanName = nickname.trim().replace(/\s+/g, " ").slice(0, 18);
    if (!cleanName) {
      setMessage("先给自己取一个昵称吧。 ");
      return;
    }

    window.localStorage.setItem("gomoku-nickname", cleanName);
    setNickname(cleanName);
    matchPollingRef.current = false;
    closeConnection();
    resetBoard();
    setMatch(null);
    matchRef.current = null;
    setActiveRoomCode("");
    setPhase("matching");
    setMessage("正在寻找一位在线棋手… ");

    try {
      await fetch(apiUrl(`/api/match?playerId=${encodeURIComponent(playerIdRef.current)}`), { method: "DELETE" }).catch(() => undefined);
      const result = await fetch(apiUrl("/api/match"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "join", playerId: playerIdRef.current, nickname: cleanName }),
      });
      const data = (await result.json()) as { status?: string; match?: MatchInfo; error?: string };
      if (!result.ok) throw new Error(data.error ?? "匹配服务暂时不可用。 ");
      if (data.match) {
        await connectToMatch(data.match);
      } else {
        void monitorMatch(playerIdRef.current);
      }
    } catch (error) {
      setPhase("error");
      setMessage(readableError(error));
    }
  }, [closeConnection, connectToMatch, monitorMatch, nickname, resetBoard, setPhase]);

  const createRoom = useCallback(async () => {
    if (!playerIdRef.current) return;
    const cleanName = nickname.trim().replace(/\s+/g, " ").slice(0, 18);
    if (!cleanName) {
      setMessage("先给自己取一个昵称吧。 ");
      return;
    }

    window.localStorage.setItem("gomoku-nickname", cleanName);
    setNickname(cleanName);
    matchPollingRef.current = false;
    closeConnection();
    resetBoard();
    setMatch(null);
    matchRef.current = null;
    setActiveRoomCode("");
    setPhase("matching");
    setMessage("正在创建房间… ");

    try {
      await fetch(apiUrl(`/api/match?playerId=${encodeURIComponent(playerIdRef.current)}`), { method: "DELETE" }).catch(() => undefined);
      const result = await fetch(apiUrl("/api/match"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create_room", playerId: playerIdRef.current, nickname: cleanName }),
      });
      const data = (await result.json()) as { status?: string; roomCode?: string; error?: string };
      if (!result.ok || !data.roomCode) throw new Error(data.error ?? "房间创建失败，请稍后重试。 ");
      setRoomCode(data.roomCode);
      setActiveRoomCode(data.roomCode);
      setPhase("room-waiting");
      setMessage(`房间号 ${data.roomCode} 已创建，等待朋友加入。 `);
      void monitorMatch(playerIdRef.current);
    } catch (error) {
      setPhase("error");
      setMessage(readableError(error));
    }
  }, [closeConnection, monitorMatch, nickname, resetBoard, setPhase]);

  const joinRoom = useCallback(async () => {
    if (!playerIdRef.current) return;
    const cleanName = nickname.trim().replace(/\s+/g, " ").slice(0, 18);
    const cleanCode = roomCode.trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
    if (!cleanName) {
      setMessage("先给自己取一个昵称吧。 ");
      return;
    }
    if (!/^[A-Z0-9]{4,8}$/.test(cleanCode)) {
      setMessage("请输入有效的房间号。 ");
      return;
    }

    window.localStorage.setItem("gomoku-nickname", cleanName);
    setNickname(cleanName);
    setRoomCode(cleanCode);
    matchPollingRef.current = false;
    closeConnection();
    resetBoard();
    setMatch(null);
    matchRef.current = null;
    setActiveRoomCode("");
    setPhase("matching");
    setMessage(`正在加入房间 ${cleanCode}… `);

    try {
      await fetch(apiUrl(`/api/match?playerId=${encodeURIComponent(playerIdRef.current)}`), { method: "DELETE" }).catch(() => undefined);
      const result = await fetch(apiUrl("/api/match"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "join_room", roomCode: cleanCode, playerId: playerIdRef.current, nickname: cleanName }),
      });
      const data = (await result.json()) as { status?: string; roomCode?: string; match?: MatchInfo; error?: string };
      if (!result.ok) throw new Error(data.error ?? "加入房间失败，请检查房间号。 ");
      if (data.match) {
        setActiveRoomCode(data.match.roomCode ?? cleanCode);
        await connectToMatch(data.match);
      } else {
        setActiveRoomCode(data.roomCode ?? cleanCode);
        setPhase("room-waiting");
        setMessage(`房间号 ${data.roomCode ?? cleanCode} 仍在等待加入。 `);
        void monitorMatch(playerIdRef.current);
      }
    } catch (error) {
      setPhase("error");
      setMessage(readableError(error));
    }
  }, [closeConnection, connectToMatch, monitorMatch, nickname, resetBoard, roomCode, setPhase]);

  const copyRoomCode = useCallback(async () => {
    if (!activeRoomCode) return;
    try {
      await navigator.clipboard.writeText(activeRoomCode);
      setMessage("房间号已复制，发给朋友就可以开始。 ");
    } catch {
      setMessage(`请手动复制房间号：${activeRoomCode} `);
    }
  }, [activeRoomCode]);

  useEffect(() => {
    startMatchingRef.current = startMatching;
  }, [startMatching]);

  const cancelMatching = useCallback(async () => {
    matchPollingRef.current = false;
    closeConnection();
    if (playerIdRef.current) {
      await fetch(apiUrl(`/api/match?playerId=${encodeURIComponent(playerIdRef.current)}`), { method: "DELETE" }).catch(() => undefined);
    }
    setMatch(null);
    matchRef.current = null;
    setActiveRoomCode("");
    resetBoard();
    setPhase("idle");
    setMessage("随时可以再找一位对手。 ");
  }, [closeConnection, resetBoard, setPhase]);

  const placeStone = useCallback(
    (index: number) => {
      if (!matchRef.current) return { ok: false, reason: "还没有匹配到对手。" };
      if (phaseRef.current !== "playing") return { ok: false, reason: "当前还不能落子。" };
      if (turnRef.current !== matchRef.current.color) return { ok: false, reason: "现在是对手的回合。" };
      return applyMove(index, matchRef.current.color, true)
        ? { ok: true }
        : { ok: false, reason: "这个位置不能落子。" };
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

  useEffect(() => () => {
    matchPollingRef.current = false;
    closeConnection();
  }, [closeConnection]);

  const isBusy = phase === "matching" || phase === "room-waiting" || phase === "connecting";
  const myTurn = Boolean(match && phase === "playing" && turn === match.color && !undoPending);
  const shownStatus = statusCopy(phase, match, turn, winner);
  const opponentLabel = match?.opponentName ?? "等待对手";

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
            <div className={`phase-pill phase-${phase}`}>
              <span className="phase-dot" />
              {phase === "playing" ? "对局中" : phase === "matching" ? "匹配中" : phase === "room-waiting" ? "等人加入" : phase === "connecting" ? "连接中" : phase === "finished" ? "已结束" : phase === "error" ? "需要重试" : "等待开始"}
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
                        className={`board-cell ${cell ? `stone-${cell}` : ""} ${myTurn && !cell ? "cell-available" : ""} ${opponentHover === index && phase === "playing" ? "opponent-hover" : ""}`}
                        key={index}
                        type="button"
                        role="gridcell"
                        aria-label={`${row + 1} 行，第${column + 1} 列${cell ? `，${cell === "black" ? "黑子" : "白子"}` : "，空位"}`}
                        disabled={!myTurn || Boolean(cell) || Boolean(winner)}
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
            {lastEmoji && (
              <div className={`emoji-burst emoji-${lastEmoji.sender}`} aria-live="polite">
                <span>{lastEmoji.emoji}</span>
                <small>{lastEmoji.sender === "self" ? "你" : opponentLabel}</small>
              </div>
            )}
            {(phase === "idle" || phase === "matching" || phase === "room-waiting" || phase === "connecting" || phase === "error") && (
              <div className={`board-overlay overlay-${phase}`}>
                {phase === "idle" && <Sparkles size={20} />}
                {phase === "matching" && <LoaderCircle className="spin" size={22} />}
                {phase === "room-waiting" && <KeyRound className="pulse" size={21} />}
                {phase === "connecting" && <Radio className="pulse" size={22} />}
                {phase === "error" && <CircleHelp size={21} />}
                <strong>{shownStatus}</strong>
                <span>
                  {phase === "idle"
                    ? "先输入昵称，再点击右侧开始匹配。"
                    : phase === "matching"
                      ? "遇到另一位棋手后会自动进入对局。"
                      : phase === "room-waiting"
                        ? <>把房间号 <b className="overlay-room-code">{activeRoomCode}</b> 发给朋友。</>
                        : phase === "connecting"
                          ? "双方建立直连后，黑方先行。"
                          : phase === "error"
                            ? "换个网络或重新匹配试试。"
                            : ""}
                </span>
              </div>
            )}
          </div>

          {phase === "finished" && match && (
            <section className={`round-result ${winner === "draw" ? "result-draw" : winner === match.color ? "result-win" : "result-loss"}`} aria-live="polite">
              <div className="round-result-copy">
                <span className="result-icon"><Swords size={19} /></span>
                <div>
                  <p>第 {round} 局结束</p>
                  <h2>{shownStatus}</h2>
                  <span>{winner === "draw" ? "势均力敌，换手再试一次。" : winner === match.color ? "棋盘保留着，随时可以和同一位对手继续。" : "不离开房间，下一局直接扳回来。"}</span>
                </div>
              </div>
              <div className="round-result-actions">
                {rematchPending === "incoming" ? (
                  <>
                    <button className="result-secondary" type="button" onClick={() => respondToRematch(false)}>稍后</button>
                    <button className="result-primary" type="button" onClick={() => respondToRematch(true)}>接受再来一局</button>
                  </>
                ) : (
                  <button className="result-primary" type="button" disabled={!isOnline || rematchPending === "outgoing"} onClick={requestRematch}>
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
            <span>{isOnline ? "WebRTC 直连" : "等待连接"}</span>
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
              disabled={isBusy || phase === "playing" || phase === "finished"}
              onClick={() => setMode("quick")}
            >
              随机匹配
            </button>
            <button
              className={`mode-tab ${mode === "room" ? "active" : ""}`}
              type="button"
              role="tab"
              aria-selected={mode === "room"}
              disabled={isBusy || phase === "playing" || phase === "finished"}
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
                  disabled={isBusy || phase === "playing" || phase === "finished"}
                  onChange={(event) => setRoomCode(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8))}
                />
              </label>
              <div className="room-actions">
                <button className="room-action room-create" type="button" disabled={isBusy || phase === "playing" || phase === "finished"} onClick={createRoom}>
                  <KeyRound size={16} /> 创建房间
                </button>
                <button className="room-action room-join" type="button" disabled={isBusy || phase === "playing" || phase === "finished" || roomCode.trim().length < 4} onClick={joinRoom}>
                  <Users size={16} /> 加入房间
                </button>
              </div>
              {activeRoomCode && (
                <div className="room-code-card">
                  <div className="room-code-copy">
                    <span><Check size={14} /> 房间已就绪</span>
                    <strong>{activeRoomCode}</strong>
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
                disabled={isBusy || phase === "playing" || phase === "finished"}
                onChange={(event) => setNickname(event.target.value)}
              />
            </div>
            <span className="color-chip chip-neutral">{match?.color === "black" ? "黑" : match?.color === "white" ? "白" : "—"}</span>
          </div>

          <div className="versus-row">
            <span />
            <strong>VS</strong>
            <span />
          </div>

          <div className="player-card opponent-card">
            <div className="player-avatar avatar-opponent">{match ? opponentLabel.slice(0, 1).toUpperCase() : "?"}</div>
            <div className="player-copy">
              <span className="player-label">对手</span>
              <strong>{opponentLabel}</strong>
            </div>
            <span className={`color-chip ${match ? match.color === "black" ? "chip-white" : "chip-black" : "chip-neutral"}`}>
              {match?.color === "black" ? "白" : match?.color === "white" ? "黑" : "—"}
            </span>
          </div>

          <div className="turn-card">
            <div className={`turn-stone ${turn}`} aria-hidden="true" />
            <div>
              <span className="player-label">当前回合</span>
              <strong>{phase === "playing" ? myTurn ? "轮到你" : "等待对手" : shownStatus}</strong>
            </div>
            <span className={`connection-label ${isOnline ? "online" : ""}`}>
              <span />
              {isOnline ? "已直连" : "未连接"}
            </span>
          </div>

          {mode === "quick" && phase !== "finished" && (
            <button className="primary-button" type="button" disabled={isBusy || phase === "playing"} onClick={startMatching}>
              {phase === "error" ? <RotateCcw size={18} /> : <Swords size={18} />}
              {phase === "error" ? "重新匹配" : "开始匹配"}
            </button>
          )}
          {isBusy && (
            <button className="secondary-button" type="button" onClick={cancelMatching}>
              {phase === "room-waiting" ? "关闭房间" : "取消匹配"}
            </button>
          )}
          {(phase === "playing" || phase === "finished") && (
            <button className="secondary-button" type="button" onClick={cancelMatching}>
              <LogOut size={16} /> 离开当前房间
            </button>
          )}

          {(phase === "playing" || phase === "finished") && match && (
            <div className="undo-area">
              {undoPending === "incoming" ? (
                <div className="undo-prompt">
                  <span>{match.opponentName} 请求悔棋</span>
                  <div className="undo-actions">
                    <button className="undo-accept" type="button" onClick={() => respondToUndo(true)}>同意</button>
                    <button className="undo-reject" type="button" onClick={() => respondToUndo(false)}>拒绝</button>
                  </div>
                </div>
              ) : (
                <button className="secondary-button undo-button" type="button" disabled={!moveHistory.length || !isOnline || Boolean(undoPending)} onClick={requestUndo}>
                  <Undo2 size={16} />
                  {undoPending === "outgoing" ? "等待对方确认" : "请求悔棋"}
                </button>
              )}
              <span className="undo-hint">{moveHistory.length ? "悔棋需要对手确认" : "落子后可以请求悔棋"}</span>
            </div>
          )}

          <p className="status-message" aria-live="polite">{message}</p>

          <div className="trust-note">
            <ShieldCheck size={17} />
            <span>只用信令服务器撮合，落子通过 WebRTC 端到端传输。</span>
          </div>
          <p className="tip-note"><span>TIP</span> 黑方先手；点击棋盘交叉点落子。</p>
        </aside>

        <section className={`chat-dock independent-chat ${chatOpen ? "chat-open" : ""}`} aria-label="对局聊天">
          <div className="chat-card-heading">
            <div className="chat-title-group">
              <span className="chat-title-icon"><MessageCircle size={17} /></span>
              <div>
                <strong>对局聊天</strong>
                <span>{isOnline ? `正在和 ${opponentLabel} 直连聊天` : "匹配成功后即可发送消息"}</span>
              </div>
            </div>
            <div className="chat-heading-actions">
              <span className={`chat-status ${isOnline ? "online" : ""}`}><i />{isOnline ? "在线" : "离线"}</span>
              {unreadChat > 0 && <b className="chat-unread">{unreadChat > 9 ? "9+" : unreadChat}</b>}
              <button
                className="chat-collapse"
                type="button"
                aria-label={chatOpen ? "收起聊天" : "展开聊天"}
                aria-expanded={chatOpen}
                aria-controls="gomoku-chat-panel"
                onClick={() => {
                  const nextOpen = !chatOpen;
                  chatOpenRef.current = nextOpen;
                  setChatOpen(nextOpen);
                  if (nextOpen) setUnreadChat(0);
                }}
              >
                {chatOpen ? <ChevronUp size={17} /> : <ChevronDown size={17} />}
              </button>
            </div>
          </div>

          {chatOpen && (
            <div className="chat-panel" id="gomoku-chat-panel">
              <div className="chat-messages" aria-live="polite">
                {chatMessages.length === 0 ? (
                  <div className="chat-empty">
                    <MessageCircle size={20} />
                    <p>{isOnline ? "已经连上了，先和对手打个招呼吧。" : "对局建立后，消息和表情都会通过 P2P 发送。"}</p>
                  </div>
                ) : (
                  chatMessages.map((chatMessage) => (
                    <div className={`chat-message ${chatMessage.sender === "self" ? "from-self" : "from-opponent"}`} key={chatMessage.id}>
                      <small>{chatMessage.sender === "self" ? "你" : opponentLabel}</small>
                      <span>{chatMessage.text}</span>
                    </div>
                  ))
                )}
              </div>

              <div className="emoji-toolbar">
                <button className={`emoji-toggle ${emojiOpen ? "active" : ""}`} type="button" disabled={!isOnline} onClick={() => setEmojiOpen((open) => !open)}>
                  <SmilePlus size={15} /> 快捷表情
                </button>
                {emojiOpen && (
                  <div className="emoji-picker" aria-label="快捷表情">
                    {QUICK_EMOJIS.map((emoji) => (
                      <button type="button" key={emoji} aria-label={`发送${emoji}`} onClick={() => sendEmoji(emoji)}>{emoji}</button>
                    ))}
                  </div>
                )}
              </div>

              <form
                className="chat-compose"
                onSubmit={(event) => {
                  event.preventDefault();
                  sendChat();
                }}
              >
                <input
                  aria-label="聊天消息"
                  value={chatInput}
                  maxLength={120}
                  disabled={!isOnline}
                  placeholder={isOnline ? "输入消息，按回车发送" : "等待建立 P2P 连接"}
                  onChange={(event) => setChatInput(event.target.value)}
                />
                <button type="submit" aria-label="发送消息" disabled={!isOnline || !chatInput.trim()}><Send size={16} /></button>
              </form>
            </div>
          )}
        </section>
        </div>
      </section>

      <footer className="page-footer">
        <span>一个房间，只留两位棋手。</span>
        <span><span className="footer-key">P2P</span> · 无需注册 · 即开即玩</span>
      </footer>
    </main>
  );
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
    id: "reversi",
    name: "黑白棋",
    description: "共享同一套 P2P 匹配与房间能力。",
    players: "2 人",
    status: "即将加入",
    available: false,
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
          <div><strong>1</strong><span>款可游玩</span></div>
          <div><strong>P2P</strong><span>对局直连</span></div>
          <div><strong>0</strong><span>注册步骤</span></div>
        </div>
      </section>

      <section className="game-catalog" aria-label="小游戏列表">
        {GAME_CATALOG.map((game) => game.available ? (
          <button className="game-card game-card-available" type="button" key={game.id} onClick={() => onSelect("gomoku")}>
            <div className="game-card-visual gomoku-card-visual" aria-hidden="true">
              <div className="gomoku-mini-board">
                <span className="mini-stone mini-black stone-one" />
                <span className="mini-stone mini-white stone-two" />
                <span className="mini-stone mini-black stone-three" />
                <span className="mini-stone mini-white stone-four" />
                <span className="mini-stone mini-black stone-five" />
              </div>
              <span className="available-badge"><span />在线</span>
            </div>
            <div className="game-card-content">
              <div className="game-card-title">
                <span className="game-icon"><Grid3X3 size={20} /></span>
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
    const syncRoute = () => setSelectedGame(window.location.hash === "#gomoku" ? "gomoku" : null);
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

  return selectedGame === "gomoku" ? <GomokuGame onBack={backToHub} /> : <GameHub onSelect={openGame} />;
}
