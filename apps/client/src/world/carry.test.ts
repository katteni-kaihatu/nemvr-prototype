import { describe, expect, it } from "vitest";
import { attach, resolve, wrapAngle } from "./carry";

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
