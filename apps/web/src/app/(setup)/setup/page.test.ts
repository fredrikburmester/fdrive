import type { ApiClient } from "@fdrive/contracts";
import { describe, expect, it, vi } from "vitest";
import SetupPage, { shouldRedirectToFiles } from "./page";

const pageMocks = vi.hoisted(() => ({ client: vi.fn() }));
vi.mock("@/lib/api/server", () => ({ serverApiClient: () => pageMocks.client() }));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`redirect:${path}`);
  },
}));

function buildClient(setupRequired: boolean): ApiClient {
  return {
    about: vi.fn().mockResolvedValue({
      version: "1.0.0",
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

describe("setup page continuation", () => {
  it("keeps an authenticated owner in setup until feature choices are finished", async () => {
    pageMocks.client.mockResolvedValue({
      about: async () => ({ setupRequired: false }),
      me: async () => ({ isAdmin: true }),
      systemFeatures: async () => ({ configuration: { walkthroughComplete: false } }),
    });
    const page = await SetupPage();
    expect(page.props.children.type.name).toBe("SetupFeatures");
  });

  it("keeps an authenticated owner in setup if feature loading fails", async () => {
    pageMocks.client.mockResolvedValue({
      about: async () => ({ setupRequired: false }),
      me: async () => ({ isAdmin: true }),
      systemFeatures: async () => {
        throw new Error("temporarily unavailable");
      },
    });
    const page = await SetupPage();
    expect(page.props.children.type.name).toBe("SetupFeatures");
  });

  it("sends other users to files without requiring the owner walkthrough", async () => {
    const features = vi.fn();
    pageMocks.client.mockResolvedValue({
      about: async () => ({ setupRequired: false }),
      me: async () => ({ isAdmin: false }),
      systemFeatures: features,
    });
    await expect(SetupPage()).rejects.toThrow("redirect:/files");
    expect(features).not.toHaveBeenCalled();
  });

  it("sends a finished administrator to files", async () => {
    pageMocks.client.mockResolvedValue({
      about: async () => ({ setupRequired: false }),
      me: async () => ({ isAdmin: true }),
      systemFeatures: async () => ({ configuration: { walkthroughComplete: true } }),
    });
    await expect(SetupPage()).rejects.toThrow("redirect:/files");
  });
});
