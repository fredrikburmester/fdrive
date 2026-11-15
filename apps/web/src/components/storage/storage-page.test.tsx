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
  trash: true,
  remove: { mutate: vi.fn(), isPending: false },
}));

vi.mock("@/components/shell/page-header", () => ({ PageHeader: () => null }));
vi.mock("@/lib/storage/queries", () => ({ useStorageUsage: () => mocks.query }));
vi.mock("@/lib/files/queries", () => ({ useDelete: () => mocks.remove }));
vi.mock("@/lib/api/auth-queries", () => ({
  useMe: () => ({
    data: {
      activeIdentityId: "i1",
      identities: [{ id: "i1", capabilities: { trash: mocks.trash, index: true } }],
    },
  }),
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
  mocks.trash = true;
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

    const trip = screen.getByText("trip.mov").closest("li") as HTMLElement;
    expect(within(trip).getByText("/Videos")).toBeTruthy();
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
    const group = screen.getByText(/^3 copies, 2\.0 MB/).closest("section") as HTMLElement;
    expect(within(group).getAllByRole("listitem")).toHaveLength(3);
    expect(screen.getByText(/^2 copies, 10 B/)).toBeTruthy();
    expect(
      within(group)
        .getAllByRole("button", { name: "Reveal clip.mov in folder" })
        .map((button) => button.getAttribute("href")),
    ).toEqual(["/files/a?select=clip.mov", "/files/b?select=clip.mov", "/files/c?select=clip.mov"]);

    fireEvent.click(screen.getByRole("button", { name: "Move y.txt to Trash" }));
    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByText('"y.txt" will be moved to Trash.')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Move to Trash" }));

    expect(mocks.remove.mutate).toHaveBeenCalledWith(
      [{ path: "/y.txt", kind: "file" }],
      expect.anything(),
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["storage", "usage"] });
  });

  it("says a copy is deleted for good where the login has no Trash, and keeps it on cancel", () => {
    mocks.trash = false;
    renderPage({ data: { ...EMPTY, duplicates: [{ size: 10, paths: ["/x.txt", "/y.txt"] }] } });

    fireEvent.click(screen.getByRole("button", { name: "Delete x.txt" }));
    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByText(/permanently deleted/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(mocks.remove.mutate).not.toHaveBeenCalled();
  });

  it("explains that the numbers need the search index", () => {
    renderPage({ data: { ...EMPTY, indexed: false } });

    expect(screen.getByText(/does not cover your files yet/)).toBeTruthy();
    expect(screen.queryByText("Images")).toBeNull();
    expect(screen.queryByText("Duplicates")).toBeNull();
  });

  it("holds the space while loading and reports a failure", () => {
    renderPage({ isLoading: true });
    expect(document.querySelector('[data-slot="skeleton"]')).toBeTruthy();
    cleanup();
    renderPage({ isError: true, error: new Error("offline") });
    expect(screen.getByRole("alert").textContent).toBe("offline");
  });
});
