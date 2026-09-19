import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

vi.mock("@/lib/api/server", () => ({
  serverApiClient: async () => ({
    about: async () => ({ setupRequired: false }),
    me: async () => ({ userId: "fixture" }),
  }),
}));
vi.mock("@/components/shell/app-sidebar", () => ({ AppSidebar: () => <aside>Navigation</aside> }));
vi.mock("@/components/shell/me-hydration", () => ({
  MeHydration: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/components/shell/shell-runtime", () => ({
  ShellRuntime: ({ children }: { children: ReactNode }) => children,
}));
// The chat panel needs the query client the runtime provides; its own tests cover it.
vi.mock("@/components/ai/chat/chat-panel", () => ({ ChatPanel: () => null }));

import ShellLayout from "./layout";

it("bounds the shell viewport while keeping long page content vertically scrollable", async () => {
  const html = renderToStaticMarkup(
    await ShellLayout({ children: <section>Settings content</section> }),
  );
  expect(html).toMatch(
    /data-slot="sidebar-wrapper"[^>]*class="[^"]*h-svh[^"]*min-h-0[^"]*overflow-hidden/,
  );
  expect(html).toMatch(
    /data-slot="sidebar-inset"[^>]*class="[^"]*min-h-0[^"]*overflow-x-hidden[^"]*overflow-y-auto/,
  );
  expect(html).toContain("Settings content");
  expect(html).toContain("Navigation");
});
