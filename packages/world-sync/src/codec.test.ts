import { describe, expect, it } from "vitest";
import type { SyncPart } from "@proto/protocol";
import {
  TransferAssembler,
  encodeTransfer,
  fromBase64,
  stateVectorEquals,
  toBase64,
} from "./codec.js";

function bytes(length: number, seed = 1): Uint8Array {
  const output = new Uint8Array(length);
  let state = seed >>> 0;
  for (let i = 0; i < length; i++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    output[i] = state >>> 24;
  }
  return output;
}

describe("base64", () => {
  it("roundtrips every byte length", () => {
    for (let length = 0; length <= 32; length++) {
      const input = bytes(length, length + 1);
      const decoded = fromBase64(toBase64(input));
      expect(decoded).not.toBeNull();
      expect(Array.from(decoded!)).toEqual(Array.from(input));
    }
  });

  it("encodes known vectors", () => {
    const encoder = new TextEncoder();
    expect(toBase64(encoder.encode("hello"))).toBe("aGVsbG8=");
    expect(toBase64(encoder.encode("a"))).toBe("YQ==");
    expect(toBase64(encoder.encode("ab"))).toBe("YWI=");
    expect(toBase64(new Uint8Array())).toBe("");
  });

  it("rejects invalid base64", () => {
    expect(fromBase64("a")).toBeNull();
    expect(fromBase64("aa=a")).toBeNull();
    expect(fromBase64("a===")).toBeNull();
    expect(fromBase64("****")).toBeNull();
    expect(fromBase64("AAAA=")).toBeNull();
  });
});

describe("encodeTransfer", () => {
  it("roundtrips zero bytes", () => {
    const parts = encodeTransfer(new Uint8Array(), "empty");
    expect(parts).toEqual([{ transferId: "empty", index: 0, count: 1, data: "" }]);
    const assembled = new TransferAssembler().accept(parts[0]!);
    expect(assembled).not.toBeNull();
    expect(assembled!.length).toBe(0);
  });

  it("roundtrips a small update", () => {
    const input = bytes(64, 5);
    const parts = encodeTransfer(input, "small");
    expect(parts).toHaveLength(1);
    const assembled = new TransferAssembler().accept(parts[0]!);
    expect(Array.from(assembled!)).toEqual(Array.from(input));
  });

  it("roundtrips multiple chunks out of order", () => {
    const input = bytes(150_000, 9);
    const parts = encodeTransfer(input, "large", 32 * 1024);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((part) => part.count === parts.length)).toBe(true);

    const assembler = new TransferAssembler();
    let assembled: Uint8Array | null = null;
    for (const part of [...parts].reverse()) {
      assembled = assembler.accept(part);
    }
    expect(assembled).not.toBeNull();
    expect(Array.from(assembled!)).toEqual(Array.from(input));
  });

  it("ignores duplicate indices", () => {
    const input = bytes(1000, 11);
    const parts = encodeTransfer(input, "dupe", 256);
    const assembler = new TransferAssembler();
    expect(assembler.accept(parts[0]!)).toBeNull();
    expect(assembler.accept(parts[0]!)).toBeNull();
    let assembled: Uint8Array | null = null;
    for (const part of parts.slice(1)) {
      const result = assembler.accept(part);
      if (result !== null) assembled = result;
    }
    expect(assembled).not.toBeNull();
    expect(Array.from(assembled!)).toEqual(Array.from(input));
  });

  it("reassembles despite a duplicate of the final part", () => {
    const input = bytes(700, 12);
    const parts = encodeTransfer(input, "dupe-final", 200);
    const assembler = new TransferAssembler();
    let assembled: Uint8Array | null = null;
    for (const part of parts) {
      const result = assembler.accept(part);
      if (result !== null) assembled = result;
      if (part === parts[parts.length - 1]) assembler.accept(part);
    }
    expect(assembled).not.toBeNull();
    expect(Array.from(assembled!)).toEqual(Array.from(input));
  });

  it("rejects malformed indices, counts and data", () => {
    const part = encodeTransfer(bytes(10, 3), "bad")[0]!;
    const assembler = new TransferAssembler();
    expect(assembler.accept({ ...part, index: 1 })).toBeNull();
    expect(assembler.accept({ ...part, index: -1 })).toBeNull();
    expect(assembler.accept({ ...part, count: 0 })).toBeNull();
    expect(assembler.accept({ ...part, data: "not base64" })).toBeNull();
    expect(assembler.accept({ ...part, transferId: "" })).toBeNull();
  });

  it("rejects inconsistent counts for the same transfer", () => {
    const parts = encodeTransfer(bytes(100, 4), "inconsistent", 40);
    const assembler = new TransferAssembler();
    expect(assembler.accept(parts[0]!)).toBeNull();
    expect(assembler.accept({ ...parts[1]!, count: parts.length + 1 })).toBeNull();
    expect(assembler.accept(parts[1]!)).toBeNull();
  });

  it("rejects oversized transfers", () => {
    const part = encodeTransfer(bytes(32, 6), "big")[0]!;
    const assembler = new TransferAssembler({ maxBytes: 16 });
    expect(assembler.accept(part)).toBeNull();
  });

  it("expires stale transfers", () => {
    const parts = encodeTransfer(bytes(100, 8), "stale", 60);
    const assembler = new TransferAssembler({ ttlMs: 1000 });
    expect(assembler.accept(parts[0]!, 0)).toBeNull();
    expect(assembler.accept(parts[1]!, 1001)).toBeNull();
    expect(assembler.accept(parts[0]!, 1001)).not.toBeNull();
  });

  it("caps concurrent transfers", () => {
    const assembler = new TransferAssembler({ maxTransfers: 2 });
    const first = encodeTransfer(bytes(100, 13), "one", 40);
    const second = encodeTransfer(bytes(100, 14), "two", 40);
    const third = encodeTransfer(bytes(100, 15), "three", 40);
    expect(assembler.accept(first[0]!)).toBeNull();
    expect(assembler.accept(second[0]!)).toBeNull();
    expect(assembler.accept(third[0]!)).toBeNull();
  });
});

describe("stateVectorEquals", () => {
  it("compares encoded state vectors", () => {
    const empty = new Uint8Array([0]);
    expect(stateVectorEquals(empty, new Uint8Array([0]))).toBe(true);
  });

  it("returns false for malformed input", () => {
    expect(stateVectorEquals(new Uint8Array([0]), new Uint8Array([255]))).toBe(false);
  });
});
