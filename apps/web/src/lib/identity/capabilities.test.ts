import type { MeResponse } from "@fdrive/contracts";
import { describe, expect, it } from "vitest";
import {
  allCapabilities,
  CAPABILITY_KEYS,
  capabilitiesFor,
  NO_SELECTION,
  selectionOf,
} from "./capabilities";

const me: MeResponse = {
  account: { id: "a", displayName: null },
  identity: {
    id: "one",
    username: "ada",
    providerId: "00000000-0000-4000-8000-000000000001",
    providerType: "local",
    providerLabel: "Main",
    capabilities: { ...allCapabilities(true), trash: false },
  },
  isAdmin: false,
};

describe("capabilitiesFor", () => {
  it("reads Trash and the index from the login", () => {
    expect(capabilitiesFor(me)).toEqual({ trash: false, index: true });
    expect(
      capabilitiesFor({
        ...me,
        identity: { ...me.identity, capabilities: { ...allCapabilities(false), trash: true } },
      }),
    ).toEqual({ trash: true, index: false });
  });

  it("assumes an indexed folder without Trash while me is loading", () => {
    expect(capabilitiesFor(undefined)).toEqual({ trash: false, index: true });
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
