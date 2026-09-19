import type { OrganizeRequest, OrganizeRun } from "@fdrive/contracts";
import { StorageError, type StorageProvider } from "@fdrive/core";
import { createMemoryStorage } from "@fdrive/core/testing";
import type { IndexQueries } from "@fdrive/db";
import { describe, expect, it, vi } from "vitest";
import type { Principal } from "../../auth/principal.js";
import { ApiHttpError } from "../../errors.js";
import type { McpToolDeps } from "../../mcp/handlers.js";
import { buildIdentity } from "../../scoping/test-fixtures/index.ts";
import {
  type AiInput,
  type AiModel,
  AiProviderError,
  type AiToolCall,
  type AiToolSpec,
  type AiTurn,
} from "../model.ts";
import type { ResolvedAiConfig } from "../settings.ts";
import { SUBMIT_TOOL } from "./agent.ts";
import { createOrganizeRuns, OrganizeBusyError, type OrganizeRuns } from "./runs.ts";
import { createOrganizeService, type OrganizeServiceDeps } from "./service.ts";

const CONFIG: ResolvedAiConfig = {
  provider: "anthropic",
  model: "claude-test",
  baseUrl: null,
  apiKey: "sk-test",
  chat: true,
};

type Send = (input: AiInput, signal: AbortSignal) => Promise<AiTurn>;

/** A model whose conversation answers with `turns` in order, or with `send` when given. */
function fakeModel(turns: readonly AiTurn[] | Send) {
  const queue = Array.isArray(turns) ? [...turns] : [];
  const inputs: AiInput[] = [];
  const starts: { system: string; tools: readonly AiToolSpec[] }[] = [];
  const model: AiModel = {
    start(options) {
      starts.push(options);
      return {
        async send(input, signal) {
          inputs.push(input);
          if (typeof turns === "function") return turns(input, signal);
          const turn = queue.shift();
          if (turn === undefined) throw new Error("the script ran out of turns");
          return turn;
        },
      };
    },
    async ping() {
      return { ok: true, message: "ok" };
    },
  };
  return { model, inputs, starts };
}

/** Never answers until the run is cancelled. */
const hangingSend: Send = (_input, signal) =>
  new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason));
  });

function toolTurn(...toolCalls: AiToolCall[]): AiTurn {
  return { text: "", toolCalls, stop: "tool_use" };
}

function submitTurn(moves: { path: string; destination: string; reason: string }[]): AiTurn {
  return toolTurn({
    id: "submit",
    name: SUBMIT_TOOL,
    input: { summary: "Sorted the inbox.", moves, unchanged: [] },
  });
}

function mcpDeps(overrides: Partial<McpToolDeps> = {}): McpToolDeps {
  return {
    indexQueries: { rootIdsByName: async () => ({}) } as unknown as IndexQueries,
    searchService: { search: async () => Promise.reject(new Error("unexpected search")) },
    scopeResolver: {
      verifiedIndexScopes: async () => ({ available: false, reason: "no_roots" }),
    },
    identities: { get: async () => buildIdentity() },
    publicUrl: async () => null,
    indexerClient: null,
    writesEnabled: false,
    clock: () => new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function principalWith(storage: StorageProvider, overrides: Partial<Principal> = {}): Principal {
  return {
    accountId: "account-1",
    identityId: "identity-1",
    username: "alice",
    storage,
    isAdmin: false,
    ...overrides,
  };
}

function drive() {
  return createMemoryStorage({
    "/Inbox/a.pdf": "a",
    "/Inbox/b.pdf": "b",
    "/Inbox/sub/c.txt": "c",
    "/Other.txt": "o",
    "/Finance/Receipts/x.pdf": "x",
    "/.Trash/old.pdf": "old",
  });
}

function setup(
  options: {
    model?: AiModel;
    resolved?: ResolvedAiConfig | null;
    mcp?: Partial<McpToolDeps>;
    runs?: OrganizeRuns;
    maxTurns?: number;
  } = {},
) {
  const onUnexpectedError = vi.fn();
  const runs =
    options.runs ??
    createOrganizeRuns({
      clock: () => new Date("2026-01-01T00:00:00.000Z"),
      idGenerator: () => "run-1",
      onUnexpectedError,
    });
  const modelFor = vi.fn(() => options.model ?? fakeModel(hangingSend).model);
  const deps: OrganizeServiceDeps = {
    settings: {
      resolved: async () => (options.resolved === undefined ? CONFIG : options.resolved),
    },
    modelFor,
    runs,
    mcp: mcpDeps(options.mcp),
    ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
  };
  return { service: createOrganizeService(deps), modelFor, onUnexpectedError };
}

async function finished(
  service: ReturnType<typeof createOrganizeService>,
  principal: Principal,
  id: string,
): Promise<OrganizeRun> {
  return vi.waitFor(() => {
    const run = service.get(principal, id);
    if (run.state === "running") throw new Error("still running");
    return run;
  });
}

async function startError(
  service: ReturnType<typeof createOrganizeService>,
  principal: Principal,
  request: OrganizeRequest,
): Promise<ApiHttpError> {
  const error = await service.start(principal, request).then(
    () => null,
    (caught: unknown) => caught,
  );
  if (!(error instanceof ApiHttpError)) throw new Error(`expected an ApiHttpError, got ${error}`);
  return error;
}

describe("createOrganizeService", () => {
  describe("status", () => {
    it("reports the configured provider", async () => {
      const { service } = setup();

      expect(await service.status()).toEqual({
        available: true,
        provider: "anthropic",
        chat: true,
      });
    });

    it("reports unavailable when AI is not set up", async () => {
      const { service } = setup({ resolved: null });

      expect(await service.status()).toEqual({ available: false, provider: null, chat: false });
    });
  });

  describe("start", () => {
    it("refuses when AI is not set up", async () => {
      const { service, modelFor } = setup({ resolved: null });

      const error = await startError(service, principalWith(drive()), { paths: ["/Inbox/a.pdf"] });

      expect(error.kind).toBe("unsupported");
      expect(error.message).toBe(
        "AI is not set up. An administrator can turn it on under System > AI.",
      );
      expect(modelFor).not.toHaveBeenCalled();
    });

    it("refuses invalid paths, the drive root and Trash", async () => {
      const { service } = setup({ mcp: { trashPathForStorage: () => "/.Trash" } });
      const principal = principalWith(drive());

      const invalid = await startError(service, principal, { paths: ["/Inbox/a.pdf", "/a\0b"] });
      expect(invalid.kind).toBe("bad_request");
      expect(invalid.message).toBe('"/a\0b" is not a valid path.');

      const root = await startError(service, principal, { paths: ["/Inbox/.."] });
      expect(root.kind).toBe("bad_request");
      expect(root.message).toBe("The drive root cannot be moved.");

      const trash = await startError(service, principal, { paths: ["/.Trash/old.pdf"] });
      expect(trash.kind).toBe("bad_request");
      expect(trash.message).toBe("Items in Trash cannot be organized.");
    });

    it("uses the configured Trash path when the storage has none of its own", async () => {
      const { service } = setup({ mcp: { trashPath: "/.Trash" } });

      const error = await startError(service, principalWith(drive()), { paths: ["/.Trash"] });

      expect(error.kind).toBe("bad_request");
    });

    it("collapses duplicate selections and items inside selected folders", async () => {
      const { service, modelFor } = setup();

      const run = await service.start(principalWith(drive()), {
        paths: ["/Inbox/a.pdf", "Inbox/a.pdf", "/Inbox", "/Inbox/sub/c.txt", "/Other.txt"],
      });

      expect(run).toMatchObject({ id: "run-1", state: "running", itemCount: 2 });
      expect(modelFor).toHaveBeenCalledWith(CONFIG);
      service.cancel(principalWith(drive()), run.id);
    });

    it("reports a full run table as rate limited", async () => {
      const runs: OrganizeRuns = {
        start: () => {
          throw new OrganizeBusyError();
        },
        get: () => null,
        cancel: () => null,
      };
      const { service } = setup({ runs });

      const error = await startError(service, principalWith(drive()), { paths: ["/Inbox/a.pdf"] });

      expect(error.kind).toBe("rate_limited");
      expect(error.message).toBe(
        "Too many organize requests are running. Try again in a few minutes.",
      );
    });

    it("passes other failures to start the run through", async () => {
      const failure = new Error("out of memory");
      const runs: OrganizeRuns = {
        start: () => {
          throw failure;
        },
        get: () => null,
        cancel: () => null,
      };
      const { service } = setup({ runs });

      await expect(service.start(principalWith(drive()), { paths: ["/Inbox/a.pdf"] })).rejects.toBe(
        failure,
      );
    });
  });

  describe("a run", () => {
    it("looks around, then verifies the suggestions into a proposal", async () => {
      const { model, inputs, starts } = fakeModel([
        toolTurn({ id: "tree", name: "folder_tree", input: { depth: 1 } }),
        submitTurn([
          { path: "/Inbox/a.pdf", destination: "/Finance/Receipts", reason: "A receipt." },
          { path: "/Inbox/b.pdf", destination: "/.Trash", reason: "Junk." },
        ]),
      ]);
      const verifyAuthority = vi.fn(async () => true);
      const { service, onUnexpectedError } = setup({
        model,
        mcp: { trashPathForStorage: () => "/.Trash" },
      });
      const principal = principalWith(drive(), { verifyAuthority });

      const started = await service.start(principal, {
        paths: ["/Inbox/a.pdf", "/Inbox/b.pdf"],
        instructions: "Receipts go to Finance",
      });
      const run = await finished(service, principal, started.id);

      expect(run.state).toBe("done");
      expect(run.activity).toEqual([
        "Looking at 2 items",
        "Looked through /",
        "Checking the suggestions",
      ]);
      expect(run.proposal).toEqual({
        summary: "Sorted the inbox.",
        suggestions: [
          {
            path: "/Inbox/a.pdf",
            kind: "file",
            destination: "/Finance/Receipts",
            target: "/Finance/Receipts/a.pdf",
            reason: "A receipt.",
            newFolder: false,
            conflict: false,
          },
        ],
        unchanged: [{ path: "/Inbox/b.pdf", reason: "The suggested folder is in Trash." }],
      });
      expect(starts[0]?.tools.map((tool) => tool.name)).toEqual([
        "folder_tree",
        "list_folder",
        SUBMIT_TOOL,
      ]);
      expect(inputs[0]).toMatchObject({ kind: "user" });
      const firstText = inputs[0]?.kind === "user" ? inputs[0].text : "";
      expect(firstText).toContain("- /Inbox/a.pdf (1 B, modified 1970-01-01)");
      expect(firstText).toContain("The person's instructions: Receipts go to Finance");
      expect(inputs[1]).toEqual({
        kind: "tool_results",
        results: [
          {
            id: "tree",
            isError: false,
            // Trash is left out of the tree.
            content: "/ 2 folders, 1 files: Other.txt\n  Finance/\n  Inbox/",
          },
        ],
      });
      // Once before looking at the items, then before each of the two turns.
      expect(verifyAuthority).toHaveBeenCalledTimes(3);
      expect(onUnexpectedError).not.toHaveBeenCalled();
    });

    it("withholds excerpts and other file names when the person chose not to share them", async () => {
      const { model, inputs, starts } = fakeModel([
        toolTurn({ id: "tree", name: "folder_tree", input: { depth: 1 } }),
        submitTurn([]),
      ]);
      const { service } = setup({
        model,
        mcp: {
          trashPathForStorage: () => "/.Trash",
          scopeResolver: {
            verifiedIndexScopes: async () => ({
              available: true,
              scopes: [{ rootName: "sftpgo", fsPrefix: "/alice", virtualPrefix: "/" }],
            }),
          },
        },
      });
      const principal = principalWith(drive());

      const started = await service.start(principal, {
        paths: ["/Inbox/a.pdf"],
        share: { contents: false, otherFileNames: false },
      });
      const run = await finished(service, principal, started.id);

      expect(run.state).toBe("done");
      expect(starts[0]?.tools.map((tool) => tool.name)).toEqual([
        "folder_tree",
        "list_folder",
        "search_drive",
        "similar_files",
        SUBMIT_TOOL,
      ]);
      const firstText = inputs[0]?.kind === "user" ? inputs[0].text : "";
      expect(firstText).toContain("the person chose not to share file contents");
      expect(firstText).toContain("names of files outside the selection");
      expect(inputs[1]).toEqual({
        kind: "tool_results",
        results: [
          {
            id: "tree",
            isError: false,
            content: "/ 2 folders, 1 files\n  Finance/\n  Inbox/",
          },
        ],
      });
    });

    it("offers the index-backed tools when the identity's index scopes are verified", async () => {
      const { model, starts } = fakeModel([submitTurn([])]);
      const { service } = setup({
        model,
        mcp: {
          scopeResolver: {
            verifiedIndexScopes: async () => ({
              available: true,
              scopes: [{ rootName: "sftpgo", fsPrefix: "/alice", virtualPrefix: "/" }],
            }),
          },
        },
      });
      const principal = principalWith(drive());

      const started = await service.start(principal, { paths: ["/Inbox"] });
      const run = await finished(service, principal, started.id);

      expect(run.state).toBe("done");
      expect(run.activity[0]).toBe("Looking at 1 item");
      expect(run.proposal?.unchanged).toEqual([
        { path: "/Inbox", reason: "The assistant made no suggestion for this item." },
      ]);
      expect(starts[0]?.tools.map((tool) => tool.name)).toEqual([
        "folder_tree",
        "list_folder",
        "read_excerpts",
        "search_drive",
        "similar_files",
        SUBMIT_TOOL,
      ]);
    });

    it("works without index-backed tools when the identity is gone", async () => {
      const { model, starts, inputs } = fakeModel([submitTurn([])]);
      const verifiedIndexScopes = vi.fn();
      const { service } = setup({
        model,
        mcp: { identities: { get: async () => null }, scopeResolver: { verifiedIndexScopes } },
      });
      const principal = principalWith(drive());

      const started = await service.start(principal, { paths: ["/Inbox"], instructions: "" });
      const run = await finished(service, principal, started.id);

      expect(run.state).toBe("done");
      expect(verifiedIndexScopes).not.toHaveBeenCalled();
      expect(starts[0]?.tools.map((tool) => tool.name)).toEqual([
        "folder_tree",
        "list_folder",
        SUBMIT_TOOL,
      ]);
      const firstText = inputs[0]?.kind === "user" ? inputs[0].text : "";
      expect(firstText).toContain("- /Inbox (folder)");
      expect(firstText).not.toContain("instructions");
    });

    it("skips selected items that no longer exist or are not files or folders", async () => {
      const memory = drive();
      const storage: StorageProvider = {
        ...memory,
        stat: async (path) =>
          path === "/link"
            ? { kind: "symlink", size: 0, modifiedAt: null, contentType: null }
            : memory.stat(path),
      };
      const { model, inputs } = fakeModel([submitTurn([])]);
      const { service } = setup({ model });
      const principal = principalWith(storage);

      const started = await service.start(principal, {
        paths: ["/Gone.pdf", "/Inbox/a.pdf", "/link"],
      });
      const run = await finished(service, principal, started.id);

      expect(started.itemCount).toBe(3);
      expect(run.state).toBe("done");
      expect(run.proposal?.unchanged.map((item) => item.path)).toEqual(["/Inbox/a.pdf"]);
      const firstText = inputs[0]?.kind === "user" ? inputs[0].text : "";
      expect(firstText.startsWith("The 1 selected items, all currently in /Inbox:")).toBe(true);
    });

    it("fails when none of the selected items exist anymore", async () => {
      const { model, inputs } = fakeModel([]);
      const { service } = setup({ model });
      const principal = principalWith(drive());

      const started = await service.start(principal, { paths: ["/Gone.pdf", "/Also/gone"] });
      const run = await finished(service, principal, started.id);

      expect(run).toMatchObject({
        state: "failed",
        error: "None of the selected items exist anymore.",
      });
      expect(inputs).toHaveLength(0);
    });

    it("fails when the session that started it has ended", async () => {
      const storage = drive();
      const stat = vi.spyOn(storage, "stat");
      const { service } = setup();
      const principal = principalWith(storage, { verifyAuthority: async () => false });

      const started = await service.start(principal, { paths: ["/Inbox/a.pdf"] });
      const run = await finished(service, principal, started.id);

      expect(run).toMatchObject({
        state: "failed",
        error: "Your session ended. Sign in and try again.",
        activity: [],
      });
      expect(stat).not.toHaveBeenCalled();
    });

    it("shows the provider's own message when the AI provider fails", async () => {
      const { model } = fakeModel(async () => {
        throw new AiProviderError("The AI provider rejected the API key.");
      });
      const { service, onUnexpectedError } = setup({ model });
      const principal = principalWith(drive());

      const started = await service.start(principal, { paths: ["/Inbox/a.pdf"] });
      const run = await finished(service, principal, started.id);

      expect(run).toMatchObject({
        state: "failed",
        error: "The AI provider rejected the API key.",
      });
      expect(onUnexpectedError).not.toHaveBeenCalled();
    });

    it("fails generically when storage fails for another reason", async () => {
      const memory = drive();
      const failure = new StorageError("upstream_unavailable", "sftpgo is down at 10.0.0.5");
      const storage: StorageProvider = {
        ...memory,
        stat: async () => {
          throw failure;
        },
      };
      const { service, onUnexpectedError } = setup();
      const principal = principalWith(storage);

      const started = await service.start(principal, { paths: ["/Inbox/a.pdf"] });
      const run = await finished(service, principal, started.id);

      expect(run).toMatchObject({
        state: "failed",
        error: "Something went wrong while organizing. Try again.",
      });
      expect(onUnexpectedError).toHaveBeenCalledWith(failure);
    });

    it("stops after the configured number of turns", async () => {
      const { model, inputs } = fakeModel(async () =>
        toolTurn({ id: "tree", name: "folder_tree", input: {} }),
      );
      const { service } = setup({ model, maxTurns: 2 });
      const principal = principalWith(drive());

      const started = await service.start(principal, { paths: ["/Inbox/a.pdf"] });
      const run = await finished(service, principal, started.id);

      expect(run).toMatchObject({
        state: "failed",
        error: "The assistant needed too many steps. Try fewer items at once.",
      });
      expect(inputs).toHaveLength(2);
    });
  });

  describe("get and cancel", () => {
    it("report runs that do not exist or belong to someone else as not found", async () => {
      const { service } = setup();
      const principal = principalWith(drive());
      const started = await service.start(principal, { paths: ["/Inbox/a.pdf"] });
      const stranger = principalWith(drive(), { identityId: "identity-2" });

      for (const action of [
        () => service.get(principal, "missing"),
        () => service.cancel(principal, "missing"),
        () => service.get(stranger, started.id),
        () => service.cancel(stranger, started.id),
      ]) {
        expect(action).toThrow(ApiHttpError);
        expect(action).toThrow("That organize request does not exist or has expired.");
      }
      service.cancel(principal, started.id);
    });

    it("cancels a running run", async () => {
      const { model } = fakeModel(hangingSend);
      const { service, onUnexpectedError } = setup({ model });
      const principal = principalWith(drive());
      const started = await service.start(principal, { paths: ["/Inbox/a.pdf"] });
      await vi.waitFor(() => {
        expect(service.get(principal, started.id).activity).toContain("Looking at 1 item");
      });

      const cancelled = service.cancel(principal, started.id);

      expect(cancelled.state).toBe("cancelled");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(service.get(principal, started.id).state).toBe("cancelled");
      expect(onUnexpectedError).not.toHaveBeenCalled();
    });

    it("stops before touching storage when cancelled while checking the session", async () => {
      let allow!: (value: boolean) => void;
      const gate = new Promise<boolean>((resolve) => {
        allow = resolve;
      });
      const storage = drive();
      const stat = vi.spyOn(storage, "stat");
      const { service } = setup();
      const principal = principalWith(storage, { verifyAuthority: () => gate });
      const started = await service.start(principal, { paths: ["/Inbox/a.pdf"] });

      service.cancel(principal, started.id);
      allow(true);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(stat).not.toHaveBeenCalled();
      expect(service.get(principal, started.id)).toMatchObject({
        state: "cancelled",
        activity: [],
      });
    });
  });
});
