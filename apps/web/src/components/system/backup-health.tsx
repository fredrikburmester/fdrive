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

type Estimate = NonNullable<NonNullable<BackupsResponse["estimate"]>["result"]>;
/** Plain-language rows; the stored-total row names the copy count the server multiplied by. */
function estimateRows(estimate: Estimate): [string, string, string][] {
  const one = BigInt(estimate.uncompressedBytes);
  const copies = one > BigInt(0) ? BigInt(estimate.retainedBytes) / one : BigInt(0);
  return [
    [
      "One backup, before compression",
      estimate.uncompressedBytes,
      "The database and recovery files below. The uploaded file is compressed, usually smaller.",
    ],
    [
      "Database",
      estimate.databaseBytes,
      "Accounts, settings, tags, shares and activity. Postgres indexes count here but are not exported.",
    ],
    [
      "Recovery files and configuration ZIPs",
      estimate.recoveryBytes,
      "Original copies kept by OCR, Office and the Mac app so changes can be recovered, plus logs and uploaded ZIPs.",
    ],
    [
      "Stored at destinations, at most",
      estimate.retainedBytes,
      copies > BigInt(0)
        ? `${copies} full backups kept in total by your retention settings, before compression. The newest backup counts as a daily, weekly and monthly copy at once, so fewer are usually stored.`
        : "No enabled destination keeps remote copies.",
    ],
    [
      "Transfer per backup run",
      estimate.transferAndReadbackBytes,
      "Each destination receives one upload, then fdrive downloads it again to verify it.",
    ],
    [
      "Free space on this server",
      estimate.availableSpoolBytes,
      "Backups are built here before upload. Keep at least twice one backup free.",
    ],
  ];
}

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
  const rehearsed = data.runs.find((run) => run.id === data.rehearsal?.snapshotId);
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
      "Free space on this server is less than twice the size of one backup. Free up space before backing up.",
    );
  if (!data.rehearsal || now - Date.parse(data.rehearsal.completedAt) > 30 * 24 * 60 * 60_000)
    alerts.push(
      "Restore rehearsal due: no backup has been test-restored in the last 30 days. See Restore rehearsal below.",
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
        description="How big one backup is and how much room your retention settings could take. Only fdrive's own data is backed up, not the files on your fileservers."
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
            <dl className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2">
              {estimateRows(estimate).map(([label, bytes, hint]) => (
                <div key={label} className="min-w-0">
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="font-medium">{formatBytes(Number(bytes))}</dd>
                  <dd className="text-xs text-muted-foreground">{hint}</dd>
                </div>
              ))}
            </dl>
            <p className="text-xs text-muted-foreground">
              Estimated {date(estimate.estimatedAt)}. Every backup is a full copy, not just the
              changes since the last one. Pinned backups, bucket versioning and object lock add to
              the stored total; provider fees and retries are not included.
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
        description="A practice restore that proves a backup can actually be decrypted and imported. It runs on a separate machine, so this installation is never touched."
      >
        <p className="text-sm">
          {data.rehearsal
            ? `Last successful rehearsal: ${date(data.rehearsal.completedAt)} · ${data.rehearsal.tableCount} tables · ${data.rehearsal.blobCount} recovery files restored`
            : "No backup has been test-restored yet. Until one is, you only know the backups were uploaded, not that they can be restored."}
        </p>
        {data.rehearsal && (
          <p className="break-all text-xs text-muted-foreground">
            Snapshot {rehearsed ? `from ${date(rehearsed.createdAt)} · ` : ""}
            {data.rehearsal.snapshotId}
          </p>
        )}
        <p className="text-sm text-muted-foreground">
          Why separately: a restore needs an empty database and your private recovery key. This
          server's database is in use, and it deliberately never holds the private key.
        </p>
        <ol className="list-decimal space-y-2 pl-5 text-sm">
          <li>
            On another machine, or a throwaway container with no access to your fileservers, set up
            the same fdrive version with a new empty database.
          </li>
          <li>
            Copy a backup there (download one from History, or fetch it from a destination) along
            with your saved recovery key file. The command below is filled in for your latest
            complete backup.
          </li>
          <li>
            Run the rehearsal. It restores into the empty database under a new identity and never
            contacts your fileservers or backup destinations.
            <pre className="mt-2 overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs">
              {`node dist/main.js backup rehearse \\\n  --file BACKUP.fdrive.age \\\n  --key-file recovery-key.txt \\\n  --snapshot ${complete?.id ?? "SNAPSHOT_ID"} \\\n  --state-dir /tmp/fdrive-rehearsal`}
            </pre>
          </li>
          <li>
            If it prints a report ending in <code className="font-mono">"result": "passed"</code>,
            save that output as a <code className="font-mono">.json</code> file and upload it below.
            Then delete the test database and directory, since they contain your restored data.
          </li>
        </ol>
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
          fdrive checks that the report belongs to this installation and one of its backups, then
          records your result. The monthly reminder above clears for 30 days. “Verify bytes” in
          History only confirms the encrypted file is intact; it can't prove a restore works.
        </p>
      </SystemSection>
    </>
  );
}
