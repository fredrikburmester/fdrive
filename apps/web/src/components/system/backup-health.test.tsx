// @vitest-environment jsdom
import type { BackupsResponse } from "@fdrive/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const client = vi.hoisted(() => ({ estimate: vi.fn(), recordRehearsal: vi.fn() }));
vi.mock("@/lib/api/backup-queries", () => ({ backupClient: client }));
const { BackupStatus, RestoreRehearsal, StorageEstimate, backupHealth, destinationStatus } =
  await import("./backup-health");
type Act = (work: () => Promise<unknown>) => Promise<void>;
const schedule = {
  frequency: "daily" as const,
  timezone: "UTC",
  hour: 3,
  daily: 7,
  weekly: 4,
  monthly: 12,
};
const uuid = "f9c0b4ba-7b67-4e2f-abf3-08d1a0e6d652";
const old = "2020-01-01T00:00:00.000Z";
const run = {
  id: uuid,
  createdAt: old,
  completedAt: old,
  state: "complete" as const,
  bytes: "1000",
  sha256: null,
  error: null,
  pinned: false,
  coverage: [],
  downloadable: true,
  verifiedAt: old,
  verificationRequested: false,
  verificationError: null,
  deliveries: [
    { destinationId: uuid, name: "Bucket", state: "complete", error: null, verifiedAt: old },
  ],
};
const bucket = {
  id: uuid,
  name: "Bucket",
  type: "s3",
  location: "bucket",
  enabled: true,
  testedAt: old,
  retainedProbe: null,
  schedule,
  nextRunAt: old as string | null,
};
const second = {
  id: "paused",
  name: "Second bucket",
  type: "s3",
  location: "second/fdrive",
  enabled: false,
  testedAt: null,
  retainedProbe: null,
  schedule: null,
  nextRunAt: old as string | null,
};
function data(): BackupsResponse {
  return {
    enabled: true,
    owner: true,
    installationId: uuid,
    keyConfirmed: true,
    recipient: "age-key",
    schedule,
    nextRunAt: null,
    restored: false,
    workerSeenAt: new Date().toISOString(),
    destinations: [],
    runs: [],
  };
}
/** A passed rehearsal of the complete run, recent enough to count. */
function rehearsal() {
  return {
    sourceInstallationId: uuid,
    snapshotId: uuid,
    completedAt: new Date().toISOString(),
    migrations: [],
    tableCount: 29,
    blobCount: 1,
    result: "passed" as const,
  };
}
/**
 * The newest attempt was partial because the bucket refused it, an older backup is complete,
 * both schedules are long overdue, and the worker has gone quiet.
 */
function troubled(): BackupsResponse {
  const state = data();
  state.runs = [
    {
      ...run,
      id: "failed",
      state: "partial",
      deliveries: run.deliveries.map((delivery) => ({
        ...delivery,
        state: "failed" as const,
        error: "Credential expired",
      })),
    },
    run,
  ];
  state.nextRunAt = old;
  state.destinations = [bucket, second];
  state.workerSeenAt = old;
  return state;
}
function stat(label: string): string | null | undefined {
  return screen.getByText(label).closest('[data-slot="stat"]')?.textContent;
}
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it("judges each destination on its own, so another full copy never hides a failure", () => {
  const state = troubled();
  const now = Date.now();
  const failed = destinationStatus(state, bucket, now);
  expect(failed).toMatchObject({
    error: "Credential expired",
    overdue: true,
    tone: "danger",
    label: "Failed",
  });
  // The older complete backup is still this destination's last full copy.
  expect(failed.delivered?.id).toBe(uuid);
  // A paused destination is neither overdue nor judged by copies it never received.
  expect(destinationStatus(state, second, now)).toEqual({
    delivered: undefined,
    error: null,
    overdue: false,
    tone: "off",
    label: "Paused",
  });
  state.runs = [run];
  expect(destinationStatus(state, bucket, now)).toMatchObject({
    error: null,
    overdue: true,
    tone: "warning",
    label: "Needs attention",
  });
  expect(destinationStatus(state, { ...bucket, nextRunAt: null }, now)).toMatchObject({
    overdue: false,
    tone: "success",
    label: "Healthy",
  });
  state.runs = [];
  expect(destinationStatus(state, { ...bucket, nextRunAt: null }, now)).toMatchObject({
    delivered: undefined,
    tone: "neutral",
    label: "No copy yet",
  });
});
it("sums the page up as one verdict and lists every reason behind it", () => {
  const state = troubled();
  const attention = backupHealth(state, Date.now());
  expect(attention).toMatchObject({ tone: "warning", label: "Needs attention", rehearsed: false });
  expect(attention.notices).toEqual([
    expect.stringMatching(/worker has not checked/),
    expect.stringMatching(/latest attempt did not complete/),
    "The installation schedule is overdue by more than 15 minutes.",
    "Bucket is overdue by more than 15 minutes.",
    expect.stringMatching(/^Restore rehearsal due:/),
  ]);
  // Only a newest attempt that failed outright turns the verdict to Failed.
  state.runs = [{ ...run, id: "failed", state: "failed" }, run];
  expect(backupHealth(state, Date.now())).toMatchObject({ tone: "danger", label: "Failed" });
  const healthy = data();
  healthy.runs = [run];
  healthy.rehearsal = rehearsal();
  expect(backupHealth(healthy, Date.now())).toEqual({
    tone: "success",
    label: "Healthy",
    notices: [],
    rehearsed: true,
  });
  // A rehearsal older than 30 days no longer counts, and a worker never seen is a notice too.
  healthy.rehearsal.completedAt = old;
  healthy.workerSeenAt = null;
  expect(backupHealth(healthy, Date.now())).toMatchObject({
    label: "Needs attention",
    rehearsed: false,
    notices: [
      expect.stringMatching(/worker has not checked/),
      expect.stringMatching(/^Restore rehearsal due:/),
    ],
  });
});
it("raises a disabled worker, an unconfirmed key, a restored installation and low space", () => {
  const state = data();
  state.enabled = false;
  state.keyConfirmed = false;
  state.restored = true;
  state.rehearsal = rehearsal();
  state.estimate = {
    id: uuid,
    state: "complete",
    error: null,
    result: {
      estimatedAt: old,
      databaseBytes: "1024",
      recoveryBytes: "2048",
      uncompressedBytes: "3072",
      retainedBytes: "9999",
      transferAndReadbackBytes: "6144",
      availableSpoolBytes: "2048",
      coverage: [],
    },
  };
  expect(backupHealth(state, Date.now()).notices).toEqual([
    "Backup worker is disabled in this deployment.",
    expect.stringMatching(/^Confirm your recovery key/),
    "This restored installation is paused for recovery review.",
    expect.stringMatching(/less than twice the size of one backup/),
  ]);
});
it("lists the notices over the headline numbers", () => {
  const state = troubled();
  const view = render(<BackupStatus data={state} />);
  const notices = screen.getByRole("list", { name: "Backup health notices" });
  expect(within(notices).getAllByRole("listitem")).toHaveLength(5);
  expect(within(notices).getByText(/worker has not checked/)).toBeTruthy();
  expect(within(notices).getByText(/latest attempt did not complete/)).toBeTruthy();
  // How long ago the last complete backup ran is the number; its date sits under it.
  expect(stat("Last complete backup")).toMatch(/\d+d ago/);
  expect(stat("Next backup")).toContain("Due");
  expect(stat("Backups kept")).toBe("Backups kept2");
  expect(stat("Destinations")).toBe("Destinations21 paused");
  // Nothing to report: no list at all, and the numbers say what is missing.
  const quiet = data();
  quiet.rehearsal = rehearsal();
  view.rerender(<BackupStatus data={quiet} />);
  expect(screen.queryByLabelText("Backup health notices")).toBeNull();
  expect(stat("Last complete backup")).toContain("Never");
  expect(stat("Next backup")).toContain("Automatic backups are off");
  expect(stat("Destinations")).toBe("Destinations0");
  quiet.nextRunAt = new Date(Date.now() + 3 * 3_600_000 + 60_000).toISOString();
  view.rerender(<BackupStatus data={quiet} />);
  expect(stat("Next backup")).toContain("in 3h");
});
it("requests an estimate and reports each size with what it stands for", async () => {
  const state = data();
  const result = {
    estimatedAt: old,
    databaseBytes: "1024",
    recoveryBytes: "2048",
    uncompressedBytes: "3072",
    retainedBytes: "9999",
    transferAndReadbackBytes: "6144",
    availableSpoolBytes: "2048",
    coverage: ["OCR source missing"],
  };
  state.estimate = { id: uuid, state: "complete", error: null, result };
  const act = vi.fn<Act>(async (work) => {
    await work();
  });
  const view = render(<StorageEstimate data={state} busy={false} unlocked act={act} />);
  expect(screen.getByText(/^3 full backups kept in total/)).toBeTruthy();
  expect(screen.getByText("OCR source missing")).toBeTruthy();
  expect(screen.getByText(/^Estimated /)).toBeTruthy();
  // A row is the size's name and what it stands for, with the size at its end.
  const database = screen.getByText("Database").closest('[data-slot="setting-row"]');
  expect(database?.textContent).toMatch(/^DatabaseAccounts, settings.*1\.0 KB$/);
  fireEvent.click(screen.getByRole("button", { name: "Estimate backup size" }));
  await waitFor(() => expect(client.estimate).toHaveBeenCalledOnce());
  // No retained copies to multiply by.
  state.estimate = {
    id: uuid,
    state: "complete",
    error: null,
    result: { ...result, uncompressedBytes: "0" },
  };
  view.rerender(<StorageEstimate data={state} busy={false} unlocked act={act} />);
  expect(screen.getByText("No enabled destination keeps remote copies.")).toBeTruthy();
});
it("disables a pending estimate and shows why one failed", () => {
  const state = data();
  state.estimate = { id: uuid, state: "pending", error: null, result: null };
  const act: Act = async (work) => {
    await work();
  };
  const view = render(<StorageEstimate data={state} busy={false} unlocked act={act} />);
  expect(screen.getByRole("button", { name: "Estimating…" })).toHaveProperty("disabled", true);
  expect(screen.queryByText(/^Estimated /)).toBeNull();
  state.estimate = { id: uuid, state: "failed", error: "Estimate unavailable", result: null };
  view.rerender(<StorageEstimate data={state} busy unlocked={false} act={act} />);
  expect(screen.getByRole("alert").textContent).toBe("Estimate unavailable");
  expect(screen.getByRole("button", { name: "Estimate backup size" })).toHaveProperty(
    "disabled",
    true,
  );
});
it("shows the last rehearsal and records a validated owner report", async () => {
  const state = data();
  const report = rehearsal();
  state.rehearsal = report;
  const act = vi.fn<Act>(async (work) => {
    await work();
  });
  const view = render(<RestoreRehearsal data={state} busy={false} unlocked act={act} />);
  const facts = screen.getByText("Last successful rehearsal").closest("dl");
  expect(facts?.textContent).toContain("29 tables · 1 recovery files");
  // The rehearsed backup is gone from the list, so only its ID is left to show.
  expect(screen.getByText("Snapshot").nextElementSibling?.textContent).toBe(uuid);
  expect(screen.getByText(/backup rehearse/).textContent).toContain("--snapshot SNAPSHOT_ID");
  const input = screen.getByLabelText("Rehearsal report (.json)");
  fireEvent.change(input, {
    target: { files: [{ size: 1000, text: async () => JSON.stringify(report) }] },
  });
  await waitFor(() => expect(client.recordRehearsal).toHaveBeenCalledWith(report));
  fireEvent.change(input, { target: { files: [] } });
  const errors: string[] = [];
  view.rerender(
    <RestoreRehearsal
      data={state}
      busy={false}
      unlocked
      act={async (work) => {
        try {
          await work();
        } catch (error) {
          errors.push(String(error));
        }
      }}
    />,
  );
  fireEvent.change(input, { target: { files: [{ size: 65537 }] } });
  await waitFor(() => expect(errors[0]).toContain("smaller than 64 KiB"));
  fireEvent.change(input, { target: { files: [{ size: 1, text: async () => "invalid" }] } });
  await waitFor(() => expect(errors).toHaveLength(2));
});
it("fills the rehearsal command in for the latest complete backup", () => {
  const state = data();
  const act: Act = async () => {};
  const view = render(<RestoreRehearsal data={state} busy unlocked={false} act={act} />);
  expect(screen.getByText(/No backup has been test-restored yet/)).toBeTruthy();
  expect(screen.queryByText("Last successful rehearsal")).toBeNull();
  expect(screen.getByLabelText("Rehearsal report (.json)")).toHaveProperty("disabled", true);
  state.runs = [run];
  state.rehearsal = rehearsal();
  view.rerender(<RestoreRehearsal data={state} busy unlocked={false} act={act} />);
  expect(screen.getByText(/backup rehearse/).textContent).toContain(`--snapshot ${uuid}`);
  // The rehearsed backup is still kept, so the fact says when it was taken.
  expect(screen.getByText("Snapshot").nextElementSibling?.textContent).toMatch(
    new RegExp(`^from .+ · ${uuid}$`),
  );
});
