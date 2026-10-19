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
  LEAN_ANGLE,
  moveSpeedFactor,
  SPRINT_SPEED_FACTOR,
  leanPose,
  speedFactorFor,
  stepLean,
  stepVertical,
  type Vertical,
  type VerticalInput,
} from "./movement";

const DT = 1 / 60;
const NONE: VerticalInput = { jump: false, jumpPressed: false, crouch: false };
/** キーを押した瞬間 (押し始め) のフレーム。 */
const PRESS: VerticalInput = { jump: true, jumpPressed: true, crouch: false };

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
    let v = stepVertical(initialVertical(), { jump: true, jumpPressed: false, crouch: false }, DT);
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

  it("押し続けているだけでは、空中でジャンプしない (押し直したときだけ)", () => {
    let v = stepVertical(initialVertical(), { jump: true, jumpPressed: true, crouch: false }, DT);
    for (let i = 0; i < 5; i++) v = stepVertical(v, { jump: true, jumpPressed: false, crouch: false }, DT);
    const vyBefore = v.vy;
    const after = stepVertical(v, { jump: true, jumpPressed: false, crouch: false }, DT);
    expect(after.vy).toBeLessThan(vyBefore); // 速さは増えず、重力で落ちていく
  });

  it("Space を押し続けると、着地してすぐ、また跳ぶ", () => {
    const states = run(initialVertical(), { jump: true, jumpPressed: false, crouch: false }, 2);
    const landings = states.filter((s, i) => i > 0 && s.y === 0 && states[i - 1]!.y > 0).length;
    expect(landings).toBeGreaterThanOrEqual(2);
  });

  it("地面より下には行かない", () => {
    const states = run(initialVertical(), { jump: true, jumpPressed: false, crouch: false }, 3);
    expect(Math.min(...states.map((s) => s.y))).toBeGreaterThanOrEqual(0);
  });
});

describe("stepVertical: しゃがみ", () => {
  it("C を押している間、しゃがみが深くなり、離すと立ち上がる", () => {
    const down = run(initialVertical(), { jump: false, jumpPressed: false, crouch: true }, 0.6).at(-1)!;
    expect(down.crouch).toBeGreaterThan(0.99);
    const up = run(down, NONE, 0.6).at(-1)!;
    expect(up.crouch).toBeLessThan(0.01);
  });

  it("しゃがみは滑らかに変わる (1 フレームでは飛ばない)", () => {
    const first = stepVertical(initialVertical(), { jump: false, jumpPressed: false, crouch: true }, DT);
    expect(first.crouch).toBeGreaterThan(0);
    expect(first.crouch).toBeLessThan(0.5);
  });

  it("しゃがんでいる間は、ジャンプできない", () => {
    const crouched = run(initialVertical(), { jump: false, jumpPressed: false, crouch: true }, 0.6).at(-1)!;
    const v = stepVertical(crouched, { jump: true, jumpPressed: false, crouch: true }, DT);
    expect(v.y).toBe(0);
    expect(v.vy).toBe(0);
  });

  it("空中でもしゃがめる", () => {
    let v = stepVertical(initialVertical(), { jump: true, jumpPressed: false, crouch: false }, DT);
    for (let i = 0; i < 6; i++) v = stepVertical(v, { jump: false, jumpPressed: false, crouch: true }, DT);
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

describe("リーン", () => {
  it("押している間は、その向きへ滑らかに傾き、離すと戻る", () => {
    let lean = 0;
    lean = stepLean(lean, 1, DT);
    expect(lean).toBeGreaterThan(0);
    expect(lean).toBeLessThan(0.5); // 1 フレームでは飛ばない
    for (let i = 0; i < 60; i++) lean = stepLean(lean, 1, DT);
    expect(lean).toBeGreaterThan(0.99);
    for (let i = 0; i < 60; i++) lean = stepLean(lean, 0, DT);
    expect(Math.abs(lean)).toBeLessThan(0.01);
  });

  it("左 (-1) へも傾く。左右を同時に押したら、まっすぐ (呼び出し側が 0 にする)", () => {
    let lean = 0;
    for (let i = 0; i < 60; i++) lean = stepLean(lean, -1, DT);
    expect(lean).toBeLessThan(-0.99);
  });

  it("まっすぐなら、頭は真上にあり、傾かない", () => {
    const pose = leanPose(1.6, 0);
    expect(pose.side).toBeCloseTo(0);
    expect(pose.height).toBeCloseTo(1.6);
    expect(pose.roll).toBeCloseTo(0);
  });

  it("右へ傾けると、頭は右へずれて少し下がり、傾きは正。左なら逆", () => {
    const right = leanPose(1.6, 1);
    expect(right.roll).toBeCloseTo(LEAN_ANGLE);
    expect(right.side).toBeCloseTo(1.6 * Math.sin(LEAN_ANGLE));
    expect(right.side).toBeGreaterThan(0.3); // 約 0.47m
    expect(right.height).toBeLessThan(1.6);
    expect(right.height).toBeGreaterThan(1.5);
    const left = leanPose(1.6, -1);
    expect(left.side).toBeCloseTo(-right.side);
    expect(left.height).toBeCloseTo(right.height);
    expect(left.roll).toBeCloseTo(-LEAN_ANGLE);
  });

  it("頭と足元の距離は、傾いても変わらない (足元を中心に傾く)", () => {
    for (const lean of [-1, -0.4, 0.7, 1]) {
      const p = leanPose(1.2, lean);
      expect(Math.hypot(p.side, p.height)).toBeCloseTo(1.2);
    }
  });

  it("しゃがんでいると、ずれる量も小さい", () => {
    expect(leanPose(0.9, 1).side).toBeLessThan(leanPose(1.6, 1).side);
  });

  it("範囲 (-1〜1) の外は丸める", () => {
    expect(leanPose(1.6, 5).roll).toBeCloseTo(LEAN_ANGLE);
    expect(leanPose(1.6, -5).roll).toBeCloseTo(-LEAN_ANGLE);
  });
});

describe("二段ジャンプ", () => {
  /** 地面から跳んで、n フレーム空中で待つ。 */
  const airborne = (frames: number): Vertical => {
    let v = stepVertical(initialVertical(), PRESS, DT);
    for (let i = 0; i < frames; i++) v = stepVertical(v, NONE, DT);
    return v;
  };

  it("空中でキーを押し直すと、もう一度跳べる (上向きの速さが、また初速になる)", () => {
    const v = airborne(24); // 頂点 (約 18 フレーム) を過ぎて、落ち始めている
    expect(v.vy).toBeLessThan(0);
    expect(v.grounded).toBe(false);
    const second = stepVertical(v, PRESS, DT);
    expect(second.vy).toBeGreaterThan(JUMP_SPEED - GRAVITY * DT - 0.01);
    expect(second.airJumps).toBe(0);
  });

  it("二段ジャンプで、1 回目より高く上がれる (2 回目の頂点が、1 回目より上)", () => {
    let v = stepVertical(initialVertical(), PRESS, DT);
    let firstPeak = v.y;
    for (let i = 0; i < 18; i++) {
      v = stepVertical(v, i === 17 ? PRESS : NONE, DT); // 頂点の少し前で、もう一度
      firstPeak = Math.max(firstPeak, v.y);
    }
    let peak = v.y;
    for (let i = 0; i < 60; i++) {
      v = stepVertical(v, NONE, DT);
      peak = Math.max(peak, v.y);
    }
    const singlePeak = (JUMP_SPEED * JUMP_SPEED) / (2 * GRAVITY);
    expect(peak).toBeGreaterThan(singlePeak * 1.5);
  });

  it("三段ジャンプはできない (空中で使えるのは 1 回だけ)", () => {
    let v = airborne(10);
    v = stepVertical(v, PRESS, DT); // 二段目
    for (let i = 0; i < 5; i++) v = stepVertical(v, NONE, DT);
    const vyBefore = v.vy;
    const third = stepVertical(v, PRESS, DT);
    expect(third.vy).toBeLessThan(vyBefore);
    expect(third.airJumps).toBe(0);
  });

  it("着地すると、また二段ジャンプできる", () => {
    let v = airborne(10);
    v = stepVertical(v, PRESS, DT); // 二段目を使い切る
    while (!v.grounded) v = stepVertical(v, NONE, DT);
    expect(v.y).toBe(0);
    v = stepVertical(v, PRESS, DT); // 地面から跳ぶ
    for (let i = 0; i < 6; i++) v = stepVertical(v, NONE, DT);
    expect(v.airJumps).toBe(1); // 立っていた間に、回数が戻っている
    const second = stepVertical(v, PRESS, DT);
    expect(second.airJumps).toBe(0);
    expect(second.vy).toBeGreaterThan(0);
  });

  it("物の上に立って (grounded が真になって) いれば、そこから跳べ、空中でもう一度跳べる", () => {
    // 足元 y = 1 の箱の上に立っている状態 (当たり判定が grounded を入れる)
    let v: Vertical = { y: 1, vy: 0, crouch: 0, grounded: true, airJumps: 0 };
    v = stepVertical(v, PRESS, DT);
    expect(v.vy).toBeGreaterThan(0);
    expect(v.y).toBeGreaterThan(1);
    for (let i = 0; i < 8; i++) v = stepVertical(v, NONE, DT);
    expect(v.airJumps).toBe(1); // 立っていたので、回数が戻っていた
    v = stepVertical(v, PRESS, DT);
    expect(v.airJumps).toBe(0);
  });

  it("縁から歩いて落ちたときも、空中で 1 回跳べる", () => {
    const falling: Vertical = { y: 1, vy: -2, crouch: 0, grounded: false, airJumps: 1 };
    expect(stepVertical(falling, PRESS, DT).vy).toBeGreaterThan(0);
  });

  it("しゃがんでいる間は、空中でも跳べない", () => {
    const v: Vertical = { y: 1, vy: -2, crouch: 0.9, grounded: false, airJumps: 1 };
    const after = stepVertical(v, PRESS, DT);
    expect(after.vy).toBeLessThan(-2);
    expect(after.airJumps).toBe(1);
  });

  it("物の上でしゃがんでいても、ジャンプはできない", () => {
    const v: Vertical = { y: 1, vy: 0, crouch: 0.9, grounded: true, airJumps: 1 };
    expect(stepVertical(v, PRESS, DT).vy).toBeLessThanOrEqual(0);
  });
});

describe("走る (Shift)", () => {
  it("立っているときは、走ると歩く速さの 2 倍", () => {
    expect(moveSpeedFactor(0, false)).toBe(1);
    expect(moveSpeedFactor(0, true)).toBe(SPRINT_SPEED_FACTOR);
    expect(SPRINT_SPEED_FACTOR).toBe(2);
  });

  it("しゃがんでいるときは、Shift を押しても走れない (しゃがみの速さのまま)", () => {
    expect(moveSpeedFactor(1, true)).toBe(CROUCH_SPEED_FACTOR);
    expect(moveSpeedFactor(0.6, true)).toBeCloseTo(speedFactorFor(0.6)); // 0.5 より深い
    expect(moveSpeedFactor(0.5, true)).toBeCloseTo(speedFactorFor(0.5)); // 境界も走れない
    expect(moveSpeedFactor(0.4, true)).toBeCloseTo(speedFactorFor(0.4) * SPRINT_SPEED_FACTOR); // 浅ければ走れる
  });

  it("範囲外のしゃがみは丸める", () => {
    expect(moveSpeedFactor(-1, true)).toBe(SPRINT_SPEED_FACTOR);
    expect(moveSpeedFactor(9, true)).toBe(CROUCH_SPEED_FACTOR);
  });
});
