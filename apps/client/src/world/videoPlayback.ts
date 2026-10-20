import { create } from "zustand";
import { sendVideoControl, showNotice } from "../net/connection";

interface VideoPlaybackState {
  /** 再生中の動画 (オブジェクト ID ごと)。 */
  playing: Record<string, boolean>;
}

/**
 * 3D 空間に置かれた動画の再生状態 (このクライアント内)。
 * 実際の再生 / 一時停止はサーバーに送られ、全員に配られる (`sendVideoControl`)。
 */
export const useVideoPlayback = create<VideoPlaybackState>(() => ({ playing: {} }));

/** オブジェクト ID ごとの、動画の要素 (サムネイルの作成と再生に使う)。 */
const elements = new Map<string, HTMLVideoElement>();

if (import.meta.env.DEV) {
  (window as unknown as { __videoPlayback: unknown }).__videoPlayback = { elements };
}

export function registerVideoElement(id: string, element: HTMLVideoElement | null): void {
  if (element) elements.set(id, element);
  else elements.delete(id);
}

function setPlaying(id: string, playing: boolean): void {
  useVideoPlayback.setState((s) => ({ playing: { ...s.playing, [id]: playing } }));
}

export function isPlaying(id: string): boolean {
  return useVideoPlayback.getState().playing[id] === true;
}

/** メタデータがまだでも、安全に再生位置を設定する (設定できなければ、読み込み後に合わせる)。 */
function seek(video: HTMLVideoElement, time: number): void {
  const target = Math.max(0, time);
  try {
    video.currentTime = target;
  } catch {
    video.addEventListener(
      "loadedmetadata",
      () => {
        try {
          video.currentTime = target;
        } catch {
          // 無視 (再生は先頭から)
        }
      },
      { once: true },
    );
  }
}

export interface VideoControlOptions {
  /** 再生を始める位置 (秒)。省略すると、いまの位置から */
  time?: number;
  /** サーバーへ知らせるか (他のクライアントから同期された状態を適用するときは false) */
  broadcast?: boolean;
  /** 「準備中」などの通知を出さない (同期の適用時) */
  quiet?: boolean;
}

/**
 * 再生を始める。リングメニューからはクリック (ユーザー操作) の中で呼ぶこと
 * (音声付きの自動再生の制限を避けるため)。
 * ブラウザに止められたら、ミュートで再生して、その旨を知らせる。
 */
export function playVideo(id: string, options: VideoControlOptions = {}): void {
  const video = elements.get(id);
  if (!video || !video.src) {
    if (!options.quiet) showNotice("動画の準備ができていません。少し待ってから、もう一度お試しください", 5000);
    return;
  }
  const broadcast = options.broadcast !== false;
  video.muted = false;
  seek(video, options.time ?? video.currentTime);
  const started = () => {
    setPlaying(id, true);
    if (broadcast) sendVideoControl(id, true, video.currentTime);
  };
  video
    .play()
    .then(started)
    .catch(() => {
      // 音声付きの再生が止められた場合、ミュートなら再生できることが多い
      video.muted = true;
      video
        .play()
        .then(() => {
          started();
          showNotice("音声付きでは再生できなかったため、ミュートで再生しています", 5000);
        })
        .catch((err: unknown) => {
          console.warn(`[video] play failed: ${String(err)}`);
          if (!options.quiet) showNotice("動画を再生できませんでした (ブラウザが対応していない形式の可能性があります)", 6000);
        });
    });
}

export function pauseVideo(id: string, options: VideoControlOptions = {}): void {
  const video = elements.get(id);
  video?.pause();
  if (video && options.time !== undefined) seek(video, options.time);
  setPlaying(id, false);
  if (options.broadcast !== false) sendVideoControl(id, false, video?.currentTime ?? options.time ?? 0);
}

/** 動画が最後まで再生された (状態だけ戻す。要素は最後のフレームを表示したまま)。 */
export function markEnded(id: string): void {
  setPlaying(id, false);
  const video = elements.get(id);
  if (video) sendVideoControl(id, false, Number.isFinite(video.duration) ? video.duration : video.currentTime);
}
