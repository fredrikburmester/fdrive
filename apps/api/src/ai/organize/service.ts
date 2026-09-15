import type { AiStatusResponse, OrganizeRequest, OrganizeRun } from "@fdrive/contracts";
import { isStorageError, isUnderPath, normalizePath } from "@fdrive/core";
import type { Principal } from "../../auth/principal.js";
import { ApiHttpError } from "../../errors.js";
import type { McpToolDeps } from "../../mcp/handlers.js";
import { type AiModel, AiProviderError } from "../model.ts";
import type { AiSettingsService, ResolvedAiConfig } from "../settings.ts";
import { type OrganizeItem, runOrganizeAgent } from "./agent.ts";
import { buildProposal } from "./proposal.ts";
import { OrganizeBusyError, OrganizeError, type OrganizeRuns } from "./runs.ts";
import { createOrganizeTools } from "./tools.ts";

export interface OrganizeService {
  status(): Promise<AiStatusResponse>;
  start(principal: Principal, request: OrganizeRequest): Promise<OrganizeRun>;
  get(principal: Principal, id: string): OrganizeRun;
  cancel(principal: Principal, id: string): OrganizeRun;
}

export interface OrganizeServiceDeps {
  readonly settings: Pick<AiSettingsService, "resolved">;
  readonly modelFor: (config: ResolvedAiConfig) => AiModel;
  readonly runs: OrganizeRuns;
  /** The MCP read handlers the organizer's tools reuse. */
  readonly mcp: McpToolDeps;
  readonly maxTurns?: number;
}

const STAT_CONCURRENCY = 8;

function notFound(): ApiHttpError {
  return new ApiHttpError("not_found", "That organize request does not exist or has expired.");
}

async function statItems(principal: Principal, paths: readonly string[], signal: AbortSignal) {
  const items: (OrganizeItem | null)[] = new Array(paths.length);
  let next = 0;
  async function worker() {
    while (next < paths.length) {
      const index = next++;
      signal.throwIfAborted();
      const path = paths[index] as string;
      try {
        const stat = await principal.storage.stat(path);
        items[index] =
          stat.kind === "dir" || stat.kind === "file"
            ? { path, kind: stat.kind, size: stat.size, modifiedAt: stat.modifiedAt ?? null }
            : null;
      } catch (error) {
        if (!isStorageError(error) || error.kind !== "not_found") throw error;
        items[index] = null;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(STAT_CONCURRENCY, paths.length) }, worker));
  return items.filter((item): item is OrganizeItem => item !== null);
}

/**
 * Starts organize runs for a signed-in person: checks the selection, lets
 * the organizer look around with read-only tools, then verifies its answer
 * against storage. Runs never move anything.
 */
export function createOrganizeService(deps: OrganizeServiceDeps): OrganizeService {
  async function indexedFor(principal: Principal): Promise<boolean> {
    const identity = await deps.mcp.identities.get(principal.identityId);
    if (identity === null) return false;
    return (await deps.mcp.scopeResolver.verifiedIndexScopes(identity)).available;
  }

  return {
    async status() {
      const config = await deps.settings.resolved();
      return { available: config !== null, provider: config?.provider ?? null };
    },

    async start(principal, request) {
      const config = await deps.settings.resolved();
      if (config === null)
        throw new ApiHttpError(
          "unsupported",
          "AI is not set up. An administrator can turn it on under System > AI.",
        );
      const trashPath =
        deps.mcp.trashPathForStorage?.(principal.storage) ?? deps.mcp.trashPath ?? null;
      const paths: string[] = [];
      for (const raw of request.paths) {
        let path: string;
        try {
          path = normalizePath(raw);
        } catch {
          throw new ApiHttpError("bad_request", `"${raw}" is not a valid path.`);
        }
        if (path === "/") throw new ApiHttpError("bad_request", "The drive root cannot be moved.");
        if (trashPath !== null && (path === trashPath || isUnderPath(trashPath, path)))
          throw new ApiHttpError("bad_request", "Items in Trash cannot be organized.");
        if (!paths.includes(path)) paths.push(path);
      }
      // Moving a folder moves its contents too, so an item inside another selected folder is redundant.
      const selected = paths.filter(
        (path) => !paths.some((other) => other !== path && isUnderPath(other, path)),
      );
      const model = deps.modelFor(config);

      try {
        return deps.runs.start(
          principal.identityId,
          selected.length,
          async ({ signal, activity }) => {
            try {
              const checkAuthority = async () => {
                if (principal.verifyAuthority !== undefined && !(await principal.verifyAuthority()))
                  throw new OrganizeError("Your session ended. Sign in and try again.");
              };
              await checkAuthority();
              activity(`Looking at ${selected.length} ${selected.length === 1 ? "item" : "items"}`);
              const items = await statItems(principal, selected, signal);
              if (items.length === 0)
                throw new OrganizeError("None of the selected items exist anymore.");
              const indexed = await indexedFor(principal);
              const submission = await runOrganizeAgent({
                model,
                tools: createOrganizeTools({
                  mcp: deps.mcp,
                  principal,
                  selected: new Set(items.map((item) => item.path)),
                  indexed,
                }),
                items,
                instructions: request.instructions || undefined,
                indexed,
                signal,
                activity,
                checkAuthority,
                ...(deps.maxTurns !== undefined ? { maxTurns: deps.maxTurns } : {}),
              });
              activity("Checking the suggestions");
              return await buildProposal({
                storage: principal.storage,
                items,
                submission,
                trashPath,
              });
            } catch (error) {
              if (error instanceof AiProviderError) throw new OrganizeError(error.message);
              throw error;
            }
          },
        );
      } catch (error) {
        if (error instanceof OrganizeBusyError)
          throw new ApiHttpError("rate_limited", error.message);
        throw error;
      }
    },

    get(principal, id) {
      const run = deps.runs.get(id, principal.identityId);
      if (run === null) throw notFound();
      return run;
    },

    cancel(principal, id) {
      const run = deps.runs.cancel(id, principal.identityId);
      if (run === null) throw notFound();
      return run;
    },
  };
}
