import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  clientThrows: false,
  about: vi.fn(),
  me: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`redirect:${path}`);
  },
}));
vi.mock("@/lib/api/server", () => ({
  serverApiClient: async () => {
    if (mocks.clientThrows) throw new Error("API unreachable");
    return { about: mocks.about, me: mocks.me };
  },
}));

import { loadMe } from "./load-me";

beforeEach(() => {
  mocks.clientThrows = false;
  mocks.about.mockReset();
  mocks.about.mockResolvedValue({ setupRequired: false });
  mocks.me.mockReset();
  mocks.me.mockResolvedValue({ userId: "fixture" });
});

it("returns the account when the installation is configured and signed in", async () => {
  await expect(loadMe()).resolves.toEqual({ userId: "fixture" });
});

it("sends an unconfigured installation to /setup without loading an account", async () => {
  mocks.about.mockResolvedValue({ setupRequired: true });

  await expect(loadMe()).rejects.toThrow(/^redirect:\/setup$/);
  expect(mocks.me).not.toHaveBeenCalled();
});

it("sends a failed account load to /login", async () => {
  mocks.me.mockRejectedValue(new Error("unauthorized"));

  await expect(loadMe()).rejects.toThrow(/^redirect:\/login$/);
});

it("sends an unbuildable API client to /login without asking /about", async () => {
  mocks.clientThrows = true;

  await expect(loadMe()).rejects.toThrow(/^redirect:\/login$/);
  expect(mocks.about).not.toHaveBeenCalled();
  expect(mocks.me).not.toHaveBeenCalled();
});
