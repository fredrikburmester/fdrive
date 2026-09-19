"use client";

import { baseName } from "@fdrive/core";
import { XIcon } from "lucide-react";
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

export interface ChatComposerProps {
  /** Paths waiting to be attached to the next message. */
  readonly chips: readonly string[];
  readonly onRemoveChip: (path: string) => void;
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
            {chips.map((path) => (
              <Badge key={path} variant="secondary" className="max-w-full gap-1 pr-1" title={path}>
                <FileIcon
                  kind={/\.[^/]+$/.test(baseName(path)) ? "file" : "dir"}
                  ext={baseName(path).replace(/^[^.]*/, "")}
                  mime={null}
                  className="size-3"
                />
                <span className="truncate">{baseName(path)}</span>
                <button
                  type="button"
                  className="rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
                  aria-label={`Remove ${baseName(path)}`}
                  onClick={() => onRemoveChip(path)}
                >
                  <XIcon className="size-3" />
                </button>
              </Badge>
            ))}
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
