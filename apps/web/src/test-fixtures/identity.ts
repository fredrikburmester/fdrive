import type { IdentitySummary, MeResponse, ProviderCapabilities } from "@fdrive/contracts";

type IdentityOverrides = Omit<Partial<IdentitySummary>, "capabilities"> & {
  capabilities?: Partial<ProviderCapabilities>;
};

export function makeIdentity(overrides: IdentityOverrides = {}): IdentitySummary {
  return {
    id: "one",
    username: "ada",
    providerType: "local",
    providerLabel: "Main",
    providerId: "00000000-0000-4000-8000-000000000009",
    ...overrides,
    capabilities: {
      zip: true,
      setModifiedAt: true,
      atomicMove: true,
      trash: false,
      shares: true,
      shareWithPeople: false,
      office: true,
      index: true,
      ...overrides.capabilities,
    },
  };
}

export function makeMe(overrides: Partial<MeResponse> = {}): MeResponse {
  return {
    account: { id: "a", displayName: "Ada" },
    identity: makeIdentity(),
    isAdmin: false,
    ...overrides,
  };
}
