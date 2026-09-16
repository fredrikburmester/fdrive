import { describe, expect, it } from "vitest";
import {
  AiSettings,
  AiSettingsUpdateRequest,
  AiStatusResponse,
  DEFAULT_AI_MODEL,
  MAX_ORGANIZE_ITEMS,
  OrganizeRequest,
  OrganizeRun,
} from "./ai";

const update = {
  revision: 0,
  enabled: true,
  provider: "anthropic",
  model: "claude-opus-5",
  baseUrl: null,
} as const;

describe("AiSettingsUpdateRequest", () => {
  it("accepts Anthropic without a base URL and trims a new key", () => {
    expect(AiSettingsUpdateRequest.parse({ ...update, apiKey: "  sk-ant-1  " })).toEqual({
      ...update,
      apiKey: "sk-ant-1",
    });
    expect(AiSettingsUpdateRequest.parse({ ...update, apiKey: null }).apiKey).toBeNull();
    expect(AiSettingsUpdateRequest.parse(update).apiKey).toBeUndefined();
  });

  it("requires a base URL only for OpenAI-compatible servers", () => {
    expect(
      AiSettingsUpdateRequest.safeParse({ ...update, baseUrl: "https://api.example/v1" }).success,
    ).toBe(false);
    expect(
      AiSettingsUpdateRequest.safeParse({ ...update, provider: "openai_compatible" }).success,
    ).toBe(false);
    expect(
      AiSettingsUpdateRequest.safeParse({
        ...update,
        provider: "openai_compatible",
        model: "llama3.1",
        baseUrl: "http://ollama:11434/v1",
      }).success,
    ).toBe(true);
  });

  it("rejects blank models, blank keys, non-http URLs and unknown fields", () => {
    expect(AiSettingsUpdateRequest.safeParse({ ...update, model: "  " }).success).toBe(false);
    expect(AiSettingsUpdateRequest.safeParse({ ...update, apiKey: " " }).success).toBe(false);
    expect(
      AiSettingsUpdateRequest.safeParse({
        ...update,
        provider: "openai_compatible",
        baseUrl: "file:///etc/passwd",
      }).success,
    ).toBe(false);
    expect(AiSettingsUpdateRequest.safeParse({ ...update, hasApiKey: true }).success).toBe(false);
  });
});

describe("AI responses", () => {
  it("never carries a key, only whether one is saved", () => {
    const settings = { ...update, hasApiKey: true };
    expect(AiSettings.parse({ ...settings, apiKey: "secret" })).toEqual(settings);
    expect(AiStatusResponse.parse({ available: false, provider: null })).toEqual({
      available: false,
      provider: null,
    });
    expect(DEFAULT_AI_MODEL.anthropic).toBe("claude-opus-5");
  });
});

describe("OrganizeRequest", () => {
  it("bounds the selection and trims instructions", () => {
    const paths = Array.from({ length: MAX_ORGANIZE_ITEMS }, (_, index) => `/inbox/${index}`);
    expect(OrganizeRequest.parse({ paths, instructions: "  by year " }).instructions).toBe(
      "by year",
    );
    expect(OrganizeRequest.safeParse({ paths: [...paths, "/x"] }).success).toBe(false);
    expect(OrganizeRequest.safeParse({ paths: [] }).success).toBe(false);
    expect(OrganizeRequest.safeParse({ paths: ["/a"], scope: "/" }).success).toBe(false);
  });

  it("carries an optional, exact sharing choice", () => {
    expect(OrganizeRequest.parse({ paths: ["/a"] }).share).toBeUndefined();
    expect(
      OrganizeRequest.parse({ paths: ["/a"], share: { contents: false, otherFileNames: true } })
        .share,
    ).toEqual({ contents: false, otherFileNames: true });
    for (const share of [
      { contents: false },
      { contents: "no", otherFileNames: true },
      { contents: true, otherFileNames: true, instructions: true },
    ])
      expect(OrganizeRequest.safeParse({ paths: ["/a"], share }).success).toBe(false);
  });
});

describe("OrganizeRun", () => {
  it("parses a finished run with its proposal", () => {
    const run = {
      id: "run-1",
      state: "done",
      createdAt: "2026-09-15T10:00:00.000Z",
      updatedAt: "2026-09-15T10:01:00.000Z",
      itemCount: 2,
      activity: ["Looked through /"],
      proposal: {
        summary: "Receipts go to Finance.",
        suggestions: [
          {
            path: "/inbox/receipt.pdf",
            kind: "file",
            destination: "/Finance/Receipts",
            target: "/Finance/Receipts/receipt.pdf",
            reason: "A grocery receipt.",
            newFolder: true,
            conflict: false,
          },
        ],
        unchanged: [{ path: "/inbox/notes.txt", reason: "Unclear." }],
      },
    };
    expect(OrganizeRun.parse(run)).toEqual(run);
    expect(OrganizeRun.safeParse({ ...run, state: "queued" }).success).toBe(false);
  });
});
