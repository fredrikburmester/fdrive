import { describe, expect, it } from "vitest";
import { takeFileClipboard, writeFileClipboard } from "./clipboard";

describe("file clipboard", () => {
  it("pastes a copy as often as wanted", () => {
    writeFileClipboard({ mode: "copy", paths: ["/a.txt"] });

    expect(takeFileClipboard()).toEqual({ mode: "copy", paths: ["/a.txt"] });
    expect(takeFileClipboard()).toEqual({ mode: "copy", paths: ["/a.txt"] });
  });

  it("pastes a cut once", () => {
    writeFileClipboard({ mode: "cut", paths: ["/a.txt", "/b"] });

    expect(takeFileClipboard()).toEqual({ mode: "cut", paths: ["/a.txt", "/b"] });
    expect(takeFileClipboard()).toBeNull();
  });
});
