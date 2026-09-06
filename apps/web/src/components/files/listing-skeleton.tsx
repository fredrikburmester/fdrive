import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { GRID_TILE_HEIGHT, GRID_TILE_WIDTH } from "./file-grid";
import { FILE_ROW_HEIGHT } from "./file-list";

const ROW_COUNT = 10;
const ROW_KEYS = Array.from({ length: ROW_COUNT }, (_, index) => `skeleton-row-${index}`);

const TILE_COUNT = 12;
const TILE_KEYS = Array.from({ length: TILE_COUNT }, (_, index) => `skeleton-tile-${index}`);

/**
 * Relative (never pixel-fixed) name-bar widths, cycled across rows so the
 * placeholder reads like real, differently-sized file names rather than a
 * uniform bar chart.
 */
const NAME_WIDTHS = ["w-1/3", "w-1/2", "w-2/5", "w-1/4", "w-3/5"];

export type ListingSkeletonVariant = "list" | "grid";

export interface ListingSkeletonProps {
  /** Which view's placeholder to render. Defaults to the list layout. */
  variant?: ListingSkeletonVariant;
}

/**
 * Placeholder shown while a folder's listing is loading. Mirrors the real
 * list's row layout and height (`FILE_ROW_HEIGHT`) or, in `"grid"`, the
 * grid's tile size, so the loading state fills the listing area exactly
 * like real content instead of a narrower, fixed-width block.
 */
export function ListingSkeleton({ variant = "list" }: ListingSkeletonProps) {
  return variant === "grid" ? <GridSkeleton /> : <ListSkeleton />;
}

function ListSkeleton() {
  return (
    <div data-slot="listing-skeleton-list" aria-hidden="true">
      {ROW_KEYS.map((key, index) => (
        <div
          key={key}
          data-slot="skeleton-row"
          className="flex items-center gap-3 border-border/60 border-b px-3"
          style={{ height: FILE_ROW_HEIGHT }}
        >
          <Skeleton className="size-4 shrink-0 rounded-sm" />
          <Skeleton className="size-4 shrink-0 rounded-sm" />
          <div className="flex min-w-0 flex-1 items-center">
            <Skeleton className={cn("h-4", NAME_WIDTHS[index % NAME_WIDTHS.length])} />
          </div>
          <div className="flex w-20 shrink-0 justify-end">
            <Skeleton className="h-4 w-12" />
          </div>
          <div className="w-28 shrink-0">
            <Skeleton className="h-4 w-20" />
          </div>
        </div>
      ))}
    </div>
  );
}

function GridSkeleton() {
  return (
    <div data-slot="listing-skeleton-grid" aria-hidden="true" className="flex flex-wrap gap-1 p-2">
      {TILE_KEYS.map((key) => (
        <div
          key={key}
          data-slot="skeleton-tile"
          className="flex flex-col items-center gap-1.5 rounded-lg p-2"
          style={{ width: GRID_TILE_WIDTH, height: GRID_TILE_HEIGHT }}
        >
          <Skeleton className="size-8 rounded-sm" />
          <Skeleton className="h-3 w-4/5" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      ))}
    </div>
  );
}
