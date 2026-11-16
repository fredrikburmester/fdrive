import { describe, expect, it } from "vitest";
import {
  DESKTOP_INTERNAL_ROOT,
  isAtOrUnder,
  isReservedPath,
  RESERVED_FOLDERS,
  TRASH_PATH,
} from "./reserved-paths.ts";

describe("RESERVED_FOLDERS", () => {
  it("names the Trash and the Mac app's folder", () => {
    expect(TRASH_PATH).toBe("/.trash");
    expect(RESERVED_FOLDERS).toEqual([TRASH_PATH, DESKTOP_INTERNAL_ROOT]);
  });
});

describe("isAtOrUnder", () => {
  it("matches the folder and what lies in it, segment by segment", () => {
    expect(isAtOrUnder("/.trash", "/.trash")).toBe(true);
    expect(isAtOrUnder("/.trash/", "/.trash/a/b")).toBe(true);
    expect(isAtOrUnder("/.trash", "/.trashcan")).toBe(false);
    expect(isAtOrUnder("/", "/anything")).toBe(true);
  });
});

describe("isReservedPath", () => {
  it("covers the Trash folder and everything in it", () => {
    expect(isReservedPath("/.trash")).toBe(true);
    expect(isReservedPath("/.trash/notes.txt")).toBe(true);
    // A disk that ignores case finds it under any spelling.
    expect(isReservedPath("/.Trash/notes.txt")).toBe(true);
    expect(isReservedPath("/.FDRIVE-DESKTOP")).toBe(true);
    expect(isReservedPath("/.trashcan/a")).toBe(false);
    expect(isReservedPath("/docs/.trash/a")).toBe(false);
    expect(isReservedPath("/Bin/a/b")).toBe(false);
  });

  it("covers the Mac app's folder at the top of the files only", () => {
    expect(isReservedPath("/.fdrive-desktop")).toBe(true);
    expect(isReservedPath("/.fdrive-desktop/staging/x")).toBe(true);
    expect(isReservedPath("/docs/.fdrive-desktop/x")).toBe(false);
  });

  it("leaves ordinary files alone and normalizes before deciding", () => {
    expect(isReservedPath("/")).toBe(false);
    expect(isReservedPath("/docs/report.pdf")).toBe(false);
    // Backups no longer go into the files folder; archives left there are the user's files.
    expect(isReservedPath("/nas/.fdrive-backups/install/a.fdrive.age")).toBe(false);
    expect(isReservedPath("docs//../.trash/a")).toBe(true);
  });
});
