import type { IdentitySummary, MeResponse, ProviderCapabilities } from "@fdrive/contracts";

type IdentityOverrides = Omit<Partial<IdentitySummary>, "capabilities"> & {
  capabilities?: Partial<ProviderCapabilities>;
};

export function makeIdentity(overrides: IdentityOverrides = {}): IdentitySummary {
  return {
    id: "one",
    username: "ada",
    providerType: "sftpgo",
    providerLabel: "Main",
    providerId: "00000000-0000-4000-8000-000000000009",
    ...overrides,
    capabilities: {
      zip: true,
      setModifiedAt: true,
      atomicMove: true,
      trash: false,
      shares: true,
      office: true,
      index: true,
      scopeMapping: true,
      ...overrides.capabilities,
    },
  };
}

export function makeMe(overrides: Partial<MeResponse> = {}): MeResponse {
  const identities = overrides.identities ?? [makeIdentity()];
  return {
    account: { id: "a", displayName: "Ada" },
    identities,
    activeIdentityId: identities[0]?.id ?? "one",
    isAdmin: false,
    ...overrides,
  };
}
