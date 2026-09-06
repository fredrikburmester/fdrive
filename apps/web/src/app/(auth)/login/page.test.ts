import type { ApiClient } from "@fdrive/contracts";
import { describe, expect, it, vi } from "vitest";
import { resolveLoginSubtitle } from "./page";

describe("resolveLoginSubtitle", () => {
  it("names the SFTPGo host from the about endpoint", async () => {
    const client = {
      about: vi.fn().mockResolvedValue({
        version: "1.0.0",
        builtOn: { name: "SFTPGo", sourceUrl: "https://github.com/drakkan/sftpgo" },
        provider: { type: "sftpgo", label: "127.0.0.1:58080" },
      }),
    } as unknown as ApiClient;

    const subtitle = await resolveLoginSubtitle(async () => client);

    expect(subtitle).toBe("Sign in with your SFTPGo account on 127.0.0.1:58080");
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
