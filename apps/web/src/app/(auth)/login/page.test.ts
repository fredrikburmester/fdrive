import type { ApiClient } from "@fdrive/contracts";
import { describe, expect, it, vi } from "vitest";
import { shouldRedirectToSetup } from "./page";

describe("shouldRedirectToSetup", () => {
  it("is true when the about endpoint says setup is required", async () => {
    const client = {
      about: vi.fn().mockResolvedValue({
        version: "1.0.0",
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
        providers: [{ type: "local", label: null }],
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
