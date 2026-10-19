import { describe, expect, it } from "vitest";
import { mediaType, parseRange } from "./media.js";

describe("parseRange", () => {
  it("範囲の指定が無ければ null", () => {
    expect(parseRange(undefined, 100)).toBeNull();
    expect(parseRange("", 100)).toBeNull();
  });

  it("bytes=start-end", () => {
    expect(parseRange("bytes=0-99", 100)).toEqual({ start: 0, end: 99 });
    expect(parseRange("bytes=10-19", 100)).toEqual({ start: 10, end: 19 });
  });

  it("bytes=start- (終端は末尾)", () => {
    expect(parseRange("bytes=90-", 100)).toEqual({ start: 90, end: 99 });
  });

  it("bytes=-suffix (末尾から)", () => {
    expect(parseRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=-500", 100)).toEqual({ start: 0, end: 99 }); // 全体より長ければ全体
  });

  it("終端がサイズを超えたら、末尾に丸める", () => {
    expect(parseRange("bytes=50-999", 100)).toEqual({ start: 50, end: 99 });
  });

  it("開始が範囲外・終端が開始より前・不正な書式は invalid", () => {
    expect(parseRange("bytes=100-", 100)).toBe("invalid");
    expect(parseRange("bytes=200-300", 100)).toBe("invalid");
    expect(parseRange("bytes=30-20", 100)).toBe("invalid");
    expect(parseRange("bytes=0-1,3-4", 100)).toBe("invalid"); // 複数範囲は未対応
    expect(parseRange("items=0-1", 100)).toBe("invalid");
    expect(parseRange("bytes=a-b", 100)).toBe("invalid");
    expect(parseRange("bytes=-0", 100)).toBe("invalid");
    expect(parseRange("bytes=0-", 0)).toBe("invalid"); // 空のファイル
  });
});

describe("mediaType", () => {
  it("拡張子から Content-Type を決める (大文字・小文字を問わない)", () => {
    expect(mediaType("clip.webm")).toBe("video/webm");
    expect(mediaType("MOVIE.MP4")).toBe("video/mp4");
    expect(mediaType("song.mp3")).toBe("audio/mpeg");
    expect(mediaType("no-extension")).toBe("application/octet-stream");
    expect(mediaType("weird.xyz")).toBe("application/octet-stream");
  });
});
