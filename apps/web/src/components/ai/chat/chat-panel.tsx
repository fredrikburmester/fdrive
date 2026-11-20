"use client";

import { ApiClientError, type ChatActionRequest } from "@fdrive/contracts";
import { cn } from "cn";
import type { CSSProperties, DragEvent, PointerEvent as ReactPointerEvent } from "react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { useLiveActivityDock } from "@/components/activity/live-activity-dock";
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
  useChatShortcut,
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
import { getActiveDragPaths, readDraggedPaths, subscribeDragSession } from "@/lib/dnd";
import { describeFsError } from "@/lib/files/queries";
import { useChatAvailability } from "./chat-availability";
import { ChatComposer } from "./chat-composer";
import { ChatHeader } from "./chat-header";
import { ChatTranscript } from "./chat-transcript";

/**
 * The chat: an overlay hanging under the files toolbar at the top right on
 * wide screens, a full-height sheet on narrow ones. The toolbar's sparkle
 * button (`ChatToggle`) and Cmd/Ctrl+Shift+K open and close it. The panel
 * stays open between folders, accepts files and folders dragged from the
 * listing, and shows the chat the browser last had open. The assistant works
 * from the folder in view, so chat is offered only on folder pages, and only
 * while AI is set up; it comes back open on the next folder page.
 */
export function ChatPanel() {
  const folder = useChatAvailability();
  const [open, setOpen] = useChatPanelOpen();
  const isMobile = useIsMobile();
  useChatShortcut(folder !== null);

  if (folder === null || !open) return null;
  if (isMobile) {
    return (
      <Sheet open onOpenChange={(next) => setOpen(next)}>
        <SheetContent
          side="right"
          // The sheet's own width is set per side, so the override has to be too.
          className="gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-full"
          showCloseButton={false}
        >
          <SheetTitle className="sr-only">Chat</SheetTitle>
          <ChatPanelBody folder={folder} onClose={() => setOpen(false)} />
        </SheetContent>
      </Sheet>
    );
  }
  return <ChatOverlay folder={folder} onClose={() => setOpen(false)} />;
}

interface PanelProps {
  /** The folder in view: the assistant may use it and everything in it with the next message. */
  readonly folder: string;
  readonly onClose: () => void;
}

/** The dock's offset from the window's bottom edge (`bottom-4`), and the gap the overlay keeps above it. */
const DOCK_OFFSET = 16;
const DOCK_GAP = 8;

/**
 * How much of the window's bottom the overlay leaves free, in pixels: the
 * live activity dock when it shows something, a margin otherwise. The bottom
 * right corner belongs to the dock, so the overlay ends above it instead of
 * sliding under the activity panel.
 */
function useDockReserve(): number {
  const dock = useLiveActivityDock();
  const [height, setHeight] = useState(0);
  useEffect(() => {
    if (dock === null) return;
    const observer = new ResizeObserver(() => setHeight(dock.offsetHeight));
    observer.observe(dock);
    return () => observer.disconnect();
  }, [dock]);
  return height > 0 ? DOCK_OFFSET + height + DOCK_GAP : DOCK_OFFSET;
}

/**
 * The desktop panel: fixed under the 48px page header at the top right, above
 * the listing and the details panel and below dialogs, sheets and the live
 * activity dock. It is as short as its content (a new chat is the header and
 * the message box), grows with the conversation up to 36rem or the room above
 * the dock, never below 20rem of room, and scrolls inside after that. It is as
 * wide as the person dragged its left edge. Not a dialog: people drag files
 * onto it and keep browsing with it open, so only its close button, the
 * toolbar button and the shortcut close it.
 */
function ChatOverlay({ folder, onClose }: PanelProps) {
  const [width, setWidth] = useChatPanelWidth();
  const reserve = useDockReserve();
  const panel = useRef<HTMLElement>(null);
  const dragging = useRef<{ startX: number; startWidth: number } | null>(null);
  const focusPending = useChatPanelStore((state) => state.focusPending);

  // The person just opened the panel: the cursor goes to the message box. A panel that was
  // already open when the page loaded leaves focus where it is.
  useEffect(() => {
    if (!focusPending) return;
    panel.current?.querySelector<HTMLTextAreaElement>('textarea[name="message"]')?.focus();
    useChatPanelStore.setState({ focusPending: false });
  }, [focusPending]);

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
      ref={panel}
      data-slot="chat-panel"
      aria-label="Chat"
      className="fixed top-14 right-3 z-40 flex max-h-[clamp(min(20rem,100svh_-_4.5rem),100svh_-_3.5rem_-_var(--chat-dock-reserve),36rem)] max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden rounded-xl bg-popover text-popover-foreground text-sm shadow-lg ring-1 ring-foreground/10"
      style={{ width, "--chat-dock-reserve": `${reserve}px` } as CSSProperties}
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
        className="absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize hover:bg-border/60 focus-visible:bg-ring/40 focus-visible:outline-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") setWidth(clampChatWidth(width + 16));
          else if (event.key === "ArrowRight") setWidth(clampChatWidth(width - 16));
        }}
      />
      <ChatPanelBody folder={folder} onClose={onClose} />
    </aside>
  );
}

function ChatPanelBody({ folder, onClose }: PanelProps) {
  const [currentId, setCurrentId] = useCurrentChatId();
  const chips = useChatPanelStore((state) => state.chips);
  const { addChips, removeChip, clearChips } = useChatPanelStore.getState();
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
          request: { text, references: [...references], location: folder },
        });
        clearChips();
      } catch (error) {
        toast.error(describeFsError(error, "Could not send the message."));
        throw error;
      }
    },
    [currentId, create, send, folder, clearChips, setCurrentId],
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
        onRetry={onRetry}
      />
      {pending.length > 0 && state === "awaiting_approval" ? (
        <p className="px-3 pt-1.5 text-muted-foreground text-xs" role="status">
          Apply or decline the card above to continue.
        </p>
      ) : null}
      <ChatComposer
        folder={folder}
        chips={chips}
        onRemoveChip={removeChip}
        onClearChips={clearChips}
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
