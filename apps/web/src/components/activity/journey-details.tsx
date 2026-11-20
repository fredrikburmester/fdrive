"use client";
import { ActivityLineageResponse, ActivityRevisionsResponse } from "@fdrive/contracts";
import { baseName } from "@fdrive/core";
import { useInfiniteQuery } from "@tanstack/react-query";
import { cn } from "cn";
import { ChevronRightIcon } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { activityRequest } from "@/lib/activity/api";
import { useMe } from "@/lib/api/auth-queries";

/** A row inside a disclosure: the file list's hairline, indented to sit under the title. */
const ROW = "border-border/60 border-t pr-3 pl-8.5";
const NOTE = cn(ROW, "py-2 text-muted-foreground text-xs");

/** One collapsed strip of a file's journey that opens into rows, like a group in a table. */
function Disclosure({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="group min-w-0">
      <summary className="flex h-9 cursor-pointer list-none items-center gap-2 px-3 font-medium text-muted-foreground text-xs hover:bg-muted/60 max-md:h-11 [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon
          aria-hidden="true"
          className="size-3.5 shrink-0 transition-transform group-open:rotate-90"
        />
        {title}
      </summary>
      {children}
    </details>
  );
}

export function JourneyDetails({ fileId }: { fileId: string }) {
  const { data: me } = useMe();
  const edges = useInfiniteQuery({
    queryKey: ["personal-activity", me?.account.id, "lineage", fileId],
    enabled: !!me,
    initialPageParam: "",
    queryFn: async ({ pageParam }) =>
      ActivityLineageResponse.parse(
        await activityRequest(
          `/files/${fileId}/lineage${pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : ""}`,
        ),
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const revisions = useInfiniteQuery({
    queryKey: ["personal-activity", me?.account.id, "revisions", fileId],
    enabled: !!me,
    initialPageParam: "",
    queryFn: async ({ pageParam }) =>
      ActivityRevisionsResponse.parse(
        await activityRequest(
          `/files/${fileId}/revisions${pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : ""}`,
        ),
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  return (
    <div
      data-slot="journey-details"
      className="grid min-w-0 divide-border/60 border-border border-b max-md:divide-y md:grid-cols-2 md:divide-x"
    >
      <Disclosure title="Related files">
        {edges.isError && (
          <p role="alert" className={NOTE}>
            Could not load related files.
          </p>
        )}
        {edges.data?.pages
          .flatMap((page) => page.items)
          .map((edge) => {
            const outgoing = edge.sourceFileId === fileId;
            const path = outgoing ? edge.targetPath : edge.sourcePath;
            return (
              <Link
                className={cn(
                  ROW,
                  "flex min-h-9 flex-wrap items-center gap-x-2 break-all py-1.5 text-sm hover:bg-muted/60 max-md:min-h-11",
                )}
                key={edge.id}
                href={
                  `/activity/files/${outgoing ? edge.targetFileId : edge.sourceFileId}` as Route
                }
              >
                {path ? baseName(path) : outgoing ? "Derived file" : "Source file"}
                <span className="text-muted-foreground text-xs">
                  {edge.kind.replaceAll("_", " ")}
                </span>
              </Link>
            );
          })}
        {edges.data?.pages.every((page) => !page.items.length) && (
          <p className={NOTE}>No recorded copies or derived files.</p>
        )}
        {edges.hasNextPage && (
          <div className={ROW}>
            <Button
              variant="ghost"
              size="sm"
              className="max-md:min-h-11"
              onClick={() => void edges.fetchNextPage()}
            >
              More related files
            </Button>
          </div>
        )}
      </Disclosure>
      <Disclosure title="Revision records">
        {revisions.isError && (
          <p role="alert" className={NOTE}>
            Could not load revisions.
          </p>
        )}
        {revisions.data?.pages
          .flatMap((page) => page.items)
          .map((revision) => (
            <div className={cn(ROW, "space-y-0.5 py-1.5 text-xs")} key={revision.id}>
              <p>
                {revision.size === null
                  ? "Size unavailable"
                  : `${revision.size.toLocaleString()} bytes`}
              </p>
              {revision.sha256 && (
                <p className="break-all text-muted-foreground">SHA-256 {revision.sha256}</p>
              )}
            </div>
          ))}
        {revisions.data?.pages.every((page) => !page.items.length) && (
          <p className={NOTE}>No recorded revisions.</p>
        )}
        {revisions.hasNextPage && (
          <div className={ROW}>
            <Button
              variant="ghost"
              size="sm"
              className="max-md:min-h-11"
              onClick={() => void revisions.fetchNextPage()}
            >
              More revisions
            </Button>
          </div>
        )}
      </Disclosure>
    </div>
  );
}
