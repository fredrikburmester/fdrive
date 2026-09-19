import { StorageError } from "@fdrive/core";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { McpToolError } from "../../mcp/handlers.js";
import type { AiToolCall } from "../model.ts";
import {
  type AiTool,
  AiToolError,
  defineTool,
  executeToolCall,
  formatSize,
  safeToolErrorMessage,
  toolSpec,
} from "./tool.ts";

describe("formatSize", () => {
  it("shows bytes as whole numbers", () => {
    expect(formatSize(0)).toBe("0 B");
    expect(formatSize(1023)).toBe("1023 B");
  });

  it("shows larger sizes with one decimal", () => {
    expect(formatSize(1024)).toBe("1.0 KB");
    expect(formatSize(1536)).toBe("1.5 KB");
    expect(formatSize(5 * 1024 ** 2)).toBe("5.0 MB");
    expect(formatSize(2.25 * 1024 ** 3)).toBe("2.3 GB");
  });

  it("stops at terabytes", () => {
    expect(formatSize(3 * 1024 ** 4)).toBe("3.0 TB");
    expect(formatSize(2048 * 1024 ** 4)).toBe("2048.0 TB");
  });
});

describe("toolSpec", () => {
  it("drops the $schema key and marks defaulted fields optional", () => {
    const spec = toolSpec(
      "example",
      "An example.",
      z.object({ path: z.string(), depth: z.number().default(2) }),
    );

    expect(spec.name).toBe("example");
    expect(spec.description).toBe("An example.");
    expect(spec.inputSchema).not.toHaveProperty("$schema");
    expect(spec.inputSchema).toMatchObject({
      type: "object",
      required: ["path"],
      properties: { path: { type: "string" }, depth: { type: "number", default: 2 } },
    });
  });
});

describe("safeToolErrorMessage", () => {
  it("passes on messages written for the model and hides everything else", () => {
    expect(safeToolErrorMessage(new AiToolError("That folder is the Trash."))).toBe(
      "That folder is the Trash.",
    );
    expect(safeToolErrorMessage(new McpToolError("file is not indexed"))).toBe(
      "file is not indexed",
    );
    expect(safeToolErrorMessage(new StorageError("forbidden", "permission denied"))).toBe(
      "Storage error (forbidden): permission denied",
    );
    expect(safeToolErrorMessage(new Error("postgres://secret"))).toBe("The tool failed.");
    expect(safeToolErrorMessage("nope")).toBe("The tool failed.");
  });
});

describe("executeToolCall", () => {
  function echoTool(run?: (text: string, signal: AbortSignal) => Promise<string>): AiTool {
    return defineTool("echo", "Repeats text.", z.object({ text: z.string() }), {
      activity: (args) => `Echoed ${args.text}`,
      run: (args, signal) => (run ? run(args.text, signal) : Promise.resolve(args.text)),
    });
  }

  function toolsOf(...tools: AiTool[]): ReadonlyMap<string, AiTool> {
    return new Map(tools.map((tool) => [tool.spec.name, tool]));
  }

  const call = (input: unknown, name = "echo"): AiToolCall => ({ id: "c1", name, input });

  it("runs the tool with parsed arguments after reporting its activity", async () => {
    const activity = vi.fn();
    const signal = new AbortController().signal;
    const run = vi.fn(async (text: string) => `got ${text}`);

    const result = await executeToolCall(toolsOf(echoTool(run)), call({ text: "hi" }), {
      signal,
      activity,
    });

    expect(result).toEqual({ id: "c1", isError: false, content: "got hi" });
    expect(activity).toHaveBeenCalledWith("Echoed hi");
    expect(run).toHaveBeenCalledWith("hi", signal);
  });

  it("answers an unknown tool without running anything", async () => {
    const activity = vi.fn();

    const result = await executeToolCall(toolsOf(echoTool()), call({}, "shout"), {
      signal: new AbortController().signal,
      activity,
    });

    expect(result).toEqual({ id: "c1", isError: true, content: "There is no tool named shout." });
    expect(activity).not.toHaveBeenCalled();
  });

  it("answers invalid arguments with the first problems and no activity", async () => {
    const activity = vi.fn();
    const run = vi.fn();

    const result = await executeToolCall(toolsOf(echoTool(run)), call({ text: 5 }), {
      signal: new AbortController().signal,
      activity,
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/^Invalid arguments: text: /);
    expect(activity).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("turns a failure into a safe error result", async () => {
    const tool = echoTool(async () => {
      throw new Error("postgres://secret");
    });

    const result = await executeToolCall(toolsOf(tool), call({ text: "x" }), {
      signal: new AbortController().signal,
      activity: () => {},
    });

    expect(result).toEqual({ id: "c1", isError: true, content: "The tool failed." });
  });

  it("lets a failure through once the run was cancelled", async () => {
    const controller = new AbortController();
    const tool = echoTool(async (_text, signal) => {
      controller.abort();
      signal.throwIfAborted();
      return "unreachable";
    });

    await expect(
      executeToolCall(toolsOf(tool), call({ text: "x" }), {
        signal: controller.signal,
        activity: () => {},
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
