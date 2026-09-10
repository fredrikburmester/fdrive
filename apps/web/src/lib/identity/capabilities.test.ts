import type { MeResponse } from "@fdrive/contracts";
import { describe, expect, it } from "vitest";
import {
  allCapabilities,
  anyLoginCan,
  browserActions,
  CAPABILITY_KEYS,
  CAPABILITY_LABELS,
  canDownload,
  capabilitiesFor,
  DEFAULT_CAPABILITIES,
  downloadNeedsZip,
  NO_SELECTION,
  selectionOf,
} from "./capabilities";

const me: MeResponse = {
  account: { id: "a", displayName: null },
  identities: [
    {
      id: "one",
      username: "ada",
      providerId: "00000000-0000-4000-8000-000000000001",
      providerType: "sftpgo",
      providerLabel: "Main",
      capabilities: { ...allCapabilities(true), trash: false },
    },
    {
      id: "two",
      username: "bob",
      providerId: "00000000-0000-4000-8000-000000000002",
      providerType: "sftpgo",
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

  it("defaults to everything an SFTPGo login can do except Trash", () => {
    expect(DEFAULT_CAPABILITIES).toEqual({ ...allCapabilities(true), trash: false });
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

describe("browserActions", () => {
  const oneFile = { files: 1, folders: 0 };

  it("keeps the ungated actions whatever the capabilities", () => {
    const none = browserActions(allCapabilities(false), oneFile);
    for (const id of ["open", "rename", "moveTo", "copyTo", "delete", "compress", "download"]) {
      expect(none.has(id as "open")).toBe(true);
    }
    expect(none.has("share")).toBe(false);
    expect(none.has("office:view")).toBe(false);
    expect(none.has("office:edit")).toBe(false);
  });

  it("adds Share and the Office items with their capabilities", () => {
    const all = browserActions(allCapabilities(true), oneFile);
    expect(all.has("share")).toBe(true);
    expect(all.has("office:convert")).toBe(true);
  });

  it("hides Download for a folder without zip", () => {
    expect(browserActions(allCapabilities(false), { files: 0, folders: 1 }).has("download")).toBe(
      false,
    );
    expect(browserActions(allCapabilities(true), { files: 0, folders: 1 }).has("download")).toBe(
      true,
    );
  });
});

it("labels every capability", () => {
  for (const key of CAPABILITY_KEYS) {
    expect(CAPABILITY_LABELS[key].length).toBeGreaterThan(0);
  }
  expect(new Set(CAPABILITY_KEYS).size).toBe(Object.keys(DEFAULT_CAPABILITIES).length);
});
