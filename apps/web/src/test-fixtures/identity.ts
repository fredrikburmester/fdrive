import type { IdentitySummary, MeResponse } from "@fdrive/contracts";

export function makeIdentity(overrides: Partial<IdentitySummary> = {}): IdentitySummary {
  return {
    id: "one",
    username: "ada",
    ...overrides,
  };
}

export function makeMe(overrides: Partial<MeResponse> = {}): MeResponse {
  return {
    account: { id: "a", displayName: "Ada" },
    identity: makeIdentity(),
    isAdmin: false,
    storageName: "Main",
    index: true,
    ...overrides,
  };
}
