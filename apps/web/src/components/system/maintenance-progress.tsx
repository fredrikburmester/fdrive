import type { IndexerClearJob } from "@fdrive/contracts";

/**
 * A background pass as one line of a sheet: its name, then how far it is. While it runs with a
 * known total, a bar under the line shows the share done. The last result stays visible after
 * the pass finishes.
 */
export function MaintenanceProgress({
  title,
  job,
}: {
  title: string;
  job: IndexerClearJob | undefined;
}) {
  if (job === undefined || (!job.running && job.startedAt === null && job.errors === 0))
    return null;
  const measurable = job.running && job.totalKnown !== false && job.total > 0;
  return (
    <div data-slot="maintenance-progress" className="flex flex-col gap-2 text-sm">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <p className="font-medium">{title}</p>
        <p role="status" className="text-muted-foreground">
          {job.running
            ? job.totalKnown === false && job.processed === 0
              ? "Discovering"
              : "Running"
            : job.outcome === "stopped"
              ? "Stopped"
              : job.errors > 0 || job.outcome === "failed"
                ? "Completed with errors"
                : "Completed"}{" "}
          · {job.processed.toLocaleString()}
          {job.running && job.totalKnown === false ? "" : ` of ${job.total.toLocaleString()}`}{" "}
          processed ·{" "}
          {job.errors > 0 ? (
            <a
              className="whitespace-nowrap rounded-sm text-destructive underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-ring"
              href="#processing-failures"
            >
              {job.errors.toLocaleString()} errors
            </a>
          ) : (
            "0 errors"
          )}
        </p>
      </div>
      {measurable ? (
        <span aria-hidden="true" className="h-2 overflow-hidden rounded-full bg-muted">
          <span
            data-slot="bar-fill"
            className="block h-full rounded-full bg-muted-foreground"
            style={{ width: `${(Math.min(job.processed / job.total, 1) * 100).toFixed(1)}%` }}
          />
        </span>
      ) : null}
    </div>
  );
}
