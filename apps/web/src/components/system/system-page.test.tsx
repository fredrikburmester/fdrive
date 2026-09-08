// @vitest-environment jsdom
import type { SystemFeaturesResponse } from "@fdrive/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const useSystemFeatures = vi.fn();
vi.mock("@/lib/api/system-queries", () => ({ useSystemFeatures: () => useSystemFeatures() }));
vi.mock("@/components/shell/page-header", () => ({
  PageHeader: ({ breadcrumbs }: { breadcrumbs: ReactNode }) => <header>{breadcrumbs}</header>,
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
    roots: [],
  };
}

function mount(title: string) {
  return render(
    <SystemPage
      title={title}
      description="Page description"
      lastUpdated={null}
      actions={<button type="button">Page action</button>}
    >
      <p>Sidecar content</p>
    </SystemPage>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SystemPage feature admission", () => {
  it("replaces a managed-off processing page with the feature control link", () => {
    useSystemFeatures.mockReturnValue({ data: features("settings") });
    mount("Indexer");

    expect(screen.getByText("Indexer is off")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Manage features" }).getAttribute("href")).toBe(
      "/system/features",
    );
    expect(screen.queryByText("Sidecar content")).toBeNull();
    expect(screen.queryByRole("button", { name: "Page action" })).toBeNull();
  });

  it("keeps legacy configuration pages visible so an upgrade retains current behavior", () => {
    useSystemFeatures.mockReturnValue({ data: features("legacy") });
    mount("OCR");

    expect(screen.getByText("Sidecar content")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Page action" })).toBeTruthy();
    expect(screen.queryByText("OCR is off")).toBeNull();
  });

  it("keeps a processing page visible when one of its managed features is enabled", () => {
    useSystemFeatures.mockReturnValue({
      data: features("settings", { ...off, thumbnails: true }),
    });
    mount("Thumbnails");

    expect(screen.getByText("Sidecar content")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Page action" })).toBeTruthy();
    expect(screen.queryByText("Thumbnails is off")).toBeNull();
  });
});
