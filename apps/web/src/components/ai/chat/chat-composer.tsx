"use client";

import { baseName } from "@fdrive/core";
import { FilesIcon, XIcon } from "lucide-react";
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputHeader,
  type PromptInputStatus,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "@/components/ai-elements/prompt-input";
import { FileIcon } from "@/components/files/file-icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";

/** Past this many, the chips fold into one badge so the composer keeps its height. */
export const MAX_CHIPS_SHOWN = 10;

export interface ChatComposerProps {
  /** Paths waiting to be attached to the next message. */
  readonly chips: readonly string[];
  readonly onRemoveChip: (path: string) => void;
  readonly onClearChips: () => void;
  readonly status: PromptInputStatus;
  /** True once the chat reached its message limit. */
  readonly closed: boolean;
  readonly onSend: (text: string) => Promise<void>;
  readonly onStop: () => void;
}

/** The message box: the chips of what will be attached, the text, and send or stop. */
export function ChatComposer({
  chips,
  onRemoveChip,
  onClearChips,
  status,
  closed,
  onSend,
  onStop,
}: ChatComposerProps) {
  return (
    <div className="shrink-0 border-t p-2">
      {closed ? (
        <p className="px-2 pb-2 text-muted-foreground text-xs">
          This chat is full. Start a new chat to continue.
        </p>
      ) : null}
      <PromptInput onSubmit={(text) => onSend(text)} aria-label="Message">
        {chips.length > 0 ? (
          <PromptInputHeader aria-label="Attached to the next message">
            {chips.length > MAX_CHIPS_SHOWN ? (
              <AttachedSummary chips={chips} onRemove={onRemoveChip} onClear={onClearChips} />
            ) : (
              chips.map((path) => (
                <Badge
                  key={path}
                  variant="secondary"
                  className="max-w-full gap-1 pr-1"
                  title={path}
                >
                  <ChipIcon path={path} />
                  <span className="truncate">{baseName(path)}</span>
                  <RemoveButton path={path} onRemove={onRemoveChip} />
                </Badge>
              ))
            )}
          </PromptInputHeader>
        ) : null}
        <PromptInputBody>
          <PromptInputTextarea
            aria-label="Message"
            placeholder={
              chips.length > 0
                ? "Ask about the attached items…"
                : "Drop files here, or ask about the drive…"
            }
            disabled={closed}
          />
        </PromptInputBody>
        <PromptInputFooter>
          <PromptInputTools>
            <span className="text-muted-foreground text-xs">
              Enter to send, Shift+Enter for a new line
            </span>
          </PromptInputTools>
          <PromptInputSubmit status={status} onStop={onStop} disabled={closed} />
        </PromptInputFooter>
      </PromptInput>
    </div>
  );
}

function ChipIcon({ path }: { path: string }) {
  const name = baseName(path);
  return (
    <FileIcon
      kind={/\.[^/]+$/.test(name) ? "file" : "dir"}
      ext={name.replace(/^[^.]*/, "")}
      mime={null}
      className="size-3 shrink-0"
    />
  );
}

function RemoveButton({ path, onRemove }: { path: string; onRemove: (path: string) => void }) {
  return (
    <button
      type="button"
      className="shrink-0 rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
      aria-label={`Remove ${baseName(path)}`}
      onClick={() => onRemove(path)}
    >
      <XIcon className="size-3" />
    </button>
  );
}

/** One badge for many chips, opening the full list to review or trim. */
function AttachedSummary({
  chips,
  onRemove,
  onClear,
}: {
  chips: readonly string[];
  onRemove: (path: string) => void;
  onClear: () => void;
}) {
  const label = `${chips.length} items`;
  return (
    <Popover>
      <Badge variant="secondary" className="gap-1 pr-1">
        <PopoverTrigger className="flex items-center gap-1 rounded-sm hover:text-foreground">
          <FilesIcon className="size-3" />
          {label}
        </PopoverTrigger>
        <button
          type="button"
          className="rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
          aria-label="Remove all"
          onClick={onClear}
        >
          <XIcon className="size-3" />
        </button>
      </Badge>
      <PopoverContent side="top" align="start" className="gap-1 p-1">
        <PopoverHeader className="flex-row items-center justify-between py-0.5 pl-2">
          <PopoverTitle>{label}</PopoverTitle>
          <Button variant="ghost" size="xs" onClick={onClear}>
            Remove all
          </Button>
        </PopoverHeader>
        <ul className="max-h-64 overflow-y-auto" aria-label="Attached items">
          {chips.map((path) => (
            <li
              key={path}
              className="flex items-center gap-1.5 rounded-md py-1 pr-1 pl-2 text-xs hover:bg-muted"
              title={path}
            >
              <ChipIcon path={path} />
              <span className="min-w-0 flex-1 truncate">{baseName(path)}</span>
              <RemoveButton path={path} onRemove={onRemove} />
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
