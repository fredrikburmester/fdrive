/**
 * What every fdrive AI feature's tools look like to the agent loop that
 * runs them: a JSON Schema spec for the model, a Zod schema for the
 * arguments it sends back, one line of activity for the person, and the
 * work itself. Organize and chat share the tools in this folder.
 */

import { isStorageError } from "@fdrive/core";
import { z } from "zod";
import { McpToolError } from "../../mcp/handlers.js";
import type { AiToolCall, AiToolResult, AiToolSpec } from "../model.ts";

export interface AiTool<T = unknown> {
  readonly spec: AiToolSpec;
  readonly schema: z.ZodType<T>;
  /** One short step for the person to read while the assistant works. */
  activity(args: T): string;
  run(args: T, signal: AbortSignal): Promise<string>;
}

/** An error whose message is returned to the model as the tool result. */
export class AiToolError extends Error {}

export function toolSpec(name: string, description: string, schema: z.ZodType): AiToolSpec {
  const { $schema: _schema, ...inputSchema } = z.toJSONSchema(schema, { io: "input" });
  return { name, description, inputSchema };
}

export function defineTool<T>(
  name: string,
  description: string,
  schema: z.ZodType<T>,
  handlers: Pick<AiTool<T>, "activity" | "run">,
): AiTool {
  return { spec: toolSpec(name, description, schema), schema, ...handlers } as AiTool;
}

export function formatSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

/** The first few validation problems, in the form the model gets back. */
export function issuesText(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`)
    .join("; ");
}

/** What the model is told when a tool fails: never an internal message. */
export function safeToolErrorMessage(error: unknown): string {
  if (error instanceof AiToolError || error instanceof McpToolError) return error.message;
  if (isStorageError(error)) return `Storage error (${error.kind}): ${error.message}`;
  return "The tool failed.";
}

export interface ExecuteToolCallOptions {
  readonly signal: AbortSignal;
  /** Receives the tool's activity line once its arguments are valid. */
  readonly activity: (text: string) => void;
}

/**
 * Runs one of the model's tool calls: an unknown tool or invalid arguments
 * become an error result, a failure becomes a safe error result, and an
 * abort propagates so the loop stops.
 */
export async function executeToolCall(
  tools: ReadonlyMap<string, AiTool>,
  call: AiToolCall,
  options: ExecuteToolCallOptions,
): Promise<AiToolResult> {
  const tool = tools.get(call.name);
  if (tool === undefined)
    return { id: call.id, isError: true, content: `There is no tool named ${call.name}.` };
  const parsed = tool.schema.safeParse(call.input);
  if (!parsed.success)
    return {
      id: call.id,
      isError: true,
      content: `Invalid arguments: ${issuesText(parsed.error)}`,
    };
  options.activity(tool.activity(parsed.data));
  try {
    return { id: call.id, isError: false, content: await tool.run(parsed.data, options.signal) };
  } catch (error) {
    if (options.signal.aborted) throw error;
    return { id: call.id, isError: true, content: safeToolErrorMessage(error) };
  }
}
