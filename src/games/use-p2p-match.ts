"use client";

import { useCallback, useEffect, useRef, useState } from "react";

declare global {
  interface Window {
    __P2P_SIGNAL_ORIGIN__?: string;
  }
}

export type MatchPhase = "idle" | "matching" | "room-waiting" | "connecting" | "playing" | "error";
export type PlayerColor = "black" | "white";

export type P2PMatch = {
  matchId: string;
  gameId: string;
  playerId: string;
  opponentId: string;
  opponentName: string;
  color: PlayerColor;
  roomCode?: string;
};

export type PeerMessage = Record<string, unknown> & {
  type?: string;
  gameId?: string;
  roundId?: number;
  seq?: number;
};

/** `reliable` is ordered and retransmitted (moves, chat, rematch).
 *  `state` and `input` are lossy and unordered, for anything disposable. */
export type SendLane = "reliable" | "state" | "input";

type MatchResponse = {
  status?: string;
  roomCode?: string;
  match?: Partial<P2PMatch>;
  error?: string;
};

type UseP2PMatchOptions = {
  gameId: string;
  onMessage?: (message: PeerMessage) => void;
  onConnected?: (match: P2PMatch) => void;
  onDisconnected?: () => void;
  onReset?: () => void;
};

const STUN_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun.cloudflare.com:3478" },
];

function delay(milliseconds: number) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function makePlayerId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `player-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

function apiUrl(path: string) {
  if (typeof window === "undefined") return path;
  const origin = window.__P2P_SIGNAL_ORIGIN__?.replace(/\/$/, "") ?? "";
  return `${origin}${path}`;
}

function cleanNickname(value: string) {
  return value.trim().replace(/\s+/g, " ").slice(0, 18);
}

function normalizeMatch(input: Partial<P2PMatch>, gameId: string): P2PMatch {
  return {
    matchId: String(input.matchId ?? ""),
    gameId: String(input.gameId ?? gameId),
    playerId: String(input.playerId ?? ""),
    opponentId: String(input.opponentId ?? ""),
    opponentName: String(input.opponentName ?? "对手"),
    color: input.color === "white" ? "white" : "black",
    roomCode: input.roomCode,
  };
}

export type P2PMatchApi = ReturnType<typeof useP2PMatch>;

export function useP2PMatch({ gameId, onMessage, onConnected, onDisconnected, onReset }: UseP2PMatchOptions) {
  const [phase, setPhaseState] = useState<MatchPhase>("idle");
  const [match, setMatch] = useState<P2PMatch | null>(null);
  const [activeRoomCode, setActiveRoomCode] = useState("");
  const [isOnline, setIsOnline] = useState(false);
  const [message, setMessage] = useState("输入昵称，和朋友开一局。 ");

  const playerIdRef = useRef("");
  const phaseRef = useRef<MatchPhase>("idle");
  const matchRef = useRef<P2PMatch | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const channelRef = useRef<RTCDataChannel | null>(null);
  const stateChannelRef = useRef<RTCDataChannel | null>(null);
  const inputChannelRef = useRef<RTCDataChannel | null>(null);
  const signalCursorRef = useRef(0);
  const stopSignalPollingRef = useRef(false);
  const matchPollingRef = useRef(false);
  const callbacksRef = useRef({ onMessage, onConnected, onDisconnected, onReset });

  useEffect(() => {
    callbacksRef.current = { onMessage, onConnected, onDisconnected, onReset };
  }, [onConnected, onDisconnected, onMessage, onReset]);

  useEffect(() => {
    const storageKey = `${gameId}-player-id`;
    const nextPlayerId = window.sessionStorage.getItem(storageKey) ?? makePlayerId();
    window.sessionStorage.setItem(storageKey, nextPlayerId);
    playerIdRef.current = nextPlayerId;
  }, [gameId]);

  const setPhase = useCallback((nextPhase: MatchPhase) => {
    phaseRef.current = nextPhase;
    setPhaseState(nextPhase);
  }, []);

  const closeTransport = useCallback(() => {
    stopSignalPollingRef.current = true;
    channelRef.current?.close();
    stateChannelRef.current?.close();
    inputChannelRef.current?.close();
    peerRef.current?.close();
    channelRef.current = null;
    stateChannelRef.current = null;
    inputChannelRef.current = null;
    peerRef.current = null;
    setIsOnline(false);
  }, []);

  const send = useCallback((payload: PeerMessage, options?: { lane?: SendLane }) => {
    // Games may name their lanes explicitly; the `-state` / `-input` suffix is
    // the shorthand the realtime games already use.
    const lane: SendLane =
      options?.lane ?? (payload.type?.endsWith("-state") ? "state" : payload.type?.endsWith("-input") ? "input" : "reliable");
    const channel = lane === "state" ? stateChannelRef.current : lane === "input" ? inputChannelRef.current : channelRef.current;
    if (channel?.readyState !== "open") return false;
    // Realtime packets are disposable. Never queue stale snapshots or inputs
    // behind congestion and make either player react to the past.
    const bufferLimit = lane === "state" ? 96 * 1024 : 8 * 1024;
    if (lane !== "reliable" && channel.bufferedAmount > bufferLimit) return false;
    channel.send(JSON.stringify({ gameId, ...payload }));
    return true;
  }, [gameId]);

  /** Turn-based games swap sides between rounds so the same player does not
   *  always move first. The channel assignment is unaffected — DataChannels are
   *  negotiated once, and both peers flip deterministically. */
  const swapColor = useCallback(() => {
    setMatch((current) => {
      if (!current) return current;
      const next: P2PMatch = { ...current, color: current.color === "black" ? "white" : "black" };
      matchRef.current = next;
      return next;
    });
  }, []);

  const sendSignal = useCallback(async (nextMatch: P2PMatch, type: "offer" | "answer", description: RTCSessionDescriptionInit) => {
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

  const attachChannel = useCallback((channel: RTCDataChannel, nextMatch: P2PMatch) => {
    const isStateChannel = channel.label === `${gameId}-state`;
    const isInputChannel = channel.label === `${gameId}-input`;
    const isRealtimeChannel = isStateChannel || isInputChannel;
    if (isStateChannel) stateChannelRef.current = channel;
    else if (isInputChannel) inputChannelRef.current = channel;
    else channelRef.current = channel;

    channel.onopen = () => {
      if (matchRef.current?.matchId !== nextMatch.matchId || isRealtimeChannel) return;
      setIsOnline(true);
      setPhase("playing");
      setMessage("直连已建立，可以开始玩了。 ");
      stopSignalPollingRef.current = true;
      callbacksRef.current.onConnected?.(nextMatch);
    };
    channel.onmessage = (event) => {
      try {
        const payload = JSON.parse(String(event.data)) as PeerMessage;
        if (!payload.gameId || payload.gameId === gameId) callbacksRef.current.onMessage?.(payload);
      } catch {
        setMessage("收到了一条无法识别的对局消息。 ");
      }
    };
    channel.onclose = () => {
      if (matchRef.current?.matchId !== nextMatch.matchId) return;
      if (isRealtimeChannel) return;
      setIsOnline(false);
      if (phaseRef.current === "playing" || phaseRef.current === "connecting") {
        setPhase("error");
        setMessage("对手的连接已断开，可以重新匹配。 ");
        callbacksRef.current.onDisconnected?.();
      }
    };
    channel.onerror = () => {
      if (matchRef.current?.matchId !== nextMatch.matchId) return;
      if (isRealtimeChannel) return;
      setIsOnline(false);
      setPhase("error");
      setMessage("P2P 连接失败，可能是当前网络限制了直连。 ");
      callbacksRef.current.onDisconnected?.();
    };
  }, [gameId, setPhase]);

  const connectToMatch = useCallback(async (rawMatch: Partial<P2PMatch>) => {
    const nextMatch = normalizeMatch(rawMatch, gameId);
    closeTransport();
    setPhase("connecting");
    setMatch(nextMatch);
    matchRef.current = nextMatch;
    if (nextMatch.roomCode) setActiveRoomCode(nextMatch.roomCode);
    signalCursorRef.current = 0;
    stopSignalPollingRef.current = false;
    setMessage(`已匹配到 ${nextMatch.opponentName}，正在建立 P2P 直连… `);

    const peer = new RTCPeerConnection({ iceServers: STUN_SERVERS });
    peerRef.current = peer;
    peer.onconnectionstatechange = () => {
      if (["failed", "closed"].includes(peer.connectionState) && phaseRef.current === "connecting") {
        setPhase("error");
        setMessage("没有建立起 P2P 直连，请重新匹配。 ");
      }
    };

    if (nextMatch.color === "black") {
      attachChannel(peer.createDataChannel(gameId), nextMatch);
      attachChannel(peer.createDataChannel(`${gameId}-state`, { ordered: false, maxRetransmits: 0 }), nextMatch);
      attachChannel(peer.createDataChannel(`${gameId}-input`, { ordered: false, maxRetransmits: 0 }), nextMatch);
    } else {
      peer.ondatachannel = (event) => attachChannel(event.channel, nextMatch);
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
            const data = (await result.json()) as { signals?: Array<{ id: number; type: string; payload: string }> };
            for (const signal of data.signals ?? []) {
              signalCursorRef.current = Math.max(signalCursorRef.current, signal.id);
              await handleSignal(signal);
            }
          }
        } catch {
          // A later poll can recover from a transient network failure.
        }
        if (!stopSignalPollingRef.current) await delay(700);
      }
    };
    void pollSignals();

    if (nextMatch.color === "black") {
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      await waitForIce(peer);
      if (peer.localDescription) await sendSignal(nextMatch, "offer", peer.localDescription);
    }
  }, [attachChannel, closeTransport, gameId, sendSignal, setPhase, waitForIce]);

  const monitorMatch = useCallback(async (nextPlayerId: string) => {
    matchPollingRef.current = true;
    try {
      while (matchPollingRef.current && (phaseRef.current === "matching" || phaseRef.current === "room-waiting")) {
        const result = await fetch(apiUrl(`/api/match?gameId=${encodeURIComponent(gameId)}&playerId=${encodeURIComponent(nextPlayerId)}`), { cache: "no-store" });
        if (!result.ok) throw new Error("匹配服务暂时不可用。 ");
        const data = (await result.json()) as { match?: Partial<P2PMatch> };
        if (data.match) {
          matchPollingRef.current = false;
          await connectToMatch(data.match);
          return;
        }
        await delay(1000);
      }
    } catch (error) {
      matchPollingRef.current = false;
      setPhase("error");
      setMessage(error instanceof Error ? error.message : "匹配服务暂时不可用。 ");
    }
  }, [connectToMatch, gameId, setPhase]);

  const prepareNewMatch = useCallback(() => {
    matchPollingRef.current = false;
    closeTransport();
    callbacksRef.current.onReset?.();
    setMatch(null);
    matchRef.current = null;
    setActiveRoomCode("");
    setPhase("matching");
  }, [closeTransport, setPhase]);

  const startMatching = useCallback(async (nickname: string) => {
    const cleanName = cleanNickname(nickname);
    if (!cleanName) {
      setMessage("先给自己取一个昵称吧。 ");
      return;
    }
    window.localStorage.setItem(`${gameId}-nickname`, cleanName);
    prepareNewMatch();
    setMessage("正在寻找一位在线玩家… ");
    try {
      await fetch(apiUrl(`/api/match?playerId=${encodeURIComponent(playerIdRef.current)}`), { method: "DELETE" }).catch(() => undefined);
      const result = await fetch(apiUrl("/api/match"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "join", gameId, playerId: playerIdRef.current, nickname: cleanName }),
      });
      const data = (await result.json()) as MatchResponse;
      if (!result.ok) throw new Error(data.error ?? "匹配服务暂时不可用。 ");
      if (data.match) await connectToMatch(data.match);
      else void monitorMatch(playerIdRef.current);
    } catch (error) {
      setPhase("error");
      setMessage(error instanceof Error ? error.message : "匹配服务暂时不可用。 ");
    }
  }, [connectToMatch, gameId, monitorMatch, prepareNewMatch, setPhase]);

  const createRoom = useCallback(async (nickname: string) => {
    const cleanName = cleanNickname(nickname);
    if (!cleanName) {
      setMessage("先给自己取一个昵称吧。 ");
      return;
    }
    window.localStorage.setItem(`${gameId}-nickname`, cleanName);
    prepareNewMatch();
    setMessage("正在创建房间… ");
    try {
      await fetch(apiUrl(`/api/match?playerId=${encodeURIComponent(playerIdRef.current)}`), { method: "DELETE" }).catch(() => undefined);
      const result = await fetch(apiUrl("/api/match"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create_room", gameId, playerId: playerIdRef.current, nickname: cleanName }),
      });
      const data = (await result.json()) as MatchResponse;
      if (!result.ok || !data.roomCode) throw new Error(data.error ?? "房间创建失败，请稍后重试。 ");
      setActiveRoomCode(data.roomCode);
      setPhase("room-waiting");
      setMessage(`房间号 ${data.roomCode} 已创建，等待朋友加入。 `);
      void monitorMatch(playerIdRef.current);
    } catch (error) {
      setPhase("error");
      setMessage(error instanceof Error ? error.message : "房间创建失败，请稍后重试。 ");
    }
  }, [gameId, monitorMatch, prepareNewMatch, setPhase]);

  const joinRoom = useCallback(async (nickname: string, requestedRoomCode: string) => {
    const cleanName = cleanNickname(nickname);
    const cleanCode = requestedRoomCode.trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
    if (!cleanName) {
      setMessage("先给自己取一个昵称吧。 ");
      return;
    }
    if (!/^[A-Z0-9]{4,8}$/.test(cleanCode)) {
      setMessage("请输入有效的房间号。 ");
      return;
    }
    window.localStorage.setItem(`${gameId}-nickname`, cleanName);
    prepareNewMatch();
    setActiveRoomCode(cleanCode);
    setMessage(`正在加入房间 ${cleanCode}… `);
    try {
      await fetch(apiUrl(`/api/match?playerId=${encodeURIComponent(playerIdRef.current)}`), { method: "DELETE" }).catch(() => undefined);
      const result = await fetch(apiUrl("/api/match"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "join_room", gameId, roomCode: cleanCode, playerId: playerIdRef.current, nickname: cleanName }),
      });
      const data = (await result.json()) as MatchResponse;
      if (!result.ok) throw new Error(data.error ?? "加入房间失败，请检查房间号。 ");
      if (data.match) await connectToMatch(data.match);
      else {
        setPhase("room-waiting");
        setMessage(`房间号 ${cleanCode} 仍在等待加入。 `);
        void monitorMatch(playerIdRef.current);
      }
    } catch (error) {
      setPhase("error");
      setMessage(error instanceof Error ? error.message : "加入房间失败，请检查房间号。 ");
    }
  }, [connectToMatch, gameId, monitorMatch, prepareNewMatch, setPhase]);

  const cancel = useCallback(async () => {
    matchPollingRef.current = false;
    closeTransport();
    await fetch(apiUrl(`/api/match?playerId=${encodeURIComponent(playerIdRef.current)}`), { method: "DELETE" }).catch(() => undefined);
    callbacksRef.current.onReset?.();
    setMatch(null);
    matchRef.current = null;
    setActiveRoomCode("");
    setPhase("idle");
    setMessage("随时可以再开一局。 ");
  }, [closeTransport, setPhase]);

  useEffect(() => {
    return () => {
      matchPollingRef.current = false;
      stopSignalPollingRef.current = true;
      channelRef.current?.close();
      stateChannelRef.current?.close();
      inputChannelRef.current?.close();
      peerRef.current?.close();
      channelRef.current = null;
      stateChannelRef.current = null;
      inputChannelRef.current = null;
      peerRef.current = null;
    };
  }, []);

  return {
    phase,
    match,
    activeRoomCode,
    isOnline,
    message,
    setMessage,
    isHost: match?.color === "black",
    send,
    swapColor,
    startMatching,
    createRoom,
    joinRoom,
    cancel,
    closeTransport,
  };
}
