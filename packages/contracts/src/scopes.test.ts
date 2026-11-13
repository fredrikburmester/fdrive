import { describe, expect, it } from "vitest";
import { IdentityScopeReason } from "./scopes.ts";

describe("IdentityScopeReason", () => {
  it("accepts every documented reason", () => {
    for (const reason of [
      "ok",
      "no_connection",
      "provider_mismatch",
      "invalid_configuration",
      "no_roots",
      "mismatch",
      "indexer_unreachable",
    ])
      expect(IdentityScopeReason.safeParse(reason).success).toBe(true);
  });

  it("rejects an unknown reason and the retired virtual-folder reasons", () => {
    for (const reason of ["something_else", "unmapped_mount", "overflow"])
      expect(IdentityScopeReason.safeParse(reason).success).toBe(false);
  });
});
