import type { ChatMessage, ChatPart } from "@fdrive/contracts";
import type { AiHistoryMessage } from "../model.ts";

/** Assistant messages, counted from the end, whose tool calls are replayed in detail. */
export const HISTORY_TOOL_WINDOW = 6;
/** Characters of one replayed tool result. */
const HISTORY_TOOL_CHARS = 1500;

export interface ReferenceLine {
  readonly path: string;
  /** For example "file, 12.0 KB, modified 2024-03-01"; omitted when unknown. */
  readonly detail?: string | undefined;
}

/** The text the model gets for one person message: what was attached, where they are, then their words. */
export function formatUserMessage(
  text: string,
  references: readonly ReferenceLine[],
  location: string | null,
): string {
  const lines: string[] = [];
  if (references.length > 0) {
    lines.push("Attached to this message:");
    for (const reference of references)
      lines.push(
        reference.detail === undefined
          ? `- ${reference.path}`
          : `- ${reference.path} (${reference.detail})`,
      );
    lines.push("");
  }
  if (location !== null) {
    lines.push(`The person is looking at ${location}.`);
    lines.push("");
  }
  lines.push(text);
  return lines.join("\n");
}

function actionLine(part: ChatPart & { kind: "action" }): string {
  const what =
    part.proposal.kind === "move"
      ? `move ${part.proposal.suggestions.length} items`
      : part.proposal.kind === "trash"
        ? `move ${part.proposal.items.length} items to Trash`
        : `${part.proposal.mode === "create" ? "create" : "replace"} ${part.proposal.path}`;
  const state =
    part.state === "pending"
      ? "still waiting for the person"
      : part.state === "applied"
        ? `applied: ${part.outcome ?? "done"}`
        : part.state === "declined"
          ? "declined by the person"
          : `failed: ${part.outcome ?? "unknown error"}`;
  return `[Proposed to ${what}; ${state}.]`;
}

function assistantText(message: ChatMessage, detailed: boolean): string {
  const lines: string[] = [];
  for (const part of message.parts) {
    if (part.kind === "text") lines.push(part.text);
    else if (part.kind === "tool") {
      if (!detailed) continue;
      const output =
        part.output.length > HISTORY_TOOL_CHARS
          ? `${part.output.slice(0, HISTORY_TOOL_CHARS)}…`
          : part.output;
      lines.push(
        `[Called ${part.name}(${part.input})${part.state === "failed" ? " which failed" : ""}: ${output}]`,
      );
    } else if (part.kind === "action") lines.push(actionLine(part));
    else lines.push(`[The reply stopped: ${part.message}]`);
  }
  return lines.join("\n");
}

/**
 * Replays a stored transcript as plain text for a fresh provider
 * conversation. Older tool calls are dropped, recent ones summarized, so a
 * long chat stays within bounds and no provider-specific blocks are needed.
 * Consecutive messages of one role are merged and the result ends with the
 * assistant, so the next message continues the conversation.
 */
export function buildHistory(
  messages: readonly ChatMessage[],
  options: { toolWindow?: number } = {},
): AiHistoryMessage[] {
  const window = options.toolWindow ?? HISTORY_TOOL_WINDOW;
  const assistantIndexes = messages.flatMap((message, index) =>
    message.role === "assistant" ? [index] : [],
  );
  const detailedFrom = assistantIndexes.length <= window ? 0 : (assistantIndexes.at(-window) ?? 0);
  const history: AiHistoryMessage[] = [];
  messages.forEach((message, index) => {
    const text =
      message.role === "user"
        ? formatUserMessage(
            message.parts.flatMap((part) => (part.kind === "text" ? [part.text] : [])).join("\n"),
            message.references.map((path) => ({ path })),
            message.location,
          )
        : assistantText(message, index >= detailedFrom);
    if (text.trim().length === 0) return;
    const last = history.at(-1);
    if (last !== undefined && last.role === message.role)
      history[history.length - 1] = { role: last.role, text: `${last.text}\n\n${text}` };
    else history.push({ role: message.role, text });
  });
  while (history.at(-1)?.role === "user") history.pop();
  return history;
}
