import { create } from "zustand";
import { showNotice } from "../net/connection";

interface VideoPlaybackState {
  /** 再生中の動画 (オブジェクト ID ごと)。 */
  playing: Record<string, boolean>;
}

/**
 * 3D 空間に置かれた動画の再生状態 (クライアントごと。他の人には同期しない)。
 * 再生は、リングメニューの「再生」を押したとき (ユーザー操作の中) に始める。
 */
export const useVideoPlayback = create<VideoPlaybackState>(() => ({ playing: {} }));

/** オブジェクト ID ごとの、動画の要素 (サムネイルの作成と再生に使う)。 */
const elements = new Map<string, HTMLVideoElement>();

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

/**
 * 再生を始める。クリック (ユーザー操作) の中で呼ぶこと (音声付きの自動再生の制限を避けるため)。
 * ブラウザに止められたら、ミュートで再生して、その旨を知らせる。
 */
export function playVideo(id: string): void {
  const video = elements.get(id);
  if (!video) {
    showNotice("動画の準備ができていません (サーバーが取得中です)。少し待ってから、もう一度お試しください", 5000);
    return;
  }
  video.muted = false;
  video.currentTime = 0;
  video
    .play()
    .then(() => setPlaying(id, true))
    .catch(() => {
      // 音声付きの再生が止められた場合、ミュートなら再生できることが多い
      video.muted = true;
      video
        .play()
        .then(() => {
          setPlaying(id, true);
          showNotice("音声付きでは再生できなかったため、ミュートで再生しています", 5000);
        })
        .catch((err: unknown) => {
          console.warn(`[video] play failed: ${String(err)}`);
          showNotice("動画を再生できませんでした (ブラウザが対応していない形式の可能性があります)", 6000);
        });
    });
}

export function pauseVideo(id: string): void {
  elements.get(id)?.pause();
  setPlaying(id, false);
}

/** 動画が最後まで再生された (状態だけ戻す。要素は最後のフレームを表示したまま)。 */
export function markEnded(id: string): void {
  setPlaying(id, false);
}
