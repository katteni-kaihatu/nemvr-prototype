import { describe, expect, it } from "vitest";
import { parseClientMessage, parsePose, sanitizeName } from "./validate.js";

describe("sanitizeName", () => {
  it("trims and truncates", () => {
    expect(sanitizeName("  alice  ", "x")).toBe("alice");
    expect(sanitizeName("a".repeat(100), "x")).toHaveLength(24);
  });
  it("falls back for empty / non-string", () => {
    expect(sanitizeName("   ", "ab12")).toBe("Guest-ab12");
    expect(sanitizeName(42, "ab12")).toBe("Guest-ab12");
  });
});

describe("parsePose", () => {
  it("accepts a valid pose and normalizes the quaternion", () => {
    const pose = parsePose({ position: [1, 2, 3], head: [0, 0, 0, 2] });
    expect(pose).toEqual({ position: [1, 2, 3], head: [0, 0, 0, 1] });
  });
  it("rejects invalid values", () => {
    expect(parsePose(null)).toBeNull();
    expect(parsePose({ position: [0, 0], head: [0, 0, 0, 1] })).toBeNull();
    expect(parsePose({ position: [NaN, 0, 0], head: [0, 0, 0, 1] })).toBeNull();
    expect(parsePose({ position: [0, 0, 0], head: [0, 0, 0, 0] })).toBeNull();
    expect(parsePose({ position: [1001, 0, 0], head: [0, 0, 0, 1] })).toBeNull();
    expect(parsePose({ position: ["0", 0, 0], head: [0, 0, 0, 1] })).toBeNull();
  });
});

describe("parseClientMessage", () => {
  it("parses join and pose", () => {
    expect(parseClientMessage('{"type":"join","name":"bob"}')).toEqual({
      type: "join",
      name: "bob",
    });
    expect(
      parseClientMessage(
        JSON.stringify({ type: "pose", pose: { position: [0, 0, 0], head: [0, 0, 0, 1] } }),
      ),
    ).toMatchObject({ type: "pose" });
  });
  describe("place_image", () => {
    const valid = {
      type: "place_image",
      imageId: "123e4567-e89b-12d3-a456-426614174000",
      position: [1, 0, -2],
      yaw: 1.5,
      width: 2,
      height: 1.5,
    };
    it("accepts a valid message", () => {
      expect(parseClientMessage(JSON.stringify(valid))).toEqual(valid);
    });
    it("rejects invalid fields", () => {
      const bad = (patch: object) => parseClientMessage(JSON.stringify({ ...valid, ...patch }));
      expect(bad({ imageId: "../etc/passwd" })).toBeNull();
      expect(bad({ position: [1, 0] })).toBeNull();
      expect(bad({ position: [5000, 0, 0] })).toBeNull();
      expect(bad({ yaw: "1" })).toBeNull();
      expect(bad({ width: 0 })).toBeNull();
      expect(bad({ height: 1000 })).toBeNull();
      expect(bad({ width: null })).toBeNull();
    });
  });

  it("returns null for garbage", () => {
    expect(parseClientMessage("not json")).toBeNull();
    expect(parseClientMessage("123")).toBeNull();
    expect(parseClientMessage('{"type":"nope"}')).toBeNull();
    expect(parseClientMessage('{"type":"pose","pose":{}}')).toBeNull();
  });
});
