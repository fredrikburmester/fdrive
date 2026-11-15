// @vitest-environment jsdom
import type { StorageUsageResponse } from "@fdrive/contracts";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";

const mocks = vi.hoisted(() => ({
  query: {
    data: undefined as StorageUsageResponse | undefined,
    isLoading: false,
    isError: false,
    error: null as unknown,
  },
}));

vi.mock("@/components/shell/page-header", () => ({ PageHeader: () => null }));
vi.mock("@/lib/storage/queries", () => ({ useStorageUsage: () => mocks.query }));

const { StoragePage } = await import("./storage-page");

const KINDS: StorageUsageResponse["kinds"] = [
  { kind: "images", bytes: 3 * 1024 ** 2 },
  { kind: "videos", bytes: 1024 ** 3 },
  { kind: "documents", bytes: 2048 },
  { kind: "audio", bytes: 0 },
  { kind: "other", bytes: 512 },
];

function renderPage(query: Partial<typeof mocks.query>) {
  mocks.query = { data: undefined, isLoading: false, isError: false, error: null, ...query };
  return render(
    <TooltipProvider>
      <StoragePage />
    </TooltipProvider>,
  );
}

afterEach(cleanup);

describe("StoragePage", () => {
  it("shows used space against the limit, by kind, and the largest files with a way to each", () => {
    renderPage({
      data: {
        indexed: true,
        used: 2 * 1024 ** 3,
        limit: 4 * 1024 ** 3,
        kinds: KINDS,
        largest: [
          { path: "/Videos/trip.mov", size: 1024 ** 3, modifiedAt: "2026-11-01T00:00:00.000Z" },
          { path: "/notes.pdf", size: 2048, modifiedAt: "2026-11-02T00:00:00.000Z" },
        ],
      },
    });

    expect(screen.getByText("2.0 GB of 4.0 GB used")).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "Storage used" })).toBeTruthy();
    const videos = screen.getByText("Videos").closest("li") as HTMLElement;
    expect(within(videos).getByText("1.0 GB")).toBeTruthy();
    expect(screen.getByText("Audio").closest("li")?.textContent).toContain("0 B");
    expect(screen.getByText(/Counted from the search index/)).toBeTruthy();

    const trip = screen.getByText("trip.mov").closest("li") as HTMLElement;
    expect(within(trip).getByText("/Videos")).toBeTruthy();
    expect(
      within(trip).getByRole("button", { name: "Reveal trip.mov in folder" }).getAttribute("href"),
    ).toBe("/files/Videos?select=trip.mov");
    expect(screen.getByRole("button", { name: "Reveal notes.pdf in folder" })).toBeTruthy();
  });

  it("shows used space alone without a limit, and no list without large files", () => {
    renderPage({ data: { indexed: true, used: 0, limit: null, kinds: KINDS, largest: [] } });

    expect(screen.getByText("0 B used")).toBeTruthy();
    expect(screen.queryByRole("progressbar", { name: "Storage used" })).toBeNull();
    expect(screen.queryByText("Largest files")).toBeNull();
  });

  it("explains that the numbers need the search index", () => {
    renderPage({ data: { indexed: false, used: 0, limit: null, kinds: KINDS, largest: [] } });

    expect(screen.getByText(/does not cover your files yet/)).toBeTruthy();
    expect(screen.queryByText("Images")).toBeNull();
  });

  it("holds the space while loading and reports a failure", () => {
    const { container } = renderPage({ isLoading: true });
    expect(container.querySelector('[data-slot="skeleton"]')).toBeTruthy();
    cleanup();
    renderPage({ isError: true, error: new Error("offline") });
    expect(screen.getByRole("alert").textContent).toBe("offline");
  });
});
