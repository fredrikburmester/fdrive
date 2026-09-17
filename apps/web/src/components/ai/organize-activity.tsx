"use client";

import { LoaderCircle, SparklesIcon } from "lucide-react";
import { ActivityPill } from "@/components/activity/activity-pill";
import { LiveActivity } from "@/components/activity/live-activity-dock";
import { itemCount } from "@/lib/ai/organize";
import type { OrganizeStatus } from "@/lib/ai/use-organize";

export function organizeStatusLabel(status: OrganizeStatus): string {
  return status.state === "running"
    ? `Organizing ${itemCount(status.count)}…`
    : "Suggestions ready";
}

/**
 * The way back into an Organize session whose sheet is closed: a pill in
 * the live activity dock at the bottom right, next to uploads and jobs,
 * that shows a run in progress or suggestions waiting and reopens the
 * sheet. Renders nothing while there is no such session.
 */
export function OrganizeActivity({
  status,
  onOpen,
}: {
  status: OrganizeStatus | null;
  /** Reopens the Organize sheet. */
  onOpen: () => void;
}) {
  if (status === null) return null;
  return (
    <LiveActivity>
      <ActivityPill onClick={onOpen}>
        {status.state === "running" ? (
          <LoaderCircle className="animate-spin motion-reduce:animate-none" />
        ) : (
          <SparklesIcon />
        )}
        {organizeStatusLabel(status)}
      </ActivityPill>
    </LiveActivity>
  );
}
