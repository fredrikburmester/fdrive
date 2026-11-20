"use client";

import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { describeApiError } from "@/lib/api/errors";

export interface SystemErrorStateProps {
  /** The error thrown by the failed query, passed straight to `describeApiError`. */
  error: unknown;
  /** Re-runs the query, typically the `refetch` returned by the `useQuery` hook. */
  onRetry: () => void;
  /** What could not be loaded, when it is less than the whole sheet: "Couldn't load the address". */
  title?: string;
  /**
   * Stands as a row of its own among `SettingRow`s, with their hairline above it, where one
   * setting failed to load and the rows around it did not.
   */
  row?: boolean;
  className?: string;
}

/**
 * Shown in place of a System sheet's content when its query has failed, so a
 * failed or unparsable response is visibly distinct from the sheet still
 * loading and from data actually being ready: what went wrong in the
 * destructive colour, and a way to ask again. It has no box of its own, so it
 * sits the same in a sheet and inside a card of the setup walkthrough.
 */
export function SystemErrorState({
  error,
  onRetry,
  title = "Couldn't load this page",
  row = false,
  className,
}: SystemErrorStateProps) {
  return (
    <div
      data-slot="system-error"
      className={cn(
        "flex flex-wrap items-center justify-between gap-x-6 gap-y-3",
        row && "border-border border-t py-4.5",
        className,
      )}
    >
      <div role="alert" className="min-w-0 flex-[1_1_16rem] text-destructive text-sm">
        <p className="font-medium">{title}</p>
        <p className="[overflow-wrap:anywhere]">{describeApiError(error)}</p>
      </div>
      <Button type="button" variant="outline" className="max-md:min-h-11" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}
