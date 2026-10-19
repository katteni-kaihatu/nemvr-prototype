import { useEffect, useMemo, useRef, useState } from "react";
import { CanvasTexture, DoubleSide, SRGBColorSpace, VideoTexture } from "three";
import { FILE_ICON_HEIGHT, FILE_ICON_WIDTH, type FileObject } from "@proto/protocol";
import { registerP2pMedia, type P2pMediaSource } from "../net/p2pMedia";
import { drawFileIcon } from "./fileIcon";
import { ObjectFrame } from "./ObjectFrame";
import { markEnded, registerVideoElement, useVideoPlayback } from "./videoPlayback";

/** 再生中の画面の、いちばん大きいときの幅・高さ (m)。映像の縦横比に合わせて、この範囲に収める。 */
const SCREEN_MAX_WIDTH = 1.8;
const SCREEN_MAX_HEIGHT = 1.2;

/**
 * ワールドに置かれたファイル。
 *
 * - 映像以外: ファイルの形のアイコン (音声は専用の絵柄) の板。
 * - 映像: サムネイル (動画の 1 コマ) をアイコンに描く。リングメニューの「再生」で、その場 (板の位置) に
 *   映像の画面を広げて再生する (全画面にはしない)。もう一度押すと一時停止する。
 *
 * 映像の中身は、サーバーの `/media/<cid>` から取得する (サムネイルも再生も、必要な範囲だけ)。
 */
export function FilePlane({ object }: { object: FileObject }) {
  const { name, size, category, offline, stored } = object;
  const isVideo = category === "video";
  const playing = useVideoPlayback((s) => s.playing[object.id] === true);

  const [thumbnail, setThumbnail] = useState<{ image: HTMLCanvasElement; width: number; height: number } | null>(null);
  const [aspect, setAspect] = useState(16 / 9);
  const [videoTexture, setVideoTexture] = useState<VideoTexture | null>(null);
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

  // 映像の要素を作る (サーバーが保持しているときだけ)。サムネイルの作成と再生の両方に使う
  useEffect(() => {
    if (!isVideo || !stored) return;
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true; // サムネイル用 (再生のときに音を出す)
    video.playsInline = true;
    // VideoTexture は、画面に描画されていない要素からはフレームを取れないことがある。見えない位置に置く
    video.style.cssText =
      "position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none;z-index:-1";
    document.body.append(video);
    videoRef.current = video;
    registerVideoElement(object.id, video);

    // 動画は、ブラウザ内の IPFS (bitswap) から P2P で流す (Service Worker 経由)。
    // 使えない環境では、サーバーの /media に切り替える。登録が終わるまで src は設定しない
    // (先に <video> が URL を要求すると、SW が 404 を返してしまう)
    let cancelled = false;
    let source: P2pMediaSource | null = null;
    void (async () => {
      source = await registerP2pMedia(object.cid, object.size, object.name);
      if (cancelled) {
        source?.stop();
        return;
      }
      video.src = source?.url ?? `/media/${encodeURIComponent(object.cid)}`;
      video.load();
    })();

    // サムネイルは 1 回だけ描く (描いたあとに先頭へ戻すと、seeked がまた走って、
    // 再生中に毎回シークし直す無限ループになるため)
    let captured = false;
    const capture = () => {
      if (captured || video.videoWidth <= 0 || video.videoHeight <= 0) return;
      captured = true;
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext("2d")?.drawImage(video, 0, 0);
      setThumbnail({ image: canvas, width: canvas.width, height: canvas.height });
    };
    const onMetadata = () => {
      const w = video.videoWidth;
      const h = video.videoHeight;
      if (w > 0 && h > 0) setAspect(w / h);
      // 再生中でなければ、10% の位置 (長すぎる場合は 2 秒) のコマをサムネイルにする
      if (video.paused) {
        video.currentTime = Number.isFinite(video.duration) ? Math.min(Math.max(0.05, video.duration * 0.1), 2) : 0.1;
      }
    };
    const onSeeked = () => {
      if (captured) return;
      capture();
      // サムネイル用のシークが終わったら、先頭に戻しておく (まだ再生していないときだけ)
      if (video.paused) video.currentTime = 0;
    };
    const onLoadedData = () => {
      // 再生が先に始まっていた場合は、最初のコマをそのままサムネイルにする
      if (!video.paused) capture();
    };
    const onEnded = () => markEnded(object.id);
    video.addEventListener("loadedmetadata", onMetadata);
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("loadeddata", onLoadedData);
    video.addEventListener("ended", onEnded);

    return () => {
      cancelled = true;
      // 先に要素を外して、読み込み中の要求を止める (そのあとで配信の口を閉じる)
      video.removeEventListener("loadedmetadata", onMetadata);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("loadeddata", onLoadedData);
      video.removeEventListener("ended", onEnded);
      registerVideoElement(object.id, null);
      video.pause();
      video.remove();
      videoRef.current = null;
      source?.stop();
    };
  }, [isVideo, stored, object.id, object.cid, object.size, object.name]);

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
