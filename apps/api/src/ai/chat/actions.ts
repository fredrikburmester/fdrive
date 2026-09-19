/**
 * Action tools: the chat's write tools. Calling one never writes. The
 * agent verifies the arguments against storage into a proposal, shows it
 * as a card, and only `apply` (the person's decision) touches storage.
 */

import type { ChatActionEdits, ChatActionProposal, ChatActionResult } from "@fdrive/contracts";
import type { z } from "zod";
import type { AiToolSpec } from "../model.ts";
import { toolSpec } from "../tools/tool.ts";

export interface ActionOutcome {
  /** One line for the card, e.g. "Moved 3 items." */
  readonly outcome: string;
  readonly results: readonly ChatActionResult[];
  /** What the model is told, in more detail than the card line. */
  readonly toolResult: string;
}

export interface ActionTool<T = unknown> {
  readonly spec: AiToolSpec;
  readonly schema: z.ZodType<T>;
  /** One short step for the person to read while the card is being prepared. */
  activity(args: T): string;
  /** Checks the arguments against storage and describes the card. Throws `AiToolError` when nothing can be proposed. */
  verify(args: T, signal: AbortSignal): Promise<ChatActionProposal>;
  /** Does the work the person approved, with their edits, and reports each item. */
  apply(
    proposal: ChatActionProposal,
    edits: ChatActionEdits | undefined,
    signal: AbortSignal,
  ): Promise<ActionOutcome>;
}

export function defineActionTool<T>(
  name: string,
  description: string,
  schema: z.ZodType<T>,
  handlers: Pick<ActionTool<T>, "activity" | "verify" | "apply">,
): ActionTool {
  return { spec: toolSpec(name, description, schema), schema, ...handlers } as ActionTool;
}
