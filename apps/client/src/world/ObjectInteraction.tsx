import { useEffect, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Raycaster, Vector2 } from "three";
import { GRAB_REACH, TICK_RATE } from "@proto/protocol";
import {
  applyLocalObjectPose,
  sendGrabObject,
  sendMoveObject,
  sendReleaseObject,
  showNotice,
  useNet,
} from "../net/connection";
import { attach, resolve, type Attachment } from "./carry";
import { CURSOR_VISIBLE_MS, carry, useInteraction } from "./interaction";
import { objectMeshes } from "./registry";

const WORLD_HALF_SIZE = 24;
const CENTER = new Vector2(0, 0); // 画面中央 (正規化デバイス座標)
const MOVE_INTERVAL_MS = 1000 / TICK_RATE;
const MOTION_EPSILON = 1e-4;

interface Grab {
  id: string;
  attachment: Attachment;
  lastSentAt: number;
}

const clamp = (v: number) => Math.max(-WORLD_HALF_SIZE, Math.min(WORLD_HALF_SIZE, v));

/**
 * 画面中央をカーソルとして、オブジェクトを操作する (描画なし)。
 * - 右ボタンを押している間、狙っているオブジェクトをつかんで運ぶ (離すと置く)
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

  /** 画面中央のレイが、届く範囲で最初に当たるオブジェクトの ID。 */
  const aimedObjectId = (): string | null => {
    camera.updateMatrixWorld();
    const rc = raycaster.current;
    rc.setFromCamera(CENTER, camera);
    rc.far = GRAB_REACH;
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
    if (object.heldBy && object.heldBy !== useNet.getState().self?.id) {
      showNotice("他の人がつかんでいます", 2500);
      return;
    }
    grab.current = {
      id,
      lastSentAt: 0,
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
    useInteraction.setState({ grabbedId: id });
    sendGrabObject(id); // 先に始めて、他の人に先を越されていたらサーバーの応答で取り消す
  };

  const endGrab = () => {
    const g = grab.current;
    if (!g) return;
    grab.current = null;
    const position: [number, number, number] = [carry.x, carry.y, carry.z];
    sendMoveObject(g.id, position, carry.yaw);
    sendReleaseObject(g.id);
    applyLocalObjectPose(g.id, position, carry.yaw);
    carry.id = null;
    useInteraction.setState({ grabbedId: null });
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
    canvas.addEventListener("contextmenu", onContextMenu);
    canvas.addEventListener("auxclick", onContextMenu);
    canvas.addEventListener("mousedown", onMouseDown);
    // 画面の外で離しても、ウィンドウが非アクティブになっても、置く
    window.addEventListener("mouseup", onMouseUp);
    window.addEventListener("blur", endGrab);
    return () => {
      canvas.removeEventListener("contextmenu", onContextMenu);
      canvas.removeEventListener("auxclick", onContextMenu);
      canvas.removeEventListener("mousedown", onMouseDown);
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
    }

    // --- つかんでいるオブジェクトを、自分の動きに合わせて運ぶ ---
    if (grab.current) {
      const o = resolve(grab.current.attachment, {
        x: camera.position.x,
        z: camera.position.z,
        yaw: camera.rotation.y,
      });
      carry.x = clamp(o.x);
      carry.y = o.y;
      carry.z = clamp(o.z);
      carry.yaw = o.yaw;
      if (now - grab.current.lastSentAt >= MOVE_INTERVAL_MS) {
        grab.current.lastSentAt = now;
        sendMoveObject(grab.current.id, [carry.x, carry.y, carry.z], carry.yaw);
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
