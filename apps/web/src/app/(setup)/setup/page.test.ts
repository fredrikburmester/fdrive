import type { ApiClient } from "@fdrive/contracts";
import { describe, expect, it, vi } from "vitest";
import { shouldRedirectToFiles } from "./page";

function buildClient(setupRequired: boolean): ApiClient {
  return {
    about: vi.fn().mockResolvedValue({
      version: "1.0.0",
      builtOn: { name: "SFTPGo", sourceUrl: "https://github.com/drakkan/sftpgo" },
      provider: setupRequired ? null : { type: "sftpgo", label: "sftpgo:8080" },
      setupRequired,
    }),
  } as unknown as ApiClient;
}

describe("shouldRedirectToFiles", () => {
  it("is false while setup is required", async () => {
    expect(await shouldRedirectToFiles(async () => buildClient(true))).toBe(false);
  });

  it("is true once setup is complete", async () => {
    expect(await shouldRedirectToFiles(async () => buildClient(false))).toBe(true);
  });

  it("fails open to false when the API is unreachable", async () => {
    const result = await shouldRedirectToFiles(async () => {
      throw new Error("connect ECONNREFUSED");
    });

    expect(result).toBe(false);
  });
});
