"use client";

import type { ProcessingFailure, ProcessingFeature } from "@fdrive/contracts";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { cn } from "cn";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { SegmentedControl } from "@/components/shell/setting-controls";
import { Code, FactList } from "@/components/shell/sheet-data";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { apiClient } from "@/lib/api/client";
import { SYSTEM_SHEET, SystemSheetHeader } from "./settings-sheet";

export const FAILURE_FEATURES = [
  "thumbnails",
  "textSearch",
  "semanticSearch",
  "imageSearch",
] as const;
const key = (feature: ProcessingFeature) => ["system", "failures", feature] as const;

const STATUSES = ["open", "resolved"] as const;
type FailureStatus = (typeof STATUSES)[number];
const STATUS_LABELS: Record<FailureStatus, string> = { open: "Unresolved", resolved: "Resolved" };

/**
 * One quiet line near the top of a feature's sheet: how many files still fail, and the way to
 * the list of them. Durable counts remain visible independently of live worker status.
 */
export function ProcessingFailures({
  feature,
  retryEnabled,
}: {
  feature: ProcessingFeature;
  retryEnabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const summary = useQuery({
    queryKey: [...key(feature), "summary"],
    queryFn: () => apiClient.processingFailures(feature, { limit: 1 }),
    refetchInterval: 5000,
  });
  const count = summary.data?.openCount ?? 0;
  return (
    <div id="processing-failures" data-slot="processing-failures" className="scroll-mt-16 text-sm">
      <p>
        <span className={cn("font-medium", count > 0 && "text-destructive")}>
          {summary.isError
            ? "Failure history unavailable."
            : summary.isPending
              ? "Loading failure history…"
              : `${count.toLocaleString()} unresolved failure${count === 1 ? "" : "s"}.`}
        </span>{" "}
        <button
          type="button"
          className="rounded-sm text-muted-foreground underline underline-offset-4 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring max-md:-my-3 max-md:py-3"
          onClick={() => setOpen(true)}
        >
          View failures
        </button>
      </p>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          showCloseButton={false}
          className={cn(SYSTEM_SHEET, "data-[side=right]:sm:max-w-2xl")}
        >
          {open ? <FailureList feature={feature} retryEnabled={retryEnabled} /> : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function FailureList({
  feature,
  retryEnabled,
}: {
  feature: ProcessingFeature;
  retryEnabled: boolean;
}) {
  const [status, setStatus] = useState<FailureStatus>("open");
  const [code, setCode] = useState("");
  const client = useQueryClient();
  const query = useInfiniteQuery({
    queryKey: [...key(feature), status, code],
    queryFn: ({ pageParam }) =>
      apiClient.processingFailures(feature, {
        status,
        ...(code ? { code } : {}),
        ...(pageParam === undefined ? {} : { before: pageParam }),
      }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (page) => page.nextCursor,
    refetchInterval: 5000,
  });
  const retry = useMutation({
    mutationFn: (id?: number) =>
      apiClient.retryProcessingFailures(feature, id === undefined ? {} : { id }),
    onSuccess: () => {
      toast.success("Retry started. Successful files move to resolved history.");
      void client.invalidateQueries({ queryKey: key(feature) });
      void client.invalidateQueries({ queryKey: ["system", "activity"] });
    },
    onError: (error) => toast.error(error.message),
  });
  const first = query.data?.pages[0];
  const entries = query.data?.pages.flatMap((page) => page.entries) ?? [];
  return (
    <>
      <SystemSheetHeader
        title="Processing failures"
        description="Why each file failed. The list survives restarts, and resolved files stay for 30 days."
      />
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 border-border border-b px-5 py-3">
        <SegmentedControl
          label="Show"
          value={status}
          options={STATUSES}
          labels={STATUS_LABELS}
          onChange={(next) => {
            setStatus(next);
            setCode("");
          }}
        />
        <Button
          className="h-11 px-4.5"
          disabled={!retryEnabled || !first?.openCount || retry.isPending}
          onClick={() => retry.mutate(undefined)}
        >
          {retry.isPending ? "Starting…" : "Retry failed"}
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {query.isError ? (
          <p role="alert" className="text-destructive text-sm">
            Could not load failures: {query.error.message}
          </p>
        ) : query.isPending ? (
          <p className="text-muted-foreground text-sm">Loading…</p>
        ) : (
          <>
            <fieldset className="mb-4 flex flex-wrap gap-1.5" aria-label="Filter by cause">
              <CauseButton chosen={code === ""} onClick={() => setCode("")}>
                All causes
              </CauseButton>
              {first?.groups.map((group) => (
                <CauseButton
                  key={group.code}
                  chosen={code === group.code}
                  onClick={() => setCode(group.code)}
                >
                  {group.code} · {group.count.toLocaleString()}
                </CauseButton>
              ))}
            </fieldset>
            <p className="pb-3 text-muted-foreground text-xs">
              {first?.total.toLocaleString()} {status === "open" ? "unresolved" : "resolved"} file
              {first?.total === 1 ? "" : "s"}
            </p>
            {entries.length === 0 ? (
              <p className="border-border border-t pt-4 text-muted-foreground text-sm">
                No {status === "open" ? "unresolved" : "resolved"} failures.
              </p>
            ) : null}
            <ul className="flex flex-col" aria-label="Failed files">
              {entries.map((entry) => (
                <FailureRow
                  key={entry.id}
                  entry={entry}
                  retryDisabled={!retryEnabled || retry.isPending}
                  onRetry={() => retry.mutate(entry.id)}
                />
              ))}
            </ul>
            {query.hasNextPage ? (
              <Button
                variant="secondary"
                className="mt-2 h-10 px-3.5 max-md:h-11"
                disabled={query.isFetchingNextPage}
                onClick={() => void query.fetchNextPage()}
              >
                Load more
              </Button>
            ) : null}
          </>
        )}
      </div>
    </>
  );
}

/** One cause in the filter: the chosen one sits on `muted`, and says so to a screen reader. */
function CauseButton({
  chosen,
  onClick,
  children,
}: {
  chosen: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      variant={chosen ? "secondary" : "ghost"}
      aria-pressed={chosen}
      className={cn(
        "h-auto min-h-9 max-w-full whitespace-normal break-all py-1.5 text-left max-md:min-h-11",
        !chosen && "text-muted-foreground",
      )}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

/** A failed file: its path, what went wrong, then when and how often, under a hairline. */
function FailureRow({
  entry,
  retryDisabled,
  onRetry,
}: {
  entry: ProcessingFailure;
  retryDisabled: boolean;
  onRetry: () => void;
}) {
  return (
    <li className="flex min-w-0 flex-col gap-2.5 border-border border-t py-4">
      <p className="break-all font-medium text-sm">
        {entry.root}/{entry.path}
      </p>
      <p className="whitespace-pre-wrap break-all text-muted-foreground text-sm">{entry.message}</p>
      <FactList
        className="gap-y-1 text-xs"
        facts={[
          { label: "Failed attempts", value: entry.attempts.toLocaleString() },
          { label: "First failure", value: new Date(entry.firstFailedAt).toLocaleString() },
          { label: "Last failure", value: new Date(entry.lastFailedAt).toLocaleString() },
          { label: "Operation", value: <Code className="text-xs">{entry.operationId}</Code> },
          ...(entry.resolvedAt
            ? [{ label: "Resolved", value: new Date(entry.resolvedAt).toLocaleString() }]
            : []),
        ]}
      />
      {entry.resolvedAt === null ? (
        <Button
          variant="secondary"
          className="h-10 self-start px-3.5 max-md:h-11"
          disabled={retryDisabled}
          onClick={onRetry}
        >
          Retry file
        </Button>
      ) : null}
    </li>
  );
}
