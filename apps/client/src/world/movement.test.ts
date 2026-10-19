import { describe, expect, it } from "vitest";
import {
  CROUCH_EYE_HEIGHT,
  CROUCH_SPEED_FACTOR,
  EYE_HEIGHT,
  GRAVITY,
  JUMP_SPEED,
  eyeHeightFor,
  initialVertical,
  isGrounded,
  speedFactorFor,
  stepVertical,
  type Vertical,
  type VerticalInput,
} from "./movement";

const DT = 1 / 60;
const NONE: VerticalInput = { jump: false, crouch: false };

/** 入力を一定にして、秒数ぶん進める。途中の状態も返す。 */
function run(start: Vertical, input: VerticalInput, seconds: number): Vertical[] {
  const states: Vertical[] = [];
  let v = start;
  for (let t = 0; t < seconds; t += DT) {
    v = stepVertical(v, input, DT);
    states.push(v);
  }
  return states;
}

describe("stepVertical: ジャンプ", () => {
  it("何も押さなければ、地面にいたまま", () => {
    const v = run(initialVertical(), NONE, 1).at(-1)!;
    expect(v.y).toBe(0);
    expect(v.vy).toBe(0);
    expect(isGrounded(v)).toBe(true);
  });

  it("Space で跳び上がり、頂点で約 v^2 / 2g の高さに達し、地面に戻る", () => {
    // 1 回跳んで、離して着地まで待つ
    let v = stepVertical(initialVertical(), { jump: true, crouch: false }, DT);
    expect(v.vy).toBeGreaterThan(0); // 跳んだ
    let peak = v.y;
    let airFrames = 1;
    while (!isGrounded(v) && airFrames < 600) {
      v = stepVertical(v, NONE, DT);
      peak = Math.max(peak, v.y);
      airFrames++;
    }
    const expectedPeak = (JUMP_SPEED * JUMP_SPEED) / (2 * GRAVITY);
    expect(peak).toBeGreaterThan(expectedPeak * 0.9);
    expect(peak).toBeLessThanOrEqual(expectedPeak * 1.05);
    expect(v.y).toBe(0);
    expect(airFrames * DT).toBeGreaterThan(0.5); // 滞空は約 0.6 秒
    expect(airFrames * DT).toBeLessThan(0.75);
  });

  it("空中では、もう一度ジャンプできない (二段ジャンプなし)", () => {
    let v = stepVertical(initialVertical(), { jump: true, crouch: false }, DT);
    for (let i = 0; i < 5; i++) v = stepVertical(v, NONE, DT);
    const vyBefore = v.vy;
    const after = stepVertical(v, { jump: true, crouch: false }, DT);
    expect(after.vy).toBeLessThan(vyBefore); // 速さは増えず、重力で落ちていく
  });

  it("Space を押し続けると、着地してすぐ、また跳ぶ", () => {
    const states = run(initialVertical(), { jump: true, crouch: false }, 2);
    const landings = states.filter((s, i) => i > 0 && s.y === 0 && states[i - 1]!.y > 0).length;
    expect(landings).toBeGreaterThanOrEqual(2);
  });

  it("地面より下には行かない", () => {
    const states = run(initialVertical(), { jump: true, crouch: false }, 3);
    expect(Math.min(...states.map((s) => s.y))).toBeGreaterThanOrEqual(0);
  });
});

describe("stepVertical: しゃがみ", () => {
  it("C を押している間、しゃがみが深くなり、離すと立ち上がる", () => {
    const down = run(initialVertical(), { jump: false, crouch: true }, 0.6).at(-1)!;
    expect(down.crouch).toBeGreaterThan(0.99);
    const up = run(down, NONE, 0.6).at(-1)!;
    expect(up.crouch).toBeLessThan(0.01);
  });

  it("しゃがみは滑らかに変わる (1 フレームでは飛ばない)", () => {
    const first = stepVertical(initialVertical(), { jump: false, crouch: true }, DT);
    expect(first.crouch).toBeGreaterThan(0);
    expect(first.crouch).toBeLessThan(0.5);
  });

  it("しゃがんでいる間は、ジャンプできない", () => {
    const crouched = run(initialVertical(), { jump: false, crouch: true }, 0.6).at(-1)!;
    const v = stepVertical(crouched, { jump: true, crouch: true }, DT);
    expect(v.y).toBe(0);
    expect(v.vy).toBe(0);
  });

  it("空中でもしゃがめる", () => {
    let v = stepVertical(initialVertical(), { jump: true, crouch: false }, DT);
    for (let i = 0; i < 6; i++) v = stepVertical(v, { jump: false, crouch: true }, DT);
    expect(v.crouch).toBeGreaterThan(0.3);
    expect(v.y).toBeGreaterThan(0);
  });

  it("目の高さは、立っているときと、しゃがみきったときの間を動く", () => {
    expect(eyeHeightFor(0)).toBe(EYE_HEIGHT);
    expect(eyeHeightFor(1)).toBe(CROUCH_EYE_HEIGHT);
    expect(eyeHeightFor(0.5)).toBeCloseTo((EYE_HEIGHT + CROUCH_EYE_HEIGHT) / 2);
    expect(eyeHeightFor(-1)).toBe(EYE_HEIGHT); // 範囲外は丸める
    expect(eyeHeightFor(9)).toBe(CROUCH_EYE_HEIGHT);
  });

  it("しゃがむほど、歩く速さが落ちる", () => {
    expect(speedFactorFor(0)).toBe(1);
    expect(speedFactorFor(1)).toBe(CROUCH_SPEED_FACTOR);
    expect(speedFactorFor(0.5)).toBeGreaterThan(CROUCH_SPEED_FACTOR);
    expect(speedFactorFor(0.5)).toBeLessThan(1);
  });
});
