import { ApiClientError, type IdentityScopeResponse } from "@fdrive/contracts";
import { describe, expect, it } from "vitest";
import {
  type AdminScopeStatus,
  describeScopeError,
  fsPrefixProblem,
  mountMappingsWith,
  mountMappingsWithout,
  requestWithMapping,
  requestWithoutPrefix,
  requestWithUnindexed,
  SCOPE_REASON_TEXT,
} from "./scope-model";

const status: AdminScopeStatus = {
  status: "unavailable",
  reason: "unmapped_mount",
  usesOverride: true,
  virtualPrefixes: ["/", "/team"],
  unmappedMounts: [{ virtualPath: "/shared", kind: "dir" }],
  unverifiedPrefixes: [],
  unindexedPrefixes: ["/archive"],
  warning: "warning",
  isAdmin: true,
  configuredRoots: ["sftpgo"],
  mappings: [
    { rootName: "sftpgo", fsPrefix: "/alice", virtualPrefix: "/" },
    { rootName: "sftpgo", fsPrefix: "/pool/team", virtualPrefix: "/team" },
  ],
  overrides: [{ rootName: "sftpgo", fsPrefix: "/pool/team", virtualPrefix: "/team" }],
  adoptedMappings: [],
};

describe("folder mapping builders", () => {
  const existing = [{ virtualPath: "/team", rootName: "sftpgo", fsPrefix: "/pool/team" }];

  it("adds or replaces the mapping at the draft's path", () => {
    expect(
      mountMappingsWith(existing, {
        virtualPrefix: "/shared",
        rootName: "sftpgo",
        fsPrefix: "/_folders/shared",
      }),
    ).toEqual({
      mappings: [
        ...existing,
        { virtualPath: "/shared", rootName: "sftpgo", fsPrefix: "/_folders/shared" },
      ],
    });
    expect(
      mountMappingsWith(existing, { virtualPrefix: "/team", rootName: "sftpgo", fsPrefix: "/x" })
        .mappings,
    ).toEqual([{ virtualPath: "/team", rootName: "sftpgo", fsPrefix: "/x" }]);
  });

  it("removes by path", () => {
    expect(mountMappingsWithout(existing, "/team")).toEqual({ mappings: [] });
    expect(mountMappingsWithout(existing, "/other")).toEqual({ mappings: existing });
  });
});

describe("request builders", () => {
  it("maps a mount on top of the stored overrides, never the template home scope", () => {
    expect(
      requestWithMapping(status, {
        virtualPrefix: "/shared",
        rootName: "sftpgo",
        fsPrefix: "/_folders/shared",
      }),
    ).toEqual({
      scopes: [
        { rootName: "sftpgo", fsPrefix: "/pool/team", virtualPrefix: "/team" },
        { rootName: "sftpgo", fsPrefix: "/_folders/shared", virtualPrefix: "/shared" },
      ],
      unindexedPrefixes: ["/archive"],
    });
  });

  it("drops a stale not-indexed acknowledgement for a path that is now mapped", () => {
    const request = requestWithMapping(status, {
      virtualPrefix: "/archive",
      rootName: "sftpgo",
      fsPrefix: "/_folders/archive",
    });
    expect(request.unindexedPrefixes).toEqual([]);
  });

  it("acknowledges a mount as not indexed once, keeping existing overrides", () => {
    expect(requestWithUnindexed(status, "/shared")).toEqual({
      scopes: status.overrides,
      unindexedPrefixes: ["/archive", "/shared"],
    });
    expect(requestWithUnindexed(status, "/archive").unindexedPrefixes).toEqual(["/archive"]);
  });

  it("removes an override or an acknowledgement by path", () => {
    expect(requestWithoutPrefix(status, "/team")).toEqual({
      scopes: [],
      unindexedPrefixes: ["/archive"],
    });
    expect(requestWithoutPrefix(status, "/archive")).toEqual({
      scopes: status.overrides,
      unindexedPrefixes: [],
    });
  });
});

describe("fsPrefixProblem", () => {
  it("accepts a canonical absolute path and rejects everything else", () => {
    expect(fsPrefixProblem("/_folders/shared")).toBeNull();
    expect(fsPrefixProblem("")).toMatch(/Enter the folder/);
    expect(fsPrefixProblem("shared")).toMatch(/absolute path/);
    expect(fsPrefixProblem("/shared/")).toMatch(/trailing slash/);
  });
});

describe("describeScopeError", () => {
  function badRequest(details: Record<string, unknown>) {
    return new ApiClientError("bad_request", "invalid", 400, { details });
  }

  it("maps the resolver's validation reasons to their own field and sentence", () => {
    expect(describeScopeError(badRequest({ reason: "unknown_root" }))).toEqual({
      field: "rootName",
      message: "That root is not configured on this server.",
    });
    expect(describeScopeError(badRequest({ reason: "unindexed_prefix_collision" }))).toEqual({
      field: "unindexedPrefixes",
      message: "That path is already mapped, so it cannot also be marked not indexed.",
    });
    expect(describeScopeError(badRequest({ reason: "duplicate_virtual_prefix" }))).toEqual({
      field: "virtualPrefix",
      message: "Another mapping already uses that path.",
    });
    expect(describeScopeError(badRequest({ reason: "too_many" })).field).toBeNull();
  });

  it("maps schema issues by path", () => {
    expect(
      describeScopeError(
        badRequest({
          issues: [{ path: ["scopes"], message: "virtualPrefix must be unique across scopes" }],
        }),
      ).field,
    ).toBe("virtualPrefix");
    expect(
      describeScopeError(
        badRequest({
          issues: [{ path: ["unindexedPrefixes"], message: "must not collide with a mapped" }],
        }),
      ).message,
    ).toMatch(/already mapped/);
    expect(
      describeScopeError(
        badRequest({ issues: [{ path: ["scopes", 0, "fsPrefix"], message: "canonical" }] }),
      ).field,
    ).toBe("fsPrefix");
    expect(
      describeScopeError(
        badRequest({ issues: [{ path: ["scopes", 0, "rootName"], message: "invalid" }] }),
      ).field,
    ).toBe("rootName");
  });

  it("explains a forbidden save and falls back to the shared wording otherwise", () => {
    expect(describeScopeError(new ApiClientError("forbidden", "no", 403)).message).toMatch(
      /administrator/,
    );
    expect(describeScopeError(new Error("Login changed elsewhere"))).toEqual({
      field: null,
      message: "Login changed elsewhere",
    });
    expect(describeScopeError(badRequest({}))).toEqual({
      field: null,
      message: "That request wasn't valid.",
    });
  });
});

it("has one sentence per reason", () => {
  const reasons: IdentityScopeResponse["reason"][] = [
    "ok",
    "no_connection",
    "provider_mismatch",
    "invalid_configuration",
    "no_roots",
    "mismatch",
    "overflow",
    "indexer_unreachable",
    "unmapped_mount",
  ];
  for (const reason of reasons) expect(SCOPE_REASON_TEXT[reason].length).toBeGreaterThan(0);
});
