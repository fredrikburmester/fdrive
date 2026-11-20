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
/** Hidden from the `md` breakpoint up, where the list and the section show side by side. */
const WIDE_HIDDEN = "md:hidden";

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
  const list = view.container.querySelector('[data-slot="list-sheet-list"]') as HTMLElement;
  const content = view.container.querySelector('[data-slot="list-sheet-content"]') as HTMLElement;
  const header = view.container.querySelector("header") as HTMLElement;
  return { nav, list, content, header };
}

afterEach(cleanup);

describe("SettingsShell", () => {
  it("opens the first section on /account, and keeps the list for a phone", () => {
    const { nav, list, content, header } = mount("/account");

    expect(within(list).getByRole("navigation", { name: "Settings sections" })).toBe(nav);
    expect(within(content).getByText("Section body")).toBeTruthy();
    expect(within(nav).getByRole("link", { name: "Appearance" }).getAttribute("aria-current")).toBe(
      "page",
    );
    // A phone sees the section list here, under a plain "Settings" title with nothing to go back to.
    expect(list.classList.contains(PHONE_HIDDEN)).toBe(false);
    expect(content.classList.contains(PHONE_HIDDEN)).toBe(true);
    const phoneTitle = within(header).getByRole("heading", { level: 1, name: "Settings" });
    expect(phoneTitle.classList.contains(WIDE_HIDDEN)).toBe(true);
    expect(screen.queryByRole("link", { name: "Back to Settings" })).toBeNull();
  });

  it("shows a section at its own URL, with a way back to the list on a phone", () => {
    const { nav, list, content, header } = mount("/account/tokens");

    expect(within(nav).getByRole("link", { name: "API tokens" }).getAttribute("aria-current")).toBe(
      "page",
    );
    expect(
      within(nav).getByRole("link", { name: "Appearance" }).getAttribute("aria-current"),
    ).toBeNull();
    expect(list.classList.contains(PHONE_HIDDEN)).toBe(true);
    expect(content.classList.contains(PHONE_HIDDEN)).toBe(false);

    const back = within(header).getByRole("link", { name: "Back to Settings" });
    expect(back.getAttribute("href")).toBe("/account");
    expect(back.classList.contains(WIDE_HIDDEN)).toBe(true);
    // The section's own sheet titles the page, so the header brings no heading of its own.
    expect(screen.queryByRole("heading")).toBeNull();
  });

  it("names the frame in the header of a wide screen, where the list is always beside it", () => {
    const { header } = mount("/account/password");

    const names = within(header)
      .getAllByText("Settings")
      .filter((element) => element.classList.contains(PHONE_HIDDEN));
    expect(names).toHaveLength(1);
    expect(names[0]?.tagName).toBe("SPAN");
  });

  it("titles the list and links every section to its own URL, in order", () => {
    const { nav } = mount("/account");

    // The title above the rows is for the eye; the list is named for assistive technology.
    expect(within(nav).getByText("Settings").getAttribute("aria-hidden")).toBe("true");
    expect(
      within(nav)
        .getAllByRole("link")
        .map((link) => link.getAttribute("href")),
    ).toEqual([
      "/account/appearance",
      "/account/browsing",
      "/account/formats",
      "/account/password",
      "/account/encryption",
      "/account/tokens",
    ]);
    // Rows are words alone: no icon ahead of a label, only a phone's chevron after it.
    for (const link of within(nav).getAllByRole("link")) {
      expect(link.querySelectorAll("svg")).toHaveLength(1);
      expect(link.firstElementChild?.tagName).toBe("SPAN");
    }
  });

  it("names a section by its label and describes it with its one-line summary", () => {
    const { nav } = mount("/account");

    const link = within(nav).getByRole("link", { name: "API tokens" });
    const description = document.getElementById(link.getAttribute("aria-describedby") ?? "");
    expect(description?.textContent).toBe("Tokens for Claude and Raycast");
    // The summary is for the phone's list, where a row has the room for it.
    expect(description?.classList.contains(WIDE_HIDDEN)).toBe(true);
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
    const { nav, list, content } = mount("/account/nope");

    expect(within(nav).getByRole("link", { name: "Appearance" }).getAttribute("aria-current")).toBe(
      "page",
    );
    expect(
      within(nav)
        .getAllByRole("link")
        .filter((link) => link.hasAttribute("aria-current")),
    ).toHaveLength(1);
    // Not /account itself, so a phone shows the section and the way back, not the list.
    expect(list.classList.contains(PHONE_HIDDEN)).toBe(true);
    expect(content.classList.contains(PHONE_HIDDEN)).toBe(false);
    expect(screen.getByRole("link", { name: "Back to Settings" })).toBeTruthy();
  });
});
