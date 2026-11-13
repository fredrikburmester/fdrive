import { describe, expect, it } from "vitest";
import {
  AdminProvider,
  AdminProvidersResponse,
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
  shareWithPeople: false,
};
const FIELD = { name: "username", label: "Username", kind: "text", required: true };

describe("provider contracts", () => {
  it("knows the files folder only", () => {
    expect(ProviderType.options).toEqual(["local"]);
    // SFTPGo, WebDAV and S3 were replaced by the files folder; their rows are no longer a type.
    for (const type of ["sftpgo", "webdav", "s3", "gdrive"]) {
      expect(ProviderType.safeParse(type).success).toBe(false);
    }
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
    const provider = {
      id: ID,
      type: "local",
      label: "Home",
      credentialFields: [FIELD],
      capabilities: CAPABILITIES,
    };
    expect(PublicProvider.parse(provider)).toEqual(provider);
    // The login form relies on the flags to say "files only" before sign-in.
    expect(PublicProvider.safeParse({ ...provider, capabilities: undefined }).success).toBe(false);
    expect(ProvidersResponse.parse({ providers: [provider] }).providers).toHaveLength(1);
  });

  it("shows the local folder with no endpoint, never another non-URL", () => {
    const local = {
      id: ID,
      type: "local",
      label: "Local folder",
      baseUrl: "",
      config: {},
      enabled: true,
      managedByEnv: true,
      capabilities: { ...CAPABILITIES, shareWithPeople: true },
      identityCount: 0,
      reachable: true,
      checkedAt: "2026-01-01T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    expect(AdminProvider.parse(local)).toEqual(local);
    expect(AdminProvider.safeParse({ ...local, baseUrl: "local" }).success).toBe(false);
    expect(AdminProvider.safeParse({ ...local, baseUrl: "http://dav.test/" }).success).toBe(false);
    expect(AdminProvider.safeParse({ ...local, identityCount: -1 }).success).toBe(false);
    expect(AdminProvider.safeParse({ ...local, capabilities: undefined }).success).toBe(false);
    expect(AdminProvidersResponse.parse({ providers: [local] })).toEqual({ providers: [local] });
  });

  it("renames only, with a trimmed and bounded name", () => {
    expect(AdminProviderUpdateRequest.parse({ label: "  Home storage  " })).toEqual({
      label: "Home storage",
    });
    for (const label of ["", " \t\n ", "x".repeat(121)]) {
      expect(AdminProviderUpdateRequest.safeParse({ label }).success).toBe(false);
    }
    expect(AdminProviderUpdateRequest.parse({ label: "x".repeat(120) }).label).toHaveLength(120);
    expect(AdminProviderUpdateRequest.safeParse({}).success).toBe(false);
    for (const extra of [{ enabled: false }, { baseUrl: "http://a" }, { config: { x: "y" } }]) {
      expect(AdminProviderUpdateRequest.safeParse({ label: "Home", ...extra }).success).toBe(false);
    }
  });
});
