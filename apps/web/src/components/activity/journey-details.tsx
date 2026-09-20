"use client";
import { ActivityLineageResponse, ActivityRevisionsResponse } from "@fdrive/contracts";
import { baseName } from "@fdrive/core";
import { useInfiniteQuery } from "@tanstack/react-query";
import type { Route } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { activityRequest } from "@/lib/activity/api";
import { useMe } from "@/lib/api/auth-queries";

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
    <div className="grid min-w-0 gap-3 sm:grid-cols-2">
      <details className="min-w-0 rounded-xl border px-4">
        <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium">
          Related files
        </summary>
        {edges.isError && (
          <p role="alert" className="py-3 text-sm">
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
                className="flex min-h-11 flex-wrap items-center gap-2 break-all py-2 text-sm underline"
                key={edge.id}
                href={
                  `/activity/files/${outgoing ? edge.targetFileId : edge.sourceFileId}` as Route
                }
              >
                {path ? baseName(path) : outgoing ? "Derived file" : "Source file"}
                <span className="text-xs text-muted-foreground">
                  {edge.kind.replaceAll("_", " ")}
                </span>
              </Link>
            );
          })}
        {edges.data?.pages.every((page) => !page.items.length) && (
          <p className="pb-4 text-sm text-muted-foreground">No recorded copies or derived files.</p>
        )}
        {edges.hasNextPage && (
          <Button variant="ghost" className="min-h-11" onClick={() => void edges.fetchNextPage()}>
            More related files
          </Button>
        )}
      </details>
      <details className="min-w-0 rounded-xl border px-4">
        <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium">
          Revision records
        </summary>
        {revisions.isError && (
          <p role="alert" className="py-3 text-sm">
            Could not load revisions.
          </p>
        )}
        {revisions.data?.pages
          .flatMap((page) => page.items)
          .map((revision) => (
            <div className="space-y-1 border-t py-3 text-xs" key={revision.id}>
              <p>
                {revision.size === null
                  ? "Size unavailable"
                  : `${revision.size.toLocaleString()} bytes`}
              </p>
              {revision.sha256 && (
                <p className="break-all text-muted-foreground">SHA-256 {revision.sha256}</p>
              )}
              {revision.providerVersion && (
                <p className="break-all">Version {revision.providerVersion}</p>
              )}
            </div>
          ))}
        {revisions.data?.pages.every((page) => !page.items.length) && (
          <p className="pb-4 text-sm text-muted-foreground">No recorded revisions.</p>
        )}
        {revisions.hasNextPage && (
          <Button
            variant="ghost"
            className="min-h-11"
            onClick={() => void revisions.fetchNextPage()}
          >
            More revisions
          </Button>
        )}
      </details>
    </div>
  );
}
