import type { MeResponse } from "@fdrive/contracts";
import { describe, expect, it } from "vitest";
import {
  allCapabilities,
  anyLoginCan,
  CAPABILITY_KEYS,
  capabilitiesFor,
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
  it("reads Trash and the index from the active login by default and another login on request", () => {
    expect(capabilitiesFor(me)).toEqual({ trash: false, index: true });
    expect(capabilitiesFor(me, "two")).toEqual({ trash: true, index: false });
  });

  it("assumes an indexed folder without Trash while me is loading or the login is unknown", () => {
    expect(capabilitiesFor(undefined)).toEqual({ trash: false, index: true });
    expect(capabilitiesFor(me, "missing")).toEqual({ trash: false, index: true });
  });
});

describe("anyLoginCan", () => {
  it("is the union across linked logins", () => {
    expect(anyLoginCan(me, "trash")).toBe(true);
    expect(anyLoginCan({ ...me, identities: me.identities.slice(0, 1) }, "trash")).toBe(false);
  });

  it("uses the defaults before me loads", () => {
    expect(anyLoginCan(undefined, "trash")).toBe(false);
    expect(anyLoginCan(undefined, "index")).toBe(true);
  });
});

it("counts files and folders in a selection", () => {
  expect(selectionOf([])).toEqual(NO_SELECTION);
  expect(selectionOf([{ kind: "file" }, { kind: "dir" }, { kind: "file" }])).toEqual({
    files: 2,
    folders: 1,
  });
});

it("sets every capability flag", () => {
  expect(Object.keys(allCapabilities(false)).sort()).toEqual([
    "atomicMove",
    "index",
    "office",
    "setModifiedAt",
    "shareWithPeople",
    "shares",
    "trash",
    "zip",
  ]);
  expect(CAPABILITY_KEYS.every((key) => allCapabilities(true)[key])).toBe(true);
});
