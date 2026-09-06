import { describe, expect, it } from "vitest";
import { type EditorKeyLike, keyToEditorAction } from "./keymap";

function key(overrides: Partial<EditorKeyLike>): EditorKeyLike {
  return { key: "", metaKey: false, ctrlKey: false, shiftKey: false, ...overrides };
}

describe("keyToEditorAction", () => {
  it("maps Cmd+S to save on mac", () => {
    expect(keyToEditorAction(key({ key: "s", metaKey: true }), "mac")).toBe("save");
  });

  it("maps Ctrl+S to save elsewhere", () => {
    expect(keyToEditorAction(key({ key: "s", ctrlKey: true }), "other")).toBe("save");
  });

  it("ignores Ctrl+S on mac (wrong modifier)", () => {
    expect(keyToEditorAction(key({ key: "s", ctrlKey: true }), "mac")).toBeNull();
  });

  it("ignores Cmd+S on other platforms", () => {
    expect(keyToEditorAction(key({ key: "s", metaKey: true }), "other")).toBeNull();
  });

  it("maps Cmd+Shift+P to togglePreview", () => {
    expect(keyToEditorAction(key({ key: "p", metaKey: true, shiftKey: true }), "mac")).toBe(
      "togglePreview",
    );
  });

  it("does not treat Cmd+Shift+S as save", () => {
    expect(keyToEditorAction(key({ key: "s", metaKey: true, shiftKey: true }), "mac")).toBeNull();
  });

  it("does not treat plain Cmd+P as togglePreview", () => {
    expect(keyToEditorAction(key({ key: "p", metaKey: true }), "mac")).toBeNull();
  });

  it("is case-insensitive on the letter", () => {
    expect(keyToEditorAction(key({ key: "S", metaKey: true }), "mac")).toBe("save");
  });

  it("returns null without the primary modifier", () => {
    expect(keyToEditorAction(key({ key: "s" }), "mac")).toBeNull();
  });

  it("returns null for unrelated keys", () => {
    expect(keyToEditorAction(key({ key: "Enter", metaKey: true }), "mac")).toBeNull();
  });
});
