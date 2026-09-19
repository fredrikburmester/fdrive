"use client";

import { MessageSquareIcon } from "lucide-react";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { accountTransition } from "@/lib/account/transition";
import { setChatPanelOpen, useChatPanelOpen } from "@/lib/ai/chat-panel";
import { useAiStatus } from "@/lib/ai/queries";

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

/** The page header's way into the chat panel; hidden until an administrator sets AI up. */
export function ChatButton() {
  const { data: aiStatus } = useAiStatus();
  const [open, setOpen] = useChatPanelOpen();
  if (aiStatus?.chat !== true) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Chat"
            aria-pressed={open}
            onClick={() => setOpen(!open)}
          />
        }
      >
        <MessageSquareIcon />
      </TooltipTrigger>
      <TooltipContent>Chat with your files</TooltipContent>
    </Tooltip>
  );
}
