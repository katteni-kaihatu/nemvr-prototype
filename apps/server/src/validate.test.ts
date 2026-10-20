import { describe, expect, it } from "vitest";
import { CID } from "multiformats/cid";
import { sha256, sha512 } from "multiformats/hashes/sha2";
import { normalizeCid, parseClientMessage, parsePose, sanitizeName } from "./validate.js";

const CODEC_RAW = 0x55;
const CODEC_DAG_PB = 0x70;
const CODEC_DAG_CBOR = 0x71;
const bytes = new TextEncoder().encode("hello");
const rawCid = CID.createV1(CODEC_RAW, await sha256.digest(bytes)).toString();
const dagPbCid = CID.createV1(CODEC_DAG_PB, await sha256.digest(bytes)).toString();

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
  it("accepts an optional crouch, clamped to 0..1, and rejects a non-number crouch", () => {
    expect(parsePose({ position: [0, 0, 0], head: [0, 0, 0, 1], crouch: 0.5 })?.crouch).toBe(0.5);
    expect(parsePose({ position: [0, 0, 0], head: [0, 0, 0, 1], crouch: 7 })?.crouch).toBe(1);
    expect(parsePose({ position: [0, 0, 0], head: [0, 0, 0, 1], crouch: -3 })?.crouch).toBe(0);
    expect(parsePose({ position: [0, 0, 0], head: [0, 0, 0, 1] })).not.toHaveProperty("crouch");
    expect(parsePose({ position: [0, 0, 0], head: [0, 0, 0, 1], crouch: "1" })).toBeNull();
    expect(parsePose({ position: [0, 0, 0], head: [0, 0, 0, 1], crouch: NaN })).toBeNull();
  });
  it("accepts an optional lean, clamped to -1..1, and rejects a non-number lean", () => {
    const base = { position: [0, 0, 0], head: [0, 0, 0, 1] };
    expect(parsePose({ ...base, lean: -0.5 })?.lean).toBe(-0.5);
    expect(parsePose({ ...base, lean: 9 })?.lean).toBe(1);
    expect(parsePose({ ...base, lean: -9 })?.lean).toBe(-1);
    expect(parsePose(base)).not.toHaveProperty("lean");
    expect(parsePose({ ...base, lean: "1" })).toBeNull();
    expect(parsePose({ ...base, lean: NaN })).toBeNull();
    // しゃがみと同時でもよい
    expect(parsePose({ ...base, crouch: 0.5, lean: 0.25 })).toMatchObject({ crouch: 0.5, lean: 0.25 });
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
      cid: dagPbCid,
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
      expect(bad({ cid: "../etc/passwd" })).toBeNull();
      expect(bad({ cid: undefined })).toBeNull();
      expect(bad({ cid: "123e4567-e89b-12d3-a456-426614174000" })).toBeNull();
      expect(bad({ position: [1, 0] })).toBeNull();
      expect(bad({ position: [5000, 0, 0] })).toBeNull();
      expect(bad({ yaw: "1" })).toBeNull();
      expect(bad({ width: 0 })).toBeNull();
      expect(bad({ height: 1000 })).toBeNull();
      expect(bad({ width: null })).toBeNull();
    });
  });

  describe("place_file", () => {
    const valid = { type: "place_file", cid: dagPbCid, name: "report.pdf", position: [1, 0.4, -2], yaw: 0.5 };
    it("accepts a valid message", () => {
      expect(parseClientMessage(JSON.stringify(valid))).toEqual(valid);
    });
    it("sanitizes the file name", () => {
      const parsed = parseClientMessage(JSON.stringify({ ...valid, name: "../../evil\u202Egpj.exe" }));
      expect(parsed).toMatchObject({ type: "place_file", name: "_.._evilgpj.exe" });
    });
    it("falls back to a default name when missing or not a string", () => {
      expect(parseClientMessage(JSON.stringify({ ...valid, name: undefined }))).toMatchObject({ name: "file" });
      expect(parseClientMessage(JSON.stringify({ ...valid, name: 5 }))).toMatchObject({ name: "file" });
    });
    it("ignores a client-claimed size / category (the server decides them)", () => {
      const parsed = parseClientMessage(JSON.stringify({ ...valid, size: 1, category: "video" }));
      expect(parsed).not.toHaveProperty("size");
      expect(parsed).not.toHaveProperty("category");
    });
    it("rejects bad cid / position / yaw", () => {
      const bad = (patch: object) => parseClientMessage(JSON.stringify({ ...valid, ...patch }));
      expect(bad({ cid: "nope" })).toBeNull();
      expect(bad({ position: [0, 0] })).toBeNull();
      expect(bad({ position: [9999, 0, 0] })).toBeNull();
      expect(bad({ yaw: "1" })).toBeNull();
    });
  });

  describe("set_avatar", () => {
    it("accepts a valid CID (and normalizes it)", () => {
      expect(parseClientMessage(JSON.stringify({ type: "set_avatar", cid: dagPbCid }))).toEqual({
        type: "set_avatar",
        cid: dagPbCid,
      });
      expect(parseClientMessage(JSON.stringify({ type: "set_avatar", cid: rawCid }))).toEqual({
        type: "set_avatar",
        cid: rawCid,
      });
      const v0 = CID.createV0(CID.parse(dagPbCid).multihash as never).toString();
      expect(parseClientMessage(JSON.stringify({ type: "set_avatar", cid: v0 }))).toEqual({ type: "set_avatar", cid: v0 });
    });
    it("accepts null to clear the avatar", () => {
      expect(parseClientMessage(JSON.stringify({ type: "set_avatar", cid: null }))).toEqual({
        type: "set_avatar",
        cid: null,
      });
    });
    it("rejects non-string / invalid / non-file CIDs", async () => {
      const bad = (cid: unknown) => parseClientMessage(JSON.stringify({ type: "set_avatar", cid }));
      expect(bad(5)).toBeNull();
      expect(bad(undefined)).toBeNull(); // cid が無い
      expect(bad("nope")).toBeNull();
      expect(bad("../etc/passwd")).toBeNull();
      expect(bad("123e4567-e89b-12d3-a456-426614174000")).toBeNull();
      expect(bad(CID.createV1(CODEC_DAG_CBOR, await sha256.digest(bytes)).toString())).toBeNull();
      expect(bad(CID.createV1(CODEC_RAW, await sha512.digest(bytes)).toString())).toBeNull();
    });
  });

  describe("place_image name", () => {
    const base = { type: "place_image", cid: dagPbCid, position: [0, 0, 0], yaw: 0, width: 2, height: 1 };
    it("keeps an optional sanitized name", () => {
      expect(parseClientMessage(JSON.stringify({ ...base, name: "cat.png" }))).toMatchObject({ name: "cat.png" });
      expect(parseClientMessage(JSON.stringify({ ...base, name: "a/b.png" }))).toMatchObject({ name: "a_b.png" });
    });
    it("omits the name when absent or unusable", () => {
      expect(parseClientMessage(JSON.stringify(base))).not.toHaveProperty("name");
      expect(parseClientMessage(JSON.stringify({ ...base, name: "..." }))).not.toHaveProperty("name");
    });
  });

  describe("object operations", () => {
    const id = "123e4567-e89b-42d3-a456-426614174000";
    it("parses grab / release / delete / duplicate", () => {
      for (const type of ["grab_object", "release_object", "delete_object", "duplicate_object", "request_file"]) {
        expect(parseClientMessage(JSON.stringify({ type, id }))).toEqual({ type, id });
      }
    });
    it("rejects bad ids", () => {
      for (const type of ["grab_object", "release_object", "delete_object", "duplicate_object", "request_file", "move_object"]) {
        expect(parseClientMessage(JSON.stringify({ type, id: "nope" }))).toBeNull();
        expect(parseClientMessage(JSON.stringify({ type }))).toBeNull();
        expect(parseClientMessage(JSON.stringify({ type, id: 5 }))).toBeNull();
      }
    });
    it("parses move_object and validates the pose", () => {
      const ok = { type: "move_object", id, position: [1, 0, -2], yaw: 0.5 };
      expect(parseClientMessage(JSON.stringify(ok))).toEqual(ok);
      const bad = (patch: object) => parseClientMessage(JSON.stringify({ ...ok, ...patch }));
      expect(bad({ position: [1, 0] })).toBeNull();
      expect(bad({ position: [5000, 0, 0] })).toBeNull();
      expect(bad({ position: [null, 0, 0] })).toBeNull();
      expect(bad({ yaw: "1" })).toBeNull();
      expect(bad({ yaw: null })).toBeNull();
    });
    it("accepts an optional pitch (finite number) in move_object", () => {
      const withPitch = { type: "move_object", id, position: [1, 2, -2], yaw: 0.5, pitch: -0.7 };
      expect(parseClientMessage(JSON.stringify(withPitch))).toEqual(withPitch);
      const bad = (pitch: unknown) => parseClientMessage(JSON.stringify({ ...withPitch, pitch }));
      expect(bad("1")).toBeNull();
      expect(bad(null)).toBeNull();
    });
    it("parses place_box and validates size, color and pose", () => {
      const ok = { type: "place_box", position: [1, 0, 2], yaw: 0, size: 1.5, color: "#aabbcc" };
      expect(parseClientMessage(JSON.stringify(ok))).toEqual(ok);
      const bad = (patch: object) => parseClientMessage(JSON.stringify({ ...ok, ...patch }));
      expect(bad({ size: 0 })).toBeNull();
      expect(bad({ size: 1000 })).toBeNull();
      expect(bad({ color: "red" })).toBeNull();
      expect(bad({ color: "#12345" })).toBeNull();
      expect(bad({ position: [1, 2] })).toBeNull();
      expect(bad({ pitch: "x" })).toBeNull();
    });
  });

  it("returns null for garbage", () => {
    expect(parseClientMessage("not json")).toBeNull();
    expect(parseClientMessage("123")).toBeNull();
    expect(parseClientMessage('{"type":"nope"}')).toBeNull();
    expect(parseClientMessage('{"type":"pose","pose":{}}')).toBeNull();
  });
});

describe("normalizeCid", () => {
  it("accepts UnixFS file CIDs (dag-pb / raw, sha2-256)", () => {
    expect(normalizeCid(rawCid)).toBe(rawCid);
    expect(normalizeCid(dagPbCid)).toBe(dagPbCid);
  });
  it("normalizes CIDv0 to its canonical string", () => {
    const v0 = CID.createV0(CID.parse(dagPbCid).multihash as never).toString();
    expect(v0.startsWith("Qm")).toBe(true);
    expect(normalizeCid(v0)).toBe(v0);
  });
  it("rejects other codecs / hashes / garbage", async () => {
    expect(normalizeCid(CID.createV1(CODEC_DAG_CBOR, await sha256.digest(bytes)).toString())).toBeNull();
    expect(normalizeCid(CID.createV1(CODEC_RAW, await sha512.digest(bytes)).toString())).toBeNull();
    expect(normalizeCid("")).toBeNull();
    expect(normalizeCid("x".repeat(500))).toBeNull();
    expect(normalizeCid(123)).toBeNull();
  });
});
