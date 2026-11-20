// @vitest-environment jsdom
import type { StorageUsageResponse } from "@fdrive/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";

const mocks = vi.hoisted(() => ({
  query: {
    data: undefined as StorageUsageResponse | undefined,
    isLoading: false,
    isError: false,
    error: null as unknown,
  },
  remove: { mutate: vi.fn(), isPending: false },
}));

vi.mock("@/components/shell/page-header", () => ({ PageHeader: () => null }));
vi.mock("@/lib/storage/queries", () => ({ useStorageUsage: () => mocks.query }));
vi.mock("@/lib/files/queries", () => ({ useDelete: () => mocks.remove }));
vi.mock("@/lib/api/trash-settings-queries", () => ({
  useTrashSettings: () => ({ data: { retentionDays: 30 } }),
}));

const { StoragePage } = await import("./storage-page");

const KINDS: StorageUsageResponse["kinds"] = [
  { kind: "images", bytes: 3 * 1024 ** 2 },
  { kind: "videos", bytes: 1024 ** 3 },
  { kind: "documents", bytes: 2048 },
  { kind: "audio", bytes: 0 },
  { kind: "other", bytes: 512 },
];

const EMPTY = { indexed: true, used: 0, limit: null, kinds: KINDS, largest: [], duplicates: [] };

function renderPage(query: Partial<typeof mocks.query>) {
  mocks.query = { data: undefined, isLoading: false, isError: false, error: null, ...query };
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, "invalidateQueries");
  render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <StoragePage />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return { invalidate };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("StoragePage", () => {
  it("shows used space against the limit, by kind, and the largest files with a way to each", () => {
    renderPage({
      data: {
        ...EMPTY,
        used: 2 * 1024 ** 3,
        limit: 4 * 1024 ** 3,
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

    // The largest files are a table like the file list: name, folder, size, a way to it.
    expect(screen.getByRole("columnheader", { name: "Folder" })).toBeTruthy();
    const trip = screen.getByText("trip.mov").closest("tr") as HTMLElement;
    // The folder has its own column, and sits under the name where a phone hides that column.
    expect(within(trip).getAllByText("/Videos")).toHaveLength(2);
    expect(trip.textContent).toContain("1.0 GB");
    expect(
      within(trip).getByRole("button", { name: "Reveal trip.mov in folder" }).getAttribute("href"),
    ).toBe("/files/Videos?select=trip.mov");
    expect(within(trip).queryByRole("button", { name: /Trash/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Reveal notes.pdf in folder" })).toBeTruthy();
    expect(screen.getByText("No identical files in your folder.")).toBeTruthy();
  });

  it("shows used space alone without a limit, and no list without large files", () => {
    renderPage({ data: EMPTY });

    expect(screen.getByText("0 B used")).toBeTruthy();
    expect(screen.queryByRole("progressbar", { name: "Storage used" })).toBeNull();
    expect(screen.queryByText("Largest files")).toBeNull();
  });

  it("lists identical files by wasted space and moves a copy to Trash after asking", () => {
    mocks.remove.mutate.mockImplementation((_items: unknown, options: { onSuccess?: () => void }) =>
      options.onSuccess?.(),
    );
    const { invalidate } = renderPage({
      data: {
        ...EMPTY,
        duplicates: [
          { size: 1024 ** 2, paths: ["/a/clip.mov", "/b/clip.mov", "/c/clip.mov"] },
          { size: 10, paths: ["/x.txt", "/y.txt"] },
        ],
      },
    });

    expect(
      screen.getByText("Identical files in your folder, most wasted space first."),
    ).toBeTruthy();
    // One table, each group titled by a row of its own, then a row per copy.
    const table = screen.getByRole("table");
    const rows = within(table)
      .getAllByRole("row")
      .slice(1)
      .map((row) => row.textContent ?? "");
    expect(rows).toHaveLength(7);
    expect(rows[0]).toMatch(/^3 copies, 2\.0 MB wasted$/);
    expect(rows.slice(1, 4).every((row) => row.startsWith("clip.mov"))).toBe(true);
    expect(rows[4]).toMatch(/^2 copies, 10 B wasted$/);
    expect(
      screen
        .getAllByRole("button", { name: "Reveal clip.mov in folder" })
        .map((button) => button.getAttribute("href")),
    ).toEqual(["/files/a?select=clip.mov", "/files/b?select=clip.mov", "/files/c?select=clip.mov"]);

    fireEvent.click(screen.getByRole("button", { name: "Move y.txt to Trash" }));
    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByText(/^"y\.txt" will be moved to Trash\./)).toBeTruthy();
    mocks.remove.mutate.mockImplementationOnce(
      (_entries: unknown, options: { onSuccess: () => void }) => options.onSuccess(),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Move to Trash" }));

    expect(mocks.remove.mutate).toHaveBeenCalledWith(
      [{ path: "/y.txt", kind: "file" }],
      expect.anything(),
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["storage", "usage"] });
    // One copy left: that group goes at once, before the index catches up.
    expect(screen.queryByText(/^2 copies, 10 B/)).toBeNull();
    expect(screen.getByText(/^3 copies, 2\.0 MB/)).toBeTruthy();
  });

  it("keeps a copy when its move to Trash is cancelled", () => {
    renderPage({ data: { ...EMPTY, duplicates: [{ size: 10, paths: ["/x.txt", "/y.txt"] }] } });

    fireEvent.click(screen.getByRole("button", { name: "Move x.txt to Trash" }));
    const dialog = screen.getByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(mocks.remove.mutate).not.toHaveBeenCalled();
    expect(screen.getByText(/^2 copies, 10 B/)).toBeTruthy();
  });

  it("explains that the numbers need the search index", () => {
    renderPage({ data: { ...EMPTY, indexed: false } });

    expect(screen.getByText("No storage numbers yet")).toBeTruthy();
    expect(screen.getByText(/does not cover your files yet/)).toBeTruthy();
    expect(screen.queryByText("Images")).toBeNull();
    expect(screen.queryByText("Duplicates")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("holds the space while loading and reports a failure", () => {
    renderPage({ isLoading: true });
    expect(document.querySelector('[data-slot="skeleton"]')).toBeTruthy();
    cleanup();
    renderPage({ isError: true, error: new Error("offline") });
    expect(screen.getByRole("alert").textContent).toBe("offline");
  });
});
