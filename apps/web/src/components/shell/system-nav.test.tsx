// @vitest-environment jsdom
import type { SystemActivityItem } from "@fdrive/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarProvider } from "@/components/ui/sidebar";

interface Activity {
  data?: { items: SystemActivityItem[] };
  isError: boolean;
  pending: Set<string>;
}

const mocks = vi.hoisted(() => ({
  pathname: "/files" as string | null,
  activity: { data: { items: [] }, isError: false, pending: new Set<string>() } as Activity,
}));
vi.mock("next/navigation", () => ({ usePathname: () => mocks.pathname }));
// The hook has tests of its own; here it reports whatever each case needs.
vi.mock("@/lib/api/activity-queries", () => ({ useSystemActivity: () => mocks.activity }));

const { isSystemRoute, SystemNav } = await import("./system-nav");

function item(overrides: Partial<SystemActivityItem>): SystemActivityItem {
  return {
    id: "thumbnails",
    state: "idle",
    percent: null,
    detail: "",
    warning: false,
    operationIds: [],
    ...overrides,
  };
}

function activity(items: SystemActivityItem[], overrides: Partial<Activity> = {}): Activity {
  return { data: { items }, isError: false, pending: new Set(), ...overrides };
}

function renderNav() {
  render(
    <SidebarProvider>
      <SystemNav />
    </SidebarProvider>,
  );
  return screen.getByRole("link", { name: "System" });
}

/** The row's one activity mark: "working", "warning", or `null` while there is nothing to say. */
function markOf(link: HTMLElement): string | null {
  const marks = link.querySelectorAll("[data-system-activity]");
  expect(marks.length).toBeLessThanOrEqual(1);
  return marks[0]?.getAttribute("data-system-activity") ?? null;
}

/** What the row says about its mark to assistive technology. */
function descriptionOf(link: HTMLElement): string | null {
  const id = link.getAttribute("aria-describedby");
  return id === null ? null : (document.getElementById(id)?.textContent ?? null);
}

beforeEach(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  mocks.pathname = "/files";
  mocks.activity = activity([]);
});

describe("SystemNav", () => {
  it("is one row that links to System, however many areas there are", () => {
    mocks.activity = activity([item({ id: "thumbnails" }), item({ id: "textSearch" })]);
    const link = renderNav();

    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(link.getAttribute("href")).toBe("/system");
    expect(link.hasAttribute("data-active")).toBe(false);
    // Nothing is running and nothing needs a look: the row is its icon and its name.
    expect(markOf(link)).toBeNull();
    expect(link.hasAttribute("aria-describedby")).toBe(false);
    expect(link.querySelectorAll("svg")).toHaveLength(1);
    expect(link.closest("li")?.querySelector(".sr-only")).toBeNull();
  });

  it.each(["/system", "/system/general", "/system/backups/restore"])(
    "is the active row on %s",
    (pathname) => {
      mocks.pathname = pathname;

      expect(renderNav().hasAttribute("data-active")).toBe(true);
    },
  );

  it("spins while any area works, and describes every area that does", () => {
    mocks.activity = activity([
      item({
        id: "thumbnails",
        state: "working",
        percent: 63,
        detail: "Rebuilding previews: 63 of 100 files processed",
      }),
      item({ id: "textSearch", state: "working", detail: "Scanning files" }),
      // An area that needs a look does not take the row from one that is working.
      item({ id: "office", state: "waiting", warning: true, detail: "Office is unreachable" }),
      item({ id: "users", state: "idle", detail: "Nothing to do" }),
    ]);
    const link = renderNav();

    expect(markOf(link)).toBe("working");
    const spinner = link.querySelector(".animate-spin");
    expect(spinner?.classList.contains("motion-reduce:animate-none")).toBe(true);
    expect(descriptionOf(link)).toBe(
      "Rebuilding previews: 63 of 100 files processed\nScanning files",
    );
    // One aggregated mark: the row carries no area's own percentage.
    expect(link.textContent).toBe("System");
    expect(link.querySelector("[data-system-activity]")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("spins from the moment an action is sent, before the server reports it", () => {
    mocks.activity = activity([], { pending: new Set(["thumbnails"]) });
    const link = renderNav();

    expect(markOf(link)).toBe("working");
    expect(descriptionOf(link)).toBe("Starting…");
  });

  it("shows a warning mark when an area needs a look, described by those areas alone", () => {
    mocks.activity = activity([
      item({ id: "thumbnails", warning: true, detail: "12 previews failed" }),
      item({ id: "office", state: "waiting", detail: "Waiting for Office to start" }),
      item({ id: "users", state: "idle", detail: "Nothing to do" }),
    ]);
    const link = renderNav();

    expect(markOf(link)).toBe("warning");
    expect(link.querySelector(".animate-spin")).toBeNull();
    expect(descriptionOf(link)).toBe("12 previews failed\nWaiting for Office to start");
  });

  it("warns, and stops spinning, when activity cannot be read", () => {
    // A failed poll keeps the last answer, which may still say an area is working.
    mocks.activity = activity(
      [item({ state: "working", percent: 63, detail: "Rebuilding previews: 63 of 100" })],
      { isError: true },
    );
    const link = renderNav();

    expect(markOf(link)).toBe("warning");
    expect(link.querySelector(".animate-spin")).toBeNull();
    expect(descriptionOf(link)).toBe("Activity status unavailable. Waiting for a fresh update.");
  });

  it("still spins for an action just sent while activity cannot be read", () => {
    mocks.activity = activity([], { isError: true, pending: new Set(["users"]) });
    const link = renderNav();

    expect(markOf(link)).toBe("working");
    expect(descriptionOf(link)).toBe("Activity status unavailable. Waiting for a fresh update.");
  });

  it("shows no mark before the first answer arrives", () => {
    mocks.activity = { isError: false, pending: new Set() };
    const link = renderNav();

    expect(markOf(link)).toBeNull();
    expect(link.hasAttribute("aria-describedby")).toBe(false);
  });
});

describe("isSystemRoute", () => {
  it("is true on System and on every area under it", () => {
    expect(isSystemRoute("/system")).toBe(true);
    expect(isSystemRoute("/system/users")).toBe(true);
    expect(isSystemRoute("/system/backups/restore")).toBe(true);
  });

  it("is false anywhere else, including a path that only starts the same", () => {
    expect(isSystemRoute("/files")).toBe(false);
    expect(isSystemRoute("/systems")).toBe(false);
    expect(isSystemRoute("/files/system")).toBe(false);
    expect(isSystemRoute(null)).toBe(false);
  });
});
