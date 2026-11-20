"use client";

import type { PersonalActivityEvent } from "@fdrive/contracts";
import { baseName, parentPath } from "@fdrive/core";
import type { Route } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { activityLabels, activityPath, collapseActivity } from "@/lib/activity/history";
import { useActivityFileAt, useActivityHistory } from "@/lib/activity/queries";
import { useFormatters } from "@/lib/use-format-preferences";
import { cn } from "@/lib/utils";

const FILTERS = { limit: 10 };

/** A rename in place names only the earlier name; a move shows where the file was. */
function earlierLocation(before: string, path: string | null) {
  return path && parentPath(before) === parentPath(path) ? baseName(before) : before;
}

function ActivityItem({ event }: { event: PersonalActivityEvent }) {
  const { formatDate } = useFormatters();
  const path = activityPath(event);
  const from =
    event.before?.path && event.before.path !== path
      ? earlierLocation(event.before.path, path)
      : null;
  const outcome =
    event.outcome && event.outcome !== "success" && event.outcome !== "unknown"
      ? event.outcome
      : null;
  return (
    <li className="flex flex-col gap-0.5">
      <div className="flex items-baseline justify-between gap-4 text-sm">
        <span className="min-w-0">
          {activityLabels[event.action]}
          {event.count > 1 ? ` ${event.count} times` : ""}
        </span>
        <time
          dateTime={event.sortAt}
          className="shrink-0 text-muted-foreground text-xs tabular-nums"
        >
          {formatDate(new Date(event.sortAt))}
        </time>
      </div>
      {from && (
        <p className="text-muted-foreground text-xs [overflow-wrap:anywhere]">From {from}</p>
      )}
      {outcome && (
        <p
          className={cn(
            "text-xs capitalize",
            outcome === "failed" || outcome === "denied"
              ? "text-destructive"
              : "text-muted-foreground",
          )}
        >
          {outcome}
        </p>
      )}
    </li>
  );
}

/**
 * The details panel's "Activity" block: the latest recorded history of one
 * entry, newest first, live while the panel is open. "See all" opens the
 * full journey with related files, revisions and export. It is a block like the panel's others:
 * a hairline, then a small muted heading over its rows.
 */
export function FileActivitySection({ path }: { path: string }) {
  const file = useActivityFileAt(path);
  const fileId = file.data ?? null;
  const history = useActivityHistory(FILTERS, fileId ? `/files/${fileId}/events` : null);
  const events = collapseActivity(
    history.data?.pages.flatMap((page) => [...page.provisionalReads, ...page.items]) ?? [],
  );

  let body: ReactNode;
  if (file.isError || history.isError) {
    body = <p className="text-muted-foreground text-sm">Could not load activity.</p>;
  } else if (file.isPending || (fileId && history.isPending)) {
    body = (
      <p role="status" className="text-muted-foreground text-sm">
        Loading activity…
      </p>
    );
  } else if (!events.length) {
    body = <p className="text-muted-foreground text-sm">No recorded activity yet.</p>;
  } else {
    body = (
      <ol className="flex flex-col gap-2.5">
        {events.map((event) => (
          <ActivityItem key={event.id} event={event} />
        ))}
      </ol>
    );
  }

  return (
    <section aria-label="Activity" className="flex flex-col gap-3 pt-1">
      <Separator />
      <div className="flex min-h-6 items-center justify-between">
        <h3 className="font-medium text-muted-foreground text-xs">Activity</h3>
        {fileId && (
          <Button
            variant="ghost"
            size="sm"
            className="-mr-2 h-6 px-2 text-xs"
            render={<Link href={`/activity/files/${fileId}` as Route} />}
            nativeButton={false}
          >
            See all
          </Button>
        )}
      </div>
      {body}
      {history.hasNextPage && (
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2 self-start px-2 text-xs"
          disabled={history.isFetchingNextPage}
          onClick={() => void history.fetchNextPage()}
        >
          {history.isFetchingNextPage ? "Loading…" : "Show more"}
        </Button>
      )}
    </section>
  );
}
