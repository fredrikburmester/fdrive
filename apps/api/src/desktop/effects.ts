import { toFsPath } from "@fdrive/core";
import type { DesktopEffectContext, DesktopEffectsRepo, Identity, IdentityRepo } from "@fdrive/db";
import type { Principal } from "../auth/principal.js";
import { ApiHttpError } from "../errors.js";
import type { EventBus } from "../events/bus.js";
import type { ConfiguredMappingsResult } from "../scoping/types.js";
import type { SystemEventLog } from "../system/event-log.js";

/** Resolve once, before publication. Recovery never reinterprets an old path
 * against a new provider configuration or needs a user's storage credentials. */
export function createDesktopEffectContext(
  identities: Pick<IdentityRepo, "get">,
  configuredMappings: (identity: Identity) => Promise<ConfiguredMappingsResult>,
) {
  return async (
    principal: Principal,
    context: Omit<DesktopEffectContext, "office">,
  ): Promise<DesktopEffectContext> => {
    const result: DesktopEffectContext = { ...context, office: null };
    if (!context.from || context.from === context.to || context.trash) return result;
    const identity = await identities.get(principal.identityId);
    if (!identity || identity.accountId !== principal.accountId)
      throw new ApiHttpError("unauthorized", "Connection was revoked");
    const configured = await configuredMappings(identity);
    if (!configured.available) return result;
    const source = toFsPath(configured.scopes, context.from);
    const target = toFsPath(configured.scopes, context.to);
    if (source)
      result.office = {
        providerId: configured.providerId,
        rootName: source.rootName,
        from: source.fsPath.slice(1),
        to: target?.rootName === source.rootName ? target.fsPath.slice(1) : null,
      };
    return result;
  };
}

export function createDesktopEffectsWorker(deps: {
  repo: DesktopEffectsRepo;
  bus: Pick<EventBus, "publish">;
  eventLog: SystemEventLog;
}) {
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let background: Promise<void> | undefined;
  const active = new Set<Promise<void>>();
  async function drain(identityId?: string) {
    for (let i = 0; i < 32 && !stopped; i++) {
      const result = await deps.repo.processNext((event) => deps.bus.publish(event), identityId);
      if (result.state === "idle") break;
      if (result.state === "failed")
        deps.eventLog.record("general", "warn", "Native metadata recovery is pending", {
          identityId: result.identityId,
          operationId: result.operationId,
          retryAt: result.retryAt.toISOString(),
        });
    }
  }
  function run(identityId?: string) {
    const promise = drain(identityId);
    active.add(promise);
    void promise.finally(() => active.delete(promise)).catch(() => {});
    return promise;
  }
  function kick() {
    if (stopped || background) return;
    background = run()
      .catch(() => {
        deps.eventLog.record(
          "general",
          "error",
          "Native metadata recovery is unavailable; retry scheduled",
        );
      })
      .finally(() => {
        background = undefined;
      });
  }
  return {
    kick,
    start() {
      if (timer || stopped) return;
      kick();
      timer = setInterval(kick, 5000);
      timer.unref();
    },
    async beforeWrite(identityId: string) {
      try {
        await run(identityId);
      } catch {
        throw new ApiHttpError(
          "upstream_unavailable",
          "Metadata recovery is busy or unavailable. Retry later.",
        );
      }
      if (stopped || (await deps.repo.pending(identityId)))
        throw new ApiHttpError(
          "upstream_unavailable",
          "An earlier save needs metadata recovery. Retry later.",
        );
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      await Promise.allSettled([...active]);
    },
  };
}
