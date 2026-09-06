import type { ApiClient } from "@fdrive/contracts";
import { describe, expect, it, vi } from "vitest";
import { resolveLoginSubtitle, shouldRedirectToSetup } from "./page";

describe("resolveLoginSubtitle", () => {
  it("names the SFTPGo host from the about endpoint", async () => {
    const client = {
      about: vi.fn().mockResolvedValue({
        version: "1.0.0",
        builtOn: { name: "SFTPGo", sourceUrl: "https://github.com/drakkan/sftpgo" },
        provider: { type: "sftpgo", label: "127.0.0.1:58080" },
        setupRequired: false,
      }),
    } as unknown as ApiClient;

    const subtitle = await resolveLoginSubtitle(async () => client);

    expect(subtitle).toBe("Sign in with your SFTPGo account on 127.0.0.1:58080");
  });

  it("falls back to a generic subtitle when the provider is null", async () => {
    const client = {
      about: vi.fn().mockResolvedValue({
        version: "1.0.0",
        builtOn: { name: "SFTPGo", sourceUrl: "https://github.com/drakkan/sftpgo" },
        provider: null,
        setupRequired: true,
      }),
    } as unknown as ApiClient;

    const subtitle = await resolveLoginSubtitle(async () => client);

    expect(subtitle).toBe("Sign in with your SFTPGo account");
  });

  it("falls back to a generic subtitle when the API is unreachable", async () => {
    const subtitle = await resolveLoginSubtitle(async () => {
      throw new Error("connect ECONNREFUSED");
    });

    expect(subtitle).toBe("Sign in with your SFTPGo account");
  });

  it("falls back to a generic subtitle when the about call itself rejects", async () => {
    const client = {
      about: vi.fn().mockRejectedValue(new Error("network error")),
    } as unknown as ApiClient;

    const subtitle = await resolveLoginSubtitle(async () => client);

    expect(subtitle).toBe("Sign in with your SFTPGo account");
  });
});

describe("shouldRedirectToSetup", () => {
  it("is true when the about endpoint reports setup is required", async () => {
    const client = {
      about: vi.fn().mockResolvedValue({
        version: "1.0.0",
        builtOn: { name: "SFTPGo", sourceUrl: "https://github.com/drakkan/sftpgo" },
        provider: null,
        setupRequired: true,
      }),
    } as unknown as ApiClient;

    expect(await shouldRedirectToSetup(async () => client)).toBe(true);
  });

  it("is false when setup is not required", async () => {
    const client = {
      about: vi.fn().mockResolvedValue({
        version: "1.0.0",
        builtOn: { name: "SFTPGo", sourceUrl: "https://github.com/drakkan/sftpgo" },
        provider: { type: "sftpgo", label: "127.0.0.1:58080" },
        setupRequired: false,
      }),
    } as unknown as ApiClient;

    expect(await shouldRedirectToSetup(async () => client)).toBe(false);
  });

  it("fails open to false when the API is unreachable", async () => {
    const redirect = await shouldRedirectToSetup(async () => {
      throw new Error("connect ECONNREFUSED");
    });

    expect(redirect).toBe(false);
  });
});
