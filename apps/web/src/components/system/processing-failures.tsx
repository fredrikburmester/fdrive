"use client";

import type { ProcessingFeature } from "@fdrive/contracts";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, RotateCcw } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { apiClient } from "@/lib/api/client";

export const FAILURE_FEATURES = [
  "thumbnails",
  "textSearch",
  "semanticSearch",
  "imageSearch",
] as const;
const key = (feature: ProcessingFeature) => ["system", "failures", feature] as const;

/** Durable counts remain visible independently of live worker status. */
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
  return (
    <Card id="processing-failures" className="scroll-mt-6">
      <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
        <div className="min-w-0 space-y-1">
          <p className="flex items-center gap-2 text-sm font-medium">
            {summary.data?.openCount ? <AlertCircle className="size-4 text-destructive" /> : null}
            {summary.isError
              ? "Failure history unavailable"
              : summary.isPending
                ? "Loading failure history…"
                : `${summary.data.openCount.toLocaleString()} unresolved file${summary.data.openCount === 1 ? "" : "s"}`}
          </p>
          <p className="text-xs text-muted-foreground">
            Failure details survive restarts. Resolved history is kept for up to 30 days.
          </p>
        </div>
        <Button variant="outline" onClick={() => setOpen(true)}>
          View failures
        </Button>
      </CardContent>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-2xl">
          {open ? <FailureList feature={feature} retryEnabled={retryEnabled} /> : null}
        </SheetContent>
      </Sheet>
    </Card>
  );
}

function FailureList({
  feature,
  retryEnabled,
}: {
  feature: ProcessingFeature;
  retryEnabled: boolean;
}) {
  const [status, setStatus] = useState<"open" | "resolved">("open");
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
      <SheetHeader className="border-b pr-12">
        <SheetTitle>Processing failures</SheetTitle>
        <SheetDescription>
          Inspect the cause for each file. Retries process unresolved files for this feature.
        </SheetDescription>
      </SheetHeader>
      <div className="flex flex-wrap items-center gap-2 border-b p-4">
        <Button
          size="sm"
          variant={status === "open" ? "secondary" : "ghost"}
          onClick={() => {
            setStatus("open");
            setCode("");
          }}
        >
          Unresolved
        </Button>
        <Button
          size="sm"
          variant={status === "resolved" ? "secondary" : "ghost"}
          onClick={() => {
            setStatus("resolved");
            setCode("");
          }}
        >
          Resolved
        </Button>
        <Button
          size="sm"
          className="ml-auto"
          disabled={!retryEnabled || !first?.openCount || retry.isPending}
          onClick={() => retry.mutate(undefined)}
        >
          <RotateCcw />
          {retry.isPending ? "Starting…" : "Retry failed"}
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {query.isError ? (
          <p role="alert" className="text-sm">
            Could not load failures: {query.error.message}
          </p>
        ) : query.isPending ? (
          <p className="text-sm">Loading…</p>
        ) : (
          <>
            <fieldset className="mb-4 flex flex-wrap gap-2" aria-label="Filter by cause">
              <Button
                size="sm"
                variant={code === "" ? "secondary" : "outline"}
                onClick={() => setCode("")}
              >
                All causes
              </Button>
              {first?.groups.map((group) => (
                <Button
                  key={group.code}
                  size="sm"
                  className="h-auto max-w-full whitespace-normal break-all text-left"
                  variant={code === group.code ? "secondary" : "outline"}
                  onClick={() => setCode(group.code)}
                >
                  {group.code} · {group.count.toLocaleString()}
                </Button>
              ))}
            </fieldset>
            <p className="mb-3 text-xs text-muted-foreground">
              {first?.total.toLocaleString()} {status === "open" ? "unresolved" : "resolved"} file
              {first?.total === 1 ? "" : "s"}
            </p>
            {entries.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No {status === "open" ? "unresolved" : "resolved"} failures.
              </p>
            ) : null}
            <ul className="space-y-3" aria-label="Failed files">
              {entries.map((entry) => (
                <li key={entry.id} className="min-w-0 space-y-2 rounded-lg border p-3">
                  <p className="break-all text-sm font-medium">
                    {entry.root}/{entry.path}
                  </p>
                  <p className="whitespace-pre-wrap break-all text-sm text-muted-foreground">
                    {entry.message}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {entry.attempts} failed attempt{entry.attempts === 1 ? "" : "s"} · Last failure{" "}
                    {new Date(entry.lastFailedAt).toLocaleString()}
                  </p>
                  <details className="text-xs text-muted-foreground">
                    <summary className="cursor-pointer">Details</summary>
                    <p className="mt-1">
                      First failure: {new Date(entry.firstFailedAt).toLocaleString()}
                    </p>
                    <p className="break-all">Operation: {entry.operationId}</p>
                    {entry.resolvedAt ? (
                      <p>Resolved: {new Date(entry.resolvedAt).toLocaleString()}</p>
                    ) : null}
                  </details>
                  {entry.resolvedAt === null ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!retryEnabled || retry.isPending}
                      onClick={() => retry.mutate(entry.id)}
                    >
                      Retry file
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
            {query.hasNextPage ? (
              <Button
                className="mt-4"
                variant="outline"
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
