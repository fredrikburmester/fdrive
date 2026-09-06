import { describe, expect, it } from "vitest";
import { type KeyLike, keyToAction } from "./keyboard";

function key(overrides: Partial<KeyLike> & Pick<KeyLike, "key">): KeyLike {
  return {
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
  };
}

describe("keyToAction", () => {
  it("maps Cmd+ArrowUp on mac to goToParent", () => {
    expect(keyToAction(key({ key: "ArrowUp", metaKey: true }), "mac")).toEqual({
      type: "goToParent",
    });
  });

  it("maps Ctrl+ArrowUp elsewhere to goToParent", () => {
    expect(keyToAction(key({ key: "ArrowUp", ctrlKey: true }), "other")).toEqual({
      type: "goToParent",
    });
  });

  it("maps plain ArrowUp to move up", () => {
    expect(keyToAction(key({ key: "ArrowUp" }), "mac")).toEqual({
      type: "move",
      direction: "up",
      extend: false,
    });
  });

  it("maps Shift+ArrowDown to an extending move down", () => {
    expect(keyToAction(key({ key: "ArrowDown", shiftKey: true }), "mac")).toEqual({
      type: "move",
      direction: "down",
      extend: true,
    });
  });

  it("maps Enter to open", () => {
    expect(keyToAction(key({ key: "Enter" }), "mac")).toEqual({ type: "open" });
  });

  it("maps Space to quickLook", () => {
    expect(keyToAction(key({ key: " " }), "mac")).toEqual({ type: "quickLook" });
  });

  it("maps Cmd+Delete on mac to delete", () => {
    expect(keyToAction(key({ key: "Delete", metaKey: true }), "mac")).toEqual({ type: "delete" });
  });

  it("does not delete on plain Delete on mac", () => {
    expect(keyToAction(key({ key: "Delete" }), "mac")).toBeNull();
  });

  it("does not delete on plain Backspace on mac", () => {
    expect(keyToAction(key({ key: "Backspace" }), "mac")).toBeNull();
  });

  it("maps plain Delete elsewhere to delete", () => {
    expect(keyToAction(key({ key: "Delete" }), "other")).toEqual({ type: "delete" });
  });

  it("maps Ctrl+Backspace elsewhere to delete", () => {
    expect(keyToAction(key({ key: "Backspace", ctrlKey: true }), "other")).toEqual({
      type: "delete",
    });
  });

  it("maps Cmd+A to selectAll", () => {
    expect(keyToAction(key({ key: "a", metaKey: true }), "mac")).toEqual({ type: "selectAll" });
  });

  it("is case-insensitive for the letter shortcuts", () => {
    expect(keyToAction(key({ key: "A", metaKey: true }), "mac")).toEqual({ type: "selectAll" });
  });

  it("does not selectAll when Alt is also held", () => {
    expect(keyToAction(key({ key: "a", metaKey: true, altKey: true }), "mac")).toBeNull();
  });

  it("maps Escape to clear", () => {
    expect(keyToAction(key({ key: "Escape" }), "mac")).toEqual({ type: "clear" });
  });

  it("maps F2 to rename", () => {
    expect(keyToAction(key({ key: "F2" }), "mac")).toEqual({ type: "rename" });
  });

  it("maps Cmd+Shift+N to newFolder", () => {
    expect(keyToAction(key({ key: "n", metaKey: true, shiftKey: true }), "mac")).toEqual({
      type: "newFolder",
    });
  });

  it("does not newFolder without shift", () => {
    expect(keyToAction(key({ key: "n", metaKey: true }), "mac")).toBeNull();
  });

  it("maps Cmd+D to download", () => {
    expect(keyToAction(key({ key: "d", metaKey: true }), "mac")).toEqual({ type: "download" });
  });

  it("does not download when Alt is also held", () => {
    expect(keyToAction(key({ key: "d", metaKey: true, altKey: true }), "mac")).toBeNull();
  });

  it("returns null for an unmapped key", () => {
    expect(keyToAction(key({ key: "x" }), "mac")).toBeNull();
  });

  it("returns null for an unmodified multi-character key", () => {
    expect(keyToAction(key({ key: "ArrowLeft" }), "mac")).toBeNull();
  });

  it("returns null for a plain letter with no modifier", () => {
    expect(keyToAction(key({ key: "d" }), "mac")).toBeNull();
  });
});
