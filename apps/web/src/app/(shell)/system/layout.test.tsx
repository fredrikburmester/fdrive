import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isAdmin: true,
  me: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`redirect:${path}`);
  },
}));
vi.mock("@/lib/api/server", () => ({
  serverApiClient: async () => ({
    about: async () => ({ setupRequired: false }),
    me: mocks.me,
  }),
}));

import SystemLayout from "./layout";

beforeEach(() => {
  mocks.me.mockReset();
  mocks.me.mockImplementation(async () => ({ userId: "fixture", isAdmin: mocks.isAdmin }));
});

it("renders the page for an administrator", async () => {
  mocks.isAdmin = true;
  const html = renderToStaticMarkup(
    await SystemLayout({ children: <section>Storage servers</section> }),
  );
  expect(html).toContain("Storage servers");
});

it("sends a signed-in non-administrator to /files instead of rendering the page", async () => {
  mocks.isAdmin = false;
  await expect(SystemLayout({ children: <section>Storage servers</section> })).rejects.toThrow(
    "redirect:/files",
  );
});

it("sends a visitor without a session to /login", async () => {
  mocks.me.mockRejectedValue(new Error("unauthorized"));
  await expect(SystemLayout({ children: <section>Storage servers</section> })).rejects.toThrow(
    "redirect:/login",
  );
});
