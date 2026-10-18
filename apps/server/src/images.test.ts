import { describe, expect, it } from "vitest";
import { MAX_IMAGES } from "@proto/protocol";
import { ImageStore, sniffImageType } from "./images.js";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const GIF = Buffer.from("GIF89a....");
const WEBP = Buffer.from("RIFF\x00\x00\x00\x00WEBPVP8 ", "latin1");

describe("sniffImageType", () => {
  it("detects supported formats", () => {
    expect(sniffImageType(PNG)).toBe("image/png");
    expect(sniffImageType(JPEG)).toBe("image/jpeg");
    expect(sniffImageType(GIF)).toBe("image/gif");
    expect(sniffImageType(WEBP)).toBe("image/webp");
  });

  it("rejects everything else (including SVG / HTML / empty)", () => {
    expect(sniffImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniffImageType(Buffer.from("<html></html>"))).toBeNull();
    expect(sniffImageType(new Uint8Array())).toBeNull();
    expect(sniffImageType(Buffer.from("RIFF\x00\x00\x00\x00WAVEfmt ", "latin1"))).toBeNull();
  });
});

describe("ImageStore", () => {
  it("stores and retrieves images", () => {
    const store = new ImageStore();
    const r = store.add(Buffer.from(PNG));
    expect("id" in r).toBe(true);
    if ("id" in r) {
      expect(store.has(r.id)).toBe(true);
      expect(store.get(r.id)?.type).toBe("image/png");
    }
  });

  it("rejects unsupported data", () => {
    expect(new ImageStore().add(Buffer.from("hello"))).toEqual({ error: "unsupported" });
  });

  it("rejects when full", () => {
    const store = new ImageStore();
    for (let i = 0; i < MAX_IMAGES; i++) expect("id" in store.add(Buffer.from(PNG))).toBe(true);
    expect(store.add(Buffer.from(PNG))).toEqual({ error: "full" });
  });
});
