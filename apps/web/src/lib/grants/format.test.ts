import { ApiClientError, type OwnedGrant } from "@fdrive/contracts";
import { describe, expect, it } from "vitest";
import {
  describeGrantError,
  GRANT_ACCESS_LABELS,
  GRANT_ACCESS_OPTIONS,
  grantsOnFolder,
  peopleToAdd,
  receivedGrantCaption,
  sharedFolderCaption,
  sharedFolderRefusal,
} from "./format";

function owned(id: string, path: string, username: string): OwnedGrant {
  return {
    id: `00000000-0000-4000-8000-0000000000${id}`,
    path,
    username,
    access: "read",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("access labels", () => {
  it("offers view before edit", () => {
    expect(GRANT_ACCESS_OPTIONS.map((access) => GRANT_ACCESS_LABELS[access])).toEqual([
      "Can view",
      "Can edit",
    ]);
  });
});

describe("captions", () => {
  const received = [
    { path: "/Shared with me/Trip", owner: "alice", access: "read" as const },
    { path: "/Shared with me/Budget", owner: "bob", access: "write" as const },
  ];

  it("names who shares a folder and what this login may do", () => {
    expect(receivedGrantCaption({ owner: "alice", access: "read" })).toBe("alice · Can view");
    expect(sharedFolderCaption("/Shared with me/Budget", received)).toBe("bob · Can edit");
  });

  it("has nothing to say about anything else, including what is inside a shared folder", () => {
    expect(sharedFolderCaption("/Photos", received)).toBeNull();
    expect(sharedFolderCaption("/Shared with me/Trip/a.jpg", received)).toBeNull();
  });
});

describe("grantsOnFolder and peopleToAdd", () => {
  const grants = [
    owned("01", "/Photos", "grace"),
    owned("02", "/Docs", "ada"),
    owned("03", "/Photos", "ada"),
  ];

  it("lists one folder's people by name", () => {
    expect(grantsOnFolder(grants, "/Photos").map((grant) => grant.username)).toEqual([
      "ada",
      "grace",
    ]);
    expect(grantsOnFolder(grants, "/Music")).toEqual([]);
  });

  it("offers only people who do not have the folder yet", () => {
    expect(peopleToAdd(["ada", "grace", "linus"], grantsOnFolder(grants, "/Photos"))).toEqual([
      "linus",
    ]);
    expect(peopleToAdd(["ada"], [])).toEqual(["ada"]);
  });
});

describe("describeGrantError", () => {
  it("shows what the API refused in its own words, as a sentence", () => {
    expect(
      describeGrantError(new ApiClientError("bad_request", "only folders can be shared", 400)),
    ).toBe("Only folders can be shared.");
    expect(describeGrantError(new ApiClientError("not_found", "no such user.", 404))).toBe(
      "No such user.",
    );
  });

  it("reads like any other API error otherwise", () => {
    expect(describeGrantError(new ApiClientError("forbidden", "nope", 403))).toBe(
      "You don't have permission to do that.",
    );
    expect(describeGrantError(new ApiClientError("bad_request", "", 400))).toBe(
      "That request wasn't valid.",
    );
    expect(describeGrantError(new Error("offline"))).toBe("offline");
  });
});

describe("sharedFolderRefusal", () => {
  it.each([
    [
      "this folder is shared read-only: /Shared with me/Trip/a.jpg",
      "This folder is shared with you to view only.",
    ],
    [
      "a shared folder is changed by its owner: /Shared with me/Trip",
      "Only the owner can rename, move or delete a shared folder.",
    ],
    [
      "only folders others share can be in Shared with me: /Shared with me/x",
      "Only folders others share with you go in Shared with me.",
    ],
    [
      "Shared with me cannot be copied: /Shared with me",
      "Shared with me can't be copied. Copy a folder inside it.",
    ],
  ])("explains %s", (message, expected) => {
    expect(sharedFolderRefusal(message)).toBe(expected);
  });

  it("leaves other refusals alone", () => {
    expect(sharedFolderRefusal("outside the home folder: /x")).toBeNull();
  });
});
