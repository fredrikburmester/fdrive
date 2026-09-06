import { describe, expect, it } from "vitest";
import { avatarInitials, isFilesRoute } from "./app-sidebar.js";

describe("avatarInitials", () => {
  it("upper-cases the first two letters of the username", () => {
    expect(avatarInitials("ada")).toBe("AD");
  });

  it("handles a single-character username", () => {
    expect(avatarInitials("a")).toBe("A");
  });
});

describe("isFilesRoute", () => {
  it("is true for the Files root", () => {
    expect(isFilesRoute("/files")).toBe(true);
  });

  it("is true for a path within Files", () => {
    expect(isFilesRoute("/files/docs")).toBe(true);
  });

  it("is false for another route", () => {
    expect(isFilesRoute("/about")).toBe(false);
  });

  it("is false when there is no pathname", () => {
    expect(isFilesRoute(null)).toBe(false);
  });
});
