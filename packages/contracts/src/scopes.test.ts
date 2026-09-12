import { describe, expect, it } from "vitest";
import {
  IdentityScopeReason,
  IdentityScopeResponse,
  IdentityScopeSuggestionsResponse,
  isCanonicalScopePath,
  MAX_SCOPE_MAPPINGS,
  MountMapping,
  ScopeCanonicalPath,
  ScopeMapping,
  ScopeRootName,
  SetIdentityScopeRequest,
  SetMountMappingsRequest,
} from "./scopes.ts";

describe("MountMapping and SetMountMappingsRequest", () => {
  const mapping = { virtualPath: "/shared", rootName: "sftpgo", fsPrefix: "/_folders/shared" };

  it("accepts a folder mapping and rejects one targeting the root", () => {
    expect(MountMapping.safeParse(mapping).success).toBe(true);
    expect(MountMapping.safeParse({ ...mapping, virtualPath: "/" }).success).toBe(false);
  });

  it("rejects duplicate virtual paths across the list", () => {
    const result = SetMountMappingsRequest.safeParse({ mappings: [mapping, mapping] });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.path).toEqual(["mappings"]);
    expect(SetMountMappingsRequest.safeParse({ mappings: [] }).success).toBe(true);
  });
});

describe("IdentityScopeSuggestionsResponse", () => {
  it("accepts mounts with and without suggestions", () => {
    expect(
      IdentityScopeSuggestionsResponse.safeParse({
        mounts: [
          { virtualPath: "/shared", suggestions: [{ rootName: "sftpgo", fsPrefix: "/x" }] },
          { virtualPath: "/other", suggestions: [] },
        ],
      }).success,
    ).toBe(true);
  });
});

describe("isCanonicalScopePath", () => {
  it("accepts the root and simple absolute paths", () => {
    expect(isCanonicalScopePath("/")).toBe(true);
    expect(isCanonicalScopePath("/a")).toBe(true);
    expect(isCanonicalScopePath("/a/b/c")).toBe(true);
  });

  it("preserves a literal percent-encoded-looking segment unchanged", () => {
    expect(isCanonicalScopePath("/%20")).toBe(true);
    expect(isCanonicalScopePath("/a/%2e%2e")).toBe(true);
  });

  it("rejects an empty string", () => {
    expect(isCanonicalScopePath("")).toBe(false);
  });

  it("rejects a relative path", () => {
    expect(isCanonicalScopePath("a/b")).toBe(false);
  });

  it("rejects a trailing slash other than the root", () => {
    expect(isCanonicalScopePath("/a/")).toBe(false);
  });

  it("rejects a doubled separator", () => {
    expect(isCanonicalScopePath("/a//b")).toBe(false);
  });

  it("rejects dot and dot-dot segments", () => {
    expect(isCanonicalScopePath("/./a")).toBe(false);
    expect(isCanonicalScopePath("/a/..")).toBe(false);
    expect(isCanonicalScopePath("/../a")).toBe(false);
  });

  it("rejects a backslash", () => {
    expect(isCanonicalScopePath("/a\\b")).toBe(false);
  });

  it("rejects a NUL byte and other control characters", () => {
    expect(isCanonicalScopePath("/a\0b")).toBe(false);
    expect(isCanonicalScopePath("/a\x01b")).toBe(false);
    expect(isCanonicalScopePath("/a\x7fb")).toBe(false);
  });

  it("rejects a path longer than 4096 characters", () => {
    expect(isCanonicalScopePath(`/${"a".repeat(4096)}`)).toBe(false);
  });
});

describe("ScopeRootName", () => {
  it("accepts lowercase alphanumerics, underscore, and hyphen", () => {
    expect(ScopeRootName.safeParse("sftpgo").success).toBe(true);
    expect(ScopeRootName.safeParse("root-2_a").success).toBe(true);
  });

  it("rejects an uppercase or empty name", () => {
    expect(ScopeRootName.safeParse("Sftpgo").success).toBe(false);
    expect(ScopeRootName.safeParse("").success).toBe(false);
  });

  it("rejects a name starting with a symbol", () => {
    expect(ScopeRootName.safeParse("-root").success).toBe(false);
  });
});

describe("ScopeCanonicalPath", () => {
  it("wraps isCanonicalScopePath", () => {
    expect(ScopeCanonicalPath.safeParse("/a/b").success).toBe(true);
    expect(ScopeCanonicalPath.safeParse("/a/b/").success).toBe(false);
  });
});

describe("ScopeMapping", () => {
  const valid = { rootName: "sftpgo", fsPrefix: "/alice", virtualPrefix: "/" };

  it("accepts a valid mapping", () => {
    expect(ScopeMapping.safeParse(valid).success).toBe(true);
  });

  it("rejects extra fields", () => {
    expect(ScopeMapping.safeParse({ ...valid, extra: true }).success).toBe(false);
  });

  it("rejects a missing field", () => {
    const { rootName: _rootName, ...rest } = valid;
    expect(ScopeMapping.safeParse(rest).success).toBe(false);
  });
});

describe("SetIdentityScopeRequest", () => {
  it("accepts an empty array (reset)", () => {
    expect(SetIdentityScopeRequest.safeParse({ scopes: [] }).success).toBe(true);
  });

  it("accepts unique mappings up to the cap", () => {
    const scopes = Array.from({ length: MAX_SCOPE_MAPPINGS }, (_, i) => ({
      rootName: "sftpgo",
      fsPrefix: `/team${i}`,
      virtualPrefix: `/team${i}`,
    }));
    expect(SetIdentityScopeRequest.safeParse({ scopes }).success).toBe(true);
  });

  it("rejects more than the cap", () => {
    const scopes = Array.from({ length: MAX_SCOPE_MAPPINGS + 1 }, (_, i) => ({
      rootName: "sftpgo",
      fsPrefix: `/team${i}`,
      virtualPrefix: `/team${i}`,
    }));
    expect(SetIdentityScopeRequest.safeParse({ scopes }).success).toBe(false);
  });

  it("rejects a duplicate virtualPrefix", () => {
    const scopes = [
      { rootName: "sftpgo", fsPrefix: "/a", virtualPrefix: "/shared" },
      { rootName: "sftpgo", fsPrefix: "/b", virtualPrefix: "/shared" },
    ];
    expect(SetIdentityScopeRequest.safeParse({ scopes }).success).toBe(false);
  });

  it("rejects extra top-level fields", () => {
    expect(SetIdentityScopeRequest.safeParse({ scopes: [], extra: 1 }).success).toBe(false);
  });

  it("defaults unindexedPrefixes to an empty list", () => {
    const parsed = SetIdentityScopeRequest.parse({ scopes: [] });
    expect(parsed.unindexedPrefixes).toEqual([]);
  });

  it("accepts canonical unindexed prefixes alongside mappings", () => {
    const body = {
      scopes: [{ rootName: "sftpgo", fsPrefix: "/pool/team", virtualPrefix: "/shared" }],
      unindexedPrefixes: ["/archive", "/shared/old"],
    };
    expect(SetIdentityScopeRequest.safeParse(body).success).toBe(true);
  });

  it("rejects a non-canonical unindexed prefix", () => {
    expect(
      SetIdentityScopeRequest.safeParse({ scopes: [], unindexedPrefixes: ["archive/"] }).success,
    ).toBe(false);
  });

  it("rejects a duplicate unindexed prefix", () => {
    const result = SetIdentityScopeRequest.safeParse({
      scopes: [],
      unindexedPrefixes: ["/archive", "/archive"],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["unindexedPrefixes"]);
    }
  });

  it("rejects an unindexed prefix that collides with a mapped virtualPrefix", () => {
    const result = SetIdentityScopeRequest.safeParse({
      scopes: [{ rootName: "sftpgo", fsPrefix: "/pool/team", virtualPrefix: "/shared" }],
      unindexedPrefixes: ["/shared"],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/collide/);
    }
  });

  it("rejects more unindexed prefixes than the cap", () => {
    const unindexedPrefixes = Array.from({ length: MAX_SCOPE_MAPPINGS + 1 }, (_, i) => `/p${i}`);
    expect(SetIdentityScopeRequest.safeParse({ scopes: [], unindexedPrefixes }).success).toBe(
      false,
    );
  });
});

describe("IdentityScopeReason", () => {
  it("accepts every documented reason", () => {
    for (const reason of [
      "ok",
      "no_connection",
      "provider_mismatch",
      "invalid_configuration",
      "no_roots",
      "mismatch",
      "overflow",
      "indexer_unreachable",
      "unmapped_mount",
    ])
      expect(IdentityScopeReason.safeParse(reason).success).toBe(true);
  });

  it("rejects an unknown reason", () => {
    expect(IdentityScopeReason.safeParse("something_else").success).toBe(false);
  });
});

describe("IdentityScopeResponse", () => {
  const common = {
    status: "available" as const,
    reason: "ok" as const,
    usesOverride: false,
    virtualPrefixes: ["/"],
    unmappedMounts: [],
    unverifiedPrefixes: [],
    unindexedPrefixes: [],
    warning: "example warning",
  };

  it("accepts a non-administrator response with no physical mapping data", () => {
    expect(IdentityScopeResponse.safeParse({ ...common, isAdmin: false }).success).toBe(true);
  });

  it("carries unmapped mounts and unverified prefixes for both roles", () => {
    const detail = {
      unmappedMounts: [{ virtualPath: "/shared", kind: "dir" }],
      unverifiedPrefixes: ["/team"],
    };
    expect(IdentityScopeResponse.safeParse({ ...common, ...detail, isAdmin: false }).success).toBe(
      true,
    );
    expect(
      IdentityScopeResponse.safeParse({
        ...common,
        ...detail,
        isAdmin: true,
        configuredRoots: ["sftpgo"],
        mappings: [],
        overrides: [],
        adoptedMappings: [],
      }).success,
    ).toBe(true);
  });

  it("rejects an unmapped mount whose virtual path is not canonical or whose kind is unknown", () => {
    expect(
      IdentityScopeResponse.safeParse({
        ...common,
        unmappedMounts: [{ virtualPath: "shared", kind: "dir" }],
        isAdmin: false,
      }).success,
    ).toBe(false);
    expect(
      IdentityScopeResponse.safeParse({
        ...common,
        unmappedMounts: [{ virtualPath: "/shared", kind: "symlink" }],
        isAdmin: false,
      }).success,
    ).toBe(false);
  });

  it("rejects a response missing the unmapped-mount fields", () => {
    const { unmappedMounts: _mounts, ...rest } = common;
    expect(IdentityScopeResponse.safeParse({ ...rest, isAdmin: false }).success).toBe(false);
  });

  it("rejects a non-administrator response carrying admin-only fields", () => {
    expect(
      IdentityScopeResponse.safeParse({
        ...common,
        isAdmin: false,
        configuredRoots: [],
        mappings: [],
      }).success,
    ).toBe(false);
  });

  it("accepts an administrator response with configured roots and full mappings", () => {
    expect(
      IdentityScopeResponse.safeParse({
        ...common,
        isAdmin: true,
        configuredRoots: ["sftpgo"],
        mappings: [{ rootName: "sftpgo", fsPrefix: "/alice", virtualPrefix: "/" }],
        overrides: [],
        adoptedMappings: [],
      }).success,
    ).toBe(true);
  });

  it("rejects an administrator response missing mappings", () => {
    expect(
      IdentityScopeResponse.safeParse({
        ...common,
        isAdmin: true,
        configuredRoots: ["sftpgo"],
      }).success,
    ).toBe(false);
  });

  it("rejects an unavailable status without a reason mismatch", () => {
    expect(
      IdentityScopeResponse.safeParse({
        ...common,
        status: "unavailable",
        reason: "no_roots",
        isAdmin: false,
      }).success,
    ).toBe(true);
  });
});

it("refuses scope segments longer than 255 UTF-8 bytes", () => {
  expect(ScopeCanonicalPath.safeParse(`/${"é".repeat(128)}`).success).toBe(false);
  expect(ScopeCanonicalPath.safeParse(`/${"é".repeat(127)}a`).success).toBe(true);
});
