"use client";

import { cn } from "cn";
import { LoaderCircleIcon, SparklesIcon } from "lucide-react";
import type { DragEvent } from "react";
import { useId, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { chatStatusLabel } from "@/lib/ai/chat";
import { addToChat, useChatPanelOpen, useCurrentChatId } from "@/lib/ai/chat-panel";
import { useChat } from "@/lib/ai/chat-queries";
import { getActiveDragPaths, readDraggedPaths, subscribeDragSession } from "@/lib/dnd";
import { useChatAvailability } from "./chat-availability";

/** The files toolbar's icon size: 14px on desktop, 18px on a phone. */
const TOOLBAR_ICON = "size-3.5 max-md:size-[18px]";

/**
 * The chat's button in the files toolbar, left of the details toggle (left of
 * More on a phone): a sparkle that opens and closes the chat overlay hanging
 * under it. With the panel closed it shows what the chat is doing, a spinner
 * while a reply is written and a dot while a card waits for the person, and
 * items dragged from the listing can be dropped on it to attach them. It
 * renders nothing where chat is not offered.
 */
export function ChatToggle() {
  const available = useChatAvailability() !== null;
  const [open, setOpen] = useChatPanelOpen();
  const [currentId] = useCurrentChatId();
  // The open panel says what the chat is doing itself.
  const current = useChat(available && !open ? currentId : null);
  const activeDrag = useSyncExternalStore(subscribeDragSession, getActiveDragPaths, () => null);
  const [dropping, setDropping] = useState(false);
  const [hovered, setHovered] = useState(false);
  const statusId = useId();

  if (!available) return null;

  const state = open ? null : (current.data?.state ?? null);
  const status =
    state === "running" || state === "awaiting_approval" ? chatStatusLabel(state) : null;

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
    <>
      {/* A drag fires no hover, so the tooltip is also held open while something is over the button. */}
      <Tooltip open={hovered || dropping} onOpenChange={setHovered}>
        <TooltipTrigger
          render={
            <Button
              variant={open ? "secondary" : "ghost"}
              size="icon-sm"
              className={cn("relative max-md:size-11", dropping && "ring-2 ring-primary")}
              aria-label="Chat"
              aria-expanded={open}
              aria-describedby={statusId}
              data-dropping={dropping || undefined}
              onClick={() => setOpen(!open)}
              onDragOver={onDragOver}
              onDragLeave={() => setDropping(false)}
              onDrop={onDrop}
            />
          }
        >
          {state === "running" ? (
            <LoaderCircleIcon
              className={cn(TOOLBAR_ICON, "animate-spin motion-reduce:animate-none")}
            />
          ) : (
            <SparklesIcon className={TOOLBAR_ICON} />
          )}
          {state === "awaiting_approval" ? (
            <span
              aria-hidden="true"
              data-slot="chat-toggle-dot"
              className="absolute top-1 right-1 size-1.5 rounded-full bg-primary max-md:top-2.5 max-md:right-2.5"
            />
          ) : null}
        </TooltipTrigger>
        <TooltipContent>
          {dropping
            ? "Drop to add to chat"
            : open
              ? "Close chat"
              : (status ?? "Chat with your files")}
        </TooltipContent>
      </Tooltip>
      {/* Outside the button, whose own label would hide it: what the spinner and the dot mean. */}
      <span id={statusId} role="status" className="sr-only">
        {status}
      </span>
    </>
  );
}
