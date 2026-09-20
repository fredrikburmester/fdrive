"use client";
import { ActivitySubjectsResponse, type PersonalActivityEvent } from "@fdrive/contracts";
import { useInfiniteQuery } from "@tanstack/react-query";
import type { Route } from "next";
import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { activityRequest } from "@/lib/activity/api";
import { useMe } from "@/lib/api/auth-queries";

export function EventMembers({ event }: { event: PersonalActivityEvent }) {
  const { data: me } = useMe();
  const [expanded, setExpanded] = useState(false);
  const members = useInfiniteQuery({
    queryKey: ["personal-activity", me?.account.id, "subjects", event.id],
    enabled: !!me && expanded && event.subjectsTruncated,
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
    <details onToggle={(e) => setExpanded(e.currentTarget.open)} className="text-xs">
      <summary className="flex min-h-11 cursor-pointer items-center">
        Files involved{event.subjectsTruncated ? "" : ` (${items.length})`}
      </summary>
      <ul className="space-y-1">
        {items.map((item) => (
          <li
            key={`${item.identityId}:${item.role}:${item.ordinal}`}
            className="flex min-w-0 flex-wrap items-center gap-2 break-all"
          >
            <span className="text-muted-foreground">{item.role}</span>
            {item.fileId ? (
              <Link
                className="inline-flex min-h-11 items-center underline"
                href={`/activity/files/${item.fileId}` as Route}
              >
                {item.path ?? "File journey"}
              </Link>
            ) : (
              <span>{item.path ?? "Location unavailable"}</span>
            )}
          </li>
        ))}
      </ul>
      {members.isError && <p role="alert">Could not load all files.</p>}
      {members.hasNextPage && (
        <Button
          variant="ghost"
          className="min-h-11"
          disabled={members.isFetchingNextPage}
          onClick={() => void members.fetchNextPage()}
        >
          More files
        </Button>
      )}
    </details>
  );
}
