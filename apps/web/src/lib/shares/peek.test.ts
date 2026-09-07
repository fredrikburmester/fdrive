import { describe, expect, it } from "vitest";
import { canPeekArchive, isPeekableArchiveName } from "./peek";

describe("isPeekableArchiveName", () => {
  it.each(["archive.zip", "ARCHIVE.ZIP", "backup.tar", "backup.tar.gz", "backup.tar.zst"])(
    "accepts %s",
    (name) => {
      expect(isPeekableArchiveName(name)).toBe(true);
    },
  );

  it.each(["photo.png", "notes.txt", "data.gz", "data.7z", "data.rar", "archive"])(
    "rejects %s",
    (name) => {
      expect(isPeekableArchiveName(name)).toBe(false);
    },
  );
});

describe("canPeekArchive", () => {
  it("shows the action for a peekable archive on an unlimited share", () => {
    expect(canPeekArchive("archive.zip", { downloadLimited: false })).toBe(true);
  });

  it("hides the action for a limited share even with a peekable archive", () => {
    expect(canPeekArchive("archive.zip", { downloadLimited: true })).toBe(false);
  });

  it("hides the action for a non-archive file", () => {
    expect(canPeekArchive("notes.txt", { downloadLimited: false })).toBe(false);
  });
});
