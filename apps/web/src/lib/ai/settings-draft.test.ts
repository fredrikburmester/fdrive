import type { AiSettings } from "@fdrive/contracts";
import { describe, expect, it } from "vitest";
import {
  aiStatus,
  draftFrom,
  isDirty,
  keyWillBeDropped,
  requestFrom,
  withProvider,
} from "./settings-draft";

const anthropic: AiSettings = {
  revision: 3,
  enabled: true,
  chat: true,
  provider: "anthropic",
  model: "claude-opus-5",
  baseUrl: null,
  hasApiKey: true,
};

const ollama: AiSettings = {
  revision: 1,
  enabled: true,
  chat: true,
  provider: "openai_compatible",
  model: "qwen3:32b",
  baseUrl: "http://ollama:11434/v1",
  hasApiKey: false,
};

describe("draftFrom and isDirty", () => {
  it("starts from the saved settings without a key", () => {
    const draft = draftFrom(ollama);
    expect(draft).toEqual({
      enabled: true,
      chat: true,
      provider: "openai_compatible",
      model: "qwen3:32b",
      baseUrl: "http://ollama:11434/v1",
      apiKey: "",
      clearKey: false,
    });
    expect(draftFrom(anthropic).baseUrl).toBe("");
    expect(isDirty(draft, ollama)).toBe(false);
    expect(isDirty({ ...draft, apiKey: "k" }, ollama)).toBe(true);
  });
});

describe("withProvider", () => {
  it("swaps a default model, keeps a custom one, and clears the URL for Anthropic", () => {
    const draft = draftFrom(anthropic);
    expect(withProvider(draft, "anthropic")).toBe(draft);
    expect(withProvider(draft, "openai_compatible")).toMatchObject({ model: "", baseUrl: "" });
    expect(withProvider({ ...draft, model: "claude-sonnet-5" }, "openai_compatible").model).toBe(
      "claude-sonnet-5",
    );
    expect(withProvider(draftFrom(ollama), "anthropic")).toMatchObject({
      provider: "anthropic",
      model: "qwen3:32b",
      baseUrl: "",
    });
    expect(withProvider({ ...draftFrom(ollama), model: "" }, "anthropic").model).toBe(
      "claude-opus-5",
    );
  });
});

describe("requestFrom", () => {
  it("keeps a saved key when nothing about the address changes", () => {
    expect(requestFrom({ ...draftFrom(anthropic), model: " claude-sonnet-5 " }, anthropic)).toEqual(
      {
        ok: true,
        request: {
          revision: 3,
          enabled: true,
          chat: true,
          provider: "anthropic",
          model: "claude-sonnet-5",
          baseUrl: null,
        },
      },
    );
  });

  it("sends a new key trimmed, or null to remove the saved one", () => {
    const draft = draftFrom(anthropic);
    expect(requestFrom({ ...draft, apiKey: " sk-ant " }, anthropic)).toMatchObject({
      request: { apiKey: "sk-ant" },
    });
    expect(requestFrom({ ...draft, enabled: false, clearKey: true }, anthropic)).toMatchObject({
      request: { apiKey: null },
    });
  });

  it("explains what blocks saving", () => {
    expect(requestFrom({ ...draftFrom(anthropic), model: " " }, anthropic)).toEqual({
      ok: false,
      errors: ["Enter a model."],
    });
    expect(requestFrom({ ...draftFrom(ollama), baseUrl: "ollama:11434" }, ollama)).toEqual({
      ok: false,
      errors: ["Enter the server's base URL, starting with http:// or https://."],
    });
    expect(requestFrom({ ...draftFrom(anthropic), clearKey: true }, anthropic)).toEqual({
      ok: false,
      errors: ["Enter an Anthropic API key to turn AI on."],
    });
    expect(
      requestFrom(withProvider(draftFrom(ollama), "anthropic"), { ...ollama, hasApiKey: true }),
    ).toEqual({ ok: false, errors: ["Enter an Anthropic API key to turn AI on."] });
  });

  it("allows an OpenAI-compatible server without a key", () => {
    expect(
      requestFrom({ ...draftFrom(ollama), baseUrl: " http://ollama:11434/v1 " }, ollama),
    ).toEqual({
      ok: true,
      request: {
        revision: 1,
        enabled: true,
        chat: true,
        provider: "openai_compatible",
        model: "qwen3:32b",
        baseUrl: "http://ollama:11434/v1",
      },
    });
  });
});

describe("keyWillBeDropped", () => {
  it("warns only when a saved key would be removed by an address change", () => {
    const saved = { ...ollama, hasApiKey: true };
    const draft = draftFrom(saved);
    expect(keyWillBeDropped(draft, saved)).toBe(false);
    expect(keyWillBeDropped({ ...draft, baseUrl: "http://other/v1" }, saved)).toBe(true);
    expect(keyWillBeDropped({ ...draft, baseUrl: "http://other/v1", apiKey: "k" }, saved)).toBe(
      false,
    );
    expect(keyWillBeDropped({ ...draft, baseUrl: "http://other/v1", clearKey: true }, saved)).toBe(
      false,
    );
    expect(keyWillBeDropped({ ...draft, baseUrl: "http://other/v1" }, ollama)).toBe(false);
  });
});

describe("aiStatus", () => {
  it("summarizes off, incomplete and on", () => {
    expect(aiStatus({ ...anthropic, enabled: false })).toEqual({ tone: "off", label: "Off" });
    expect(aiStatus({ ...anthropic, hasApiKey: false })).toEqual({
      tone: "incomplete",
      label: "Needs an API key",
    });
    expect(aiStatus(anthropic)).toEqual({ tone: "on", label: "On" });
    expect(aiStatus(ollama)).toEqual({ tone: "on", label: "On" });
  });
});
