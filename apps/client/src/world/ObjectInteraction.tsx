import { useEffect, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Raycaster, Vector2 } from "three";
import { TICK_RATE } from "@proto/protocol";
import {
  applyLocalObjectPose,
  isCrdtWorldAvailable,
  sendGrabObject,
  sendMoveObject,
  sendReleaseObject,
  showNotice,
  useNet,
} from "../net/connection";
import { attach, liftedHeight, pulled, resolve, scaled, wrapAngle, type Attachment } from "./carry";
import { CURSOR_VISIBLE_MS, carry, useInteraction } from "./interaction";
import { objectMeshes } from "./registry";

const WORLD_HALF_SIZE = 24;
const CENTER = new Vector2(0, 0); // 画面中央 (正規化デバイス座標)
const MOVE_INTERVAL_MS = 1000 / TICK_RATE;
const MOTION_EPSILON = 1e-4;
const MAX_HEIGHT = 20; // m。つかんだオブジェクトを上げられる高さの上限 (下は床)
const ROTATE_SENSITIVITY = 0.0022; // rad/px。視点操作と同じ
const WHEEL_PULL_FACTOR = 1.12; // ホイール 1 目盛りあたりの、つかんだものとの距離の倍率
const WHEEL_SCALE_FACTOR = 1.12; // Shift + ホイール 1 目盛りあたりの、つかんだものの大きさの倍率

interface Grab {
  id: string;
  attachment: Attachment;
  /** X 軸回りの傾き (rad)。回転モードで変える。 */
  pitch: number;
  /** 大きさの倍率。Shift + ホイールで変える。 */
  scale: number;
  /** 前のフレームのカメラの上下の向き (rad)。視点を上下させた量から、高さの変化を求める。 */
  lastCameraPitch: number;
  /** 前のフレームのカメラの高さ (m)。ジャンプ・しゃがみで目の高さが変わった分だけ、つかんだものも上下させる。 */
  lastCameraY: number;
  lastSentAt: number;
}

const clamp = (v: number) => Math.max(-WORLD_HALF_SIZE, Math.min(WORLD_HALF_SIZE, v));

/**
 * 画面中央をカーソルとして、オブジェクトを操作する (描画なし)。
 * - 右ボタンを押している間、狙っているオブジェクトをつかんで運ぶ (離すと置く)
 *   - 移動モード (既定): 視点に合わせて動く。マウスを上下に動かして視点を上げ下げすると、つかんだものも、視線の先に付いたまま上がる・下がる (高さ Y)
 *   - ホイール (どちらのモードでも): つかんだものを、視線に沿って遠ざける (上に回す) / 引き寄せる (下に回す)
 *   - Shift + ホイール (どちらのモードでも): ホイールの代わりに、つかんだものの大きさを変える (上に回すと大きく)
 *   - 回転モード (E キーで切り替え): 視点を固定し、マウスの動きでオブジェクトを回す (左右 = 水平、上下 = 垂直)
 * - 中ボタンで、狙っている (つかんでいればそれ) オブジェクトのリングメニューを開く
 * - 視点・位置が動いている間と、止まってから数秒間だけ、中央の白い点を表示する
 */
export function ObjectInteraction() {
  const camera = useThree((s) => s.camera);
  const canvas = useThree((s) => s.gl.domElement);
  const scene = useThree((s) => s.scene);

  // 開発時のみ、E2E テストから 3D シーンの中身を調べられるようにする
  useEffect(() => {
    if (import.meta.env.DEV) (window as unknown as { __scene: unknown }).__scene = scene;
  }, [scene]);

  const raycaster = useRef(new Raycaster());
  const grab = useRef<Grab | null>(null);
  const lastPose = useRef({ x: 0, z: 0, yaw: 0, pitch: 0 });
  const lastMovedAt = useRef(performance.now());

  /** 画面中央のレイが、最初に当たるオブジェクトの ID (距離の制限なし)。 */
  const aimedObjectId = (): string | null => {
    camera.updateMatrixWorld();
    const rc = raycaster.current;
    rc.setFromCamera(CENTER, camera);
    // 距離の制限は設けない (無限遠。画面中央に写っているものは、どこにあっても狙える)
    rc.far = Infinity;
    const hit = rc.intersectObjects([...objectMeshes.values()], false)[0];
    return (hit?.object.userData.objectId as string | undefined) ?? null;
  };

  const startGrab = () => {
    const interaction = useInteraction.getState();
    if (interaction.menuTargetId || grab.current) return;
    const id = aimedObjectId();
    if (!id) return;
    const object = useNet.getState().objects[id];
    if (!object) return;
    if (object.heldBy && object.heldBy !== useNet.getState().self?.id && !isCrdtWorldAvailable()) {
      showNotice("他の人がつかんでいます", 2500);
      return;
    }
    grab.current = {
      id,
      lastSentAt: 0,
      pitch: object.pitch ?? 0,
      scale: object.scale ?? 1,
      lastCameraPitch: camera.rotation.x,
      lastCameraY: camera.position.y,
      attachment: attach(
        { x: camera.position.x, z: camera.position.z, yaw: camera.rotation.y },
        { x: object.position[0], y: object.position[1], z: object.position[2], yaw: object.yaw },
      ),
    };
    carry.id = id;
    carry.x = object.position[0];
    carry.y = object.position[1];
    carry.z = object.position[2];
    carry.yaw = object.yaw;
    carry.pitch = object.pitch ?? 0;
    carry.scale = object.scale ?? 1;
    useInteraction.setState({ grabbedId: id, grabMode: "move" });
    sendGrabObject(id); // 先に始めて、他の人に先を越されていたらサーバーの応答で取り消す
  };

  const endGrab = () => {
    const g = grab.current;
    if (!g) return;
    grab.current = null;
    const position: [number, number, number] = [carry.x, carry.y, carry.z];
    sendMoveObject(g.id, position, carry.yaw, carry.pitch, carry.scale);
    sendReleaseObject(g.id);
    applyLocalObjectPose(g.id, position, carry.yaw, carry.pitch, carry.scale);
    carry.id = null;
    useInteraction.setState({ grabbedId: null, grabMode: "move" });
  };

  const openMenu = () => {
    const target = grab.current?.id ?? aimedObjectId();
    if (!target) {
      showNotice("オブジェクトを狙ってから中ボタンを押してください", 2500);
      return;
    }
    useInteraction.setState({ menuTargetId: target });
    // マウスでメニューを選べるよう、ポインターロックを解除する (選択後に取り直す)
    if (document.pointerLockElement === canvas) document.exitPointerLock();
  };

  useEffect(() => {
    const onContextMenu = (e: Event) => e.preventDefault();
    const onMouseDown = (e: MouseEvent) => {
      if (e.button === 2) {
        e.preventDefault();
        startGrab();
      } else if (e.button === 1) {
        e.preventDefault(); // 中ボタンのオートスクロールを防ぐ
        openMenu();
      }
    };
    const onMouseUp = (e: MouseEvent) => {
      if (e.button === 2) endGrab();
    };
    // E キー: つかんでいる間、移動モードと回転モードを切り替える
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== "KeyE" || e.repeat || e.metaKey || e.altKey) return; // Ctrl は、しゃがみのキーなので、押していてもよい
      if (!grab.current || useInteraction.getState().menuTargetId) return;
      const next = useInteraction.getState().grabMode === "move" ? "rotate" : "move";
      useInteraction.setState({ grabMode: next });
      showNotice(next === "rotate" ? "回転モード: マウスで回す。ホイールで遠近、Shift+ホイールで大きさ (E で移動に戻る)" : "移動モード: マウスの上下で持ち上げ、ホイールで遠近、Shift+ホイールで大きさ (E で回転)", 2500);
    };
    // ホイール: つかんでいるものを、視線に沿って遠ざける (上に回す) / 引き寄せる (下に回す)。どちらのモードでも
    // Shift + ホイール: 引き寄せ・遠ざけの代わりに、大きさを変える (上に回すと大きく)
    const onWheel = (e: WheelEvent) => {
      const g = grab.current;
      if (!g) return;
      e.preventDefault();
      if (useInteraction.getState().menuTargetId || e.deltaY === 0) return;
      const notches = Math.min(3, Math.max(1, Math.round(Math.abs(e.deltaY) / 100)));
      const factor = (e.shiftKey ? WHEEL_SCALE_FACTOR : WHEEL_PULL_FACTOR) ** (notches * Math.sign(-e.deltaY));
      if (e.shiftKey) {
        g.scale = scaled(g.scale, factor);
        carry.scale = g.scale;
        showNotice(`大きさ: ${Math.round(g.scale * 100)}%`, 1200);
        return;
      }
      Object.assign(g.attachment, pulled(g.attachment, factor, camera.position.y, MAX_HEIGHT));
    };
    // 回転モード: マウスの動きで回す。視点は固定されている (LocalPlayer は回転モードの間、視点を動かさない)
    const onMouseMove = (e: MouseEvent) => {
      const g = grab.current;
      if (!g || useInteraction.getState().grabMode !== "rotate") return;
      if (document.pointerLockElement !== canvas) return;
      g.attachment.dyaw += e.movementX * ROTATE_SENSITIVITY;
      // 手前の面をマウスの動きに合わせて上下させる。裏向きのときは、傾ける向きを逆にする
      const facing = Math.cos(g.attachment.dyaw) >= 0 ? 1 : -1;
      g.pitch = wrapAngle(g.pitch - e.movementY * ROTATE_SENSITIVITY * facing);
    };
    canvas.addEventListener("contextmenu", onContextMenu);
    canvas.addEventListener("auxclick", onContextMenu);
    canvas.addEventListener("mousedown", onMouseDown);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousemove", onMouseMove);
    // 画面の外で離しても、ウィンドウが非アクティブになっても、置く
    window.addEventListener("mouseup", onMouseUp);
    window.addEventListener("blur", endGrab);
    return () => {
      canvas.removeEventListener("contextmenu", onContextMenu);
      canvas.removeEventListener("auxclick", onContextMenu);
      canvas.removeEventListener("mousedown", onMouseDown);
      canvas.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("blur", endGrab);
      endGrab();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera, canvas]);

  useFrame(() => {
    const now = performance.now();
    const interaction = useInteraction.getState();

    // サーバーに拒否された・オブジェクトが消えた場合は、手元のつかみも取りやめる
    const g = grab.current;
    if (g && interaction.grabbedId !== g.id) {
      grab.current = null;
      carry.id = null;
      if (useInteraction.getState().grabMode !== "move") useInteraction.setState({ grabMode: "move" });
    }

    // --- つかんでいるオブジェクトを、自分の動きに合わせて運ぶ ---
    if (grab.current) {
      // 視点を上下させた量だけ、視線の方向の角度を変えて、高さを求める (視線の先に付いたまま上がる・下がる)。
      // 回転モードでは視点が動かないので、高さは変わらない
      const a = grab.current.attachment;
      const dPitch = camera.rotation.x - grab.current.lastCameraPitch;
      grab.current.lastCameraPitch = camera.rotation.x;
      // ジャンプ・しゃがみで目の高さが変わったら、つかんだものも同じだけ上下する (目から見た位置を保つ)
      const dEye = camera.position.y - grab.current.lastCameraY;
      grab.current.lastCameraY = camera.position.y;
      if (dEye !== 0) a.y = Math.max(0, Math.min(MAX_HEIGHT, a.y + dEye));
      if (dPitch !== 0) a.y = liftedHeight(a.y, Math.hypot(a.dx, a.dz), dPitch, camera.position.y, MAX_HEIGHT);
      const o = resolve(grab.current.attachment, {
        x: camera.position.x,
        z: camera.position.z,
        yaw: camera.rotation.y,
      });
      carry.x = clamp(o.x);
      carry.y = o.y;
      carry.z = clamp(o.z);
      carry.yaw = o.yaw;
      carry.pitch = grab.current.pitch;
      carry.scale = grab.current.scale;
      if (now - grab.current.lastSentAt >= MOVE_INTERVAL_MS) {
        grab.current.lastSentAt = now;
        sendMoveObject(grab.current.id, [carry.x, carry.y, carry.z], carry.yaw, carry.pitch, carry.scale);
      }
    }

    // --- 狙っているオブジェクト (ハイライト) ---
    const hoverId = interaction.menuTargetId ?? grab.current?.id ?? aimedObjectId();
    if (hoverId !== interaction.hoverId) useInteraction.setState({ hoverId });

    // --- 中央の白い点: 動いている間と、止まってから CURSOR_VISIBLE_MS だけ表示する ---
    const pose = {
      x: camera.position.x,
      z: camera.position.z,
      yaw: camera.rotation.y,
      pitch: camera.rotation.x,
    };
    const last = lastPose.current;
    if (
      Math.abs(pose.x - last.x) > MOTION_EPSILON ||
      Math.abs(pose.z - last.z) > MOTION_EPSILON ||
      Math.abs(pose.yaw - last.yaw) > MOTION_EPSILON ||
      Math.abs(pose.pitch - last.pitch) > MOTION_EPSILON
    ) {
      lastMovedAt.current = now;
    }
    lastPose.current = pose;
    const cursorVisible =
      !interaction.menuTargetId && (!!grab.current || now - lastMovedAt.current < CURSOR_VISIBLE_MS);
    if (cursorVisible !== interaction.cursorVisible) useInteraction.setState({ cursorVisible });
  });

  return null;
}
