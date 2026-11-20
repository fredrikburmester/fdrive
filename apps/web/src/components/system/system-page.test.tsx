// @vitest-environment jsdom
import type { FeatureStatus, SystemFeaturesResponse } from "@fdrive/contracts";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const useSystemFeatures = vi.fn();
const mutate = vi.fn();
const useUpdateFeatures = vi.fn();
vi.mock("@/lib/api/system-queries", () => ({
  useSystemFeatures: () => useSystemFeatures(),
  useUpdateFeatures: () => useUpdateFeatures(),
}));

vi.mock("./processing-failures", () => ({
  FAILURE_FEATURES: ["thumbnails", "textSearch", "semanticSearch", "imageSearch"],
  ProcessingFailures: ({ retryEnabled }: { retryEnabled: boolean }) => (
    <div data-retry={String(retryEnabled)}>Failure history</div>
  ),
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

function features(values = off, statuses: FeatureStatus[] = []): SystemFeaturesResponse {
  return {
    source: "settings",
    configuration: { version: 1, revision: 7, values, walkthroughComplete: true },
    statuses,
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

function sheet(container: HTMLElement): HTMLElement {
  return container.querySelector('[data-slot="detail-sheet"]') as HTMLElement;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function ready(update: Record<string, unknown> = {}) {
  useUpdateFeatures.mockReturnValue({ mutate, isPending: false, isError: false, ...update });
}

describe("SystemPage sheet", () => {
  it("draws the area as a sheet whose title is the page's heading", () => {
    ready();
    useSystemFeatures.mockReturnValue({ data: features() });
    const { container } = mount({ title: "General" });

    const region = screen.getByRole("region", { name: "General" });
    expect(region).toBe(sheet(container));
    expect(within(region).getByRole("heading", { level: 1, name: "General" })).toBeTruthy();
    expect(screen.getAllByRole("heading", { name: "General" })).toHaveLength(1);
    expect(within(region).getByText("Page description")).toBeTruthy();
    expect(within(region).getByText("Sidecar content")).toBeTruthy();
  });

  it("carries the last update beside the badges and the actions in the header", () => {
    ready();
    useSystemFeatures.mockReturnValue({ data: features() });
    const { container } = mount({
      title: "General",
      lastUpdated: new Date(),
      badges: <span>Reachable</span>,
    });

    const badges = container.querySelector('[data-slot="detail-sheet-badges"]') as HTMLElement;
    expect(within(badges).getByText("Reachable")).toBeTruthy();
    expect(within(badges).getByText("Updated just now")).toBeTruthy();
    const actions = container.querySelector('[data-slot="detail-sheet-actions"]') as HTMLElement;
    expect(within(actions).getByRole("button", { name: "Page action" })).toBeTruthy();
  });

  it("leaves out the last update until the page has data, and the actions when there are none", () => {
    ready();
    useSystemFeatures.mockReturnValue({ data: features() });
    const { container } = render(
      <SystemPage title="General" description="Page description" lastUpdated={null}>
        <p>Sidecar content</p>
      </SystemPage>,
    );

    expect(screen.queryByText(/^Updated/)).toBeNull();
    expect(container.querySelector('[data-slot="system-page-actions"]')).toBeNull();
    expect(container.querySelector('[data-slot="detail-sheet-footer"]')).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("ends the sheet in the footer the area gives it", () => {
    ready();
    useSystemFeatures.mockReturnValue({ data: features() });
    const { container } = mount({ title: "General", footer: <button type="button">Clear</button> });

    const footer = container.querySelector('[data-slot="detail-sheet-footer"]') as HTMLElement;
    expect(within(footer).getByRole("button", { name: "Clear" })).toBeTruthy();
  });
});

describe("SystemPage feature switch", () => {
  it("says what turning an off feature on does, in place of its content, actions and footer", () => {
    ready();
    useSystemFeatures.mockReturnValue({ data: features() });
    const { container } = mount({
      title: "Thumbnails",
      feature: "thumbnails",
      badges: <span>Reachable</span>,
      footer: <button type="button">Clear</button>,
    });

    expect(screen.getByText("Thumbnails is off")).toBeTruthy();
    expect(
      screen.getByText(/^Generate image and PDF previews for the file browser\./),
    ).toBeTruthy();
    expect(
      screen.getByText("Processing is inactive. Existing index and cache data are retained."),
    ).toBeTruthy();
    expect(screen.queryByText("Sidecar content")).toBeNull();
    expect(screen.queryByRole("button", { name: "Page action" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
    expect(screen.queryByText("Reachable")).toBeNull();
    const badges = container.querySelector('[data-slot="detail-sheet-badges"]') as HTMLElement;
    expect(within(badges).getByText("Off")).toBeTruthy();
    // The durable failure history stays, with nothing to retry while processing is off.
    expect(screen.getByText("Failure history").getAttribute("data-retry")).toBe("false");
  });

  it("turns the area's own feature on at once, with what that feature depends on", () => {
    ready();
    useSystemFeatures.mockReturnValue({ data: features() });
    mount({ title: "Semantic search", feature: "semanticSearch" });

    const toggle = screen.getByRole("switch", { name: "Enable semantic search" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);

    expect(mutate).toHaveBeenCalledWith({
      revision: 7,
      values: { ...off, semanticSearch: true, textSearch: true },
      walkthroughComplete: true,
      walkthroughStep: 0,
    });
  });

  it("turns it off the same way, and waits while a change is being saved", () => {
    ready({ isPending: true });
    useSystemFeatures.mockReturnValue({ data: features({ ...off, thumbnails: true }) });
    mount({ title: "Thumbnails", feature: "thumbnails" });

    const toggle = screen.getByRole("switch", { name: "Enable thumbnails" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(toggle.hasAttribute("disabled") || toggle.getAttribute("aria-disabled") === "true").toBe(
      true,
    );
  });

  it("keeps a page visible while any of its features is on, with the first one's switch", () => {
    ready();
    useSystemFeatures.mockReturnValue({ data: features({ ...off, thumbnails: true }) });
    mount({ title: "Full-text search", feature: ["textSearch", "thumbnails"] });

    expect(screen.getByText("Sidecar content")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Page action" })).toBeTruthy();
    expect(screen.queryByText("Full-text search is off")).toBeNull();
    const toggle = screen.getByRole("switch", { name: "Enable full-text search" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText("Failure history").getAttribute("data-retry")).toBe("true");
  });

  it("has no switch until the features have loaded", () => {
    ready();
    useSystemFeatures.mockReturnValue({ data: undefined });
    mount({ title: "Thumbnails", feature: "thumbnails" });

    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.getByText("Sidecar content")).toBeTruthy();
  });

  it.each([
    ["ready", "On"],
    ["preparing", "Preparing"],
    ["stopping", "Stopping"],
  ] as const)("says a %s feature is %s", (state, label) => {
    ready();
    useSystemFeatures.mockReturnValue({
      data: features({ ...off, thumbnails: true }, [{ id: "thumbnails", state, detail: "Detail" }]),
    });
    const { container } = mount({ title: "Thumbnails", feature: "thumbnails" });

    const badges = container.querySelector('[data-slot="detail-sheet-badges"]') as HTMLElement;
    expect(within(badges).getByText(label).getAttribute("title")).toBe("Detail");
    expect(container.querySelector('[data-slot="feature-problem"]')).toBeNull();
  });

  it("says a feature without a reported state is on", () => {
    ready();
    useSystemFeatures.mockReturnValue({ data: features({ ...off, thumbnails: true }) });
    const { container } = mount({ title: "Thumbnails", feature: "thumbnails" });

    const badges = container.querySelector('[data-slot="detail-sheet-badges"]') as HTMLElement;
    expect(within(badges).getByText("On")).toBeTruthy();
  });

  it("shows why a failed feature failed and retries its preparation", () => {
    ready();
    const values = { ...off, thumbnails: true };
    useSystemFeatures.mockReturnValue({
      data: features(values, [{ id: "thumbnails", state: "failed", detail: "Model missing" }]),
    });
    const { container } = mount({ title: "Thumbnails", feature: "thumbnails" });

    const badges = container.querySelector('[data-slot="detail-sheet-badges"]') as HTMLElement;
    expect(within(badges).getByText("Failed")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("Model missing");
    fireEvent.click(screen.getByRole("button", { name: "Retry preparation" }));

    expect(mutate).toHaveBeenCalledWith({
      revision: 7,
      values,
      walkthroughComplete: true,
      walkthroughStep: 0,
    });
  });

  it("shows what blocks a blocked feature, with nothing to retry", () => {
    ready();
    useSystemFeatures.mockReturnValue({
      data: features({ ...off, thumbnails: true }, [
        { id: "thumbnails", state: "blocked", detail: "Storage is not mounted" },
      ]),
    });
    const { container } = mount({ title: "Thumbnails", feature: "thumbnails" });

    const badges = container.querySelector('[data-slot="detail-sheet-badges"]') as HTMLElement;
    expect(within(badges).getByText("Needs attention")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("Storage is not mounted");
    expect(screen.queryByRole("button", { name: "Retry preparation" })).toBeNull();
  });

  it("says why a change could not be saved", () => {
    ready({ isError: true, error: new Error("Conflict") });
    useSystemFeatures.mockReturnValue({ data: features() });
    mount({ title: "Thumbnails", feature: "thumbnails" });

    expect(screen.getByRole("alert")).toBeTruthy();
  });
});

describe("SystemPage areas that are not features", () => {
  it("shows a page that administers no feature at all", () => {
    ready();
    useSystemFeatures.mockReturnValue({ data: features() });
    const { container } = mount({ title: "General" });

    expect(screen.getByText("Sidecar content")).toBeTruthy();
    expect(screen.queryByText("General is off")).toBeNull();
    expect(screen.queryByText("Failure history")).toBeNull();
    expect(container.querySelector('[data-slot="status-badge"]')).toBeNull();
  });

  it("turns a page off through `enabled`, with the area's own switch and note", () => {
    ready();
    useSystemFeatures.mockReturnValue({ data: features() });
    const { container } = mount({
      title: "Office",
      enabled: false,
      toggle: <button type="button">Enable Office</button>,
      offNote: "Turning Office on starts the document server.",
    });

    expect(screen.getByText("Office is off")).toBeTruthy();
    expect(screen.getByText("Turning Office on starts the document server.")).toBeTruthy();
    expect(screen.queryByText("Sidecar content")).toBeNull();
    expect(screen.queryByRole("button", { name: "Page action" })).toBeNull();
    const badges = container.querySelector('[data-slot="detail-sheet-badges"]') as HTMLElement;
    expect(within(badges).getByText("Off")).toBeTruthy();
    const actions = container.querySelector('[data-slot="detail-sheet-actions"]') as HTMLElement;
    expect(within(actions).getByRole("button", { name: "Enable Office" })).toBeTruthy();
  });

  it("says an off area without a note only that it is off", () => {
    ready();
    useSystemFeatures.mockReturnValue({ data: features() });
    const { container } = mount({ title: "Office", enabled: false });

    const offState = container.querySelector('[data-slot="system-page-off"]') as HTMLElement;
    expect(offState.textContent).toBe("Office is off");
  });

  it("keeps an enabled non-feature page visible, and says it is on", () => {
    ready();
    useSystemFeatures.mockReturnValue({ data: features() });
    const { container } = mount({ title: "Office", enabled: true });

    expect(screen.getByText("Sidecar content")).toBeTruthy();
    const badges = container.querySelector('[data-slot="detail-sheet-badges"]') as HTMLElement;
    expect(within(badges).getByText("On")).toBeTruthy();
  });
});
