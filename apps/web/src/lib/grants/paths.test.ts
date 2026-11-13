import type { ReceivedGrant } from "@fdrive/contracts";
import { describe, expect, it } from "vitest";
import {
  canShareWithPeople,
  dropBlock,
  entryRestrictions,
  firstLockedReason,
  folderWriteBlock,
  isPinnedSharedPath,
  isUnderSharedWithMe,
  lockedReason,
  receivedGrantFor,
  SHARED_WITH_ME_PATH,
} from "./paths";

const VIEW: ReceivedGrant = {
  id: "00000000-0000-4000-8000-0000000000a1",
  owner: "alice",
  name: "Trip",
  path: "/Shared with me/Trip",
  access: "read",
  createdAt: "2026-01-01T00:00:00.000Z",
};
const EDIT: ReceivedGrant = {
  ...VIEW,
  id: "00000000-0000-4000-8000-0000000000a2",
  owner: "bob",
  name: "Budget",
  path: "/Shared with me/Budget",
  access: "write",
};
const RECEIVED = [VIEW, EDIT];
const SHARING = { shareWithPeople: true };

describe("Shared with me paths", () => {
  it("knows the folder and everything under it", () => {
    expect(SHARED_WITH_ME_PATH).toBe("/Shared with me");
    expect(isUnderSharedWithMe("/Shared with me")).toBe(true);
    expect(isUnderSharedWithMe("/Shared with me/Trip/a.jpg")).toBe(true);
    expect(isUnderSharedWithMe("/Shared with meadows")).toBe(false);
    expect(isUnderSharedWithMe("/Photos")).toBe(false);
  });

  it("pins the folder itself and the shared folders directly in it", () => {
    expect(isPinnedSharedPath("/Shared with me")).toBe(true);
    expect(isPinnedSharedPath("/Shared with me/Trip")).toBe(true);
    expect(isPinnedSharedPath("/Shared with me/Trip/a.jpg")).toBe(false);
    expect(isPinnedSharedPath("/Photos")).toBe(false);
  });

  it("finds the shared folder a path is or lies in", () => {
    expect(receivedGrantFor("/Shared with me/Trip", RECEIVED)).toBe(VIEW);
    expect(receivedGrantFor("/Shared with me/Trip/day 1/a.jpg", RECEIVED)).toBe(VIEW);
    expect(receivedGrantFor("/Shared with me/Tripod", RECEIVED)).toBeUndefined();
    expect(receivedGrantFor("/Photos", RECEIVED)).toBeUndefined();
  });
});

describe("canShareWithPeople", () => {
  const folder = { kind: "dir" as const, path: "/Photos" };

  it("offers a folder of the login's own on storage that shares", () => {
    expect(canShareWithPeople(folder, SHARING)).toBe(true);
  });

  it("refuses files, all of the files, anything shared with the login, and other storage", () => {
    expect(canShareWithPeople({ kind: "file", path: "/a.txt" }, SHARING)).toBe(false);
    expect(canShareWithPeople({ kind: "dir", path: "/" }, SHARING)).toBe(false);
    expect(canShareWithPeople({ kind: "dir", path: "/Shared with me" }, SHARING)).toBe(false);
    expect(canShareWithPeople({ kind: "dir", path: "/Shared with me/Trip/x" }, SHARING)).toBe(
      false,
    );
    expect(canShareWithPeople(folder, { shareWithPeople: false })).toBe(false);
  });
});

describe("folderWriteBlock", () => {
  it("keeps everything out of Shared with me and folders shared to view", () => {
    expect(folderWriteBlock("/Shared with me", RECEIVED)).toBe(
      "Only folders others share with you appear here.",
    );
    expect(folderWriteBlock("/Shared with me/Trip/day 1", RECEIVED)).toBe(
      "alice shares this folder with you to view only.",
    );
  });

  it("lets things into the login's own folders and folders shared to edit", () => {
    expect(folderWriteBlock("/Photos", RECEIVED)).toBeNull();
    expect(folderWriteBlock("/Shared with me/Budget", RECEIVED)).toBeNull();
  });
});

describe("lockedReason", () => {
  it("locks Shared with me, its folders, and everything in a folder shared to view", () => {
    expect(lockedReason("/Shared with me", RECEIVED)).toBe(
      "Shared with me only lists what others share with you.",
    );
    expect(lockedReason("/Shared with me/Budget", RECEIVED)).toBe(
      "Only its owner can rename, move or delete a shared folder.",
    );
    expect(lockedReason("/Shared with me/Trip/a.jpg", RECEIVED)).toBe(
      "alice shares this folder with you to view only.",
    );
  });

  it("leaves the login's own files and what is in a folder shared to edit", () => {
    expect(lockedReason("/Photos/a.jpg", RECEIVED)).toBeNull();
    expect(lockedReason("/Shared with me/Budget/q1.xlsx", RECEIVED)).toBeNull();
  });

  it("names the first locked path of several", () => {
    expect(firstLockedReason(["/a", "/Shared with me/Trip/b", "/c"], RECEIVED)).toBe(
      "alice shares this folder with you to view only.",
    );
    expect(firstLockedReason(["/a", "/b"], RECEIVED)).toBeNull();
    expect(firstLockedReason([], RECEIVED)).toBeNull();
  });
});

describe("dropBlock", () => {
  it("refuses a drop onto a folder that takes nothing", () => {
    expect(dropBlock(["/a.txt"], "/Shared with me/Trip", "copy", RECEIVED)).toBe(
      "alice shares this folder with you to view only.",
    );
  });

  it("refuses moving out of a folder shared to view, but allows copying out", () => {
    expect(dropBlock(["/Shared with me/Trip/a.jpg"], "/Photos", "move", RECEIVED)).toBe(
      "alice shares this folder with you to view only.",
    );
    expect(dropBlock(["/Shared with me/Trip/a.jpg"], "/Photos", "copy", RECEIVED)).toBeNull();
  });

  it("allows moves between the login's files and a folder shared to edit", () => {
    expect(dropBlock(["/a.txt"], "/Shared with me/Budget", "move", RECEIVED)).toBeNull();
    expect(dropBlock(["/Shared with me/Budget/q1.xlsx"], "/", "move", RECEIVED)).toBeNull();
  });
});

describe("entryRestrictions", () => {
  it("leaves the login's own folder unrestricted and offers sharing it", () => {
    expect(entryRestrictions({ kind: "dir", path: "/Photos" }, SHARING, RECEIVED)).toEqual({
      shareWithPeople: true,
      publicLink: true,
      leave: null,
      locked: null,
    });
  });

  it("offers leaving a shared folder and nothing its owner keeps", () => {
    expect(
      entryRestrictions({ kind: "dir", path: "/Shared with me/Trip" }, SHARING, RECEIVED),
    ).toEqual({
      shareWithPeople: false,
      publicLink: false,
      leave: VIEW,
      locked: "Only its owner can rename, move or delete a shared folder.",
    });
  });

  it("keeps public links out of a shared folder without offering to leave what is inside", () => {
    const inside = entryRestrictions(
      { kind: "file", path: "/Shared with me/Budget/q1.xlsx" },
      SHARING,
      RECEIVED,
    );
    expect(inside.publicLink).toBe(false);
    expect(inside.leave).toBeNull();
    expect(inside.locked).toBeNull();
  });
});
