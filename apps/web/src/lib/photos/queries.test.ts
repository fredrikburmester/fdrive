// @vitest-environment jsdom
import type { PhotoItem } from "@fdrive/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { groupByMonth, usePhotos } from "./queries.ts";

const photosMock = vi.fn();

vi.mock("@/lib/api/client", () => ({
  apiClient: { photos: (...args: unknown[]) => photosMock(...args) },
}));

function photo(name: string, takenAt: string | null, modifiedAt: string): PhotoItem {
  return { path: `/${name}`, name, size: 1, takenAt, modifiedAt };
}

describe("groupByMonth", () => {
  it("groups by the month taken, or modified without a date taken, keeping the order", () => {
    const months = groupByMonth(
      [
        photo("a.jpg", "2024-05-31T23:30:00", "2020-01-01T00:00:00.000Z"),
        photo("b.png", null, "2024-05-10T12:00:00.000Z"),
        photo("c.jpg", "2024-04-02T09:00:00", "2024-06-01T00:00:00.000Z"),
      ],
      "en-US",
    );

    expect(months.map((month) => [month.label, month.photos.map((p) => p.name)])).toEqual([
      ["May 2024", ["a.jpg", "b.png"]],
      ["April 2024", ["c.jpg"]],
    ]);
  });
});

describe("usePhotos", () => {
  it("reads the first page, then the next one from its cursor, until there is none", async () => {
    photosMock
      .mockResolvedValueOnce({
        photos: [photo("a.jpg", null, "2024-05-10T12:00:00.000Z")],
        nextCursor: "c1",
      })
      .mockResolvedValueOnce({ photos: [], nextCursor: null });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children);

    const { result } = renderHook(() => usePhotos(), { wrapper });
    await waitFor(() => expect(result.current.hasNextPage).toBe(true));
    await act(() => result.current.fetchNextPage());

    await waitFor(() => expect(result.current.hasNextPage).toBe(false));
    expect(photosMock.mock.calls).toEqual([[undefined], ["c1"]]);
  });
});
