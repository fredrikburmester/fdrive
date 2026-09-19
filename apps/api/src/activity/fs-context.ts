import { type ActivityFacts, CanonicalUuid, type PersonalActivitySource } from "@fdrive/contracts";
import type { Principal } from "../auth/principal.js";
import { ApiHttpError } from "../errors.js";
import type { FsContext } from "../fs/routes.js";
import type { ActivityRunInput, PersonalActivityService } from "./service.js";

/**
 * Provenance for one recorded command. HTTP handlers derive it from the
 * request; callers that never touch Hono, such as an applied AI chat action,
 * build it themselves.
 */
export interface ActivityCallContext {
  readonly source: PersonalActivitySource;
  readonly producerOperationId?: string;
  readonly batchId?: string;
  /** The chat that proposed this command, when the person applied an AI action. */
  readonly conversationId?: string;
}

export function activityRequestContext(c: FsContext): ActivityCallContext {
  const operation = c.req.header("x-fdrive-operation-id");
  const batch = c.req.header("x-fdrive-batch-id");
  if (operation && !/^[a-zA-Z0-9:_-]{1,200}$/.test(operation))
    throw new ApiHttpError("bad_request", "Invalid activity operation ID");
  if (batch && !CanonicalUuid.safeParse(batch).success)
    throw new ApiHttpError("bad_request", "Invalid activity batch ID");
  return {
    producerOperationId: operation ?? c.get("requestId"),
    ...(batch ? { batchId: batch } : {}),
    source: c.req.header("sec-fetch-site") ? "web" : "api",
  };
}

/**
 * Records one command around `mutate`. Recording is skipped entirely when no
 * service is configured, so every producer keeps working without the feature.
 */
export async function recordActivity<T>(
  activity: PersonalActivityService | undefined,
  principal: Principal,
  input: ActivityRunInput,
  mutate: () => Promise<T>,
  facts?: (value: T) => ActivityFacts | Promise<ActivityFacts>,
): Promise<T> {
  if (!activity) return mutate();
  const result = await activity.run(principal, input, mutate, facts);
  return result.value;
}

/** Same as `recordActivity`, plus the response headers the web client reads. */
export async function recordFsAction<T>(
  activity: PersonalActivityService | undefined,
  c: FsContext,
  input: ActivityRunInput,
  mutate: () => Promise<T>,
  facts?: (value: T) => ActivityFacts | Promise<ActivityFacts>,
): Promise<T> {
  if (!activity) return mutate();
  const result = await activity.run(
    c.get("principal"),
    { ...activityRequestContext(c), ...input },
    mutate,
    facts,
  );
  c.header("X-Activity-Status", result.historyPending ? "pending" : "recorded");
  if (result.eventId) c.header("X-Activity-Event-Id", result.eventId);
  return result.value;
}
