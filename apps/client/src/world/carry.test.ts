import { describe, expect, it } from "vitest";
import { attach, liftedHeight, MAX_PULL_DISTANCE, MIN_PULL_DISTANCE, pulled, resolve, wrapAngle } from "./carry";

const near = (a: number, b: number) => expect(a).toBeCloseTo(b, 6);

describe("attach / resolve", () => {
  it("restores the object when the camera has not moved", () => {
    const camera = { x: 1, z: 2, yaw: 0.7 };
    const object = { x: -3, y: 0.5, z: 4, yaw: 1.1 };
    const back = resolve(attach(camera, object), camera);
    near(back.x, object.x);
    near(back.y, object.y);
    near(back.z, object.z);
    near(back.yaw, object.yaw);
  });

  it("an object straight ahead has a relative position of -Z", () => {
    // yaw 90° のとき前方は -X。その 1m 先にある物は、カメラ座標では (0, -1)
    const att = attach({ x: 0, z: 0, yaw: Math.PI / 2 }, { x: -1, y: 0, z: 0, yaw: 0 });
    near(att.dx, 0);
    near(att.dz, -1);
  });

  it("keeps the object in front of the camera when the camera turns", () => {
    const start = { x: 0, z: 0, yaw: 0 };
    const att = attach(start, { x: 0, y: 0, z: -4, yaw: 0 }); // 4m 先 (前方 = -Z)
    // 右へ 90° 向く (yaw が -90°) と、前方は +X になる
    const turned = resolve(att, { x: 0, z: 0, yaw: -Math.PI / 2 });
    near(turned.x, 4);
    near(turned.z, 0);
    near(turned.yaw, -Math.PI / 2); // 向きも一緒に回る
  });

  it("follows the camera when it walks", () => {
    const att = attach({ x: 0, z: 0, yaw: 0 }, { x: 1, y: 0, z: -3, yaw: 0 });
    const moved = resolve(att, { x: 10, z: 5, yaw: 0 });
    near(moved.x, 11);
    near(moved.z, 2);
  });

  it("does not change the height", () => {
    const att = attach({ x: 0, z: 0, yaw: 0.3 }, { x: 1, y: 2, z: 1, yaw: 0 });
    expect(resolve(att, { x: 5, z: 5, yaw: 2 }).y).toBe(2);
  });
});

describe("wrapAngle", () => {
  it("wraps into [-π, π)", () => {
    near(wrapAngle(0), 0);
    near(wrapAngle(Math.PI * 2), 0);
    near(wrapAngle(Math.PI * 1.5), -Math.PI / 2);
    near(wrapAngle(-Math.PI * 1.5), Math.PI / 2);
    near(wrapAngle(7), 7 - Math.PI * 2);
  });
});

const EYE = 1.6;
const MAX = 20;

describe("liftedHeight (視点を上下させて、つかんだものを持ち上げる)", () => {
  it("視点を動かさなければ、高さは変わらない", () => {
    expect(liftedHeight(0.7, 4, 0, EYE, MAX)).toBeCloseTo(0.7);
  });

  it("視点を上げると上がり、下げると下がる", () => {
    expect(liftedHeight(1, 4, 0.1, EYE, MAX)).toBeGreaterThan(1);
    expect(liftedHeight(1, 4, -0.1, EYE, MAX)).toBeLessThan(1);
  });

  it("視線の先に付いたまま動く: 視線の方向 (仰角) の変化と、オブジェクトの仰角の変化が等しい", () => {
    const d = 5;
    const y0 = 3;
    const dPitch = 0.2;
    const y1 = liftedHeight(y0, d, dPitch, EYE, MAX);
    const aim0 = Math.atan2(y0 - EYE, d);
    const aim1 = Math.atan2(y1 - EYE, d);
    expect(aim1 - aim0).toBeCloseTo(dPitch, 6);
  });

  it("上げて下げると、元の高さに戻る", () => {
    const up = liftedHeight(1, 4, 0.3, EYE, MAX);
    expect(liftedHeight(up, 4, -0.3, EYE, MAX)).toBeCloseTo(1, 6);
  });

  it("遠いほど、同じ視点の動きで大きく動く", () => {
    const near = liftedHeight(EYE, 2, 0.1, EYE, MAX) - EYE;
    const far = liftedHeight(EYE, 8, 0.1, EYE, MAX) - EYE;
    expect(far).toBeGreaterThan(near * 3);
  });

  it("床より下には行かず、上限で止まる", () => {
    expect(liftedHeight(0.2, 4, -1, EYE, MAX)).toBe(0);
    expect(liftedHeight(19, 8, 1, EYE, MAX)).toBe(MAX);
  });

  it("床に当たったあとでも、視点を戻せばすぐ上がる (丸めた高さから求め直す)", () => {
    const floor = liftedHeight(0.2, 4, -1, EYE, MAX); // 0
    expect(liftedHeight(floor, 4, 0.05, EYE, MAX)).toBeGreaterThan(0);
  });

  it("近すぎる (距離 0) でも、視点を動かせば高さが動く", () => {
    expect(liftedHeight(EYE, 0, 0.2, EYE, MAX)).toBeGreaterThan(EYE);
  });

  it("真上を向いても、有限の値になる", () => {
    expect(Number.isFinite(liftedHeight(1, 4, 10, EYE, MAX))).toBe(true);
    expect(Number.isFinite(liftedHeight(1, 4, -10, EYE, MAX))).toBe(true);
  });
});

describe("pulled (ホイールで、つかんだものを遠ざける / 引き寄せる)", () => {
  const horizontal = (a: { dx: number; dz: number }) => Math.hypot(a.dx, a.dz);

  it("factor 倍の距離になり、カメラから見た向きは変わらない", () => {
    const before = { dx: 3, dz: -4, y: 1 };
    const after = pulled(before, 1.5, EYE, MAX);
    expect(horizontal(after)).toBeCloseTo(7.5);
    expect(Math.atan2(after.dx, after.dz)).toBeCloseTo(Math.atan2(before.dx, before.dz));
  });

  it("遠ざけて引き寄せると、元に戻る", () => {
    const before = { dx: 1, dz: -3, y: 2.5 };
    const far = pulled(before, 1.12 ** 3, EYE, MAX);
    const back = pulled(far, 1.12 ** -3, EYE, MAX);
    expect(back.dx).toBeCloseTo(before.dx);
    expect(back.dz).toBeCloseTo(before.dz);
    expect(back.y).toBeCloseTo(before.y);
  });

  it("目の高さから見た仰角は変わらない (視線の先に付いたまま動く)", () => {
    const before = { dx: 0, dz: -4, y: 3 };
    const after = pulled(before, 2, EYE, MAX);
    expect(Math.atan2(after.y - EYE, horizontal(after))).toBeCloseTo(Math.atan2(before.y - EYE, 4));
  });

  it("目の高さにあるものは、遠ざけても高さが変わらない", () => {
    expect(pulled({ dx: 0, dz: -4, y: EYE }, 3, EYE, MAX).y).toBeCloseTo(EYE);
  });

  it("近づけすぎない・遠ざけすぎない", () => {
    expect(horizontal(pulled({ dx: 0, dz: -2, y: 1 }, 0.1, EYE, MAX))).toBe(MIN_PULL_DISTANCE);
    expect(horizontal(pulled({ dx: 0, dz: -20, y: 1 }, 10, EYE, MAX))).toBe(MAX_PULL_DISTANCE);
  });

  it("範囲の外にあるものは、範囲の方向へだけ動く", () => {
    const tooNear = { dx: 0, dz: -0.3, y: 1 };
    expect(horizontal(pulled(tooNear, 0.5, EYE, MAX))).toBeCloseTo(0.3); // 近づける方向には動かない
    expect(horizontal(pulled(tooNear, 2, EYE, MAX))).toBeCloseTo(0.6); // 遠ざける方向には動く
    const tooFar = { dx: 0, dz: -40, y: 1 };
    expect(horizontal(pulled(tooFar, 2, EYE, MAX))).toBeCloseTo(40);
    expect(horizontal(pulled(tooFar, 0.5, EYE, MAX))).toBeCloseTo(20);
  });

  it("高さは床と上限の範囲に収まる", () => {
    expect(pulled({ dx: 0, dz: -4, y: 0 }, 5, EYE, MAX).y).toBe(0);
    expect(pulled({ dx: 0, dz: -4, y: 19 }, 5, EYE, MAX).y).toBe(MAX);
  });

  it("真下にある (距離 0) ものは、前方へ押し出される", () => {
    const after = pulled({ dx: 0, dz: 0, y: EYE }, 2, EYE, MAX);
    expect(after.dx).toBeCloseTo(0);
    expect(after.dz).toBeLessThan(0);
  });
});
