import { describe, expect, it } from "vitest";
import { avatarInitials, isFilesRoute, isSystemRoute, isTrashRoute } from "./app-sidebar.tsx";

describe("avatarInitials", () => {
  it("upper-cases the first two letters of the login title", () => {
    expect(avatarInitials("ada")).toBe("AD");
  });

  it("handles a single-character title", () => {
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

describe("isSystemRoute", () => {
  it("is true for the System root", () => {
    expect(isSystemRoute("/system")).toBe(true);
  });

  it("is true for a path within System", () => {
    expect(isSystemRoute("/system/shared-folders")).toBe(true);
  });

  it("is false for another route", () => {
    expect(isSystemRoute("/files")).toBe(false);
  });

  it("is false when there is no pathname", () => {
    expect(isSystemRoute(null)).toBe(false);
  });
});

describe("isTrashRoute", () => {
  it("is true for the Trash route", () => {
    expect(isTrashRoute("/trash")).toBe(true);
  });

  it("is false for another route", () => {
    expect(isTrashRoute("/files")).toBe(false);
  });

  it("is false when there is no pathname", () => {
    expect(isTrashRoute(null)).toBe(false);
  });
});
