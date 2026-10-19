import { describe, expect, it } from "vitest";
import type { Pose } from "@proto/protocol";
import { PoseBuffer, slerpQuat } from "./interpolation";

const pose = (x: number, yawDeg = 0): Pose => {
  const h = (yawDeg * Math.PI) / 180 / 2;
  return { position: [x, 0, 0], head: [0, Math.sin(h), 0, Math.cos(h)] };
};

describe("PoseBuffer", () => {
  it("returns null when empty", () => {
    expect(new PoseBuffer().sample(0)).toBeNull();
  });

  it("interpolates between samples", () => {
    const b = new PoseBuffer();
    b.push(1000, pose(0));
    b.push(1050, pose(10));
    expect(b.sample(1025)?.position[0]).toBeCloseTo(5);
  });

  it("clamps outside the range (no extrapolation)", () => {
    const b = new PoseBuffer();
    b.push(1000, pose(0));
    b.push(1050, pose(10));
    expect(b.sample(900)?.position[0]).toBe(0);
    expect(b.sample(2000)?.position[0]).toBe(10);
  });

  it("interpolates the height (jumping) and the crouch", () => {
    const b = new PoseBuffer();
    b.push(1000, { position: [0, 0, 0], head: [0, 0, 0, 1], crouch: 0 });
    b.push(1050, { position: [0, 1, 0], head: [0, 0, 0, 1], crouch: 1 });
    const mid = b.sample(1025)!;
    expect(mid.position[1]).toBeCloseTo(0.5);
    expect(mid.crouch).toBeCloseTo(0.5);
    // しゃがみを送ってこない相手 (古いクライアント) は、立っているとみなす
    b.push(1100, { position: [0, 0, 0], head: [0, 0, 0, 1] });
    expect(b.sample(1075)?.crouch).toBeCloseTo(0.5);
  });

  it("interpolates the lean, and treats a missing lean as upright", () => {
    const b = new PoseBuffer();
    b.push(1000, { position: [0, 0, 0], head: [0, 0, 0, 1], lean: -1 });
    b.push(1050, { position: [0, 0, 0], head: [0, 0, 0, 1], lean: 1 });
    expect(b.sample(1025)?.lean).toBeCloseTo(0);
    b.push(1100, { position: [0, 0, 0], head: [0, 0, 0, 1] });
    expect(b.sample(1075)?.lean).toBeCloseTo(0.5);
  });

  it("ignores out-of-order samples", () => {
    const b = new PoseBuffer();
    b.push(1000, pose(0));
    b.push(1050, pose(10));
    b.push(1020, pose(99));
    expect(b.sample(1050)?.position[0]).toBe(10);
  });
});

describe("slerpQuat", () => {
  it("interpolates yaw halfway", () => {
    const a = pose(0, 0).head;
    const b = pose(0, 90).head;
    const mid = slerpQuat(a, b, 0.5);
    const expected = pose(0, 45).head;
    for (let i = 0; i < 4; i++) expect(mid[i]).toBeCloseTo(expected[i]!);
  });

  it("takes the shortest path", () => {
    const a = pose(0, 0).head;
    const b = pose(0, 90).head.map((v) => -v) as typeof a; // 同じ回転の逆符号
    const mid = slerpQuat(a, b, 0.5);
    const expected = pose(0, 45).head;
    for (let i = 0; i < 4; i++) expect(mid[i]).toBeCloseTo(expected[i]!);
  });
});
