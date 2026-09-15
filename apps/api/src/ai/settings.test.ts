import { AI_SETTINGS_KEY, type AiSettingsUpdateRequest, DEFAULT_AI_MODEL } from "@fdrive/contracts";
import type { SettingsRepo } from "@fdrive/db";
import { describe, expect, it, vi } from "vitest";
import { open, seal } from "../auth/crypto.js";
import { ApiHttpError } from "../errors.js";
import type { SystemEventLog } from "../system/event-log.js";
import { createAiSettingsService, type SecretBox } from "./settings.ts";

const MASTER = Buffer.alloc(32, 7);
const OTHER_MASTER = Buffer.alloc(32, 9);
const OLLAMA = "http://ollama:11434/v1";

const secrets: SecretBox = {
  seal: (plaintext, context) => seal(MASTER, plaintext, context),
  open: (sealed, context) => open(MASTER, sealed, context),
};

interface StoredRow {
  revision: number;
  enabled: boolean;
  provider: "anthropic" | "openai_compatible";
  model: string;
  baseUrl: string | null;
  apiKey: string | null;
}

function sealKey(key: string, context: string, master: Uint8Array = MASTER): string {
  return Buffer.from(seal(master, Buffer.from(key, "utf8"), context)).toString("base64");
}

function openKey(sealed: string, context: string): string {
  return Buffer.from(open(MASTER, Buffer.from(sealed, "base64"), context)).toString("utf8");
}

function setup(options: { initial?: unknown; eventLog?: SystemEventLog } = {}) {
  let stored: unknown | null = options.initial ?? null;
  const settings = {
    get: async <T>() => stored as T | null,
    compareAndSet: vi.fn(async (_key: string, expected: unknown, value: unknown) => {
      if (JSON.stringify(stored) !== JSON.stringify(expected)) return false;
      stored = value;
      return true;
    }),
  } satisfies Pick<SettingsRepo, "get" | "compareAndSet">;
  const service = createAiSettingsService({
    settings,
    secrets,
    ...(options.eventLog !== undefined ? { eventLog: options.eventLog } : {}),
  });
  return { service, settings, row: () => stored as StoredRow | null };
}

function anthropicUpdate(
  overrides: Partial<AiSettingsUpdateRequest> = {},
): AiSettingsUpdateRequest {
  return {
    revision: 0,
    enabled: false,
    provider: "anthropic",
    model: "claude-opus-5",
    baseUrl: null,
    ...overrides,
  };
}

function ollamaUpdate(overrides: Partial<AiSettingsUpdateRequest> = {}): AiSettingsUpdateRequest {
  return {
    revision: 0,
    enabled: true,
    provider: "openai_compatible",
    model: "llama3",
    baseUrl: OLLAMA,
    ...overrides,
  };
}

async function rejection(promise: Promise<unknown>): Promise<ApiHttpError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ApiHttpError);
  return error as ApiHttpError;
}

describe("AI settings service", () => {
  it("returns the defaults when nothing is stored", async () => {
    const { service } = setup();
    expect(await service.configuration()).toEqual({
      revision: 0,
      enabled: false,
      provider: "anthropic",
      model: DEFAULT_AI_MODEL.anthropic,
      baseUrl: null,
      hasApiKey: false,
    });
    expect(await service.resolved()).toBeNull();
    expect(await service.saved()).toBeNull();
  });

  it("saves an update, bumps the revision and never exposes the key", async () => {
    const { service, settings, row } = setup();
    const view = await service.update(anthropicUpdate({ enabled: true, apiKey: "sk-ant-1" }));
    expect(view).toEqual({
      revision: 1,
      enabled: true,
      provider: "anthropic",
      model: "claude-opus-5",
      baseUrl: null,
      hasApiKey: true,
    });
    expect(JSON.stringify(view)).not.toContain("sk-ant-1");
    expect(settings.compareAndSet).toHaveBeenCalledWith(AI_SETTINGS_KEY, null, row());
    expect(row()?.apiKey).not.toContain("sk-ant-1");
    expect(await service.configuration()).toEqual(view);
    expect(await service.resolved()).toEqual({
      provider: "anthropic",
      model: "claude-opus-5",
      baseUrl: null,
      apiKey: "sk-ant-1",
    });
  });

  it("rejects an update made against a stale revision without writing", async () => {
    const { service, settings } = setup();
    await service.update(anthropicUpdate());
    const error = await rejection(service.update(anthropicUpdate({ revision: 0, model: "other" })));
    expect(error.kind).toBe("conflict");
    expect(settings.compareAndSet).toHaveBeenCalledTimes(1);
    expect((await service.configuration()).model).toBe("claude-opus-5");
  });

  it("reports a conflict when another writer wins the compare-and-set", async () => {
    const { service, settings } = setup();
    settings.compareAndSet.mockResolvedValueOnce(false);
    const error = await rejection(service.update(anthropicUpdate()));
    expect(error.kind).toBe("conflict");
    expect(await service.configuration()).toMatchObject({ revision: 0 });
  });

  it("fails with an internal error when the stored row is invalid", async () => {
    const { service } = setup({ initial: { revision: -1, enabled: "yes" } });
    expect((await rejection(service.configuration())).kind).toBe("internal");
    expect((await rejection(service.resolved())).kind).toBe("internal");
    expect((await rejection(service.update(anthropicUpdate()))).kind).toBe("internal");
  });

  describe("API key handling", () => {
    it("seals a new key under a context bound to the provider and base URL", async () => {
      const { service, row } = setup();
      await service.update(anthropicUpdate({ apiKey: "sk-ant-1" }));
      const anthropicKey = row()?.apiKey ?? "";
      expect(openKey(anthropicKey, "ai-api-key:anthropic:")).toBe("sk-ant-1");
      expect(() => openKey(anthropicKey, `ai-api-key:openai_compatible:${OLLAMA}`)).toThrow();

      await service.update(ollamaUpdate({ revision: 1, apiKey: "sk-local" }));
      const ollamaKey = row()?.apiKey ?? "";
      expect(openKey(ollamaKey, `ai-api-key:openai_compatible:${OLLAMA}`)).toBe("sk-local");
      expect(() =>
        openKey(ollamaKey, "ai-api-key:openai_compatible:http://elsewhere/v1"),
      ).toThrow();
    });

    it("keeps the saved key when the key is omitted and the address is unchanged", async () => {
      const { service, row } = setup();
      await service.update(ollamaUpdate({ apiKey: "sk-local" }));
      const sealed = row()?.apiKey;
      const view = await service.update(ollamaUpdate({ revision: 1, model: "qwen3" }));
      expect(view).toMatchObject({ model: "qwen3", hasApiKey: true });
      expect(row()?.apiKey).toBe(sealed);
      expect(await service.resolved()).toMatchObject({ model: "qwen3", apiKey: "sk-local" });
    });

    it("drops the saved key when the base URL changes and no new key is sent", async () => {
      const { service } = setup();
      await service.update(ollamaUpdate({ apiKey: "sk-local" }));
      const view = await service.update(
        ollamaUpdate({ revision: 1, baseUrl: "http://elsewhere:8000/v1" }),
      );
      expect(view.hasApiKey).toBe(false);
      expect(await service.resolved()).toEqual({
        provider: "openai_compatible",
        model: "llama3",
        baseUrl: "http://elsewhere:8000/v1",
        apiKey: null,
      });
    });

    it("drops the saved key when the provider changes and no new key is sent", async () => {
      const { service } = setup();
      await service.update(anthropicUpdate({ apiKey: "sk-ant-1" }));
      const view = await service.update(ollamaUpdate({ revision: 1 }));
      expect(view.hasApiKey).toBe(false);
      expect((await service.resolved())?.apiKey).toBeNull();
    });

    it("clears the saved key when null is sent", async () => {
      const { service, row } = setup();
      await service.update(ollamaUpdate({ apiKey: "sk-local" }));
      const view = await service.update(ollamaUpdate({ revision: 1, apiKey: null }));
      expect(view.hasApiKey).toBe(false);
      expect(row()?.apiKey).toBeNull();
    });

    it("refuses to turn Anthropic on without a key", async () => {
      const { service, settings } = setup();
      const error = await rejection(service.update(anthropicUpdate({ enabled: true })));
      expect(error.kind).toBe("bad_request");
      expect(settings.compareAndSet).not.toHaveBeenCalled();

      await service.update(anthropicUpdate({ apiKey: "sk-ant-1" }));
      const cleared = await rejection(
        service.update(anthropicUpdate({ revision: 1, enabled: true, apiKey: null })),
      );
      expect(cleared.kind).toBe("bad_request");
    });

    it("turns Anthropic on with a previously saved key", async () => {
      const { service } = setup();
      await service.update(anthropicUpdate({ apiKey: "sk-ant-1" }));
      const view = await service.update(anthropicUpdate({ revision: 1, enabled: true }));
      expect(view).toMatchObject({ enabled: true, hasApiKey: true });
    });
  });

  describe("resolved and saved configurations", () => {
    function storedRow(overrides: Partial<StoredRow>): StoredRow {
      return {
        revision: 3,
        enabled: true,
        provider: "anthropic",
        model: "claude-opus-5",
        baseUrl: null,
        apiKey: sealKey("sk-ant-1", "ai-api-key:anthropic:"),
        ...overrides,
      };
    }

    it("is null while AI is turned off, but the saved configuration is still available", async () => {
      const { service } = setup({ initial: storedRow({ enabled: false }) });
      expect(await service.resolved()).toBeNull();
      expect(await service.saved()).toEqual({
        provider: "anthropic",
        model: "claude-opus-5",
        baseUrl: null,
        apiKey: "sk-ant-1",
      });
    });

    it("is null for Anthropic without a key", async () => {
      const { service } = setup({ initial: storedRow({ apiKey: null }) });
      expect(await service.resolved()).toBeNull();
      expect(await service.saved()).toBeNull();
    });

    it("treats a key that no longer opens as missing", async () => {
      const rotated = setup({
        initial: storedRow({ apiKey: sealKey("sk-ant-1", "ai-api-key:anthropic:", OTHER_MASTER) }),
      });
      expect(await rotated.service.resolved()).toBeNull();
      expect(await rotated.service.saved()).toBeNull();
      // The page asks for the key again instead of claiming one is saved.
      expect((await rotated.service.configuration()).hasApiKey).toBe(false);
      const resaved = await rotated.service.update(anthropicUpdate({ revision: 3 }));
      expect(resaved.hasApiKey).toBe(false);
      expect(rotated.row()?.apiKey).toBeNull();

      // A row whose address was edited behind fdrive's back must not forward the key there.
      const moved = setup({
        initial: storedRow({
          provider: "openai_compatible",
          model: "llama3",
          baseUrl: "http://attacker.example/v1",
          apiKey: sealKey("sk-local", `ai-api-key:openai_compatible:${OLLAMA}`),
        }),
      });
      expect(await moved.service.resolved()).toEqual({
        provider: "openai_compatible",
        model: "llama3",
        baseUrl: "http://attacker.example/v1",
        apiKey: null,
      });
    });

    it("treats a key as missing when the secret box throws", async () => {
      const service = createAiSettingsService({
        settings: { get: async <T>() => storedRow({}) as T, compareAndSet: async () => true },
        secrets: {
          seal: () => new Uint8Array(),
          open: () => {
            throw new Error("master key rotated");
          },
        },
      });
      expect(await service.resolved()).toBeNull();
    });

    it("accepts an OpenAI-compatible server with a base URL and no key", async () => {
      const { service } = setup();
      await service.update(ollamaUpdate());
      expect(await service.resolved()).toEqual({
        provider: "openai_compatible",
        model: "llama3",
        baseUrl: OLLAMA,
        apiKey: null,
      });
    });

    it("is null for an OpenAI-compatible server without a base URL", async () => {
      const { service } = setup({
        initial: storedRow({ provider: "openai_compatible", baseUrl: null, apiKey: null }),
      });
      expect(await service.resolved()).toBeNull();
      expect(await service.saved()).toBeNull();
    });
  });

  it("records each update in the event log without the key", async () => {
    const eventLog = { record: vi.fn() };
    const { service } = setup({ eventLog });
    await service.update(ollamaUpdate({ apiKey: "sk-local" }));
    await service.update(ollamaUpdate({ revision: 1, enabled: false }));
    await service.update(ollamaUpdate({ revision: 2, baseUrl: "http://elsewhere:8000/v1" }));
    expect(eventLog.record.mock.calls).toEqual([
      [
        "general",
        "info",
        "AI settings updated",
        { enabled: true, provider: "openai_compatible", model: "llama3", apiKeyChanged: true },
      ],
      [
        "general",
        "info",
        "AI settings updated",
        { enabled: false, provider: "openai_compatible", model: "llama3", apiKeyChanged: false },
      ],
      [
        "general",
        "info",
        "AI settings updated",
        { enabled: true, provider: "openai_compatible", model: "llama3", apiKeyChanged: true },
      ],
    ]);
    expect(JSON.stringify(eventLog.record.mock.calls)).not.toContain("sk-local");
  });
});
