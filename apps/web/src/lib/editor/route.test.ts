import { describe, expect, it } from "vitest";
import { editHref } from "./route";

describe("editHref", () => {
  it("returns the bare edit route at the root", () => {
    expect(editHref("/")).toBe("/edit");
  });

  it("encodes each segment of a nested path", () => {
    expect(editHref("/notes/todo.md")).toBe("/edit/notes/todo.md");
  });

  it("percent-encodes special characters in segments", () => {
    expect(editHref("/a/b c.md")).toBe("/edit/a/b%20c.md");
  });
});
