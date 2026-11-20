import { expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`redirect:${path}`);
  },
}));

import SystemFeaturesPage from "./page";

it("sends an old link to the Features page on to System", () => {
  expect(() => SystemFeaturesPage()).toThrow("redirect:/system");
});
