"use client";

import type { PhotoItem } from "@fdrive/contracts";
import { useInfiniteQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/keys";

/** Every image the signed-in login can read, newest first, a page at a time. */
export function usePhotos() {
  return useInfiniteQuery({
    queryKey: queryKeys.photos.list(),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => apiClient.photos(pageParam),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
}

/** One month of photos, as the timeline shows it. */
export interface PhotoMonth {
  readonly key: string;
  readonly label: string;
  readonly photos: readonly PhotoItem[];
}

/**
 * Groups photos, already newest first, by the month each was taken in, or modified in when
 * it has no date taken. `takenAt` is the camera's wall-clock time, which `Date` reads as
 * local time, so a photo lands in the month the camera recorded.
 */
export function groupByMonth(photos: readonly PhotoItem[], locale?: string): PhotoMonth[] {
  const months = new Map<string, { key: string; label: string; photos: PhotoItem[] }>();
  for (const photo of photos) {
    const date = new Date(photo.takenAt ?? photo.modifiedAt);
    const key = `${date.getFullYear()}-${date.getMonth() + 1}`;
    const month = months.get(key) ?? {
      key,
      label: date.toLocaleDateString(locale, { month: "long", year: "numeric" }),
      photos: [],
    };
    month.photos.push(photo);
    months.set(key, month);
  }
  return [...months.values()];
}
