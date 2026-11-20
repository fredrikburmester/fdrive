import { cn } from "cn";
import type { ComponentProps, ReactNode } from "react";
import { DataTableCell } from "@/components/shell/page-layout";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Pieces the row-based pages (Trash, Shares, My activity) share on top of `page-layout`: the
 * placeholder shown while rows load, a cell that truncates, and a phone row's two lines of text.
 */

/** A page action on a phone: a 44px tap target, without changing the desktop control. */
export const PHONE_TARGET = "max-md:min-h-11";

/**
 * A cell that cuts its text off at the column's edge, for a `DataTable` with `table-fixed`
 * columns, which never grows wider than the page. Give it the full text as `title`.
 */
export function TruncatedCell({ className, ...props }: ComponentProps<typeof DataTableCell>) {
  return <DataTableCell className={cn("truncate", className)} {...props} />;
}

export interface RowsSkeletonProps {
  /** What is loading, for assistive technology; the rows themselves are decorative. */
  label: string;
  rows?: number;
}

/** Placeholder rows in the table's own rhythm, so the page does not jump when rows arrive. */
export function RowsSkeleton({ label, rows = 6 }: RowsSkeletonProps) {
  return (
    <div role="status" data-slot="rows-skeleton">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, index) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: a static, never-reordered list of placeholder rows
          key={index}
          aria-hidden="true"
          className="flex h-9 items-center gap-3 border-border/60 border-b px-3"
        >
          <Skeleton className="h-3.5 w-1/3 max-w-64" />
          <Skeleton className="ml-auto h-3 w-20" />
        </div>
      ))}
    </div>
  );
}

export interface RowTextProps {
  name: ReactNode;
  /** The columns a phone has no room for, folded into one smaller line. */
  detail: ReactNode;
  className?: string;
}

/**
 * A phone row's text, as in the file list: the name on its own line with the row's other
 * columns on a smaller line under it. Both lines truncate.
 */
export function RowText({ name, detail, className }: RowTextProps) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-0.5", className)}>
      <span className="truncate text-[15px] leading-5">{name}</span>
      <span className="truncate text-muted-foreground text-xs leading-4">{detail}</span>
    </div>
  );
}
