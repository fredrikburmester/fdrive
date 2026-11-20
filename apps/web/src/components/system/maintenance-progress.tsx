import type { IndexerClearJob } from "@fdrive/contracts";
import { SettingRow } from "@/components/shell/page-layout";

/** Keep the last result visible after a background pass finishes. */
export function MaintenanceProgress({
  title,
  job,
}: {
  title: string;
  job: IndexerClearJob | undefined;
}) {
  if (job === undefined || (!job.running && job.startedAt === null && job.errors === 0))
    return null;
  return (
    <SettingRow label={title}>
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
          <a className="underline" href="#processing-failures">
            {job.errors.toLocaleString()} errors
          </a>
        ) : (
          "0 errors"
        )}
      </p>
    </SettingRow>
  );
}
