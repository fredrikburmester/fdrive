// @vitest-environment jsdom
import type { MeResponse } from "@fdrive/contracts";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeMe } from "@/test-fixtures/identity";

const mocks = vi.hoisted(() => ({
  pathname: "/account" as string | null,
  me: undefined as MeResponse | undefined,
}));

vi.mock("next/navigation", () => ({ usePathname: () => mocks.pathname }));
// The real header needs the sidebar and search providers; its own tests cover it.
vi.mock("@/components/shell/page-header", () => ({
  useShellMe: () => ({ data: mocks.me }),
  PageHeader: ({ breadcrumbs }: { breadcrumbs: ReactNode }) => <header>{breadcrumbs}</header>,
}));

const { SettingsShell } = await import("./settings-shell");

/** Hidden below the `md` breakpoint, where a phone shows the list or the section, not both. */
const PHONE_HIDDEN = "max-md:hidden";

/** Renders the frame at `pathname`; `me: null` stands for an account that is still loading. */
function mount(pathname: string | null, me: MeResponse | null = makeMe()) {
  mocks.pathname = pathname;
  mocks.me = me ?? undefined;
  const view = render(
    <SettingsShell>
      <p>Section body</p>
    </SettingsShell>,
  );
  const nav = screen.getByRole("navigation", { name: "Settings sections" });
  const content = view.container.querySelector('[data-slot="settings-content"]') as HTMLElement;
  return { nav, content };
}

afterEach(cleanup);

describe("SettingsShell", () => {
  it("opens the first section on /account, and keeps the list for a phone", () => {
    const { nav, content } = mount("/account");

    expect(within(content).getByText("Section body")).toBeTruthy();
    expect(within(nav).getByRole("link", { name: "Appearance" }).getAttribute("aria-current")).toBe(
      "page",
    );
    // A phone sees the section list here, under a plain "Settings" title with nothing to go back to.
    expect(nav.classList.contains(PHONE_HIDDEN)).toBe(false);
    expect(content.classList.contains(PHONE_HIDDEN)).toBe(true);
    const phoneTitle = screen.getByRole("heading", { level: 1, name: "Settings" });
    expect(phoneTitle.closest("li")?.classList.contains("md:hidden")).toBe(true);
    const wideTitle = screen.getByRole("heading", { level: 1, name: "Appearance" });
    expect(wideTitle.closest("li")?.classList.contains(PHONE_HIDDEN)).toBe(true);
    expect(screen.queryByRole("link", { name: "Back to Settings" })).toBeNull();
  });

  it("shows a section at its own URL, with a way back to the list on a phone", () => {
    const { nav, content } = mount("/account/tokens");

    expect(within(nav).getByRole("link", { name: "API tokens" }).getAttribute("aria-current")).toBe(
      "page",
    );
    expect(
      within(nav).getByRole("link", { name: "Appearance" }).getAttribute("aria-current"),
    ).toBeNull();
    expect(nav.classList.contains(PHONE_HIDDEN)).toBe(true);
    expect(content.classList.contains(PHONE_HIDDEN)).toBe(false);

    const title = screen.getByRole("heading", { level: 1 });
    expect(title.textContent).toBe("API tokens");
    expect(title.getAttribute("aria-current")).toBe("page");
    expect(title.closest("li")?.classList.contains(PHONE_HIDDEN)).toBe(false);
    const back = screen.getByRole("link", { name: "Back to Settings" });
    expect(back.getAttribute("href")).toBe("/account");
    expect(back.closest("li")?.classList.contains("md:hidden")).toBe(true);
  });

  it("leads the wide trail with a link to Settings", () => {
    mount("/account/password");

    const trail = screen.getByRole("navigation", { name: "breadcrumb" });
    const settings = within(trail).getByRole("link", { name: "Settings" });
    expect(settings.getAttribute("href")).toBe("/account");
    expect(settings.closest("li")?.classList.contains(PHONE_HIDDEN)).toBe(true);
    expect(within(trail).getByRole("heading", { level: 1 }).textContent).toBe("Password");
  });

  it("lists Encryption only where the installation has encrypted folders", () => {
    const { nav } = mount("/account", makeMe({ encryptedFolders: false }));
    expect(within(nav).queryByRole("link", { name: "Encryption" })).toBeNull();
    expect(within(nav).getAllByRole("link")).toHaveLength(5);

    cleanup();
    const loading = mount("/account", null);
    expect(within(loading.nav).getByRole("link", { name: "Encryption" })).toBeTruthy();
  });

  it("falls back to the first section for a path it does not know", () => {
    const { nav } = mount("/account/nope");

    expect(within(nav).getByRole("link", { name: "Appearance" }).getAttribute("aria-current")).toBe(
      "page",
    );
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Appearance");
  });
});
