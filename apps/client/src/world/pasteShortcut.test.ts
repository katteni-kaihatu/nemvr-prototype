import { describe, expect, it } from "vitest";
import { isPasteShortcut, shouldHandlePaste } from "./pasteShortcut";

describe("isPasteShortcut", () => {
  it("accepts Ctrl+V and Cmd+V", () => {
    expect(isPasteShortcut({ key: "v", ctrlKey: true, metaKey: false, altKey: false })).toBe(true);
    expect(isPasteShortcut({ key: "V", ctrlKey: true, metaKey: false, altKey: false })).toBe(true);
    expect(isPasteShortcut({ key: "v", ctrlKey: false, metaKey: true, altKey: false })).toBe(true);
  });

  it("rejects other keys and modified shortcuts", () => {
    expect(isPasteShortcut({ key: "v", ctrlKey: false, metaKey: false, altKey: false })).toBe(false);
    expect(isPasteShortcut({ key: "c", ctrlKey: true, metaKey: false, altKey: false })).toBe(false);
    expect(isPasteShortcut({ key: "v", ctrlKey: true, metaKey: false, altKey: true })).toBe(false);
  });
});

describe("shouldHandlePaste", () => {
  it("accepts a paste soon after the shortcut", () => {
    expect(shouldHandlePaste(1000, 1000)).toBe(true);
    expect(shouldHandlePaste(1000, 2000)).toBe(true);
  });

  it("rejects a paste without a shortcut, such as middle-click paste", () => {
    expect(shouldHandlePaste(0, 1000)).toBe(false);
    expect(shouldHandlePaste(Number.NaN, 1000)).toBe(false);
  });

  it("rejects a paste before the shortcut or after the TTL", () => {
    expect(shouldHandlePaste(2000, 1000)).toBe(false);
    expect(shouldHandlePaste(1000, 3000)).toBe(false);
  });
});
