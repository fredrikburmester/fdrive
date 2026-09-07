import type { IndexerClearJob } from "@fdrive/contracts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

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
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <p role="status" className="text-sm text-muted-foreground">
          {job.running ? "Running" : job.errors > 0 ? "Completed with errors" : "Completed"} ·{" "}
          {job.processed.toLocaleString()} of {job.total.toLocaleString()} processed ·{" "}
          {job.errors.toLocaleString()} errors
        </p>
      </CardContent>
    </Card>
  );
}
