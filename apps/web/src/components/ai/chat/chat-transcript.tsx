"use client";

import type { Chat, ChatActionRequest, ChatMessage } from "@fdrive/contracts";
import { baseName } from "@fdrive/core";
import { MessageSquareIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import type { MouseEvent } from "react";
import { useMemo } from "react";
import { toast } from "sonner";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { Suggestion } from "@/components/ai-elements/suggestion";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from "@/components/ai-elements/tool";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  CHAT_SUGGESTIONS,
  hrefForPath,
  isThinking,
  knownPaths,
  linkifyPaths,
  pathForHref,
  userText,
} from "@/lib/ai/chat";
import { apiClient } from "@/lib/api/client";
import { locatePath } from "@/lib/files/locate";
import { ChatActionCard } from "./chat-action-card";

export interface ChatTranscriptProps {
  /** `null` before the first message of a new chat. */
  readonly chat: Chat | null;
  /** The card whose decision is on its way, if any. */
  readonly actingOn: string | null;
  readonly onAct: (actionId: string, request: ChatActionRequest) => Promise<void>;
  readonly onSuggestion: (text: string) => void;
  /** Sends the last message again after a failed reply. */
  readonly onRetry: () => void;
}

/** The conversation: the person's messages with what they attached, and the assistant's text, tool calls and cards. */
export function ChatTranscript({
  chat,
  actingOn,
  onAct,
  onSuggestion,
  onRetry,
}: ChatTranscriptProps) {
  const router = useRouter();
  const known = useMemo(() => (chat === null ? new Set<string>() : knownPaths(chat)), [chat]);

  /** Internal links inside the markdown navigate without a full page load. */
  function onClickCapture(event: MouseEvent<HTMLDivElement>) {
    const anchor = (event.target as HTMLElement).closest("a");
    if (anchor === null || event.metaKey || event.ctrlKey || event.button !== 0) return;
    const href = anchor.getAttribute("href");
    if (href === null || !href.startsWith("/")) return;
    event.preventDefault();
    void follow(href);
  }

  /** A path the assistant wrote may spell accents differently from storage, or not exist: find it first. */
  async function follow(href: string) {
    let target = href;
    try {
      const path = pathForHref(href);
      if (path !== null) {
        const found = await locatePath(apiClient, path);
        if (found === null) {
          toast.error(`Could not find ${path}.`);
          return;
        }
        target = hrefForPath(found.path, found.kind === "dir" ? "dir" : "file");
      }
    } catch {
      // Storage could not answer; the folder view says why.
    }
    router.push(target as Parameters<typeof router.push>[0]);
  }

  if (chat === null || chat.messages.length === 0) {
    return (
      <ConversationEmptyState
        icon={<MessageSquareIcon className="size-6" />}
        title="Ask about your files"
        description="Drop files or folders here, or add them from a selection, then ask away."
      >
        <MessageSquareIcon className="size-6 text-muted-foreground" />
        <div className="space-y-1">
          <h3 className="font-medium text-sm">Ask about your files</h3>
          <p className="text-muted-foreground text-sm">
            Drop files or folders here, or add them from a selection, then ask away.
          </p>
        </div>
        {/* Wrap rather than the registry's scrolling row: the panel is too narrow for one line. */}
        <div className="flex max-w-full flex-wrap justify-center gap-2">
          {CHAT_SUGGESTIONS.map((suggestion) => (
            <Suggestion key={suggestion} suggestion={suggestion} onClick={onSuggestion} />
          ))}
        </div>
      </ConversationEmptyState>
    );
  }

  return (
    <Conversation className="min-h-0">
      <ConversationContent onClickCapture={onClickCapture}>
        {chat.messages.map((message) =>
          message.role === "user" ? (
            <UserMessage key={message.id} message={message} />
          ) : (
            <AssistantMessage
              key={message.id}
              chat={chat}
              message={message}
              known={known}
              actingOn={actingOn}
              onAct={onAct}
              onRetry={onRetry}
            />
          ),
        )}
        {isThinking(chat) ? (
          <div className="flex items-center gap-2 text-muted-foreground text-sm" role="status">
            <Spinner /> Thinking…
          </div>
        ) : null}
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  );
}

function UserMessage({ message }: { message: ChatMessage }) {
  return (
    <Message from="user">
      <MessageContent>
        {message.references.length > 0 ? (
          <ul className="flex flex-wrap gap-1" aria-label="Attached">
            {message.references.map((path) => (
              <li key={path}>
                <Badge variant="outline" className="max-w-full" title={path}>
                  <a href={hrefForPath(path)} className="truncate">
                    {baseName(path)}
                  </a>
                </Badge>
              </li>
            ))}
          </ul>
        ) : null}
        <p className="whitespace-pre-wrap">{userText(message.parts)}</p>
      </MessageContent>
    </Message>
  );
}

function AssistantMessage({
  chat,
  message,
  known,
  actingOn,
  onAct,
  onRetry,
}: {
  chat: Chat;
  message: ChatMessage;
  known: ReadonlySet<string>;
  actingOn: string | null;
  onAct: ChatTranscriptProps["onAct"];
  onRetry: () => void;
}) {
  return (
    <Message from="assistant">
      <MessageContent className="w-full">
        {message.parts.map((part, index) => {
          const key = `${message.id}-${index}`;
          switch (part.kind) {
            case "text":
              return <MessageResponse key={key}>{linkifyPaths(part.text, known)}</MessageResponse>;
            case "tool":
              return (
                <Tool key={key}>
                  <ToolHeader title={part.activity || part.name} state={part.state} />
                  <ToolContent>
                    <ToolInput input={part.input} />
                    <ToolOutput output={part.output} failed={part.state === "failed"} />
                  </ToolContent>
                </Tool>
              );
            case "action":
              return (
                <ChatActionCard
                  key={part.id}
                  chat={chat}
                  part={part}
                  busy={actingOn === part.id}
                  onAct={onAct}
                />
              );
            case "error":
              return (
                <div
                  key={key}
                  role="alert"
                  className="flex items-center gap-2 text-destructive text-sm"
                >
                  <span>{part.message}</span>
                  {index === message.parts.length - 1 && chat.state === "idle" ? (
                    <Button variant="outline" size="xs" onClick={onRetry}>
                      Retry
                    </Button>
                  ) : null}
                </div>
              );
            default:
              return null;
          }
        })}
      </MessageContent>
    </Message>
  );
}
