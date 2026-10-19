import { createRoot } from "react-dom/client";
import { App } from "./App";
import { p2pMediaAvailable } from "./net/p2pMedia";

// 動画の P2P 配信に使う Service Worker を、起動時に登録しておく (最初の動画で待たないように)
void p2pMediaAvailable();

createRoot(document.getElementById("root")!).render(<App />);
