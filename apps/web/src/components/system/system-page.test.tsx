// @vitest-environment jsdom
import type { SystemFeaturesResponse } from "@fdrive/contracts";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const useSystemFeatures = vi.fn();
vi.mock("@/lib/api/system-queries", () => ({ useSystemFeatures: () => useSystemFeatures() }));
vi.mock("@/components/shell/page-header", () => ({
  PageHeader: ({ breadcrumbs }: { breadcrumbs: ReactNode }) => <header>{breadcrumbs}</header>,
}));

vi.mock("./processing-failures", () => ({
  FAILURE_FEATURES: ["thumbnails", "textSearch", "semanticSearch", "imageSearch"],
  ProcessingFailures: () => <div>Failure history</div>,
}));

const { SystemPage } = await import("./system-page");

const off = {
  thumbnails: false,
  textSearch: false,
  searchOcr: false,
  semanticSearch: false,
  imageSearch: false,
  pdfOcr: false,
};

function features(source: SystemFeaturesResponse["source"], values = off): SystemFeaturesResponse {
  return {
    source,
    configuration: {
      version: 1,
      revision: 1,
      values,
      walkthroughComplete: true,
    },
    statuses: [],
  };
}

function mount(props: Partial<Parameters<typeof SystemPage>[0]> = {}) {
  return render(
    <SystemPage
      title="Indexer"
      description="Page description"
      lastUpdated={null}
      actions={<button type="button">Page action</button>}
      {...props}
    >
      <p>Sidecar content</p>
    </SystemPage>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SystemPage header and bar", () => {
  it("names the page in the header's trail, as its heading", () => {
    useSystemFeatures.mockReturnValue({ data: features("settings") });
    mount({ title: "General" });

    const trail = screen.getByRole("navigation", { name: "breadcrumb" });
    expect(within(trail).getByText("System")).toBeTruthy();
    const heading = within(trail).getByRole("heading", { level: 1, name: "General" });
    expect(heading.getAttribute("aria-current")).toBe("page");
    // The page has one heading for its name: the bar under the header does not repeat it.
    expect(screen.getAllByRole("heading", { name: "General" })).toHaveLength(1);
  });

  it("carries the description, scope note, last update and actions in one bar", () => {
    useSystemFeatures.mockReturnValue({ data: features("settings") });
    const { container } = mount({ title: "General", lastUpdated: new Date() });

    const bar = container.querySelector('[data-slot="page-bar"]') as HTMLElement;
    expect(within(bar).getByText("Page description")).toBeTruthy();
    expect(within(bar).getByText(/^Installation-wide\./)).toBeTruthy();
    expect(within(bar).getByText("Last updated just now")).toBeTruthy();
    expect(within(bar).getByRole("button", { name: "Page action" })).toBeTruthy();
    // The content follows the bar edge to edge, inside the page body.
    const body = container.querySelector('[data-slot="page-body"]') as HTMLElement;
    expect(body.contains(bar)).toBe(true);
    expect(body.contains(screen.getByText("Sidecar content"))).toBe(true);
  });

  it("leaves out the last update until the page has data, and the actions when there are none", () => {
    useSystemFeatures.mockReturnValue({ data: features("settings") });
    const { container } = render(
      <SystemPage title="General" description="Page description" lastUpdated={null}>
        <p>Sidecar content</p>
      </SystemPage>,
    );

    expect(screen.queryByText(/^Last updated/)).toBeNull();
    expect(container.querySelector('[data-slot="system-page-actions"]')).toBeNull();
  });
});

describe("SystemPage feature admission", () => {
  it("replaces a managed-off processing page with the feature control link", () => {
    useSystemFeatures.mockReturnValue({ data: features("settings") });
    mount({ feature: ["thumbnails", "textSearch", "imageSearch"] });

    expect(screen.getByText("Indexer is off")).toBeTruthy();
    expect(
      screen.getByText("Processing is inactive. Existing index and cache data are retained."),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Manage features" }).getAttribute("href")).toBe(
      "/system/features",
    );
    expect(screen.queryByText("Sidecar content")).toBeNull();
    expect(screen.queryByRole("button", { name: "Page action" })).toBeNull();
    expect(screen.getByText(/^Installation-wide\./)).toBeTruthy();
  });

  it("keeps a processing page visible when one of its managed features is enabled", () => {
    useSystemFeatures.mockReturnValue({
      data: features("settings", { ...off, thumbnails: true }),
    });
    mount({ title: "Thumbnails", feature: "thumbnails" });

    expect(screen.getByText("Sidecar content")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Page action" })).toBeTruthy();
    expect(screen.queryByText("Thumbnails is off")).toBeNull();
  });

  it("shows a page that administers no feature at all", () => {
    useSystemFeatures.mockReturnValue({ data: features("settings") });
    mount({ title: "General" });

    expect(screen.getByText("Sidecar content")).toBeTruthy();
    expect(screen.queryByText("General is off")).toBeNull();
    expect(
      screen.getByText(
        "Installation-wide. Applies to every user and login, not just the one you are browsing.",
      ),
    ).toBeTruthy();
  });

  it("turns a page off through `enabled` for a subsystem that is not a feature", () => {
    useSystemFeatures.mockReturnValue({ data: features("settings") });
    mount({ title: "Office", enabled: false });

    expect(screen.getByText("Office is off")).toBeTruthy();
    expect(screen.queryByText("Sidecar content")).toBeNull();
  });

  it("keeps an enabled non-feature page visible", () => {
    useSystemFeatures.mockReturnValue({ data: features("settings") });
    mount({ title: "Office", enabled: true });

    expect(screen.getByText("Sidecar content")).toBeTruthy();
  });
});
