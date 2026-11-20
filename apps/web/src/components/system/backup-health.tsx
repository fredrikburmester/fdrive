"use client";
import { BackupRehearsal, type BackupsResponse } from "@fdrive/contracts";
import { useId } from "react";
import { SettingRow } from "@/components/shell/page-layout";
import { Code, FactList } from "@/components/shell/sheet-data";
import type { StatusTone } from "@/components/shell/status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { backupClient } from "@/lib/api/backup-queries";
import { formatDate } from "@/lib/format";
import { formatRelativeTime } from "@/lib/system/format";
import { useFormatters } from "@/lib/use-format-preferences";
import { StatGrid } from "./stat-grid";
import { SystemAlert, SystemNote, SystemSection } from "./system-section";

type Destination = BackupsResponse["destinations"][number];
type Run = BackupsResponse["runs"][number];
type Act = (work: () => Promise<unknown>) => Promise<void>;

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** How late a scheduled backup may be before it counts as overdue. */
const OVERDUE = 15 * MINUTE;
/** How long a passed restore rehearsal keeps its reminder away. */
const REHEARSAL_VALID = 30 * DAY;

/**
 * A backup's time as the Formats settings write it. Unlike a file's date it always keeps the
 * hour, since several backups can share a day and the next one is still ahead.
 */
export function useBackupTime(): (iso: string) => string {
  const { prefs } = useFormatters();
  return (iso) => {
    const date = new Date(iso);
    const relative = formatDate(date, { clock: prefs.clock });
    return prefs.dates === "relative" && /^(Today|Yesterday) /.test(relative)
      ? relative
      : formatDate(date, { clock: prefs.clock, style: "absolute" });
  };
}

/** True while the last passed restore rehearsal is recent enough to count. */
function rehearsed(data: BackupsResponse, now: number): boolean {
  return data.rehearsal != null && now - Date.parse(data.rehearsal.completedAt) <= REHEARSAL_VALID;
}

/** The newest backup with full coverage, which is what "protected" means on this page. */
function lastComplete(data: BackupsResponse): Run | undefined {
  return data.runs.find((run) => run.state === "complete" && run.coverage.length === 0);
}

export interface DestinationStatus {
  /** The newest backup with full coverage that this destination holds a verified copy of. */
  delivered: Run | undefined;
  /** Why the newest attempt to copy a backup here failed, if it did. */
  error: string | null;
  /** True when an enabled destination's own schedule is more than 15 minutes late. */
  overdue: boolean;
  tone: StatusTone;
  label: "Healthy" | "Needs attention" | "Failed" | "Paused" | "No copy yet";
}

/** One destination's state, judged apart from every other destination's. */
export function destinationStatus(
  data: BackupsResponse,
  destination: Destination,
  now: number,
): DestinationStatus {
  const delivers = (run: Run, complete: boolean) =>
    run.deliveries.some(
      (item) => item.destinationId === destination.id && (!complete || item.state === "complete"),
    );
  const delivered = data.runs.find((run) => run.coverage.length === 0 && delivers(run, true));
  const attempt = data.runs.find((run) => delivers(run, false));
  const error =
    attempt?.deliveries.find((item) => item.destinationId === destination.id)?.error ?? null;
  const overdue =
    destination.enabled &&
    destination.nextRunAt !== null &&
    Date.parse(destination.nextRunAt) < now - OVERDUE;
  const state = !destination.enabled
    ? ({ tone: "off", label: "Paused" } as const)
    : error !== null
      ? ({ tone: "danger", label: "Failed" } as const)
      : overdue
        ? ({ tone: "warning", label: "Needs attention" } as const)
        : delivered
          ? ({ tone: "success", label: "Healthy" } as const)
          : ({ tone: "neutral", label: "No copy yet" } as const);
  return { delivered, error, overdue, ...state };
}

export interface BackupHealthSummary {
  tone: "success" | "warning" | "danger";
  label: "Healthy" | "Needs attention" | "Failed";
  /** What needs a look, one sentence each. Empty when healthy. */
  notices: string[];
  /** True while a restore rehearsal passed within the last 30 days. */
  rehearsed: boolean;
}

/**
 * The page's one health verdict, for the badge in the sheet's header, with the reasons behind
 * it. Failed means the newest attempt failed; anything else that needs a look is Needs
 * attention. Coverage, delivery and restore rehearsals each raise their own notice.
 */
export function backupHealth(data: BackupsResponse, now: number): BackupHealthSummary {
  const latest = data.runs[0];
  const estimate = data.estimate?.result;
  const notices: string[] = [];
  if (!data.enabled) notices.push("Backup worker is disabled in this deployment.");
  else if (!data.workerSeenAt || now - Date.parse(data.workerSeenAt) > MINUTE)
    notices.push("Backup worker has not checked in during the last minute.");
  if (!data.keyConfirmed)
    notices.push("Confirm your recovery key under Recovery before creating backups.");
  if (data.restored) notices.push("This restored installation is paused for recovery review.");
  if (latest && ["failed", "partial", "cancelled"].includes(latest.state))
    notices.push(
      "The latest attempt did not complete full protection. Check its coverage and delivery errors under History.",
    );
  if (data.nextRunAt && Date.parse(data.nextRunAt) < now - OVERDUE)
    notices.push("The installation schedule is overdue by more than 15 minutes.");
  for (const destination of data.destinations)
    if (destinationStatus(data, destination, now).overdue)
      notices.push(`${destination.name} is overdue by more than 15 minutes.`);
  if (
    estimate &&
    BigInt(estimate.availableSpoolBytes) < BigInt(estimate.uncompressedBytes) * BigInt(2)
  )
    notices.push(
      "Free space on this server is less than twice the size of one backup. Free up space before backing up.",
    );
  const recent = rehearsed(data, now);
  if (!recent)
    notices.push(
      "Restore rehearsal due: no backup has been test-restored in the last 30 days. See Recovery.",
    );
  const verdict =
    latest?.state === "failed"
      ? ({ tone: "danger", label: "Failed" } as const)
      : notices.length > 0
        ? ({ tone: "warning", label: "Needs attention" } as const)
        : ({ tone: "success", label: "Healthy" } as const);
  return { ...verdict, notices: [...new Set(notices)], rehearsed: recent };
}

/**
 * The top of the Overview: what needs a look, then the headline numbers. How long ago the last
 * complete backup ran and how soon the next one is due are numbers; their dates sit under them.
 */
export function BackupStatus({ data }: { data: BackupsResponse }) {
  const time = useBackupTime();
  const now = Date.now();
  const { notices } = backupHealth(data, now);
  const complete = lastComplete(data);
  const next = data.nextRunAt;
  const kept = data.runs.filter((run) => ["complete", "partial"].includes(run.state)).length;
  const paused = data.destinations.filter((destination) => !destination.enabled).length;
  return (
    <>
      {notices.length > 0 && (
        <SystemSection title="Needs attention">
          <ul aria-label="Backup health notices" className="flex flex-col gap-2 text-sm">
            {notices.map((notice) => (
              <li key={notice} className="flex gap-2.5">
                <span
                  aria-hidden="true"
                  className="mt-[7px] size-1.5 shrink-0 rounded-full bg-warning"
                />
                <span className="min-w-0 max-w-prose [overflow-wrap:anywhere]">{notice}</span>
              </li>
            ))}
          </ul>
        </SystemSection>
      )}
      <StatGrid
        stats={[
          complete
            ? {
                label: "Last complete backup",
                value: formatRelativeTime(new Date(complete.createdAt), new Date(now)),
                hint: time(complete.createdAt),
              }
            : {
                label: "Last complete backup",
                value: "Never",
                hint: "No complete backup recorded yet",
              },
          next
            ? {
                label: "Next backup",
                value:
                  Date.parse(next) < now
                    ? "Due"
                    : formatRelativeTime(new Date(next), new Date(now)),
                hint: time(next),
              }
            : { label: "Next backup", value: "Off", hint: "Automatic backups are off" },
          { label: "Backups kept", value: kept.toLocaleString("en-US") },
          {
            label: "Destinations",
            value: data.destinations.length.toLocaleString("en-US"),
            ...(paused > 0 ? { hint: `${paused} paused` } : {}),
          },
        ]}
      />
    </>
  );
}

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
      "Recovery files",
      estimate.recoveryBytes,
      "Original copies kept by OCR and Office so changes can be recovered, plus logs.",
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

interface OwnerProps {
  data: BackupsResponse;
  busy: boolean;
  unlocked: boolean;
  act: Act;
}

/** How big one backup is and how much room retention could take, measured on request. */
export function StorageEstimate({ data, busy, unlocked, act }: OwnerProps) {
  const { formatBytes } = useFormatters();
  const time = useBackupTime();
  const estimate = data.estimate?.result;
  return (
    <SystemSection
      title="Storage estimate"
      description="How big one backup is and how much room your retention settings could take. Only fdrive's own data is backed up, not the files folder."
      actions={
        <Button
          variant="outline"
          disabled={busy || !unlocked || data.estimate?.state === "pending"}
          onClick={() => void act(() => backupClient.estimate())}
        >
          {data.estimate?.state === "pending" ? "Estimating…" : "Estimate backup size"}
        </Button>
      }
    >
      {data.estimate?.error && <SystemAlert row>{data.estimate.error}</SystemAlert>}
      {estimate && (
        <>
          {estimateRows(estimate).map(([label, bytes, hint]) => (
            <SettingRow key={label} label={label} description={hint} align="end">
              <span className="font-medium tabular-nums">{formatBytes(Number(bytes))}</span>
            </SettingRow>
          ))}
          <SystemNote className="border-border border-t pt-4.5">
            <p>
              Estimated {time(estimate.estimatedAt)}. Every backup is a full copy, not just the
              changes since the last one. Pinned backups, bucket versioning and object lock add to
              the stored total; provider fees and retries are not included.
            </p>
            {estimate.coverage.map((gap) => (
              <p key={gap} className="text-destructive [overflow-wrap:anywhere]">
                {gap}
              </p>
            ))}
          </SystemNote>
        </>
      )}
    </SystemSection>
  );
}

/**
 * The practice restore: when the last one passed, how to run one on another machine, and where
 * its report is recorded.
 */
export function RestoreRehearsal({ data, busy, unlocked, act }: OwnerProps) {
  const id = useId();
  const time = useBackupTime();
  const complete = lastComplete(data);
  const rehearsal = data.rehearsal;
  const snapshot = data.runs.find((run) => run.id === rehearsal?.snapshotId);
  return (
    <SystemSection
      title="Restore rehearsal"
      description="A practice restore that proves a backup can actually be decrypted and imported. It runs on a separate machine, so this installation is never touched."
    >
      {rehearsal ? (
        <FactList
          facts={[
            { label: "Last successful rehearsal", value: time(rehearsal.completedAt) },
            {
              label: "Restored",
              value: `${rehearsal.tableCount} tables · ${rehearsal.blobCount} recovery files`,
            },
            {
              label: "Snapshot",
              value: (
                <>
                  {snapshot ? `from ${time(snapshot.createdAt)} · ` : ""}
                  <Code>{rehearsal.snapshotId}</Code>
                </>
              ),
            },
          ]}
        />
      ) : (
        <SystemNote>
          <p>
            No backup has been test-restored yet. Until one is, you only know the backups were
            uploaded, not that they can be restored.
          </p>
        </SystemNote>
      )}
      <SettingRow
        label="Rehearsal report (.json)"
        htmlFor={id}
        description="fdrive checks that the report belongs to this installation and one of its backups, then records your result for 30 days."
        className="mt-4.5"
      >
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
      </SettingRow>
      <SystemNote className="border-border border-t pt-4.5">
        <p className="font-medium text-foreground">How to rehearse a restore</p>
        <p>
          A restore needs an empty database and your private recovery key. This server's database is
          in use, and it deliberately never holds the private key.
        </p>
        <ol className="list-decimal space-y-2 pl-5 text-foreground">
          <li>
            On another machine, or a throwaway container with no access to your files folder, set up
            the same fdrive version with a new empty database.
          </li>
          <li>
            Copy a backup there (download one from History, or fetch it from a destination) along
            with your saved recovery key file. The command below is filled in for your latest
            complete backup.
          </li>
          <li>
            Run the rehearsal. It restores into the empty database under a new identity and never
            contacts your files folder or backup destinations.
            <pre className="mt-2 overflow-x-auto border-border border-l py-1 pl-3 font-mono text-[13px] text-foreground">
              {`node dist/main.js backup rehearse \\\n  --file BACKUP.fdrive.age \\\n  --key-file recovery-key.txt \\\n  --snapshot ${complete?.id ?? "SNAPSHOT_ID"} \\\n  --state-dir /tmp/fdrive-rehearsal`}
            </pre>
          </li>
          <li>
            If it prints a report ending in <Code>"result": "passed"</Code>, save that output as a{" "}
            <Code>.json</Code> file and upload it above. Then delete the test database and
            directory, since they contain your restored data.
          </li>
        </ol>
        <p>
          “Verify bytes” in History only confirms the encrypted file is intact; it can't prove a
          restore works.
        </p>
      </SystemNote>
    </SystemSection>
  );
}
