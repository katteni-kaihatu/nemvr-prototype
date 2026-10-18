import { useEffect, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { TICK_RATE } from "@proto/protocol";
import { sendPose } from "../net/connection";
import { EYE_HEIGHT } from "./Avatar";
import { useInteraction } from "./interaction";

const SPEED = 3; // m/s
const MOUSE_SENSITIVITY = 0.0022;
const WORLD_HALF_SIZE = 24;
const MAX_PITCH = Math.PI / 2 - 0.01;

/** 入力処理・移動・一人称カメラ・姿勢送信。移動はクライアント権威。 */
export function LocalPlayer() {
  const camera = useThree((s) => s.camera);
  const canvas = useThree((s) => s.gl.domElement);

  // 入室位置は原点の手前あたりに少しばらつかせ、-Z 方向を向く
  const player = useRef({
    x: (Math.random() - 0.5) * 6,
    z: 4 + Math.random() * 2,
    yaw: 0,
    pitch: 0,
  });
  const keys = useRef(new Set<string>());

  // 開発時のみ、E2E テストから位置・向きを直接設定できるようにする
  useEffect(() => {
    if (import.meta.env.DEV) (window as unknown as { __player: unknown }).__player = player.current;
  }, []);

  useEffect(() => {
    camera.rotation.order = "YXZ";
  }, [camera]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => keys.current.add(e.code);
    const onKeyUp = (e: KeyboardEvent) => keys.current.delete(e.code);
    const onBlur = () => keys.current.clear();
    const onMouseMove = (e: MouseEvent) => {
      if (document.pointerLockElement !== canvas) return;
      // 回転モード (つかんだオブジェクトを回している) の間は、視点を動かさない
      const interaction = useInteraction.getState();
      if (interaction.grabbedId && interaction.grabMode === "rotate") return;
      const p = player.current;
      p.yaw -= e.movementX * MOUSE_SENSITIVITY;
      p.pitch -= e.movementY * MOUSE_SENSITIVITY;
      p.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, p.pitch));
    };
    const onClick = () => {
      if (document.pointerLockElement !== canvas) void canvas.requestPointerLock();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    document.addEventListener("mousemove", onMouseMove);
    canvas.addEventListener("click", onClick);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("mousemove", onMouseMove);
      canvas.removeEventListener("click", onClick);
      if (document.pointerLockElement === canvas) document.exitPointerLock();
    };
  }, [canvas]);

  // 固定レートで姿勢を送信
  useEffect(() => {
    const id = setInterval(() => {
      const p = player.current;
      const q = camera.quaternion;
      sendPose({ position: [p.x, 0, p.z], head: [q.x, q.y, q.z, q.w] });
    }, 1000 / TICK_RATE);
    return () => clearInterval(id);
  }, [camera]);

  useFrame((_, delta) => {
    const p = player.current;
    const k = keys.current;
    const forward = (k.has("KeyW") || k.has("ArrowUp") ? 1 : 0) - (k.has("KeyS") || k.has("ArrowDown") ? 1 : 0);
    const right = (k.has("KeyD") || k.has("ArrowRight") ? 1 : 0) - (k.has("KeyA") || k.has("ArrowLeft") ? 1 : 0);
    const menuOpen = useInteraction.getState().menuTargetId !== null; // メニューを選んでいる間は動かない
    if (!menuOpen && (forward !== 0 || right !== 0)) {
      const len = Math.hypot(forward, right);
      const step = (SPEED * delta) / len;
      const sin = Math.sin(p.yaw);
      const cos = Math.cos(p.yaw);
      // yaw=0 のとき前方は -Z、右は +X
      p.x += (-sin * forward + cos * right) * step;
      p.z += (-cos * forward - sin * right) * step;
      p.x = Math.max(-WORLD_HALF_SIZE, Math.min(WORLD_HALF_SIZE, p.x));
      p.z = Math.max(-WORLD_HALF_SIZE, Math.min(WORLD_HALF_SIZE, p.z));
    }
    camera.position.set(p.x, EYE_HEIGHT, p.z);
    camera.rotation.set(p.pitch, p.yaw, 0);
  });

  return null;
}
