import { describe, expect, it } from "vitest";
import { MAX_MESSAGE_BYTES } from "./index.js";

describe("legacy protocol limits", () => {
  it("keeps the 4 KiB WebSocket message limit", () => {
    expect(MAX_MESSAGE_BYTES).toBe(4096);
  });
});
