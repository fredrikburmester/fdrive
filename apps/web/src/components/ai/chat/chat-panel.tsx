"use client";

import { ApiClientError, type ChatActionRequest } from "@fdrive/contracts";
import { cn } from "cn";
import { usePathname } from "next/navigation";
import type { DragEvent, PointerEvent as ReactPointerEvent } from "react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { useIsMobile } from "@/hooks/use-mobile";
import { pendingActions } from "@/lib/ai/chat";
import {
  clampChatWidth,
  MAX_CHAT_WIDTH,
  MIN_CHAT_WIDTH,
  useChatPanelOpen,
  useChatPanelStore,
  useChatPanelWidth,
  useCurrentChatId,
} from "@/lib/ai/chat-panel";
import {
  useActOnChat,
  useCancelChat,
  useChat,
  useChats,
  useCreateChat,
  useDeleteChat,
  useRenameChat,
  useSendChatMessage,
} from "@/lib/ai/chat-queries";
import { useAiStatus } from "@/lib/ai/queries";
import { getActiveDragPaths, readDraggedPaths, subscribeDragSession } from "@/lib/dnd";
import { pathFromFilesPathname } from "@/lib/files/path-url";
import { describeFsError } from "@/lib/files/queries";
import { ChatActivity } from "./chat-activity";
import { useChatShortcut } from "./chat-button";
import { ChatComposer } from "./chat-composer";
import { ChatHeader } from "./chat-header";
import { ChatTranscript } from "./chat-transcript";

/**
 * The chat panel: docked to the right of every shell page on wide screens,
 * a full-height sheet on narrow ones. It follows the person between pages,
 * accepts files and folders dragged from any listing, and shows the chat
 * the browser last had open. Rendered only while AI is set up.
 */
export function ChatPanel() {
  const { data: aiStatus } = useAiStatus();
  const available = aiStatus?.available === true;
  const [open, setOpen] = useChatPanelOpen();
  const [currentId] = useCurrentChatId();
  const isMobile = useIsMobile();
  useChatShortcut(available);
  // The pill needs the chat's state even while the panel is closed.
  const current = useChat(available && !open ? currentId : null);

  if (!available) return null;
  if (!open)
    return <ChatActivity state={current.data?.state ?? null} onOpen={() => setOpen(true)} />;
  if (isMobile)
    return (
      <Sheet open onOpenChange={(next) => setOpen(next)}>
        <SheetContent
          side="right"
          className="w-full gap-0 p-0 sm:max-w-full"
          showCloseButton={false}
        >
          <SheetTitle className="sr-only">Chat</SheetTitle>
          <ChatPanelBody onClose={() => setOpen(false)} />
        </SheetContent>
      </Sheet>
    );
  return <DockedPanel onClose={() => setOpen(false)} />;
}

function DockedPanel({ onClose }: { onClose: () => void }) {
  const [width, setWidth] = useChatPanelWidth();
  const dragging = useRef<{ startX: number; startWidth: number } | null>(null);

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    dragging.current = { startX: event.clientX, startWidth: width };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (dragging.current === null) return;
    setWidth(
      clampChatWidth(dragging.current.startWidth - (event.clientX - dragging.current.startX)),
    );
  }
  function onPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    dragging.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  }

  return (
    <aside
      data-slot="chat-panel"
      aria-label="Chat"
      className="relative flex h-svh shrink-0 flex-col border-l bg-background"
      style={{ width }}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: an <hr> cannot be dragged; this is a resize handle with the separator role WAI-ARIA gives it. */}
      <div
        role="separator"
        tabIndex={0}
        aria-orientation="vertical"
        aria-label="Resize chat panel"
        aria-valuenow={width}
        aria-valuemin={MIN_CHAT_WIDTH}
        aria-valuemax={MAX_CHAT_WIDTH}
        className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize hover:bg-border/60 focus-visible:bg-ring/40 focus-visible:outline-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") setWidth(clampChatWidth(width + 16));
          else if (event.key === "ArrowRight") setWidth(clampChatWidth(width - 16));
        }}
      />
      <ChatPanelBody onClose={onClose} />
    </aside>
  );
}

function ChatPanelBody({ onClose }: { onClose: () => void }) {
  const [currentId, setCurrentId] = useCurrentChatId();
  const chips = useChatPanelStore((state) => state.chips);
  const { addChips, removeChip, clearChips } = useChatPanelStore.getState();
  const pathname = usePathname();
  const location = pathFromFilesPathname(pathname);
  const chats = useChats();
  const chat = useChat(currentId);
  const create = useCreateChat();
  const send = useSendChatMessage();
  const cancel = useCancelChat();
  const act = useActOnChat();
  const rename = useRenameChat();
  const remove = useDeleteChat();
  const [actingOn, setActingOn] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);
  const activeDrag = useSyncExternalStore(subscribeDragSession, getActiveDragPaths, () => null);

  // A chat that no longer exists (deleted elsewhere, expired) falls back to a new one.
  useEffect(() => {
    if (chat.error instanceof ApiClientError && chat.error.kind === "not_found") setCurrentId(null);
  }, [chat.error, setCurrentId]);

  const sendText = useCallback(
    async (text: string, references: readonly string[]) => {
      try {
        const id = currentId ?? (await create.mutateAsync({})).id;
        if (id !== currentId) setCurrentId(id);
        await send.mutateAsync({
          id,
          request: { text, references: [...references], location },
        });
        clearChips();
      } catch (error) {
        toast.error(describeFsError(error, "Could not send the message."));
        throw error;
      }
    },
    [currentId, create, send, location, clearChips, setCurrentId],
  );

  async function onAct(actionId: string, request: ChatActionRequest) {
    if (currentId === null) return;
    setActingOn(actionId);
    try {
      await act.mutateAsync({ id: currentId, actionId, request });
    } catch (error) {
      toast.error(describeFsError(error, "Could not apply that."));
    } finally {
      setActingOn(null);
    }
  }

  function onRetry() {
    const last = [...(chat.data?.messages ?? [])]
      .reverse()
      .find((message) => message.role === "user");
    if (last === undefined) return;
    void sendText(
      last.parts.flatMap((part) => (part.kind === "text" ? [part.text] : [])).join("\n"),
      last.references,
    ).catch(() => {});
  }

  function onDragOver(event: DragEvent<HTMLDivElement>) {
    if (activeDrag === null) return;
    event.preventDefault();
    // Listings allow copy or move; "link" would make the browser refuse the drop.
    event.dataTransfer.dropEffect = "copy";
    setDropping(true);
  }
  function onDrop(event: DragEvent<HTMLDivElement>) {
    const paths = readDraggedPaths(event.dataTransfer);
    setDropping(false);
    if (paths === null) return;
    event.preventDefault();
    addChips(paths);
  }

  const state = chat.data?.state ?? "idle";
  const pending = chat.data === undefined ? [] : pendingActions(chat.data);
  const status =
    send.isPending || create.isPending ? "submitted" : state === "running" ? "streaming" : "ready";

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the whole panel is a drop target for items dragged from a listing; everything inside stays keyboard-operable.
    <div
      className="relative flex min-h-0 flex-1 flex-col"
      data-dropping={dropping || undefined}
      onDragOver={onDragOver}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropping(false);
      }}
      onDrop={onDrop}
    >
      <ChatHeader
        chat={chat.data ?? null}
        chats={chats.data?.chats ?? []}
        onSelect={(id) => setCurrentId(id)}
        onNew={() => setCurrentId(null)}
        onRename={(id, title) =>
          rename.mutate(
            { id, request: { title } },
            {
              onError: (error) => toast.error(describeFsError(error, "Could not rename the chat.")),
            },
          )
        }
        onDelete={(id) =>
          remove.mutate(id, {
            onSuccess: () => {
              if (id === currentId) setCurrentId(null);
            },
            onError: (error) => toast.error(describeFsError(error, "Could not delete the chat.")),
          })
        }
        onClose={onClose}
      />
      <ChatTranscript
        chat={chat.data ?? null}
        actingOn={actingOn}
        onAct={onAct}
        onSuggestion={(text) => void sendText(text, chips).catch(() => {})}
        onRetry={onRetry}
      />
      {pending.length > 0 && state === "awaiting_approval" ? (
        <p className="border-t px-3 py-1.5 text-muted-foreground text-xs" role="status">
          Apply or decline the card above to continue.
        </p>
      ) : null}
      <ChatComposer
        chips={chips}
        onRemoveChip={removeChip}
        status={status}
        closed={state === "closed"}
        onSend={(text) => sendText(text, chips)}
        onStop={() => {
          if (currentId !== null) cancel.mutate(currentId);
        }}
      />
      <div
        aria-hidden={!dropping}
        className={cn(
          "pointer-events-none absolute inset-2 flex items-center justify-center rounded-lg border-2 border-dashed border-primary bg-background/80 text-sm transition-opacity",
          dropping ? "opacity-100" : "opacity-0",
        )}
      >
        Drop to add to chat
      </div>
    </div>
  );
}
