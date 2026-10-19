import { useEffect, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { TICK_RATE } from "@proto/protocol";
import { sendPose, useNet } from "../net/connection";
import { bodyHeightFor, colliderFor, overlapsAny, resolvePlayer, type Collider } from "./collision";
import { carry, useInteraction } from "./interaction";
import { eyeHeightFor, initialVertical, leanPose, moveSpeedFactor, stepLean, stepVertical, type Vertical } from "./movement";

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
    /** 縦方向の状態 (足元の高さ・上向きの速さ・しゃがみの深さ)。開発時の確認用に、中身は公開している。 */
    ...initialVertical(),
    /** リーンの深さ (-1 = 左いっぱい 〜 1 = 右いっぱい)。 */
    lean: 0,
    /** 目の高さ (足元の高さ + しゃがみ・リーンで変わる目の高さ)。毎フレーム更新する。 */
    eyeY: eyeHeightFor(0),
    /** 頭 (カメラ) の水平位置。リーンで足元からずれる。毎フレーム更新する。 */
    headX: 0,
    headZ: 0,
  });
  const keys = useRef(new Set<string>());
  /** Space を押し始めたが、まだ処理していない (短く押して離しても、取りこぼさない)。二段ジャンプは、押し直しで起きる。 */
  const pendingJump = useRef(false);

  // 開発時のみ、E2E テストから位置・向きを直接設定できるようにする
  useEffect(() => {
    if (import.meta.env.DEV) (window as unknown as { __player: unknown }).__player = player.current;
  }, []);

  useEffect(() => {
    camera.rotation.order = "YXZ";
  }, [camera]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Space でページがスクロールしないようにする (ポインターロック中だけ)
      if (e.code === "Space" && document.pointerLockElement === canvas) e.preventDefault();
      if (e.code === "Space" && !e.repeat) pendingJump.current = true;
      keys.current.add(e.code);
    };
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
      sendPose({ position: [p.x, p.y, p.z], head: [q.x, q.y, q.z, q.w], crouch: Math.round(p.crouch * 100) / 100, lean: Math.round(p.lean * 100) / 100 });
    }, 1000 / TICK_RATE);
    return () => clearInterval(id);
  }, [camera]);

  useFrame((_, delta) => {
    const p = player.current;
    const k = keys.current;
    const forward = (k.has("KeyW") || k.has("ArrowUp") ? 1 : 0) - (k.has("KeyS") || k.has("ArrowDown") ? 1 : 0);
    const right = (k.has("KeyD") || k.has("ArrowRight") ? 1 : 0) - (k.has("KeyA") || k.has("ArrowLeft") ? 1 : 0);
    const menuOpen = useInteraction.getState().menuTargetId !== null; // メニューを選んでいる間は動かない

    const dt = Math.min(delta, 0.05); // フレームが飛んだときに、ジャンプが突き抜けたり跳ね上がりすぎたりしないように
    // 当たり判定の対象 (つかんでいるものは、手元で動かすので除く)
    const colliders: Collider[] = [];
    for (const object of Object.values(useNet.getState().objects)) {
      if (object.id === carry.id) continue;
      const collider = colliderFor(object);
      if (collider) colliders.push(collider);
    }

    // ジャンプ (Space。空中で押し直すと二段ジャンプ) としゃがみ (C または Ctrl)。メニューを選んでいる間は、入力を受け付けない
    const jumpPressed = !menuOpen && pendingJump.current;
    pendingJump.current = false;
    let crouchWanted = !menuOpen && (k.has("KeyC") || k.has("ControlLeft") || k.has("ControlRight"));
    // 低い天井の下では、キーを離しても立ち上がらない (立つと頭が食い込むため)
    if (!crouchWanted && p.crouch > 0.02 && overlapsAny([p.x, p.y, p.z], bodyHeightFor(eyeHeightFor(0)), colliders)) crouchWanted = true;
    const vertical: Vertical = stepVertical(
      { y: p.y, vy: p.vy, crouch: p.crouch, grounded: p.grounded, airJumps: p.airJumps },
      { jump: !menuOpen && (k.has("Space") || jumpPressed), jumpPressed, crouch: crouchWanted },
      dt,
    );
    p.y = vertical.y;
    p.vy = vertical.vy;
    p.crouch = vertical.crouch;
    p.grounded = vertical.grounded;
    p.airJumps = vertical.airJumps;

    // リーン: Q で左、E で右 (押している間)。オブジェクトをつかんでいる間の E は、回転モードの切り替えに使うので、傾けない
    const grabbing = useInteraction.getState().grabbedId !== null;
    const leanDirection = menuOpen ? 0 : ((k.has("KeyE") && !grabbing ? 1 : 0) - (k.has("KeyQ") ? 1 : 0)) as -1 | 0 | 1;
    p.lean = stepLean(p.lean, leanDirection, Math.min(delta, 0.05));

    if (!menuOpen && (forward !== 0 || right !== 0)) {
      const len = Math.hypot(forward, right);
      // Shift を押している間は走る (しゃがんでいるときは走れない)
      const sprinting = k.has("ShiftLeft") || k.has("ShiftRight");
      const step = (SPEED * moveSpeedFactor(p.crouch, sprinting) * delta) / len;
      const sin = Math.sin(p.yaw);
      const cos = Math.cos(p.yaw);
      // yaw=0 のとき前方は -Z、右は +X
      p.x += (-sin * forward + cos * right) * step;
      p.z += (-cos * forward - sin * right) * step;
      p.x = Math.max(-WORLD_HALF_SIZE, Math.min(WORLD_HALF_SIZE, p.x));
      p.z = Math.max(-WORLD_HALF_SIZE, Math.min(WORLD_HALF_SIZE, p.z));
    }

    // 物との当たり判定: 食い込んだぶんを押し出す。上面に触れていれば立てる (物の上に乗れる)。壁には沿って滑る
    const resolved = resolvePlayer([p.x, p.y, p.z], bodyHeightFor(eyeHeightFor(p.crouch)), colliders);
    p.x = Math.max(-WORLD_HALF_SIZE, Math.min(WORLD_HALF_SIZE, resolved.position[0]));
    p.y = Math.max(0, resolved.position[1]);
    p.z = Math.max(-WORLD_HALF_SIZE, Math.min(WORLD_HALF_SIZE, resolved.position[2]));
    if (resolved.grounded) {
      p.grounded = true;
      if (p.vy < 0) p.vy = 0;
    }
    if (resolved.hitCeiling && p.vy > 0) p.vy = 0;
    // 体が足元を中心に傾いたとして、頭 (カメラ) を、視線の右方向へずらし、少し下げ、画面を傾ける
    const lean = leanPose(eyeHeightFor(p.crouch), p.lean);
    p.eyeY = p.y + lean.height;
    p.headX = p.x + Math.cos(p.yaw) * lean.side;
    p.headZ = p.z - Math.sin(p.yaw) * lean.side;
    camera.position.set(p.headX, p.eyeY, p.headZ);
    camera.rotation.set(p.pitch, p.yaw, -lean.roll); // 右へ傾けると、時計回り (回転の向きは負)
  });

  return null;
}
