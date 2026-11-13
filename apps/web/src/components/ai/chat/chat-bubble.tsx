"use client";

import type { ChatState } from "@fdrive/contracts";
import { cn } from "cn";
import { ChevronDownIcon, LoaderCircle, MessageSquareIcon } from "lucide-react";
import { usePathname } from "next/navigation";
import type { DragEvent } from "react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { ActivityPill } from "@/components/activity/activity-pill";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { accountTransition } from "@/lib/account/transition";
import { chatStatusLabel } from "@/lib/ai/chat";
import { addToChat, setChatPanelOpen } from "@/lib/ai/chat-panel";
import { getActiveDragPaths, readDraggedPaths, subscribeDragSession } from "@/lib/dnd";
import { pathFromFilesPathname } from "@/lib/files/path-url";

/** Cmd+Shift+K on Apple platforms, Ctrl+Shift+K elsewhere: next to search's Cmd+K. */
export function isChatShortcut(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey">,
): boolean {
  return event.key.toLowerCase() === "k" && event.shiftKey && (event.metaKey || event.ctrlKey);
}

/** Toggles the chat panel from the keyboard while AI is available. */
export function useChatShortcut(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    function onKeyDown(event: KeyboardEvent) {
      if (!isChatShortcut(event) || accountTransition.getSnapshot().pending) return;
      event.preventDefault();
      setChatPanelOpen(!(localStorage.getItem("fdrive.chat.open") === "true"));
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled]);
}

/**
 * The folder in view, which the assistant may use; `null` on pages that are
 * not a folder, where chat is not offered.
 */
export function useChatFolder(): string | null {
  return pathFromFilesPathname(usePathname());
}

export interface ChatBubbleProps {
  readonly open: boolean;
  /** The current chat's state, known while the panel is closed; `null` otherwise. */
  readonly state: ChatState | null;
  readonly onToggle: () => void;
}

/**
 * The chat's corner of the live activity dock: a round button that opens and
 * closes the chat panel above it. With the panel closed it widens into a pill
 * while a reply is written or a card waits for the person, and items dragged
 * from the listing can be dropped on it to attach them.
 */
export function ChatBubble({ open, state, onToggle }: ChatBubbleProps) {
  const activeDrag = useSyncExternalStore(subscribeDragSession, getActiveDragPaths, () => null);
  const [dropping, setDropping] = useState(false);
  const status =
    !open && (state === "running" || state === "awaiting_approval") ? chatStatusLabel(state) : null;

  function onDragOver(event: DragEvent<HTMLButtonElement>) {
    if (activeDrag === null) return;
    event.preventDefault();
    // Listings allow copy or move; "link" would make the browser refuse the drop.
    event.dataTransfer.dropEffect = "copy";
    setDropping(true);
  }
  function onDrop(event: DragEvent<HTMLButtonElement>) {
    const paths = readDraggedPaths(event.dataTransfer);
    setDropping(false);
    if (paths === null) return;
    event.preventDefault();
    addToChat(paths);
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ActivityPill
            // Below the activity panel's `order-last` and the chat panel: the very corner.
            className={cn(
              "order-[10001] shadow-lg",
              status === null && "size-12 p-0 [&_svg:not([class*='size-'])]:size-5",
              dropping && "ring-2 ring-primary",
            )}
            aria-label={status === null ? "Chat" : undefined}
            aria-expanded={open}
            data-dropping={dropping || undefined}
            onClick={onToggle}
            onDragOver={onDragOver}
            onDragLeave={() => setDropping(false)}
            onDrop={onDrop}
          />
        }
      >
        {state === "running" && !open ? (
          <LoaderCircle className="animate-spin motion-reduce:animate-none" />
        ) : open ? (
          <ChevronDownIcon />
        ) : (
          <MessageSquareIcon />
        )}
        {status}
      </TooltipTrigger>
      <TooltipContent side="left">
        {dropping ? "Drop to add to chat" : open ? "Close chat" : "Chat with your files"}
      </TooltipContent>
    </Tooltip>
  );
}
