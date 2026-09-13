import { describe, expect, it } from "vitest";
import {
  AdminProvider,
  AdminProviderCreateRequest,
  AdminProvidersResponse,
  AdminProviderTestRequest,
  AdminProviderUpdateRequest,
  ProviderCapabilities,
  ProviderField,
  ProvidersResponse,
  ProviderType,
  PublicProvider,
} from "./providers.ts";

const ID = "123e4567-e89b-42d3-a456-426614174000";
const CAPABILITIES = {
  zip: true,
  setModifiedAt: true,
  atomicMove: true,
  trash: false,
  shares: true,
  office: true,
  index: false,
  scopeMapping: true,
};
const FIELD = { name: "username", label: "Username", kind: "text", required: true };

describe("provider contracts", () => {
  it("knows the registered provider types only", () => {
    expect(ProviderType.safeParse("sftpgo").success).toBe(true);
    expect(ProviderType.safeParse("gdrive").success).toBe(false);
  });

  it("requires every capability flag", () => {
    expect(ProviderCapabilities.parse(CAPABILITIES)).toEqual(CAPABILITIES);
    const { zip: _drop, ...rest } = CAPABILITIES;
    expect(ProviderCapabilities.safeParse(rest).success).toBe(false);
  });

  it("parses fields, public providers and the public list", () => {
    expect(ProviderField.parse({ ...FIELD, transient: true, help: "h", maxLength: 3 })).toEqual({
      ...FIELD,
      transient: true,
      help: "h",
      maxLength: 3,
    });
    expect(ProviderField.safeParse({ ...FIELD, kind: "checkbox" }).success).toBe(false);
    const provider = { id: ID, type: "sftpgo", label: "Home", credentialFields: [FIELD] };
    expect(PublicProvider.parse(provider)).toEqual(provider);
    expect(ProvidersResponse.parse({ providers: [provider] }).providers).toHaveLength(1);
  });

  it("parses admin providers and the admin list", () => {
    const provider = {
      id: ID,
      type: "sftpgo",
      label: "Home",
      baseUrl: "http://sftpgo:8080",
      config: { homeTemplate: "sftpgo:/{username}" },
      enabled: true,
      managedByEnv: false,
      identityCount: 2,
      reachable: true,
      checkedAt: "2026-01-01T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    expect(AdminProvider.parse(provider)).toEqual(provider);
    expect(AdminProvider.safeParse({ ...provider, baseUrl: "nope" }).success).toBe(false);
    expect(AdminProvider.safeParse({ ...provider, identityCount: -1 }).success).toBe(false);
    const list = {
      providers: [provider],
      types: [
        {
          type: "sftpgo",
          label: "SFTPGo",
          configFields: [],
          credentialFields: [FIELD],
          capabilities: CAPABILITIES,
        },
      ],
    };
    expect(AdminProvidersResponse.parse(list)).toEqual(list);
  });

  it("normalizes names consistently for creates and label-only updates", () => {
    const create = { type: "sftpgo", baseUrl: "http://sftpgo:8080" };
    expect(AdminProviderCreateRequest.parse({ ...create, label: "  Home storage  " }).label).toBe(
      "Home storage",
    );
    expect(AdminProviderUpdateRequest.parse({ label: "  Home storage  " })).toEqual({
      label: "Home storage",
    });
    for (const label of ["", " \t\n ", "x".repeat(121)]) {
      expect(AdminProviderCreateRequest.safeParse({ ...create, label }).success).toBe(false);
      expect(AdminProviderUpdateRequest.safeParse({ label }).success).toBe(false);
    }
    expect(AdminProviderUpdateRequest.parse({ label: "x".repeat(120) }).label).toHaveLength(120);
  });

  it("bounds the admin requests", () => {
    const create = { type: "sftpgo", label: "Home", baseUrl: "http://sftpgo:8080" };
    expect(AdminProviderCreateRequest.parse(create)).toEqual(create);
    expect(AdminProviderCreateRequest.safeParse({ ...create, label: "" }).success).toBe(false);
    expect(AdminProviderCreateRequest.safeParse({ ...create, extra: 1 }).success).toBe(false);
    expect(AdminProviderCreateRequest.safeParse({ ...create, config: { a: 1 } }).success).toBe(
      false,
    );
    expect(AdminProviderUpdateRequest.parse({})).toEqual({});
    expect(AdminProviderUpdateRequest.parse({ enabled: false, config: { x: "y" } })).toEqual({
      enabled: false,
      config: { x: "y" },
    });
    expect(AdminProviderUpdateRequest.safeParse({ baseUrl: "nope" }).success).toBe(false);
    expect(AdminProviderTestRequest.parse({ type: "sftpgo", baseUrl: "http://a" })).toEqual({
      type: "sftpgo",
      baseUrl: "http://a",
    });
    expect(AdminProviderTestRequest.safeParse({ baseUrl: "http://a" }).success).toBe(false);
  });
});
