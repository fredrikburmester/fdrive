import type { Scope } from "@fdrive/core";
import { describe, expect, it } from "vitest";
import { ScopeOverrideValidationError, validateScopeOverrides } from "./validate-overrides.ts";

function scope(overrides: Partial<Scope> = {}): Scope {
  return { rootName: "sftpgo", fsPrefix: "/pool/team", virtualPrefix: "/shared", ...overrides };
}

describe("validateScopeOverrides", () => {
  it("accepts an empty list", () => {
    expect(() => validateScopeOverrides([])).not.toThrow();
  });

  it("accepts a well-formed list of unique mappings", () => {
    expect(() =>
      validateScopeOverrides([
        scope(),
        scope({ virtualPrefix: "/team2", fsPrefix: "/pool/team2" }),
      ]),
    ).not.toThrow();
  });

  it("rejects more than the cap", () => {
    const scopes = Array.from({ length: 33 }, (_, i) =>
      scope({ virtualPrefix: `/t${i}`, fsPrefix: `/pool/t${i}` }),
    );
    expect(() => validateScopeOverrides(scopes)).toThrow(ScopeOverrideValidationError);
    try {
      validateScopeOverrides(scopes);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ScopeOverrideValidationError);
      expect((error as ScopeOverrideValidationError).reason).toBe("too_many");
    }
  });

  it("rejects an invalid root name", () => {
    try {
      validateScopeOverrides([scope({ rootName: "Not Valid" })]);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ScopeOverrideValidationError);
      expect((error as ScopeOverrideValidationError).reason).toBe("invalid_mapping");
    }
  });

  it("rejects a non-canonical path", () => {
    try {
      validateScopeOverrides([scope({ fsPrefix: "/pool/team/" })]);
      expect.unreachable();
    } catch (error) {
      expect((error as ScopeOverrideValidationError).reason).toBe("invalid_mapping");
    }
  });

  it("rejects a duplicate virtualPrefix", () => {
    try {
      validateScopeOverrides([scope(), scope({ fsPrefix: "/pool/other" })]);
      expect.unreachable();
    } catch (error) {
      expect((error as ScopeOverrideValidationError).reason).toBe("duplicate_virtual_prefix");
    }
  });

  it("rejects a mapping on a root outside the known set, when one is given", () => {
    expect(() =>
      validateScopeOverrides([scope()], [], { knownRoots: new Set(["sftpgo"]) }),
    ).not.toThrow();
    try {
      validateScopeOverrides([scope({ rootName: "other" })], [], {
        knownRoots: new Set(["sftpgo"]),
      });
      expect.unreachable();
    } catch (error) {
      expect((error as ScopeOverrideValidationError).reason).toBe("unknown_root");
    }
  });

  it("accepts canonical, unique unindexed prefixes that map nothing", () => {
    expect(() => validateScopeOverrides([scope()], ["/archive", "/shared/old"])).not.toThrow();
  });

  it("rejects a non-canonical unindexed prefix", () => {
    try {
      validateScopeOverrides([], ["archive"]);
      expect.unreachable();
    } catch (error) {
      expect((error as ScopeOverrideValidationError).reason).toBe("invalid_unindexed_prefix");
    }
  });

  it("rejects a duplicate unindexed prefix", () => {
    try {
      validateScopeOverrides([], ["/archive", "/archive"]);
      expect.unreachable();
    } catch (error) {
      expect((error as ScopeOverrideValidationError).reason).toBe("duplicate_unindexed_prefix");
    }
  });

  it("rejects an unindexed prefix that is also a mapped virtualPrefix", () => {
    try {
      validateScopeOverrides([scope()], ["/shared"]);
      expect.unreachable();
    } catch (error) {
      expect((error as ScopeOverrideValidationError).reason).toBe("unindexed_prefix_collision");
    }
  });

  it("rejects more unindexed prefixes than the cap", () => {
    const prefixes = Array.from({ length: 33 }, (_, i) => `/p${i}`);
    try {
      validateScopeOverrides([], prefixes);
      expect.unreachable();
    } catch (error) {
      expect((error as ScopeOverrideValidationError).reason).toBe("too_many");
    }
  });
});
