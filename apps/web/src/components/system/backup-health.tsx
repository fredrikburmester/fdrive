"use client";
import { BackupRehearsal, type BackupsResponse } from "@fdrive/contracts";
import { useId } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { backupClient } from "@/lib/api/backup-queries";
import { formatBytes } from "@/lib/format";
import { SystemSection } from "./system-section";

const date = (value: string) => new Date(value).toLocaleString();

export function BackupHealth({
  data,
  busy,
  unlocked,
  act,
}: {
  data: BackupsResponse;
  busy: boolean;
  unlocked: boolean;
  act: (work: () => Promise<unknown>) => Promise<void>;
}) {
  const id = useId();
  const now = Date.now();
  const complete = data.runs.find((run) => run.state === "complete" && run.coverage.length === 0);
  const latest = data.runs[0];
  const estimate = data.estimate?.result;
  const alerts: string[] = [];
  if (!data.enabled) alerts.push("Backup worker is disabled in this deployment.");
  else if (!data.workerSeenAt || now - Date.parse(data.workerSeenAt) > 60_000)
    alerts.push("Backup worker has not checked in during the last minute.");
  if (!data.keyConfirmed) alerts.push("Confirm your recovery key before creating backups.");
  if (data.restored) alerts.push("This restored installation is paused for recovery review.");
  if (latest && ["failed", "partial", "cancelled"].includes(latest.state))
    alerts.push(
      "The latest attempt did not complete full protection. Check its coverage and delivery errors below.",
    );
  if (data.nextRunAt && Date.parse(data.nextRunAt) < now - 15 * 60_000)
    alerts.push("The installation schedule is overdue by more than 15 minutes.");
  if (
    estimate &&
    BigInt(estimate.availableSpoolBytes) < BigInt(estimate.uncompressedBytes) * BigInt(2)
  )
    alerts.push(
      "Available spool space is below twice the estimated snapshot size. Free space before starting a backup.",
    );
  if (!data.rehearsal || now - Date.parse(data.rehearsal.completedAt) > 30 * 24 * 60 * 60_000)
    alerts.push(
      "Restore rehearsal due: test a snapshot in an isolated installation and record the report here.",
    );
  return (
    <>
      <SystemSection
        title="Backup health"
        description="Full coverage, delivery verification and restore rehearsals are tracked separately."
      >
        <p className="text-sm">
          {complete
            ? `Last complete snapshot: ${date(complete.createdAt)} · ${Math.max(0, Math.floor((now - Date.parse(complete.createdAt)) / 3_600_000))} hours ago`
            : "No complete snapshot recorded yet."}
        </p>
        {data.nextRunAt && (
          <p className="text-sm">Next installation backup: {date(data.nextRunAt)}</p>
        )}
        {alerts.length > 0 && (
          <ul className="space-y-2 text-sm" aria-label="Backup health notices">
            {alerts.map((alert) => (
              <li key={alert} className="break-words">
                {alert}
              </li>
            ))}
          </ul>
        )}
        {data.destinations.map((destination) => {
          const delivered = data.runs.find(
            (run) =>
              run.coverage.length === 0 &&
              run.deliveries.some(
                (item) => item.destinationId === destination.id && item.state === "complete",
              ),
          );
          const attempt = data.runs.find((run) =>
            run.deliveries.some((item) => item.destinationId === destination.id),
          );
          const delivery = attempt?.deliveries.find(
            (item) => item.destinationId === destination.id,
          );
          const overdue =
            destination.enabled &&
            destination.nextRunAt &&
            Date.parse(destination.nextRunAt) < now - 15 * 60_000;
          return (
            <div key={destination.id} className="min-w-0 space-y-1 border-t pt-3 text-sm">
              <p className="break-words font-medium">
                {destination.name}
                {!destination.enabled && " · paused"}
              </p>
              <p>
                {delivered
                  ? `Last full delivery: ${date(delivered.createdAt)}`
                  : "No verified full delivery recorded."}
              </p>
              {destination.nextRunAt && (
                <p>Next scheduled delivery: {date(destination.nextRunAt)}</p>
              )}
              {overdue && (
                <p className="text-destructive">Delivery overdue by more than 15 minutes.</p>
              )}
              {delivery?.error && <p className="break-words text-destructive">{delivery.error}</p>}
            </div>
          );
        })}
        <p className="text-xs text-muted-foreground">
          Downloaded archives are only protected after you save them independently. History here
          does not confirm possession or override a bucket's own lifecycle rules.
        </p>
      </SystemSection>
      <SystemSection
        title="Storage estimate"
        description="Estimate before enabling a schedule. Scanning recovery sources may take a few minutes."
      >
        <Button
          variant="outline"
          disabled={busy || !unlocked || data.estimate?.state === "pending"}
          onClick={() => void act(() => backupClient.estimate())}
        >
          {data.estimate?.state === "pending" ? "Estimating…" : "Estimate backup size"}
        </Button>
        {data.estimate?.error && <p className="text-sm text-destructive">{data.estimate.error}</p>}
        {estimate && (
          <>
            <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
              {[
                ["Database", estimate.databaseBytes],
                ["Recovery files and ZIPs", estimate.recoveryBytes],
                ["Uncompressed snapshot", estimate.uncompressedBytes],
                ["Available spool space", estimate.availableSpoolBytes],
                ["Remote retained snapshots", estimate.retainedBytes],
                ["Upload and full readback per run", estimate.transferAndReadbackBytes],
              ].map(([label, bytes]) => (
                <div key={label}>
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd>{formatBytes(Number(bytes))}</dd>
                </div>
              ))}
            </dl>
            <p className="text-xs text-muted-foreground">
              Estimated {date(estimate.estimatedAt)}. Sizes vary with compression and database
              export. Retention assumes distinct full copies for every slot; overlapping slots
              reduce this, while pins, versioning and locked objects add storage. Network estimates
              exclude retries and provider charges.
            </p>
            {estimate.coverage.map((gap) => (
              <p key={gap} className="break-words text-sm text-destructive">
                {gap}
              </p>
            ))}
          </>
        )}
      </SystemSection>
      <SystemSection
        title="Restore rehearsal"
        description="Run the backup rehearse command against an empty isolated database. Upload its JSON report after reviewing the result."
      >
        <p className="text-sm">
          {data.rehearsal
            ? `Owner-recorded successful restore: ${date(data.rehearsal.completedAt)} · ${data.rehearsal.tableCount} tables · ${data.rehearsal.blobCount} recovery files`
            : "No successful restore rehearsal recorded."}
        </p>
        {data.rehearsal && (
          <p className="break-all text-xs text-muted-foreground">
            Snapshot {data.rehearsal.snapshotId}
          </p>
        )}
        <Label htmlFor={id}>Rehearsal report (.json)</Label>
        <Input
          id={id}
          type="file"
          accept=".json,application/json"
          disabled={busy || !unlocked}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (file)
              void act(async () => {
                if (file.size > 64 * 1024)
                  throw Error("Rehearsal reports must be smaller than 64 KiB");
                await backupClient.recordRehearsal(
                  BackupRehearsal.parse(JSON.parse(await file.text())),
                );
              });
          }}
        />
        <p className="text-xs text-muted-foreground">
          This records your report. Routine byte verification cannot decrypt or restore a backup
          without your private recovery key.
        </p>
      </SystemSection>
    </>
  );
}
