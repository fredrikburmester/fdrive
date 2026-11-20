"use client";
import { ActivityLineageResponse, ActivityRevisionsResponse } from "@fdrive/contracts";
import { baseName } from "@fdrive/core";
import { useInfiniteQuery } from "@tanstack/react-query";
import { cn } from "cn";
import type { Route } from "next";
import Link from "next/link";
import { PageSection } from "@/components/shell/page-layout";
import { PHONE_TARGET } from "@/components/shell/page-rows";
import { Code } from "@/components/shell/sheet-data";
import { Button } from "@/components/ui/button";
import { activityRequest } from "@/lib/activity/api";
import { useMe } from "@/lib/api/auth-queries";

/** A quiet list inside a sheet: a hairline above each row, none around it. */
const LIST = "divide-y divide-border border-border border-t text-sm";
const NOTE = "text-muted-foreground text-sm";

/**
 * A file's journey beyond its events, as two blocks of a sheet: the files copied or derived from
 * it (each a link to its own journey) and the revisions recorded for it. Revision records are
 * evidence of a change, a size and a hash; earlier contents are not stored.
 */
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
  const related = edges.data?.pages.flatMap((page) => page.items) ?? [];
  const recorded = revisions.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <>
      <PageSection title="Related files">
        {edges.isError && (
          <p role="alert" className={NOTE}>
            Could not load related files.
          </p>
        )}
        {related.length > 0 && (
          <ul className={LIST}>
            {related.map((edge) => {
              const outgoing = edge.sourceFileId === fileId;
              const path = outgoing ? edge.targetPath : edge.sourcePath;
              return (
                <li key={edge.id}>
                  <Link
                    className="flex min-h-10 flex-wrap items-center justify-between gap-x-3 rounded-sm py-2 outline-none [overflow-wrap:anywhere] hover:underline focus-visible:ring-2 focus-visible:ring-ring max-md:min-h-11"
                    href={
                      `/activity/files/${outgoing ? edge.targetFileId : edge.sourceFileId}` as Route
                    }
                  >
                    {path ? baseName(path) : outgoing ? "Derived file" : "Source file"}
                    <span className="text-muted-foreground text-xs">
                      {edge.kind.replaceAll("_", " ")}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
        {edges.data !== undefined && related.length === 0 && (
          <p className={NOTE}>No recorded copies or derived files.</p>
        )}
        {edges.hasNextPage && (
          <Button
            variant="outline"
            className={cn("mt-3", PHONE_TARGET)}
            disabled={edges.isFetchingNextPage}
            onClick={() => void edges.fetchNextPage()}
          >
            More related files
          </Button>
        )}
      </PageSection>
      <PageSection
        title="Revision records"
        description="Evidence of each change. Earlier file contents are not stored."
      >
        {revisions.isError && (
          <p role="alert" className={NOTE}>
            Could not load revisions.
          </p>
        )}
        {recorded.length > 0 && (
          <ul className={LIST}>
            {recorded.map((revision) => (
              <li key={revision.id} className="flex flex-col gap-0.5 py-2">
                <span>
                  {revision.size === null
                    ? "Size unavailable"
                    : `${revision.size.toLocaleString()} bytes`}
                </span>
                {revision.sha256 && (
                  <span className="text-muted-foreground text-xs [overflow-wrap:anywhere]">
                    SHA-256 <Code className="text-xs">{revision.sha256}</Code>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        {revisions.data !== undefined && recorded.length === 0 && (
          <p className={NOTE}>No recorded revisions.</p>
        )}
        {revisions.hasNextPage && (
          <Button
            variant="outline"
            className={cn("mt-3", PHONE_TARGET)}
            disabled={revisions.isFetchingNextPage}
            onClick={() => void revisions.fetchNextPage()}
          >
            More revisions
          </Button>
        )}
      </PageSection>
    </>
  );
}
