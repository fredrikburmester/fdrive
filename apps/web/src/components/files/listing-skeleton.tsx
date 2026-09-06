import { Skeleton } from "@/components/ui/skeleton";

const ROW_KEYS = Array.from({ length: 10 }, (_, index) => `skeleton-row-${index}`);

/** Placeholder rows shown while a folder's listing is loading. */
export function ListingSkeleton() {
  return (
    <div className="flex flex-col gap-2 px-4 py-3" aria-hidden="true">
      {ROW_KEYS.map((key) => (
        <div key={key} className="flex items-center gap-3">
          <Skeleton className="size-4 rounded-sm" />
          <Skeleton className="h-4 max-w-72 flex-1" />
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-4 w-24" />
        </div>
      ))}
    </div>
  );
}
