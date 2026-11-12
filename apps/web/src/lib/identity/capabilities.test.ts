import type { MeResponse } from "@fdrive/contracts";
import { describe, expect, it } from "vitest";
import {
  allCapabilities,
  anyLoginCan,
  CAPABILITY_KEYS,
  CAPABILITY_LABELS,
  canDownload,
  capabilitiesFor,
  DEFAULT_CAPABILITIES,
  downloadNeedsZip,
  isFilesOnly,
  NO_SELECTION,
  selectionOf,
  storageNote,
} from "./capabilities";

const me: MeResponse = {
  account: { id: "a", displayName: null },
  identities: [
    {
      id: "one",
      username: "ada",
      providerId: "00000000-0000-4000-8000-000000000001",
      providerType: "local",
      providerLabel: "Main",
      capabilities: { ...allCapabilities(true), trash: false },
    },
    {
      id: "two",
      username: "bob",
      providerId: "00000000-0000-4000-8000-000000000002",
      providerType: "local",
      providerLabel: "Other",
      capabilities: { ...allCapabilities(false), trash: true },
    },
  ],
  activeIdentityId: "one",
  isAdmin: false,
};

describe("capabilitiesFor", () => {
  it("returns the active login's capabilities by default and another login's on request", () => {
    expect(capabilitiesFor(me)).toEqual(me.identities[0]?.capabilities);
    expect(capabilitiesFor(me, "two")).toEqual(me.identities[1]?.capabilities);
  });

  it("falls back to the defaults while me is loading or the login is unknown", () => {
    expect(capabilitiesFor(undefined)).toBe(DEFAULT_CAPABILITIES);
    expect(capabilitiesFor(me, "missing")).toBe(DEFAULT_CAPABILITIES);
  });

  it("defaults to everything a local-folder login can do except Trash and sharing with people", () => {
    expect(DEFAULT_CAPABILITIES).toEqual({
      ...allCapabilities(true),
      trash: false,
      shareWithPeople: false,
    });
  });
});

describe("anyLoginCan", () => {
  it("is the union across linked logins", () => {
    expect(anyLoginCan(me, "trash")).toBe(true);
    expect(anyLoginCan(me, "shares")).toBe(true);
    expect(anyLoginCan({ ...me, identities: me.identities.slice(1) }, "shares")).toBe(false);
  });

  it("uses the defaults before me loads", () => {
    expect(anyLoginCan(undefined, "shares")).toBe(true);
    expect(anyLoginCan(undefined, "trash")).toBe(false);
  });
});

describe("selectionOf and downloads", () => {
  it("counts files and folders", () => {
    expect(selectionOf([])).toEqual(NO_SELECTION);
    expect(selectionOf([{ kind: "file" }, { kind: "dir" }, { kind: "file" }])).toEqual({
      files: 2,
      folders: 1,
    });
  });

  it("needs a zip for anything but exactly one file", () => {
    expect(downloadNeedsZip({ files: 1, folders: 0 })).toBe(false);
    expect(downloadNeedsZip({ files: 2, folders: 0 })).toBe(true);
    expect(downloadNeedsZip({ files: 0, folders: 1 })).toBe(true);
    expect(downloadNeedsZip(NO_SELECTION)).toBe(true);
  });

  it("without zip, downloads only when the selection holds a file", () => {
    expect(canDownload({ zip: false }, { files: 0, folders: 1 })).toBe(false);
    expect(canDownload({ zip: false }, { files: 1, folders: 1 })).toBe(true);
    expect(canDownload({ zip: false }, { files: 2, folders: 0 })).toBe(true);
    expect(canDownload({ zip: true }, { files: 0, folders: 1 })).toBe(true);
    expect(canDownload({ zip: true }, NO_SELECTION)).toBe(false);
  });
});

it("labels every capability", () => {
  for (const key of CAPABILITY_KEYS) {
    expect(CAPABILITY_LABELS[key].length).toBeGreaterThan(0);
  }
  expect(new Set(CAPABILITY_KEYS).size).toBe(Object.keys(DEFAULT_CAPABILITIES).length);
});

describe("isFilesOnly", () => {
  it("is true only when search, shares and Office are all missing", () => {
    expect(isFilesOnly({ ...allCapabilities(false), trash: true, atomicMove: true })).toBe(true);
    expect(isFilesOnly(allCapabilities(true))).toBe(false);
    // Storage without an index root can still share and open Office files.
    expect(isFilesOnly({ ...allCapabilities(true), index: false })).toBe(false);
  });
});

describe("storageNote", () => {
  it("leads with files only and names search, shares and Office when the storage has none", () => {
    expect(storageNote({ ...allCapabilities(false), trash: true })).toBe(
      "Files only. Search and thumbnails, share links, sharing with people and Office aren't available on this storage.",
    );
  });

  it("names only what the storage lacks once a feature is added to it", () => {
    // A backend that gained shares: the note shrinks by itself, and no longer says files only.
    expect(storageNote({ ...allCapabilities(false), trash: true, shares: true })).toBe(
      "Search and thumbnails, sharing with people and Office aren't available on this storage.",
    );
    expect(storageNote({ ...allCapabilities(true), shareWithPeople: false })).toBe(
      "Sharing with people isn't available on this storage.",
    );
    expect(storageNote({ ...allCapabilities(true), office: false })).toBe(
      "Office isn't available on this storage.",
    );
    expect(storageNote({ ...allCapabilities(true), shares: false })).toBe(
      "Share links aren't available on this storage.",
    );
    expect(storageNote({ ...allCapabilities(true), index: false })).toBe(
      "Search and thumbnails aren't available on this storage.",
    );
    expect(storageNote({ ...allCapabilities(true), index: false, shares: false })).toBe(
      "Search and thumbnails and share links aren't available on this storage.",
    );
  });

  it("says nothing for storage with search, shares and Office, whatever else it lacks", () => {
    expect(storageNote(allCapabilities(true))).toBeNull();
    expect(storageNote({ ...allCapabilities(true), zip: false, trash: false })).toBeNull();
  });
});
