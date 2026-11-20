"use client";
import { ActivitySubjectsResponse, type PersonalActivityEvent } from "@fdrive/contracts";
import { useInfiniteQuery } from "@tanstack/react-query";
import type { Route } from "next";
import Link from "next/link";
import { PageSection } from "@/components/shell/page-layout";
import { PHONE_TARGET } from "@/components/shell/page-rows";
import { Code } from "@/components/shell/sheet-data";
import { Button } from "@/components/ui/button";
import { activityRequest } from "@/lib/activity/api";
import { useMe } from "@/lib/api/auth-queries";

/**
 * The files one event touched, as a block of its sheet: each with its part in the event and a
 * link to its own journey. Nothing for an event about a single file. An event names its first
 * files itself; one that touched more loads the rest while its sheet is open.
 */
export function EventMembers({ event }: { event: PersonalActivityEvent }) {
  const { data: me } = useMe();
  const members = useInfiniteQuery({
    queryKey: ["personal-activity", me?.account.id, "subjects", event.id],
    enabled: !!me && event.subjectsTruncated,
    initialPageParam: "",
    queryFn: async ({ pageParam }) =>
      ActivitySubjectsResponse.parse(
        await activityRequest(
          `/events/${event.id}/subjects${pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : ""}`,
        ),
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  if (event.subjects.length < 2 && !event.subjectsTruncated) return null;
  const items = members.data?.pages.flatMap((page) => page.items) ?? event.subjects;
  return (
    <PageSection title={`Files involved${event.subjectsTruncated ? "" : ` (${items.length})`}`}>
      <ul className="divide-y divide-border border-border border-t text-sm">
        {items.map((item) => (
          <li
            key={`${item.identityId}:${item.role}:${item.ordinal}`}
            className="flex min-h-10 min-w-0 items-center gap-3 py-2 max-md:min-h-11"
          >
            <span className="w-16 shrink-0 text-muted-foreground text-xs capitalize">
              {item.role}
            </span>
            {item.fileId ? (
              <Link
                className="min-w-0 rounded-sm underline decoration-border underline-offset-4 outline-none [overflow-wrap:anywhere] hover:decoration-current focus-visible:ring-2 focus-visible:ring-ring"
                href={`/activity/files/${item.fileId}` as Route}
              >
                {item.path ? <Code>{item.path}</Code> : "File journey"}
              </Link>
            ) : (
              <span className="min-w-0 [overflow-wrap:anywhere]">
                {item.path ? <Code>{item.path}</Code> : "Location unavailable"}
              </span>
            )}
          </li>
        ))}
      </ul>
      {members.isError && (
        <p role="alert" className="pt-2 text-destructive text-sm">
          Could not load all files.
        </p>
      )}
      {members.hasNextPage && (
        <Button
          variant="outline"
          className={`mt-3 ${PHONE_TARGET}`}
          disabled={members.isFetchingNextPage}
          onClick={() => void members.fetchNextPage()}
        >
          More files
        </Button>
      )}
    </PageSection>
  );
}
