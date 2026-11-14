import { describe, expect, it } from "vitest";
import {
  DESKTOP_INTERNAL_ROOT,
  isBackupPath,
  isReservedPath,
  RESERVED_FOLDER_NAMES,
  reservedFolders,
} from "./reserved-paths.ts";

describe("isBackupPath", () => {
  it("matches a backup folder anywhere, in any case", () => {
    expect(isBackupPath("/.fdrive-backups")).toBe(true);
    expect(isBackupPath("/archive/.FDRIVE-Backups/install/a.tar")).toBe(true);
    expect(isBackupPath("/fdrive-backups")).toBe(false);
    expect(isBackupPath("/.fdrive-backups-old/a")).toBe(false);
    expect(isBackupPath("/")).toBe(false);
  });
});

describe("reservedFolders", () => {
  it("names the Trash while it is on and always the Mac app's folder", () => {
    expect(reservedFolders("/.trash/")).toEqual(["/.trash", DESKTOP_INTERNAL_ROOT]);
    expect(reservedFolders(null)).toEqual([DESKTOP_INTERNAL_ROOT]);
  });
});

describe("isReservedPath", () => {
  it("covers the Trash folder and everything in it", () => {
    expect(isReservedPath("/.trash", "/.trash")).toBe(true);
    expect(isReservedPath("/.trash/notes.txt", "/.trash")).toBe(true);
    expect(isReservedPath("/Bin/a/b", "/Bin")).toBe(true);
    expect(isReservedPath("/.trashcan/a", "/.trash")).toBe(false);
    expect(isReservedPath("/.trash/notes.txt", null)).toBe(false);
  });

  it("covers the Mac app's folder at the top of the files only", () => {
    expect(isReservedPath("/.fdrive-desktop", null)).toBe(true);
    expect(isReservedPath("/.fdrive-desktop/staging/x", "/.trash")).toBe(true);
    expect(isReservedPath("/docs/.fdrive-desktop/x", null)).toBe(false);
  });

  it("covers fdrive's Trash layout and backup folders wherever they lie, in any case", () => {
    expect(isReservedPath("/old-trash/.fdrive-move-v1/file/p/a/v/1", "/Bin")).toBe(true);
    expect(isReservedPath("/x/.FDRIVE-MOVE-V1", null)).toBe(true);
    expect(isReservedPath("/nas/.fdrive-backups/install/a.tar", null)).toBe(true);
    for (const name of RESERVED_FOLDER_NAMES) {
      expect(isReservedPath(`/deep/down/${name}/x`, null)).toBe(true);
    }
  });

  it("leaves ordinary files alone and normalizes before deciding", () => {
    expect(isReservedPath("/", "/.trash")).toBe(false);
    expect(isReservedPath("/docs/report.pdf", "/.trash")).toBe(false);
    expect(isReservedPath("docs//../.trash/a", "/.trash")).toBe(true);
  });
});
