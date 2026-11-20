"use client";
import { ActivitySubjectsResponse, type PersonalActivityEvent } from "@fdrive/contracts";
import { useInfiniteQuery } from "@tanstack/react-query";
import { ChevronRightIcon } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { activityRequest } from "@/lib/activity/api";
import { useMe } from "@/lib/api/auth-queries";

/**
 * The files one event touched, inside its details: each with its part in the event and a link
 * to its own journey. Nothing for an event about a single file.
 */
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
    <details onToggle={(e) => setExpanded(e.currentTarget.open)} className="group text-xs">
      <summary className="flex min-h-7 cursor-pointer list-none items-center gap-1.5 font-medium max-md:min-h-11 [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon
          aria-hidden="true"
          className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90"
        />
        Files involved{event.subjectsTruncated ? "" : ` (${items.length})`}
      </summary>
      <ul className="pl-5">
        {items.map((item) => (
          <li
            key={`${item.identityId}:${item.role}:${item.ordinal}`}
            className="flex min-h-7 min-w-0 flex-wrap items-center gap-x-2 break-all"
          >
            <span className="w-14 shrink-0 text-muted-foreground">{item.role}</span>
            {item.fileId ? (
              <Link
                className="inline-flex items-center underline underline-offset-2 max-md:min-h-11"
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
      {members.isError && (
        <p role="alert" className="pl-5 text-destructive">
          Could not load all files.
        </p>
      )}
      {members.hasNextPage && (
        <Button
          variant="ghost"
          size="sm"
          className="ml-3 max-md:min-h-11"
          disabled={members.isFetchingNextPage}
          onClick={() => void members.fetchNextPage()}
        >
          More files
        </Button>
      )}
    </details>
  );
}
