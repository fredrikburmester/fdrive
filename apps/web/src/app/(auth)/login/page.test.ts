import type { ApiClient, PublicProvider } from "@fdrive/contracts";
import { describe, expect, it, vi } from "vitest";
import { resolveLoginProviders, shouldRedirectToSetup } from "./page";

const sftpgo: PublicProvider = {
  id: "00000000-0000-4000-8000-000000000001",
  type: "sftpgo",
  label: "127.0.0.1:58080",
  credentialFields: [
    { name: "username", label: "Username", kind: "text", required: true },
    { name: "password", label: "Password", kind: "password", required: true },
  ],
};

describe("resolveLoginProviders", () => {
  it("returns the enabled providers from the public endpoint", async () => {
    const client = {
      providers: vi.fn().mockResolvedValue({ providers: [sftpgo] }),
    } as unknown as ApiClient;

    expect(await resolveLoginProviders(async () => client)).toEqual([sftpgo]);
  });

  it("returns no providers when the API is unreachable", async () => {
    expect(
      await resolveLoginProviders(async () => {
        throw new Error("connect ECONNREFUSED");
      }),
    ).toEqual([]);
  });

  it("returns no providers when the call itself rejects", async () => {
    const client = {
      providers: vi.fn().mockRejectedValue(new Error("502")),
    } as unknown as ApiClient;

    expect(await resolveLoginProviders(async () => client)).toEqual([]);
  });
});

describe("shouldRedirectToSetup", () => {
  it("is true when the about endpoint says setup is required", async () => {
    const client = {
      about: vi.fn().mockResolvedValue({
        version: "1.0.0",
        builtOn: [],
        providers: [],
        setupRequired: true,
      }),
    } as unknown as ApiClient;

    expect(await shouldRedirectToSetup(async () => client)).toBe(true);
  });

  it("is false once a provider is configured", async () => {
    const client = {
      about: vi.fn().mockResolvedValue({
        version: "1.0.0",
        builtOn: [{ name: "SFTPGo", sourceUrl: "https://github.com/drakkan/sftpgo" }],
        providers: [{ type: "sftpgo", label: null }],
        setupRequired: false,
      }),
    } as unknown as ApiClient;

    expect(await shouldRedirectToSetup(async () => client)).toBe(false);
  });

  it("stays on the login page when the API is unreachable", async () => {
    expect(
      await shouldRedirectToSetup(async () => {
        throw new Error("connect ECONNREFUSED");
      }),
    ).toBe(false);
  });
});
