"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  Check,
  CircleHelp,
  Copy,
  KeyRound,
  LoaderCircle,
  LogOut,
  Radio,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Swords,
  Users,
} from "lucide-react";
import { GameChat, type GameChatState } from "./game-chat";
import type { MatchPhase, P2PMatchApi, PeerMessage } from "./use-p2p-match";

const NICKNAME_KEY = "p2p-nickname";

/** Phase pill text. Every game finishes with the same word for it. */
export function phaseLabelFor(phase: MatchPhase, finished: boolean) {
  if (finished) return "已结束";
  if (phase === "playing") return "对局中";
  if (phase === "matching") return "匹配中";
  if (phase === "room-waiting") return "等人加入";
  if (phase === "connecting") return "连接中";
  if (phase === "error") return "需要重试";
  return "等待开始";
}

/** Status line for every phase except a finished game, which each game words
 *  for itself ("被炸飞了" reads better than "你输了"). */
export function phaseStatusFor(phase: MatchPhase) {
  if (phase === "idle") return "准备好就开始匹配";
  if (phase === "matching") return "正在寻找对手…";
  if (phase === "room-waiting") return "房间已创建，等待加入";
  if (phase === "connecting") return "对手已找到，建立直连…";
  if (phase === "error") return "连接中断了";
  return "对局进行中";
}

/** Every game words its phases differently ("轮到你落子" vs "等待对手"), so the
 *  shell takes the strings rather than guessing them. */
export type ShellStatus = {
  /** Overlay headline, and the turn card's fallback when nothing is live. */
  label: string;
  /** Phase pill text. */
  pillLabel: string;
  /** Turn card text while the game is live. */
  turn: string;
};

export type Rematch = ReturnType<typeof useRematch>;

/** Rematch handshake shared by every game. A crossed pair of requests resolves
 *  itself, so both players mashing the button still starts exactly one round. */
export function useRematch({ send, onStart }: { send: (payload: PeerMessage) => boolean; onStart: () => void }) {
  const [pending, setPending] = useState<"outgoing" | "incoming" | null>(null);
  const pendingRef = useRef<"outgoing" | "incoming" | null>(null);
  const onStartRef = useRef(onStart);

  useEffect(() => {
    onStartRef.current = onStart;
  }, [onStart]);

  const setPendingState = useCallback((next: "outgoing" | "incoming" | null) => {
    pendingRef.current = next;
    setPending(next);
  }, []);

  const request = useCallback(() => {
    if (pendingRef.current) return false;
    setPendingState("outgoing");
    send({ type: "rematch-request" });
    return true;
  }, [send, setPendingState]);

  const respond = useCallback(
    (accepted: boolean) => {
      if (pendingRef.current !== "incoming") return;
      send({ type: "rematch-response", accepted });
      if (accepted) onStartRef.current();
      else setPendingState(null);
    },
    [send, setPendingState],
  );

  /** Returns true when the message belonged to the rematch handshake. */
  const handleMessage = useCallback(
    (message: PeerMessage) => {
      if (message.type === "rematch-request") {
        if (pendingRef.current === "outgoing") {
          send({ type: "rematch-response", accepted: true });
          onStartRef.current();
        } else {
          setPendingState("incoming");
        }
        return true;
      }
      if (message.type === "rematch-response" && pendingRef.current === "outgoing") {
        if (message.accepted === true) onStartRef.current();
        else setPendingState(null);
        return true;
      }
      return false;
    },
    [send, setPendingState],
  );

  const reset = useCallback(() => setPendingState(null), [setPendingState]);

  return { pending, request, respond, handleMessage, reset };
}

export function RoundResult({
  round,
  headline,
  blurb,
  tone,
  isOnline,
  rematch,
}: {
  round: number;
  headline: string;
  blurb: string;
  tone: "win" | "loss" | "draw";
  isOnline: boolean;
  rematch: Rematch;
}) {
  const toneClass = tone === "draw" ? "result-draw" : tone === "win" ? "result-win" : "result-loss";
  return (
    <section className={`round-result ${toneClass}`} aria-live="polite">
      <div className="round-result-copy">
        <span className="result-icon"><Swords size={19} /></span>
        <div>
          <p>第 {round} 局结束</p>
          <h2>{headline}</h2>
          <span>{blurb}</span>
        </div>
      </div>
      <div className="round-result-actions">
        {rematch.pending === "incoming" ? (
          <>
            <button className="result-secondary" type="button" onClick={() => rematch.respond(false)}>稍后</button>
            <button className="result-primary" type="button" onClick={() => rematch.respond(true)}>接受再来一局</button>
          </>
        ) : (
          <button className="result-primary" type="button" disabled={!isOnline || rematch.pending === "outgoing"} onClick={rematch.request}>
            <RotateCcw size={16} />
            {rematch.pending === "outgoing" ? "等待对手确认" : "和同一位对手再来一局"}
          </button>
        )}
      </div>
    </section>
  );
}

type GameShellProps = {
  onBack: () => void;
  title: string;
  headline: string;
  tip: string;
  /** Footer notes; the live connection state is appended to them. */
  footerNotes: string[];
  chatPanelId: string;
  status: ShellStatus;
  p2p: P2PMatchApi;
  chat: GameChatState;
  round: number;
  finished: boolean;
  /** Overlay sub-line while the two peers are shaking hands. */
  connectHint?: string;
  board: ReactNode;
  result?: ReactNode;
  /** Extra sidebar blocks, such as an undo button. */
  panelExtras?: ReactNode;
};

export function GameShell({
  onBack,
  title,
  headline,
  tip,
  footerNotes,
  chatPanelId,
  status,
  p2p,
  chat,
  round,
  finished,
  connectHint = "双方建立直连后开始。",
  board,
  result,
  panelExtras,
}: GameShellProps) {
  const [nickname, setNickname] = useState(() => (typeof window === "undefined" ? "" : window.localStorage.getItem(NICKNAME_KEY) ?? ""));
  const [mode, setMode] = useState<"quick" | "room">("quick");
  const [roomCode, setRoomCode] = useState("");

  const currentMatch = p2p.match;
  const isBusy = p2p.phase === "matching" || p2p.phase === "room-waiting" || p2p.phase === "connecting";
  const locked = isBusy || p2p.phase === "playing";
  const opponentLabel = currentMatch?.opponentName ?? "等待对手";

  const withNickname = useCallback(
    async (run: (name: string) => Promise<void>) => {
      const cleanName = nickname.trim().replace(/\s+/g, " ").slice(0, 18);
      if (!cleanName) {
        p2p.setMessage("先给自己取一个昵称吧。 ");
        return;
      }
      window.localStorage.setItem(NICKNAME_KEY, cleanName);
      setNickname(cleanName);
      await run(cleanName);
    },
    [nickname, p2p],
  );

  const copyRoomCode = useCallback(async () => {
    if (!p2p.activeRoomCode) return;
    try {
      await navigator.clipboard.writeText(p2p.activeRoomCode);
      p2p.setMessage("房间号已复制，发给朋友就可以开始。 ");
    } catch {
      p2p.setMessage(`请手动复制房间号：${p2p.activeRoomCode} `);
    }
  }, [p2p]);

  const overlayHint =
    p2p.phase === "idle" ? "先输入昵称，再点击右侧开始匹配。"
      : p2p.phase === "matching" ? "匹配成功后会自动进入对局。"
        : p2p.phase === "connecting" ? connectHint
          : p2p.phase === "error" ? "换个网络或重新匹配试试。" : "";

  return (
    <main className="game-shell">
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
              <p className="brand-name">{title}</p>
              <p className="brand-caption">P2P GAME ARCADE</p>
            </div>
          </div>
        </div>
        <div className="topbar-note">
          <span className="live-dot" />
          <span>对局不经过服务器</span>
        </div>
      </header>

      <section className="game-layout">
        <div className="board-column">
          <div className="eyebrow-row">
            <div>
              <p className="eyebrow">ONLINE MATCH · ROUND {round}</p>
              <h1>{headline}</h1>
            </div>
            <div className={`phase-pill phase-${finished ? "finished" : p2p.phase}`}>
              <span className="phase-dot" />
              {status.pillLabel}
            </div>
          </div>

          <div className="board-stage">
            {board}
            {chat.lastEmoji && (
              <div className={`emoji-burst emoji-${chat.lastEmoji.sender}`} aria-live="polite">
                <span>{chat.lastEmoji.emoji}</span>
                <small>{chat.lastEmoji.sender === "self" ? "你" : opponentLabel}</small>
              </div>
            )}
            {p2p.phase !== "playing" && (
              <div className={`board-overlay overlay-${p2p.phase}`}>
                {p2p.phase === "idle" && <Sparkles size={20} />}
                {p2p.phase === "matching" && <LoaderCircle className="spin" size={22} />}
                {p2p.phase === "room-waiting" && <KeyRound className="pulse" size={21} />}
                {p2p.phase === "connecting" && <Radio className="pulse" size={22} />}
                {p2p.phase === "error" && <CircleHelp size={21} />}
                <strong>{status.label}</strong>
                <span>
                  {p2p.phase === "room-waiting"
                    ? <>把房间号 <b className="overlay-room-code">{p2p.activeRoomCode}</b> 发给朋友。</>
                    : overlayHint}
                </span>
              </div>
            )}
          </div>

          {result}

          <div className="board-footer">
            {footerNotes.flatMap((note) => [
              <span key={note}>{note}</span>,
              <span className="footer-separator" key={`${note}-separator`}>·</span>,
            ])}
            <span>{p2p.isOnline ? "WebRTC 直连" : "等待连接"}</span>
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
                  <button className="room-action room-create" type="button" disabled={locked} onClick={() => void withNickname(p2p.createRoom)}>
                    <KeyRound size={16} /> 创建房间
                  </button>
                  <button
                    className="room-action room-join"
                    type="button"
                    disabled={locked || roomCode.trim().length < 4}
                    onClick={() => void withNickname((name) => p2p.joinRoom(name, roomCode))}
                  >
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
              <span className={`color-chip ${currentMatch ? (currentMatch.color === "black" ? "chip-white" : "chip-black") : "chip-neutral"}`}>
                {currentMatch?.color === "black" ? "白" : currentMatch?.color === "white" ? "黑" : "—"}
              </span>
            </div>

            <div className="turn-card">
              <div className={`turn-stone ${currentMatch?.color ?? "black"}`} aria-hidden="true" />
              <div>
                <span className="player-label">当前状态</span>
                <strong>{p2p.phase === "playing" && !finished ? status.turn : status.label}</strong>
              </div>
              <span className={`connection-label ${p2p.isOnline ? "online" : ""}`}>
                <span />
                {p2p.isOnline ? "已直连" : "未连接"}
              </span>
            </div>

            {panelExtras}

            {mode === "quick" && !finished && (
              <button className="primary-button" type="button" disabled={locked} onClick={() => void withNickname(p2p.startMatching)}>
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

            <p className="status-message" aria-live="polite">{p2p.message}</p>

            <div className="trust-note">
              <ShieldCheck size={17} />
              <span>只用信令服务器撮合，对局数据通过 WebRTC 端到端传输。</span>
            </div>
            <p className="tip-note"><span>TIP</span> {tip}</p>
          </aside>

          <GameChat panelId={chatPanelId} isOnline={p2p.isOnline} opponentLabel={opponentLabel} chat={chat} />
        </div>
      </section>

      <footer className="page-footer">
        <span>一个房间，只留两位玩家。</span>
        <span><span className="footer-key">P2P</span> · 无需注册 · 即开即玩</span>
      </footer>
    </main>
  );
}
