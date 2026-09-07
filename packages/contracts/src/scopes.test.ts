import { describe, expect, it } from "vitest";
import {
  IdentityScopeReason,
  IdentityScopeResponse,
  isCanonicalScopePath,
  MAX_SCOPE_MAPPINGS,
  ScopeCanonicalPath,
  ScopeMapping,
  ScopeRootName,
  SetIdentityScopeRequest,
} from "./scopes.ts";

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
    warning: "example warning",
  };

  it("accepts a non-administrator response with no physical mapping data", () => {
    expect(IdentityScopeResponse.safeParse({ ...common, isAdmin: false }).success).toBe(true);
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
