"use client";

import type { PhotoItem } from "@fdrive/contracts";
import { ImageIcon } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { PageHeader } from "@/components/shell/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { apiClient } from "@/lib/api/client";
import { viewHref } from "@/lib/files/path-url";
import { groupByMonth, usePhotos } from "@/lib/photos/queries";

const GRID = "grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-1";

function PhotoTile({ photo }: { photo: PhotoItem }) {
  const [failed, setFailed] = useState(false);
  return (
    <Link
      href={viewHref(photo.path) as Route}
      title={photo.name}
      aria-label={photo.name}
      className="flex aspect-square items-center justify-center overflow-hidden rounded-md bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
 * by month, newest first. More load as the end of the grid scrolls into view, and a photo
 * opens in the viewer.
 */
export function PhotosPage() {
  const { data, isPending, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = usePhotos();
  const months = useMemo(
    () => groupByMonth(data?.pages.flatMap((page) => page.photos) ?? []),
    [data],
  );
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
      <PageHeader breadcrumbs={<span className="truncate font-medium text-sm">Photos</span>} />
      <div className="flex flex-col gap-6 p-4">
        {isPending ? (
          <div className={GRID}>
            {Array.from({ length: 12 }, (_, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a static, never-reordered list of placeholders
              <Skeleton key={index} className="aspect-square rounded-md" />
            ))}
          </div>
        ) : isError ? (
          <p className="py-16 text-center text-muted-foreground text-sm">Could not load photos.</p>
        ) : months.length === 0 && !hasNextPage ? (
          <p className="py-16 text-center text-muted-foreground text-sm">No photos yet.</p>
        ) : (
          months.map((month) => (
            <section key={month.key} aria-label={month.label} className="flex flex-col gap-2">
              <h2 className="font-medium text-sm">{month.label}</h2>
              <div className={GRID}>
                {month.photos.map((photo) => (
                  <PhotoTile key={photo.path} photo={photo} />
                ))}
              </div>
            </section>
          ))
        )}
        <div ref={end} aria-hidden className="h-px" />
      </div>
    </>
  );
}
