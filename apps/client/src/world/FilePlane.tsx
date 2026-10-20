import { useEffect, useMemo, useRef, useState } from "react";
import { CanvasTexture, DoubleSide, SRGBColorSpace, VideoTexture } from "three";
import { FILE_ICON_HEIGHT, FILE_ICON_WIDTH, type FileObject } from "@proto/protocol";
import { serverNow, useNet } from "../net/connection";
import { registerP2pMedia, type P2pMediaSource } from "../net/p2pMedia";
import { drawFileIcon } from "./fileIcon";
import { ObjectFrame } from "./ObjectFrame";
import {
  markEnded,
  pauseVideo,
  playVideo,
  registerVideoElement,
  useVideoPlayback,
} from "./videoPlayback";

/** 再生中の画面の、いちばん大きいときの幅・高さ (m)。映像の縦横比に合わせて、この範囲に収める。 */
const SCREEN_MAX_WIDTH = 1.8;
const SCREEN_MAX_HEIGHT = 1.2;

/** 画面に描画されていない要素からは、VideoTexture がフレームを取れないことがある。見えない位置に置く。 */
const OFFSCREEN = "position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none;z-index:-1";

/**
 * ワールドに置かれたファイル。
 *
 * - 映像以外: ファイルの形のアイコン (音声は専用の絵柄) の板。
 * - 映像: サムネイル (動画の 1 コマ) をアイコンに描く。リングメニューの「再生」で、その場 (板の位置) に
 *   映像の画面を広げて再生する (全画面にはしない)。もう一度押すと一時停止する。
 *
 * 映像の中身は、再生のときはブラウザ同士の P2P (Service Worker 経由)、サムネイルはサーバーの `/media` から取得する。
 */
export function FilePlane({ object }: { object: FileObject }) {
  const { name, size, category, offline, stored } = object;
  const isVideo = category === "video";
  const playing = useVideoPlayback((s) => s.playing[object.id] === true);
  /** サーバーが保持している、この動画の再生状態 (全員で共有) */
  const remoteVideo = useNet((s) => s.videoStates[object.id]);

  const [thumbnail, setThumbnail] = useState<{ image: HTMLCanvasElement; width: number; height: number } | null>(null);
  const [aspect, setAspect] = useState(16 / 9);
  const [videoTexture, setVideoTexture] = useState<VideoTexture | null>(null);
  /** 再生用の要素に、P2P (または /media) の URL を設定し終えたか */
  const [playerReady, setPlayerReady] = useState(false);
  /** 再生用の video 要素 (P2P の URL を最初から持つ。preload=none で、再生するまで読まない) */
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // アイコンのテクスチャ (2D canvas)。サムネイルが用意できたら、描き直す
  const iconTexture = useMemo(() => {
    const canvas = document.createElement("canvas");
    drawFileIcon(canvas, { name, size, category, offline, thumbnail: thumbnail ?? undefined });
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    texture.anisotropy = 8;
    return texture;
  }, [name, size, category, offline, thumbnail]);
  useEffect(() => () => iconTexture.dispose(), [iconTexture]);

  useEffect(() => {
    if (!isVideo || !stored) return;

    // 再生用の要素。最初から P2P の URL を持たせる (再生のときに src を変えると、
    // Firefox で再生が中断されることがあるため)。preload=none なので、再生するまで取得しない
    setPlayerReady(false);
    const player = document.createElement("video");
    player.preload = "none";
    player.muted = true; // 再生のときに音を出す
    player.playsInline = true;
    player.style.cssText = OFFSCREEN;
    document.body.append(player);
    videoRef.current = player;
    registerVideoElement(object.id, player);
    const onEnded = () => markEnded(object.id);
    player.addEventListener("ended", onEnded);

    // サムネイル用の要素。サーバーの /media からメタデータと 1 コマだけ読む。
    // 読み終わったら要素を外して、要求を閉じる (ダウンロードと同じ CID を同時に取りに行かないように)
    const thumb = document.createElement("video");
    thumb.preload = "metadata";
    thumb.muted = true;
    thumb.playsInline = true;
    thumb.src = `/media/${encodeURIComponent(object.cid)}`;
    thumb.style.cssText = OFFSCREEN;
    document.body.append(thumb);

    let captured = false;
    const capture = () => {
      if (captured || thumb.videoWidth <= 0 || thumb.videoHeight <= 0) return;
      captured = true;
      const canvas = document.createElement("canvas");
      canvas.width = thumb.videoWidth;
      canvas.height = thumb.videoHeight;
      canvas.getContext("2d")?.drawImage(thumb, 0, 0);
      setThumbnail({ image: canvas, width: canvas.width, height: canvas.height });
      // サムネイルが撮れたら、再生はしない (要素は残す。取得はサーバーの /media なので、P2P の要求とは競合しない)
      thumb.pause();
    };
    const onMetadata = () => {
      if (thumb.videoWidth > 0 && thumb.videoHeight > 0) setAspect(thumb.videoWidth / thumb.videoHeight);
      // 10% の位置 (長すぎる場合は 2 秒) のコマをサムネイルにする
      if (!captured) {
        thumb.currentTime = Number.isFinite(thumb.duration) ? Math.min(Math.max(0.05, thumb.duration * 0.1), 2) : 0.1;
      }
    };
    const onError = () => thumb.remove();
    thumb.addEventListener("loadedmetadata", onMetadata);
    thumb.addEventListener("seeked", capture);
    thumb.addEventListener("error", onError);
    // 自動で先頭のコマが来た場合 (シークが起きない形式) にも撮る
    thumb.addEventListener("loadeddata", () => {
      if (!captured && thumb.currentTime === 0) capture();
    });

    let cancelled = false;
    let source: P2pMediaSource | null = null;
    void (async () => {
      source = await registerP2pMedia(object.cid, object.size, object.name);
      if (cancelled) {
        source?.stop();
        return;
      }
      // Service Worker が使えない環境では、サーバーの /media から再生する
      player.src = source?.url ?? `/media/${encodeURIComponent(object.cid)}`;
      setPlayerReady(true);
    })();

    return () => {
      cancelled = true;
      // 先に要素を外して、読み込み中の要求を止める (そのあとで配信の口を閉じる)
      thumb.removeEventListener("loadedmetadata", onMetadata);
      thumb.removeEventListener("seeked", capture);
      thumb.removeEventListener("error", onError);
      thumb.remove();
      player.removeEventListener("ended", onEnded);
      registerVideoElement(object.id, null);
      player.pause();
      player.remove();
      videoRef.current = null;
      source?.stop();
    };
  }, [isVideo, stored, object.id, object.cid, object.size, object.name]);

  // 他の人の操作 (再生・一時停止) や、入室時の状態を、この要素にも反映する。
  // serverNow() で、状態を受け取るまでの遅れ (サーバーの at からの経過) を足して、再生位置を合わせる
  useEffect(() => {
    if (!playerReady || !remoteVideo) return;
    const now = serverNow() ?? remoteVideo.at;
    const elapsed = remoteVideo.playing ? Math.max(0, (now - remoteVideo.at) / 1000) : 0;
    const target = remoteVideo.time + elapsed;
    if (remoteVideo.playing) playVideo(object.id, { time: target, broadcast: false, quiet: true });
    else pauseVideo(object.id, { time: target, broadcast: false });
  }, [playerReady, remoteVideo, object.id]);

  // 再生が始まったら、動画をテクスチャにする (止めたら、アイコンに戻す)
  useEffect(() => {
    const video = videoRef.current;
    if (!playing || !video) return;
    const texture = new VideoTexture(video);
    texture.colorSpace = SRGBColorSpace;
    setVideoTexture(texture);
    return () => {
      texture.dispose();
      setVideoTexture(null);
    };
  }, [playing]);

  const showVideo = playing && videoTexture !== null;
  const screen = (() => {
    const a = aspect > 0 ? aspect : 16 / 9;
    const width = Math.min(SCREEN_MAX_WIDTH, SCREEN_MAX_HEIGHT * a);
    return { width, height: width / a };
  })();

  return (
    <ObjectFrame
      object={object}
      width={showVideo ? screen.width : FILE_ICON_WIDTH}
      height={showVideo ? screen.height : FILE_ICON_HEIGHT}
    >
      {showVideo ? (
        <meshBasicMaterial map={videoTexture} toneMapped={false} side={DoubleSide} />
      ) : (
        // ページの外側は透明。角や欄の外を抜く
        <meshBasicMaterial map={iconTexture} transparent alphaTest={0.02} side={DoubleSide} toneMapped={false} />
      )}
    </ObjectFrame>
  );
}
