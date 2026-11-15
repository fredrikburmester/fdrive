import type { IdentitySummary, MeResponse } from "@fdrive/contracts";

export function makeIdentity(overrides: Partial<IdentitySummary> = {}): IdentitySummary {
  return {
    id: "one",
    username: "ada",
    providerType: "local",
    providerLabel: "Main",
    providerId: "00000000-0000-4000-8000-000000000009",
    ...overrides,
  };
}

export function makeMe(overrides: Partial<MeResponse> = {}): MeResponse {
  return {
    account: { id: "a", displayName: "Ada" },
    identity: makeIdentity(),
    isAdmin: false,
    trash: false,
    index: true,
    ...overrides,
  };
}
