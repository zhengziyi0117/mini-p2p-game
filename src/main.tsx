import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import Home from "./page";
import "./styles.css";

window.__P2P_SIGNAL_ORIGIN__ = "https://p2p-gomoku.zhengziyi0117.chatgpt.site";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Home />
  </StrictMode>,
);
