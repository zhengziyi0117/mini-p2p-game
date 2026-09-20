"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, MessageCircle, Send, SmilePlus } from "lucide-react";

export const QUICK_EMOJIS = ["👏", "😂", "😮", "👍", "🤔", "🔥", "🎉", "🙏"];

type ChatMessage = { id: string; sender: "self" | "opponent"; text: string };
type EmojiBurst = { emoji: string; sender: "self" | "opponent" };

type UseGameChatOptions = {
  /** Sends one P2P payload; returns false when the channel is not open yet. */
  send: (payload: Record<string, unknown>) => boolean;
  onNotice: (text: string) => void;
};

function messageId(sender: "self" | "opponent") {
  return `${sender}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Shared chat + emoji state for every game. Chat is presentation-only and never
 *  touches authoritative game state, so it lives outside each game's reducer. */
export function useGameChat({ send, onNotice }: UseGameChatOptions) {
  const [chatOpen, setChatOpen] = useState(true);
  const [chatInput, setChatInput] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [unreadChat, setUnreadChat] = useState(0);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [lastEmoji, setLastEmoji] = useState<EmojiBurst | null>(null);

  const chatOpenRef = useRef(true);
  const emojiTimerRef = useRef<number | null>(null);
  const sendRef = useRef(send);
  const noticeRef = useRef(onNotice);

  useEffect(() => {
    sendRef.current = send;
    noticeRef.current = onNotice;
  });

  useEffect(() => () => {
    if (emojiTimerRef.current) window.clearTimeout(emojiTimerRef.current);
  }, []);

  const showEmoji = useCallback((emoji: string, sender: "self" | "opponent") => {
    setLastEmoji({ emoji, sender });
    if (emojiTimerRef.current) window.clearTimeout(emojiTimerRef.current);
    emojiTimerRef.current = window.setTimeout(() => {
      setLastEmoji(null);
      emojiTimerRef.current = null;
    }, 1800);
  }, []);

  const toggleChat = useCallback((nextOpen: boolean) => {
    chatOpenRef.current = nextOpen;
    setChatOpen(nextOpen);
    if (nextOpen) setUnreadChat(0);
  }, []);

  const sendChat = useCallback(() => {
    const text = chatInput.trim().replace(/\s+/g, " ").slice(0, 120);
    if (!text) return;
    if (!sendRef.current({ type: "chat", text })) {
      noticeRef.current("建立直连后才能聊天。 ");
      return;
    }
    setChatMessages((current) => [...current, { id: messageId("self"), sender: "self", text }]);
    setChatInput("");
  }, [chatInput]);

  const sendEmoji = useCallback(
    (emoji: string) => {
      if (!sendRef.current({ type: "emoji", emoji })) {
        noticeRef.current("建立直连后才能发送表情。 ");
        return;
      }
      showEmoji(emoji, "self");
      setEmojiOpen(false);
    },
    [showEmoji],
  );

  const receiveChat = useCallback((text: unknown) => {
    if (typeof text !== "string") return;
    setChatMessages((current) => [...current, { id: messageId("opponent"), sender: "opponent", text: text.slice(0, 120) }]);
    if (!chatOpenRef.current) setUnreadChat((current) => current + 1);
  }, []);

  const receiveEmoji = useCallback(
    (emoji: unknown) => {
      if (typeof emoji !== "string" || !QUICK_EMOJIS.includes(emoji)) return;
      showEmoji(emoji, "opponent");
    },
    [showEmoji],
  );

  const resetChat = useCallback(() => {
    setChatMessages([]);
    setChatInput("");
    setUnreadChat(0);
    setEmojiOpen(false);
    setLastEmoji(null);
    chatOpenRef.current = true;
    setChatOpen(true);
  }, []);

  return {
    chatOpen,
    toggleChat,
    chatInput,
    setChatInput,
    chatMessages,
    unreadChat,
    emojiOpen,
    setEmojiOpen,
    lastEmoji,
    showEmoji,
    sendChat,
    sendEmoji,
    receiveChat,
    receiveEmoji,
    resetChat,
  };
}

export type GameChatState = ReturnType<typeof useGameChat>;

type GameChatProps = {
  panelId: string;
  isOnline: boolean;
  opponentLabel: string;
  chat: GameChatState;
};

export function GameChat({ panelId, isOnline, opponentLabel, chat }: GameChatProps) {
  return (
    <section className={`chat-dock independent-chat ${chat.chatOpen ? "chat-open" : ""}`} aria-label="对局聊天">
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
          {chat.unreadChat > 0 && <b className="chat-unread">{chat.unreadChat > 9 ? "9+" : chat.unreadChat}</b>}
          <button
            className="chat-collapse"
            type="button"
            aria-label={chat.chatOpen ? "收起聊天" : "展开聊天"}
            aria-expanded={chat.chatOpen}
            aria-controls={panelId}
            onClick={() => chat.toggleChat(!chat.chatOpen)}
          >
            {chat.chatOpen ? <ChevronUp size={17} /> : <ChevronDown size={17} />}
          </button>
        </div>
      </div>

      {chat.chatOpen && (
        <div className="chat-panel" id={panelId}>
          <div className="chat-messages" aria-live="polite">
            {chat.chatMessages.length === 0 ? (
              <div className="chat-empty">
                <MessageCircle size={20} />
                <p>{isOnline ? "已经连上了，先和对手打个招呼吧。" : "对局建立后，消息和表情都会通过 P2P 发送。"}</p>
              </div>
            ) : (
              chat.chatMessages.map((chatMessage) => (
                <div className={`chat-message ${chatMessage.sender === "self" ? "from-self" : "from-opponent"}`} key={chatMessage.id}>
                  <small>{chatMessage.sender === "self" ? "你" : opponentLabel}</small>
                  <span>{chatMessage.text}</span>
                </div>
              ))
            )}
          </div>

          <div className="emoji-toolbar">
            <button className={`emoji-toggle ${chat.emojiOpen ? "active" : ""}`} type="button" disabled={!isOnline} onClick={() => chat.setEmojiOpen(!chat.emojiOpen)}>
              <SmilePlus size={15} /> 快捷表情
            </button>
            {chat.emojiOpen && (
              <div className="emoji-picker" aria-label="快捷表情">
                {QUICK_EMOJIS.map((emoji) => (
                  <button type="button" key={emoji} aria-label={`发送${emoji}`} onClick={() => chat.sendEmoji(emoji)}>{emoji}</button>
                ))}
              </div>
            )}
          </div>

          <form
            className="chat-compose"
            onSubmit={(event) => {
              event.preventDefault();
              chat.sendChat();
            }}
          >
            <input
              aria-label="聊天消息"
              value={chat.chatInput}
              maxLength={120}
              disabled={!isOnline}
              placeholder={isOnline ? "输入消息，按回车发送" : "等待建立 P2P 连接"}
              onChange={(event) => chat.setChatInput(event.target.value)}
            />
            <button type="submit" aria-label="发送消息" disabled={!isOnline || !chat.chatInput.trim()}><Send size={16} /></button>
          </form>
        </div>
      )}
    </section>
  );
}
