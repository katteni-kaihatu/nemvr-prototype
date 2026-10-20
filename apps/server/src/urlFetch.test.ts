import { describe, expect, it } from "vitest";
import { assertPublicUrl, fileNameFromUrl, imageSize, isPrivateAddress } from "./urlFetch.js";

const bytes = (base64: string) => new Uint8Array(Buffer.from(base64, "base64"));

// 1x1 の PNG / GIF
const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const GIF_1X1 = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

describe("isPrivateAddress", () => {
  it("rejects loopback, private, link-local and reserved IPv4", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.1.1", "100.64.0.1", "0.0.0.0", "224.0.0.1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });
  it("allows public IPv4", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "203.0.113.1"]) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });
  it("handles IPv6", () => {
    expect(isPrivateAddress("::1")).toBe(true);
    expect(isPrivateAddress("::")).toBe(true);
    expect(isPrivateAddress("fd00::1")).toBe(true);
    expect(isPrivateAddress("fe80::1")).toBe(true);
    expect(isPrivateAddress("2001:db8::1")).toBe(true);
    expect(isPrivateAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateAddress("2606:4700::1111")).toBe(false);
  });
  it("rejects things that are not IP addresses", () => {
    expect(isPrivateAddress("example.com")).toBe(true);
  });
});

describe("assertPublicUrl", () => {
  it("rejects non-http(s), credentials, localhost and private IPs", async () => {
    await expect(assertPublicUrl("ftp://example.com/x")).rejects.toThrow();
    await expect(assertPublicUrl("https://user:pass@example.com/x")).rejects.toThrow();
    await expect(assertPublicUrl("http://localhost:8080/x")).rejects.toThrow();
    await expect(assertPublicUrl("http://127.0.0.1:8080/x")).rejects.toThrow();
    await expect(assertPublicUrl("http://[::1]/x")).rejects.toThrow();
    await expect(assertPublicUrl("http://10.0.0.1/x")).rejects.toThrow();
    await expect(assertPublicUrl("not a url")).rejects.toThrow();
  });
  it("rejects an overly long URL", async () => {
    await expect(assertPublicUrl(`https://example.com/${"a".repeat(3000)}`)).rejects.toThrow();
  });
});

describe("fileNameFromUrl", () => {
  it("uses the last path segment", () => {
    expect(fileNameFromUrl("https://example.com/a/b/cat.png")).toBe("cat.png");
    expect(fileNameFromUrl("https://example.com/a%20b/clip.webm")).toBe("clip.webm");
  });
  it("falls back to the host, and adds an extension from the content type", () => {
    expect(fileNameFromUrl("https://example.com/")).toBe("example.com");
    expect(fileNameFromUrl("https://example.com/file", "image/png")).toBe("file.png");
    expect(fileNameFromUrl("https://example.com/", "video/mp4")).toBe("example.com.mp4");
  });
  it("removes path separators and control characters", () => {
    expect(fileNameFromUrl("https://example.com/a%2Fb.png")).toBe("a_b.png");
  });
});

describe("imageSize", () => {
  it("reads PNG dimensions", () => {
    expect(imageSize(bytes(PNG_1X1))).toEqual({ width: 1, height: 1 });
  });
  it("reads GIF dimensions", () => {
    expect(imageSize(bytes(GIF_1X1))).toEqual({ width: 1, height: 1 });
  });
  it("returns null for unknown content", () => {
    expect(imageSize(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});
