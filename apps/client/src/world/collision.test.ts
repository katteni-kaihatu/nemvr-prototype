import { describe, expect, it } from "vitest";
import type { WorldObject } from "@proto/protocol";
import { FILE_ICON_HEIGHT, FILE_ICON_WIDTH } from "@proto/protocol";
import {
  CONTACT_SKIN,
  PLATE_THICKNESS,
  PLAYER_RADIUS,
  bodyHeightFor,
  bodySpheres,
  colliderFor,
  overlapsAny,
  resolvePlayer,
  sphereVsCollider,
  type Collider,
} from "./collision";

const STAND = bodyHeightFor(1.6); // 1.8m
const CROUCH = bodyHeightFor(0.9); // 1.1m

/** 底面の中央が (x, y, z) で、一辺 size の箱。 */
const box = (size: number, position: [number, number, number] = [0, 0, 0], yaw = 0, pitch = 0): Collider => {
  const h = size / 2;
  return { position, yaw, pitch, center: [0, h, 0], half: [h, h, h] };
};
const near = (a: number, b: number, digits = 3) => expect(a).toBeCloseTo(b, digits);

describe("colliderFor", () => {
  const base = { id: "x", position: [1, 2, 3] as [number, number, number], yaw: 0.5 };

  it("箱は、底面の中央を基準にした立方体", () => {
    const c = colliderFor({ ...base, kind: "box", size: 2, color: "#fff", pitch: 0.2 })!;
    expect(c.position).toEqual([1, 2, 3]);
    expect(c.half).toEqual([1, 1, 1]);
    expect(c.center).toEqual([0, 1, 0]);
    expect(c.yaw).toBe(0.5);
    expect(c.pitch).toBe(0.2);
  });

  it("画像は、幅 x 高さ x 板の厚みの、薄い板", () => {
    const c = colliderFor({ ...base, kind: "image", cid: "c", width: 4, height: 2 })!;
    expect(c.half).toEqual([2, 1, PLATE_THICKNESS / 2]);
    expect(c.center).toEqual([0, 1, 0]);
    expect(c.pitch).toBe(0); // pitch が無ければ 0
  });

  it("ファイルのアイコンも、薄い板", () => {
    const c = colliderFor({ ...base, kind: "file", cid: "c", name: "a", size: 1, stored: true, category: "file" } as WorldObject)!;
    expect(c.half).toEqual([FILE_ICON_WIDTH / 2, FILE_ICON_HEIGHT / 2, PLATE_THICKNESS / 2]);
  });

  it("リンクは、画像と同じ薄い板", () => {
    const c = colliderFor({ id: "x", kind: "link", url: "https://example.com", position: [1, 2, 3], yaw: 0.5 })!;
    expect(c.half).toEqual([FILE_ICON_WIDTH / 2, FILE_ICON_HEIGHT / 2, PLATE_THICKNESS / 2]);
    expect(c.pitch).toBe(0);
  });

  it("誰かがつかんでいるものは、当たり判定を外す", () => {
    expect(colliderFor({ ...base, kind: "box", size: 1, color: "#fff", heldBy: "someone" })).toBeNull();
  });
});

describe("sphereVsCollider", () => {
  it("離れていれば、触れていない", () => {
    expect(sphereVsCollider([0, 5, 0], PLAYER_RADIUS, box(1))).toBeNull();
    expect(sphereVsCollider([2, 0.5, 0], PLAYER_RADIUS, box(1))).toBeNull();
  });

  it("箱の上に球が食い込んでいると、真上へ押し出す", () => {
    // 箱の上面は y = 1。球の中心 y = 1.2 (半径 0.3 なので、0.1 食い込む)
    const c = sphereVsCollider([0, 1.2, 0], PLAYER_RADIUS, box(1))!;
    near(c.depth, 0.1);
    expect(c.normal).toEqual([0, 1, 0]);
    near(c.push[1], 0.1);
    near(c.push[0], 0);
  });

  it("箱の側面なら、横へ押し出す", () => {
    // 箱は x = -0.5〜0.5。球の中心 x = 0.7 (0.1 食い込む)
    const c = sphereVsCollider([0.7, 0.5, 0], PLAYER_RADIUS, box(1))!;
    near(c.depth, 0.1);
    near(c.normal[0], 1);
    near(c.push[0], 0.1);
    near(c.push[1], 0);
  });

  it("ちょうど触れる距離 (皮膚の内側) では、押し出さずに、触れていると返す", () => {
    const c = sphereVsCollider([0, 1 + PLAYER_RADIUS + CONTACT_SKIN / 2, 0], PLAYER_RADIUS, box(1))!;
    expect(c.depth).toBeLessThan(0);
    expect(c.push).toEqual([0, 0, 0]);
    expect(c.normal[1]).toBe(1);
  });

  it("球の中心が箱の中にあるときは、いちばん近い面から出す", () => {
    // 箱の中心 (0, 0.5, 0)。上面に近い (y = 0.9)
    const c = sphereVsCollider([0, 0.9, 0], PLAYER_RADIUS, box(1))!;
    expect(c.normal).toEqual([0, 1, 0]);
    near(c.depth, 0.1 + PLAYER_RADIUS); // 面まで 0.1、さらに半径ぶん
  });

  it("水平に回した (yaw) 箱でも、回した向きの面で判定する", () => {
    // 幅 4 (x)・奥行 0.2 の板を、yaw = 90 度 回す: 板の面は、ワールドの X 軸方向を向く
    const plate: Collider = { position: [0, 0, 0], yaw: Math.PI / 2, pitch: 0, center: [0, 1, 0], half: [2, 1, 0.1] };
    // 回すと、板の厚み (0.2) は X 方向になる。x = 0.35 の球は、厚みの外側から 0.05 食い込む
    const c = sphereVsCollider([0.35, 1, 0], PLAYER_RADIUS, plate)!;
    near(c.depth, 0.05);
    near(c.normal[0], 1);
    // 回す前の向きなら、同じ位置では触れていない (幅方向 2 の内側なので、厚みの外 0.25 > 半径 0.3 ではないが…)
    const unrotated: Collider = { ...plate, yaw: 0 };
    expect(sphereVsCollider([0.35, 1, 0], PLAYER_RADIUS, unrotated)!.depth).toBeCloseTo(PLAYER_RADIUS + 0.1, 3); // 板の中に入っている
  });

  it("垂直に傾けた (pitch) 箱では、傾いた面の向きへ押し出す", () => {
    // 幅 4・厚み 0.2 の板を、X 軸のまわりに 45 度 傾ける (上面の法線が、斜め上を向く)
    const slab: Collider = { position: [0, 0, 0], yaw: 0, pitch: Math.PI / 4, center: [0, 0, 0], half: [2, 0.1, 2] };
    const c = sphereVsCollider([0, 0.2, 0], PLAYER_RADIUS, slab)!;
    // 法線は、(0, cos 45°, sin 45°) の向き (ローカルの +Y を X 軸まわりに 45 度回したもの)
    near(c.normal[1], Math.cos(Math.PI / 4));
    near(Math.abs(c.normal[2]), Math.sin(Math.PI / 4));
    near(Math.hypot(...c.normal), 1);
  });
});

describe("resolvePlayer", () => {
  it("何もなければ、位置は変わらず、立ってもいない", () => {
    const r = resolvePlayer([0, 3, 0], STAND, [box(1)]);
    expect(r.position).toEqual([0, 3, 0]);
    expect(r.grounded).toBe(false);
  });

  it("箱の上に落ちてきたら、上面に立つ (足元が箱の高さ)", () => {
    // 足元 y = 0.95 (箱の上面 y = 1 に 5cm 食い込んでいる)
    const r = resolvePlayer([0, 0.95, 0], STAND, [box(1)]);
    near(r.position[1], 1);
    expect(r.grounded).toBe(true);
    expect(r.hitCeiling).toBe(false);
  });

  it("箱の上面にちょうど立っている (食い込んでいない) ときも、立っていると判定する", () => {
    const r = resolvePlayer([0, 1.002, 0], STAND, [box(1)]);
    expect(r.grounded).toBe(true);
    near(r.position[1], 1.002); // 動かさない
  });

  it("箱から少し離れて浮いていれば、立っていない", () => {
    const r = resolvePlayer([0, 1.2, 0], STAND, [box(1)]);
    expect(r.grounded).toBe(false);
  });

  it("壁 (箱の側面) に歩いて突っ込むと、半径ぶん手前で止まる。立っているのは、そのまま", () => {
    // 箱の側面は x = 0.5。足元 x = 0.6 なので、半径 0.3 の球は、0.2 食い込む
    const r = resolvePlayer([0.6, 0, 0], STAND, [box(2, [0, 0, 0])]);
    near(r.position[0], 1 + PLAYER_RADIUS); // 一辺 2 の箱は x = -1〜1。壁の外 0.3 まで
    expect(r.hitWall).toBe(true);
  });

  it("壁に斜めに突っ込んでも、壁に沿って滑る (壁と平行な方向には動ける)", () => {
    // 一辺 2 の箱の壁 (x = 1) に、x 方向に 0.1 食い込み、z 方向には 0.5 動いたあと
    const r = resolvePlayer([0.95, 0, 0.5], STAND, [box(2, [0, 0, 0])]);
    near(r.position[0], 1 + PLAYER_RADIUS);
    near(r.position[2], 0.5); // z は、そのまま
  });

  it("頭が箱の下面に当たると、天井として押し下げられる", () => {
    // 高さ 1 の台 (y = 2〜3) の下。足元 y = 0.3 だと、頭の上端 (2.1) が 0.1 食い込む
    const ceiling = box(1, [0, 2, 0]);
    const r = resolvePlayer([0, 0.3, 0], STAND, [ceiling]);
    near(r.position[1], 0.2);
    expect(r.hitCeiling).toBe(true);
    expect(r.grounded).toBe(false);
  });

  it("傾けた板の上では、急すぎる斜面 (約 60 度より急) には、立てない", () => {
    const steep: Collider = { position: [0, 0, 0], yaw: 0, pitch: Math.atan(2), center: [0, 0, 0], half: [3, 0.1, 3] }; // 約 63 度
    const gentle: Collider = { ...steep, pitch: 0.4 }; // 約 23 度
    // 足の球が、板の上面に、少し食い込む高さに置く (板の面までの距離 = 半径 - 食い込み)
    const heightFor = (pitch: number) => (0.1 + PLAYER_RADIUS - 0.03) / Math.cos(pitch) - PLAYER_RADIUS;
    const steepResult = resolvePlayer([0, heightFor(Math.atan(2)), 0], STAND, [steep]);
    const gentleResult = resolvePlayer([0, heightFor(0.4), 0], STAND, [gentle]);
    expect(steepResult.grounded).toBe(false);
    expect(gentleResult.grounded).toBe(true);
  });

  it("中に埋まっていても、いちばん浅い面から出る (有限の位置になる)", () => {
    const r = resolvePlayer([0, 0.2, 0], STAND, [box(1)]); // 足元が、箱の中
    for (const n of r.position) expect(Number.isFinite(n)).toBe(true);
    expect(overlapsAny(r.position, STAND, [box(1)])).toBe(false);
  });

  it("薄い板は、歩く速さの 1 フレーム (最大 0.15m) では、すり抜けない", () => {
    const wall: Collider = { position: [0, 0, 0], yaw: 0, pitch: 0, center: [0, 1, 0], half: [2, 1, PLATE_THICKNESS / 2] };
    // 板の手前 (z < 0) から、奥へ 0.15m ずつ歩いて、板を越えようとする
    let z = -0.8;
    for (let i = 0; i < 20; i++) {
      z += 0.15;
      z = resolvePlayer([0, 0, z], STAND, [wall]).position[2];
    }
    expect(z).toBeLessThan(0); // 板の手前に、とどまっている
    expect(z).toBeGreaterThan(-PLAYER_RADIUS - PLATE_THICKNESS); // 半径ぶんの手前まで来ている
  });

  it("コライダーが複数あっても、すべてから押し出す", () => {
    const a = box(1, [0, 0, 0]);
    const b = box(1, [0.8, 0, 0]);
    const r = resolvePlayer([0.4, 0.1, 0], STAND, [a, b]);
    expect(overlapsAny(r.position, STAND, [a, b])).toBe(false);
  });
});

describe("bodySpheres / overlapsAny", () => {
  it("立っているときと、しゃがんだときで、頭の球の高さが変わる", () => {
    const stand = bodySpheres([0, 0, 0], STAND);
    const crouch = bodySpheres([0, 0, 0], CROUCH);
    near(stand[0]![1], PLAYER_RADIUS);
    near(stand[2]![1], STAND - PLAYER_RADIUS);
    near(crouch[2]![1], CROUCH - PLAYER_RADIUS);
    expect(crouch[2]![1]).toBeLessThan(stand[2]![1]);
  });

  it("低い天井の下では、しゃがめば入れて、立つと食い込む (立ち上がれるかの確認)", () => {
    // 足元から 1.4m の高さに、下面がある台
    const low = box(1, [0, 1.4, 0]);
    expect(overlapsAny([0, 0, 0], CROUCH, [low])).toBe(false);
    expect(overlapsAny([0, 0, 0], STAND, [low])).toBe(true);
  });

  it("コライダーが無ければ、食い込まない", () => {
    expect(overlapsAny([0, 0, 0], STAND, [])).toBe(false);
  });
});
