"use client";

import type { ChatState } from "@fdrive/contracts";
import { LoaderCircle, MessageSquareIcon } from "lucide-react";
import { ActivityPill } from "@/components/activity/activity-pill";
import { LiveActivity } from "@/components/activity/live-activity-dock";
import { chatStatusLabel } from "@/lib/ai/chat";

/**
 * The way back into a chat whose panel is closed: a pill in the live
 * activity dock while a reply is being written or a card waits for the
 * person. Renders nothing otherwise.
 */
export function ChatActivity({ state, onOpen }: { state: ChatState | null; onOpen: () => void }) {
  if (state !== "running" && state !== "awaiting_approval") return null;
  return (
    <LiveActivity>
      <ActivityPill onClick={onOpen}>
        {state === "running" ? (
          <LoaderCircle className="animate-spin motion-reduce:animate-none" />
        ) : (
          <MessageSquareIcon />
        )}
        {chatStatusLabel(state)}
      </ActivityPill>
    </LiveActivity>
  );
}
