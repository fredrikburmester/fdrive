import { createHash, randomUUID } from "node:crypto";
import type { Principal } from "../auth/principal.js";
import type { PersonalActivityService } from "./service.js";

/**
 * How long the end of a transfer waits for its outcome to be written. The write
 * still runs to completion in the background afterwards: an intent left open is
 * recoverable, while a download that never reaches EOF is not, so a stalled
 * journal must never hold the response open.
 */
const RECORD_DEADLINE_MS = 2_000;

function bounded(work: Promise<void>): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, RECORD_DEADLINE_MS);
    timer.unref();
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    work.then(done, done);
  });
}

/** EOF confirms bytes sent; cancellation/stream failure never becomes a successful download. */
export async function activityStream(
  activity: PersonalActivityService | undefined,
  principal: Principal,
  path: string,
  action: "file.download" | "file.materialize" | "archive.compress",
  body: ReadableStream<Uint8Array>,
  options: {
    requestId?: string;
    partial?: boolean;
    expectedBytes?: number | null;
    source?: "web" | "api" | "native";
    subjects?: import("@fdrive/db").ActivityOperationInput["subjects"];
  } = {},
): Promise<ReadableStream<Uint8Array>> {
  if (!activity) return body;
  const source = options.source ?? (action === "file.materialize" ? "native" : "web");
  // Admission runs alongside the transfer, never ahead of it. The provider's
  // response is already open by the time we get here, and holding it unread
  // while a journal write completes can leave the caller with a truncated
  // download. History is also not a reason to refuse bytes the person asked
  // for: an unavailable journal records nothing and serves the file anyway.
  const admitted = (async () => {
    const operation = await activity.repo.begin({
      accountId: principal.accountId,
      identityId: principal.identityId,
      action,
      source,
      producerOperationId: options.requestId ?? randomUUID(),
      requestDigest: createHash("sha256")
        .update(JSON.stringify([action, path, options.subjects]))
        .digest("hex"),
      requested: {
        path,
        ...(action === "archive.compress" ? {} : { kind: "file" as const }),
        ...(action === "archive.compress" ? { variant: "stream" } : {}),
      },
      before: { path, ...(action === "archive.compress" ? {} : { kind: "file" as const }) },
      ...(options.subjects ? { subjects: options.subjects } : {}),
    });
    // Replaying a read may send bytes again. It must not replay an attributed action.
    return (await activity.repo.claim(principal.accountId, operation.id)) ? operation : null;
  })().catch(() => null);
  const reader = body.getReader();
  let bytes = 0,
    finished = false;
  const timer = setInterval(() => {
    void admitted
      .then((operation) =>
        operation ? activity.repo.heartbeat(principal.accountId, operation.id) : undefined,
      )
      .catch(() => undefined);
  }, 15_000);
  timer.unref();
  async function finish(outcome: "success" | "partial" | "cancelled" | "failed") {
    if (finished) return;
    finished = true;
    clearInterval(timer);
    const operation = await admitted;
    if (!operation) return;
    try {
      await activity?.repo.finish(principal.accountId, operation.id, {
        outcome,
        after: { path, size: bytes },
        ...(outcome === "success" ? {} : { errorCode: `transfer_${outcome}` }),
      });
    } catch {
      /* stale intent recovery reports uncertainty without replaying I/O */
    }
  }
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const item = await reader.read();
        if (item.done) {
          await bounded(
            finish(
              options.partial || (options.expectedBytes != null && bytes !== options.expectedBytes)
                ? "partial"
                : "success",
            ),
          );
          controller.close();
        } else {
          bytes += item.value.byteLength;
          controller.enqueue(item.value);
        }
      } catch (error) {
        await bounded(finish(bytes ? "partial" : "failed"));
        controller.error(error);
      }
    },
    async cancel(reason) {
      const recorded = bounded(finish(bytes ? "partial" : "cancelled"));
      try {
        await reader.cancel(reason);
      } finally {
        await recorded;
      }
    },
  });
}
