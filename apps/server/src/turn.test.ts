import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { iceServersFor, turnConfigFromEnv } from "./turn.js";

describe("turnConfigFromEnv", () => {
  it("returns null unless host and secret are set", () => {
    expect(turnConfigFromEnv({})).toBeNull();
    expect(turnConfigFromEnv({ TURN_HOST: "example.com" })).toBeNull();
    expect(turnConfigFromEnv({ TURN_SECRET: "s" })).toBeNull();
  });
  it("applies defaults", () => {
    expect(turnConfigFromEnv({ TURN_HOST: "example.com", TURN_SECRET: "s" })).toEqual({
      host: "example.com",
      port: 3478,
      secret: "s",
      ttlSeconds: 6 * 60 * 60,
    });
  });
});

describe("iceServersFor", () => {
  const config = { host: "turn.example.com", port: 3478, secret: "topsecret", ttlSeconds: 3600 };

  it("returns undefined without TURN config", () => {
    expect(iceServersFor(null, "u1")).toBeUndefined();
  });

  it("issues time-limited REST credentials that coturn can verify", () => {
    const now = Date.UTC(2026, 0, 1, 0, 0, 0);
    const servers = iceServersFor(config, "user-1", now)!;
    const turn = servers.find((s) => s.username)!;

    const expiry = now / 1000 + 3600;
    expect(turn.username).toBe(`${expiry}:user-1`);
    // coturn は共有秘密から同じ HMAC-SHA1 を計算して照合する
    expect(turn.credential).toBe(createHmac("sha1", "topsecret").update(turn.username!).digest("base64"));
    expect(turn.urls).toEqual([
      "turn:turn.example.com:3478?transport=udp",
      "turn:turn.example.com:3478?transport=tcp",
    ]);
  });

  it("never leaks the shared secret", () => {
    expect(JSON.stringify(iceServersFor(config, "u"))).not.toContain("topsecret");
  });

  it("gives different credentials to different users", () => {
    const a = iceServersFor(config, "a", 0)!.find((s) => s.username)!;
    const b = iceServersFor(config, "b", 0)!.find((s) => s.username)!;
    expect(a.credential).not.toBe(b.credential);
  });

  it("includes STUN servers without credentials", () => {
    const stun = iceServersFor(config, "u")![0]!;
    expect(stun.urls[0]).toBe("stun:turn.example.com:3478");
    expect(stun.username).toBeUndefined();
  });
});
