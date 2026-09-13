import { and, count, desc, eq, isNotNull, isNull, lt } from "drizzle-orm";
import type { Db } from "../index.js";
import { processingFailures, roots } from "../schema/idx.js";

/** Admin diagnostics deliberately span configured roots, like the existing worker logs. */
export function createProcessingFailureReader(db: Db) {
  return async (
    feature: string,
    opts: {
      status: "open" | "resolved";
      limit: number;
      before?: number | undefined;
      code?: string | undefined;
    },
  ) => {
    const matching = and(
      eq(processingFailures.feature, feature),
      opts.status === "open"
        ? isNull(processingFailures.resolvedAt)
        : isNotNull(processingFailures.resolvedAt),
    );
    const filtered = and(
      matching,
      opts.code === undefined ? undefined : eq(processingFailures.code, opts.code),
    );
    const [rows, groups, totals, open] = await Promise.all([
      db
        .select({ failure: processingFailures, root: roots.name })
        .from(processingFailures)
        .innerJoin(roots, eq(roots.id, processingFailures.rootId))
        .where(
          and(
            filtered,
            opts.before === undefined ? undefined : lt(processingFailures.id, opts.before),
          ),
        )
        .orderBy(desc(processingFailures.id))
        .limit(opts.limit + 1),
      db
        .select({ code: processingFailures.code, count: count() })
        .from(processingFailures)
        .where(matching)
        .groupBy(processingFailures.code)
        .orderBy(desc(count()), processingFailures.code),
      db.select({ count: count() }).from(processingFailures).where(filtered),
      db
        .select({ count: count() })
        .from(processingFailures)
        .where(and(eq(processingFailures.feature, feature), isNull(processingFailures.resolvedAt))),
    ]);
    const entries = rows.slice(0, opts.limit).map(({ failure: row, root }) => ({
      id: row.id,
      root,
      path: row.path,
      feature: row.feature,
      code: row.code,
      message: row.message,
      operationId: row.operationId,
      attempts: row.attempts,
      firstFailedAt: row.firstFailedAt.toISOString(),
      lastFailedAt: row.lastFailedAt.toISOString(),
      resolvedAt: row.resolvedAt?.toISOString() ?? null,
    }));
    return {
      entries,
      groups,
      total: totals[0]?.count ?? 0,
      openCount: open[0]?.count ?? 0,
      ...(rows.length > opts.limit ? { nextCursor: entries.at(-1)?.id } : {}),
    };
  };
}

export type ProcessingFailureReader = ReturnType<typeof createProcessingFailureReader>;
