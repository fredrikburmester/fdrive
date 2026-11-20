// @vitest-environment jsdom
import type { SystemActivityItem } from "@fdrive/contracts";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SYSTEM_AREAS } from "@/lib/system/areas";
import { SYSTEM_SCOPE_NOTE } from "@/lib/system/pages";

interface Activity {
  data?: { items: SystemActivityItem[] };
  isError: boolean;
  pending: Set<string>;
}

const mocks = vi.hoisted(() => ({
  pathname: "/system/general" as string | null,
  activity: { data: { items: [] }, isError: false, pending: new Set<string>() } as Activity,
  features: {} as { data?: { configuration: { values: Record<string, boolean> } } },
  office: {} as { data?: { configuration: { enabled: boolean } } },
  ai: {} as { data?: { configuration: { organize: boolean; chat: boolean } } },
  users: {} as { data?: { users: unknown[] } },
}));
vi.mock("next/navigation", () => ({ usePathname: () => mocks.pathname }));
// The shell header needs the sidebar context; its trail is all this test reads from it.
vi.mock("@/components/shell/page-header", () => ({
  PageHeader: ({ breadcrumbs }: { breadcrumbs: ReactNode }) => <header>{breadcrumbs}</header>,
}));
vi.mock("@/lib/api/activity-queries", () => ({ useSystemActivity: () => mocks.activity }));
vi.mock("@/lib/api/system-queries", () => ({
  useSystemFeatures: () => mocks.features,
  useAdminUsers: () => mocks.users,
}));
vi.mock("@/lib/api/office-settings-queries", () => ({ useSystemOffice: () => mocks.office }));
vi.mock("@/lib/ai/queries", () => ({ useSystemAi: () => mocks.ai }));

const { SystemShell } = await import("./system-shell");

const ALL_OFF = {
  thumbnails: false,
  textSearch: false,
  searchOcr: false,
  semanticSearch: false,
  imageSearch: false,
  pdfOcr: false,
};

function features(values: Partial<typeof ALL_OFF>) {
  return { data: { configuration: { values: { ...ALL_OFF, ...values } } } };
}

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

function renderShell() {
  return render(
    <SystemShell>
      <p>Area sheet</p>
    </SystemShell>,
  );
}

function row(name: string): HTMLElement {
  return within(screen.getByRole("navigation", { name: "System areas" })).getByRole("link", {
    name,
  });
}

/** "On", "Off", or `null` for a row that ends in no dot. */
function dotOf(name: string): string | null {
  return within(row(name)).queryByRole("img")?.getAttribute("aria-label") ?? null;
}

/** A row's activity mark, as its state and everything it says. */
function markOf(name: string): { state: string | null; text: string } | null {
  const marks = row(name).querySelectorAll("[data-system-activity]");
  expect(marks.length).toBeLessThanOrEqual(1);
  const mark = marks[0];
  return mark === undefined
    ? null
    : { state: mark.getAttribute("data-system-activity"), text: mark.textContent ?? "" };
}

afterEach(() => {
  cleanup();
  mocks.pathname = "/system/general";
  mocks.activity = { data: { items: [] }, isError: false, pending: new Set() };
  mocks.features = {};
  mocks.office = {};
  mocks.ai = {};
  mocks.users = {};
});

describe("SystemShell: the list of areas", () => {
  it("lists every area as a link to its own page, beside the chosen area's sheet", () => {
    const view = renderShell();

    const nav = screen.getByRole("navigation", { name: "System areas" });
    expect(
      within(nav)
        .getAllByRole("link")
        .map((link) => link.getAttribute("href")),
    ).toEqual(SYSTEM_AREAS.map((area) => area.href));
    for (const area of SYSTEM_AREAS) {
      // A row is named by its label; what is inside is its description.
      const link = row(area.label);
      const description = document.getElementById(link.getAttribute("aria-describedby") ?? "");
      expect(description?.textContent).toBe(area.description);
    }
    expect(within(nav).getByText(SYSTEM_SCOPE_NOTE)).toBeTruthy();
    // The list is one column of the frame and the area's sheet is the other.
    const frame = view.container.querySelector('[data-slot="list-sheet"]');
    expect(frame?.querySelector('[data-slot="list-sheet-list"]')?.contains(nav)).toBe(true);
    expect(
      frame
        ?.querySelector('[data-slot="list-sheet-content"]')
        ?.contains(screen.getByText("Area sheet")),
    ).toBe(true);
  });

  it.each([
    ["/system/general", "General"],
    ["/system/indexer", "Full-text search"],
    ["/system/backups/restore", "Backups"],
    ["/system/about", "About"],
    // System itself opens on the first area.
    ["/system", "General"],
    ["/system/nope", "General"],
  ])("marks the area of %s as the current page", (pathname, current) => {
    mocks.pathname = pathname;
    renderShell();

    for (const area of SYSTEM_AREAS) {
      expect(row(area.label).getAttribute("aria-current")).toBe(
        area.label === current ? "page" : null,
      );
    }
  });

  it("names the frame in the header: the heading on System itself, the way back inside an area", () => {
    mocks.pathname = "/system";
    const index = renderShell();
    const header = index.container.querySelector("header") as HTMLElement;
    expect(within(header).getByRole("heading", { level: 1, name: "System" })).toBeTruthy();
    expect(within(header).queryByRole("link")).toBeNull();
    index.unmount();

    mocks.pathname = "/system/users";
    const area = renderShell();
    const trail = within(area.container.querySelector("header") as HTMLElement);
    expect(trail.getByRole("link", { name: "Back to System" }).getAttribute("href")).toBe(
      "/system",
    );
    // Inside an area the sheet's own title is the page's heading.
    expect(trail.queryByRole("heading")).toBeNull();
  });
});

describe("SystemShell: what a row ends in", () => {
  it("shows no dot, count or mark while nothing is known yet", () => {
    mocks.activity = { isError: false, pending: new Set() };
    renderShell();

    for (const area of SYSTEM_AREAS) {
      expect(dotOf(area.label)).toBeNull();
      expect(markOf(area.label)).toBeNull();
      // Only the label and the description: nothing sits at the row's end.
      expect(row(area.label).textContent).toBe(`${area.label}${area.description}`);
    }
  });

  it("ends each feature's row in an On or Off dot from the features", () => {
    mocks.features = features({ thumbnails: true, semanticSearch: true, searchOcr: true });
    renderShell();

    expect(dotOf("Thumbnails")).toBe("On");
    expect(dotOf("Full-text search")).toBe("Off");
    expect(dotOf("Semantic search")).toBe("On");
    expect(dotOf("Searchable PDFs")).toBe("Off");
    expect(dotOf("Image search")).toBe("Off");
    expect(within(row("Thumbnails")).getByRole("img").getAttribute("data-tone")).toBe("success");
    expect(within(row("Image search")).getByRole("img").getAttribute("data-tone")).toBe("off");
    // Areas that are only settings cannot be turned off, so they have no dot.
    for (const name of ["General", "Users", "Backups", "About"]) {
      expect(dotOf(name)).toBeNull();
    }
    // Office and AI answer for themselves, and have not yet.
    expect(dotOf("Office")).toBeNull();
    expect(dotOf("AI")).toBeNull();
  });

  it("ends Office's row in a dot from its own settings", () => {
    mocks.office = { data: { configuration: { enabled: true } } };
    const on = renderShell();
    expect(dotOf("Office")).toBe("On");
    on.unmount();

    mocks.office = { data: { configuration: { enabled: false } } };
    renderShell();
    expect(dotOf("Office")).toBe("Off");
  });

  it.each([
    [{ organize: true, chat: false }, "On"],
    [{ organize: false, chat: true }, "On"],
    [{ organize: true, chat: true }, "On"],
    [{ organize: false, chat: false }, "Off"],
  ])("ends AI's row in a dot that is on while organize or chat is: %o", (configuration, dot) => {
    mocks.ai = { data: { configuration } };
    renderShell();

    expect(dotOf("AI")).toBe(dot);
  });

  it("ends Users' row in how many there are", () => {
    mocks.users = { data: { users: [{}, {}, {}] } };
    renderShell();

    expect(row("Users").textContent).toBe("UsersPeople who can sign in3");
    // The count is Users' alone.
    expect(row("General").textContent).toBe("GeneralServer address, trash and setup");
  });

  it("counts no users as zero, not as unknown", () => {
    mocks.users = { data: { users: [] } };
    renderShell();

    expect(row("Users").textContent).toBe("UsersPeople who can sign in0");
  });
});

describe("SystemShell: an area's activity", () => {
  it("spins on the row of an area that works, with its percentage where one is known", () => {
    mocks.features = features({ thumbnails: true });
    mocks.activity = {
      isError: false,
      pending: new Set(),
      data: {
        items: [
          item({
            id: "thumbnails",
            state: "working",
            percent: 63,
            detail: "Rebuilding previews: 63 of 100 files processed",
          }),
          item({ id: "textSearch", state: "working", detail: "Scanning files" }),
          item({ id: "users", state: "idle", detail: "Nothing to do" }),
        ],
      },
    };
    renderShell();

    expect(markOf("Thumbnails")).toEqual({
      state: "working",
      text: "63%Rebuilding previews: 63 of 100 files processed",
    });
    const mark = row("Thumbnails").querySelector("[data-system-activity]") as HTMLElement;
    expect(mark.getAttribute("title")).toBe("Rebuilding previews: 63 of 100 files processed");
    expect(
      mark.querySelector(".animate-spin")?.classList.contains("motion-reduce:animate-none"),
    ).toBe(true);
    // No percentage is invented where none is reported.
    expect(markOf("Full-text search")).toEqual({ state: "working", text: "Scanning files" });
    // An idle area, and one that reports nothing, carry no mark.
    expect(markOf("Users")).toBeNull();
    expect(markOf("General")).toBeNull();
    // The mark sits beside the area's dot, not in its place.
    expect(dotOf("Thumbnails")).toBe("On");
  });

  it("spins from the moment an action is sent, before the server reports any progress", () => {
    mocks.activity = {
      isError: false,
      pending: new Set(["users", "thumbnails"]),
      // The last answer still carries the previous run's percentage.
      data: {
        items: [item({ id: "thumbnails", state: "working", percent: 90, detail: "Old run" })],
      },
    };
    renderShell();

    expect(markOf("Users")).toEqual({ state: "working", text: "Starting…" });
    expect(markOf("Thumbnails")).toEqual({ state: "working", text: "Starting…" });
    expect(markOf("General")).toBeNull();
  });

  it("marks an area that needs a look or is waiting, without spinning", () => {
    mocks.activity = {
      isError: false,
      pending: new Set(),
      data: {
        items: [
          item({ id: "thumbnails", warning: true, detail: "12 previews failed" }),
          item({ id: "office", state: "waiting", detail: "Waiting for Office to start" }),
        ],
      },
    };
    renderShell();

    expect(markOf("Thumbnails")).toEqual({ state: "warning", text: "12 previews failed" });
    expect(markOf("Office")).toEqual({ state: "warning", text: "Waiting for Office to start" });
    expect(row("Thumbnails").querySelector(".animate-spin")).toBeNull();
    expect(row("Office").querySelector(".animate-spin")).toBeNull();
  });

  it("warns on every feature's row, and stops spinning there, when activity cannot be read", () => {
    const unavailable = "Activity status unavailable. Waiting for a fresh update.";
    mocks.activity = {
      isError: true,
      pending: new Set(),
      // A failed poll keeps the last answer, which may still say an area is working.
      data: {
        items: [
          item({ id: "thumbnails", state: "working", percent: 63, detail: "Rebuilding previews" }),
          item({ id: "general", state: "working", detail: "Saving" }),
        ],
      },
    };
    renderShell();

    for (const area of SYSTEM_AREAS.filter((candidate) => candidate.feature !== undefined)) {
      expect(markOf(area.label)).toEqual({ state: "warning", text: unavailable });
      expect(row(area.label).querySelector(".animate-spin")).toBeNull();
    }
    // Areas without a feature keep what they last reported.
    expect(markOf("General")).toEqual({ state: "working", text: "Saving" });
    for (const name of ["Users", "Backups", "Office", "AI", "About"]) {
      expect(markOf(name)).toBeNull();
    }
  });

  it("still spins for an action just sent while activity cannot be read", () => {
    mocks.activity = { isError: true, pending: new Set(["thumbnails"]) };
    renderShell();

    expect(markOf("Thumbnails")).toEqual({ state: "working", text: "Starting…" });
  });

  it("never marks an area that reports no activity of its own", () => {
    mocks.activity = {
      isError: false,
      pending: new Set(["features", "storage"]),
      data: { items: [item({ id: "features", state: "working", detail: "Saving features" })] },
    };
    renderShell();

    for (const area of SYSTEM_AREAS) {
      expect(markOf(area.label)).toBeNull();
    }
  });
});
