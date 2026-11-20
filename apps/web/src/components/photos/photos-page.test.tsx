// @vitest-environment jsdom
import type { PhotoItem } from "@fdrive/contracts";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { apiClient } from "@/lib/api/client";
import { PhotosPage, photoCountLabel } from "./photos-page";

const mocks = vi.hoisted(() => ({
  photos: {} as Record<string, unknown>,
  fetchNextPage: vi.fn(),
}));

vi.mock("@/lib/photos/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/photos/queries")>()),
  usePhotos: () => mocks.photos,
}));
// The shell header needs the sidebar context and search wiring this page test does not exercise.
vi.mock("@/components/shell/page-header", () => ({ PageHeader: () => <header /> }));

function photo(path: string, takenAt: string | null, modifiedAt: string): PhotoItem {
  return { path, name: path.slice(path.lastIndexOf("/") + 1), size: 1024, modifiedAt, takenAt };
}

const MAY_A = photo("/pics/a.jpg", "2024-05-20T10:00:00", "2026-01-01T00:00:00.000Z");
const MAY_B = photo("/pics/b b.jpg", "2024-05-01T14:03:09", "2026-01-01T00:00:00.000Z");
// No date taken: it falls in the month it was last modified.
const JANUARY = photo("/old/c.png", null, "2023-01-15T12:00:00.000Z");

/** A month's title as the page writes it, in whatever locale the test runs in. */
function monthLabel(date: string): string {
  return new Date(date).toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

function loaded(photos: PhotoItem[], query: Record<string, unknown> = {}) {
  return {
    data: { pages: [{ photos, nextCursor: null }] },
    isPending: false,
    isError: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: mocks.fetchNextPage,
    ...query,
  };
}

/** Every observer the page made, with the callback that says the grid's end came into view. */
const observers: { callback: IntersectionObserverCallback; disconnect: () => void }[] = [];

function scrollEndIntoView(isIntersecting: boolean) {
  const observer = observers.at(-1);
  if (observer === undefined) throw new Error("the page is not watching the end of the grid");
  act(() => {
    observer.callback(
      [{ isIntersecting } as IntersectionObserverEntry],
      observer as unknown as IntersectionObserver,
    );
  });
}

beforeEach(() => {
  observers.length = 0;
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      readonly callback: IntersectionObserverCallback;
      readonly disconnect = vi.fn();
      constructor(callback: IntersectionObserverCallback) {
        this.callback = callback;
        observers.push(this);
      }
      observe() {}
    },
  );
  mocks.photos = loaded([MAY_A, MAY_B, JANUARY]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it("groups photos by month under a strip with the month's count", () => {
  render(<PhotosPage />);

  expect(screen.getByText("3 photos")).toBeTruthy();
  const regions = screen.getAllByRole("region").map((region) => region.getAttribute("aria-label"));
  expect(regions).toEqual([monthLabel(MAY_A.takenAt ?? ""), monthLabel(JANUARY.modifiedAt)]);

  const may = within(screen.getByRole("region", { name: monthLabel(MAY_A.takenAt ?? "") }));
  expect(may.getByRole("heading", { name: monthLabel(MAY_A.takenAt ?? "") })).toBeTruthy();
  expect(may.getByText("2")).toBeTruthy();
  expect(may.getAllByRole("link").map((link) => link.getAttribute("aria-label"))).toEqual([
    "a.jpg",
    "b b.jpg",
  ]);

  const january = within(screen.getByRole("region", { name: monthLabel(JANUARY.modifiedAt) }));
  expect(january.getByText("1")).toBeTruthy();
  expect(january.getAllByRole("link")).toHaveLength(1);
});

it("shows each photo as a thumbnail that opens it in the viewer", () => {
  render(<PhotosPage />);

  const link = screen.getByRole("link", { name: "b b.jpg" });
  expect(link.getAttribute("href")).toBe("/view/pics/b%20b.jpg");
  expect(link.getAttribute("title")).toBe("b b.jpg");
  expect(link.querySelector("img")?.getAttribute("src")).toBe(
    apiClient.thumbUrl("/pics/b b.jpg", 256),
  );
});

it("keeps a photo's tile, with an icon, when its thumbnail does not load", () => {
  render(<PhotosPage />);
  const link = screen.getByRole("link", { name: "a.jpg" });
  const image = link.querySelector("img");
  if (image === null) throw new Error("the tile has no thumbnail");

  fireEvent.error(image);

  expect(link.querySelector("img")).toBeNull();
  expect(link.querySelector("svg")).not.toBeNull();
  // The other tiles keep their thumbnails.
  expect(screen.getByRole("link", { name: "b b.jpg" }).querySelector("img")).not.toBeNull();
});

it("shows a placeholder grid while photos load", () => {
  mocks.photos = loaded([], { data: undefined, isPending: true });
  render(<PhotosPage />);

  expect(document.querySelector('[data-slot="photos-skeleton"]')?.children).toHaveLength(12);
  expect(screen.queryByRole("region")).toBeNull();
  expect(screen.queryByText("0 photos")).toBeNull();
  expect(screen.queryByText("No photos yet.")).toBeNull();
});

it("says when photos could not be loaded", () => {
  mocks.photos = loaded([], { data: undefined, isError: true });
  render(<PhotosPage />);

  expect(screen.getByText("Could not load photos.")).toBeTruthy();
  expect(screen.queryByText("No photos yet.")).toBeNull();
});

it("says when there are no photos", () => {
  mocks.photos = loaded([]);
  render(<PhotosPage />);

  expect(screen.getByText("No photos yet.")).toBeTruthy();
  expect(screen.getByText("0 photos")).toBeTruthy();
  expect(screen.queryByRole("region")).toBeNull();
  // Nothing more to load, so nothing watches the end of the grid.
  expect(observers).toHaveLength(0);
});

it("loads the next page when the end of the grid scrolls into view", () => {
  mocks.photos = loaded([MAY_A], { hasNextPage: true });
  const view = render(<PhotosPage />);

  expect(screen.getByText("1+ photos")).toBeTruthy();
  scrollEndIntoView(false);
  expect(mocks.fetchNextPage).not.toHaveBeenCalled();
  scrollEndIntoView(true);
  expect(mocks.fetchNextPage).toHaveBeenCalledTimes(1);

  // While that page is on its way, the page stops watching, then watches afresh.
  const first = observers.at(-1);
  mocks.photos = loaded([MAY_A], { hasNextPage: true, isFetchingNextPage: true });
  view.rerender(<PhotosPage />);
  expect(first?.disconnect).toHaveBeenCalledTimes(1);
  expect(observers).toHaveLength(1);

  mocks.photos = loaded([MAY_A, JANUARY], { hasNextPage: true });
  view.rerender(<PhotosPage />);
  expect(observers).toHaveLength(2);
});

it("keeps watching for more while the first pages hold no photos", () => {
  mocks.photos = loaded([], { hasNextPage: true });
  render(<PhotosPage />);

  expect(screen.queryByText("No photos yet.")).toBeNull();
  scrollEndIntoView(true);
  expect(mocks.fetchNextPage).toHaveBeenCalledTimes(1);
});

it("counts photos, with a plus while more can load", () => {
  expect(photoCountLabel(0, false)).toBe("0 photos");
  expect(photoCountLabel(1, false)).toBe("1 photo");
  expect(photoCountLabel(2, false)).toBe("2 photos");
  expect(photoCountLabel(1, true)).toBe("1+ photos");
  expect(photoCountLabel(200, true)).toBe("200+ photos");
});
