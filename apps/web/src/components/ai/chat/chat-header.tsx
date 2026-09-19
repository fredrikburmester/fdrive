"use client";

import type { Chat, ChatSummary } from "@fdrive/contracts";
import { ChevronDownIcon, PencilIcon, PlusIcon, Trash2Icon, XIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { chatStatusLabel } from "@/lib/ai/chat";

export interface ChatHeaderProps {
  /** The chat on screen; `null` before the first message of a new chat. */
  readonly chat: Chat | null;
  readonly chats: readonly ChatSummary[];
  readonly onSelect: (id: string) => void;
  readonly onNew: () => void;
  readonly onRename: (id: string, title: string) => void;
  readonly onDelete: (id: string) => void;
  readonly onClose: () => void;
}

/** The panel's top bar: which chat this is, the menu to switch, rename or delete, and the close button. */
export function ChatHeader({
  chat,
  chats,
  onSelect,
  onNew,
  onRename,
  onDelete,
  onClose,
}: ChatHeaderProps) {
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState("");
  const status = chat === null ? null : chatStatusLabel(chat.state);

  return (
    <div className="flex h-12 shrink-0 items-center gap-1 border-b px-2">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              className="min-w-0 max-w-full justify-start gap-1 px-2"
              aria-label="Chats"
            />
          }
        >
          <span className="truncate font-medium">{chat?.title ?? "New chat"}</span>
          <ChevronDownIcon className="shrink-0 text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuGroup>
            <DropdownMenuItem onClick={onNew}>
              <PlusIcon />
              New chat
            </DropdownMenuItem>
            {chat !== null ? (
              <>
                <DropdownMenuItem
                  onClick={() => {
                    setTitle(chat.title);
                    setRenaming(true);
                  }}
                >
                  <PencilIcon />
                  Rename
                </DropdownMenuItem>
                <DropdownMenuItem variant="destructive" onClick={() => onDelete(chat.id)}>
                  <Trash2Icon />
                  Delete
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuGroup>
          {chats.length > 0 ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuLabel>Recent chats</DropdownMenuLabel>
                {chats.map((entry) => (
                  <DropdownMenuItem
                    key={entry.id}
                    onClick={() => onSelect(entry.id)}
                    className={entry.id === chat?.id ? "bg-muted" : undefined}
                  >
                    <span className="truncate">{entry.title}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {status !== null ? (
        <span className="ml-1 truncate text-muted-foreground text-xs" aria-live="polite">
          {status}
        </span>
      ) : null}
      <Button
        variant="ghost"
        size="icon-sm"
        className="ml-auto"
        aria-label="Close chat"
        onClick={onClose}
      >
        <XIcon />
      </Button>
      <Dialog open={renaming} onOpenChange={setRenaming}>
        <DialogContent>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (chat === null || title.trim().length === 0) return;
              onRename(chat.id, title.trim());
              setRenaming(false);
            }}
          >
            <DialogHeader>
              <DialogTitle>Rename chat</DialogTitle>
              <DialogDescription>A short name for this chat.</DialogDescription>
            </DialogHeader>
            <div className="py-4">
              <Label htmlFor="chat-title">Name</Label>
              <Input
                id="chat-title"
                className="mt-2"
                value={title}
                maxLength={120}
                onChange={(event) => setTitle(event.target.value)}
                autoFocus
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setRenaming(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={title.trim().length === 0}>
                Rename
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
