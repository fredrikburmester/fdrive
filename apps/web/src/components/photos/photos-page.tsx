"use client";

import type { PhotoItem } from "@fdrive/contracts";
import { ImageIcon, TriangleAlertIcon } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { PageHeader } from "@/components/shell/page-header";
import { PageBar, PageBody, PageEmpty } from "@/components/shell/page-layout";
import { Skeleton } from "@/components/ui/skeleton";
import { apiClient } from "@/lib/api/client";
import { viewHref } from "@/lib/files/path-url";
import { groupByMonth, usePhotos } from "@/lib/photos/queries";

/** Edge to edge, with a hairline of background between tiles; larger tiles from `md` up. */
const GRID =
  "grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-0.5 md:grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))]";

/** "1 photo" or "N photos", with a plus while more are still to load. */
export function photoCountLabel(count: number, more: boolean): string {
  return `${count}${more ? "+" : ""} ${count === 1 && !more ? "photo" : "photos"}`;
}

function PhotoTile({ photo }: { photo: PhotoItem }) {
  const [failed, setFailed] = useState(false);
  return (
    <Link
      href={viewHref(photo.path) as Route}
      title={photo.name}
      aria-label={photo.name}
      className="flex aspect-square items-center justify-center overflow-hidden bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
    >
      {failed ? (
        <ImageIcon className="size-6 text-muted-foreground" strokeWidth={1.5} />
      ) : (
        // biome-ignore lint/performance/noImgElement: a thumbnail from the API, not a static asset next/image can optimize
        <img
          src={apiClient.thumbUrl(photo.path, 256)}
          alt=""
          loading="lazy"
          decoding="async"
          className="size-full object-cover"
          onError={() => setFailed(true)}
        />
      )}
    </Link>
  );
}

/**
 * The `/photos` page: every image the signed-in login can read, as a thumbnail grid grouped
 * by month, newest first. Each month is titled by a strip that reads like a group row in a
 * table and stays under the header while its photos scroll. More load as the end of the grid
 * scrolls into view, and a photo opens in the viewer.
 */
export function PhotosPage() {
  const { data, isPending, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = usePhotos();
  const photos = useMemo(() => data?.pages.flatMap((page) => page.photos) ?? [], [data]);
  const months = useMemo(() => groupByMonth(photos), [photos]);
  const end = useRef<HTMLDivElement>(null);

  // Observed afresh after every page, so a page that adds nothing on screen loads the next.
  useEffect(() => {
    const target = end.current;
    if (target === null || !hasNextPage || isFetchingNextPage) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void fetchNextPage();
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  return (
    <>
      <PageHeader breadcrumbs={<h1 className="truncate font-medium text-sm">Photos</h1>} />
      <PageBody>
        <PageBar>
          {data !== undefined && (
            <span className="text-foreground">{photoCountLabel(photos.length, hasNextPage)}</span>
          )}
          <span>Every image in your files, by the month it was taken.</span>
        </PageBar>
        {isPending ? (
          <div className={GRID} data-slot="photos-skeleton">
            {Array.from({ length: 12 }, (_, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a static, never-reordered list of placeholders
              <Skeleton key={index} className="aspect-square rounded-none" />
            ))}
          </div>
        ) : isError ? (
          <PageEmpty icon={TriangleAlertIcon} title="Could not load photos." />
        ) : months.length === 0 && !hasNextPage ? (
          <PageEmpty
            icon={ImageIcon}
            title="No photos yet."
            description="Images you add to your files show up here."
          />
        ) : (
          months.map((month) => (
            <section key={month.key} aria-label={month.label}>
              {/* Opaque under the sticky strip, so photos do not show through its tint. */}
              <div className="sticky top-12 z-[5] bg-background">
                <div className="flex h-8 items-center justify-between gap-3 border-border/60 border-b bg-muted/40 px-3 text-muted-foreground text-xs">
                  <h2 className="font-medium">{month.label}</h2>
                  <span className="tabular-nums">{month.photos.length}</span>
                </div>
              </div>
              <div className={GRID}>
                {month.photos.map((photo) => (
                  <PhotoTile key={photo.path} photo={photo} />
                ))}
              </div>
            </section>
          ))
        )}
        <div ref={end} aria-hidden className="h-px" />
      </PageBody>
    </>
  );
}
