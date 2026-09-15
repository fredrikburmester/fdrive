// @vitest-environment jsdom
import type { BackupsResponse } from "@fdrive/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const client = vi.hoisted(() => ({ estimate: vi.fn(), recordRehearsal: vi.fn() }));
vi.mock("@/lib/api/backup-queries", () => ({ backupClient: client }));
const { BackupHealth } = await import("./backup-health");
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
    attachments: [],
    runs: [],
  };
}
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it("shows overdue and failed destinations separately from another full copy and requests estimates", async () => {
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
  state.destinations = [
    {
      id: uuid,
      name: "Bucket",
      type: "s3",
      location: "bucket",
      enabled: true,
      testedAt: old,
      retainedProbe: null,
      schedule,
      nextRunAt: old,
    },
    {
      id: "paused",
      name: "Fileserver",
      type: "provider",
      location: "private",
      enabled: false,
      testedAt: null,
      retainedProbe: null,
      schedule: null,
      nextRunAt: null,
    },
  ];
  state.workerSeenAt = old;
  const act = vi.fn(async (work) => work());
  render(<BackupHealth data={state} busy={false} unlocked act={act} />);
  expect(screen.getByText(/Last complete snapshot:/)).toBeTruthy();
  expect(screen.getByText(/Last full delivery:/)).toBeTruthy();
  expect(screen.getByText("Credential expired")).toBeTruthy();
  expect(screen.getByText("Delivery overdue by more than 15 minutes.")).toBeTruthy();
  expect(screen.getByText(/worker has not checked/)).toBeTruthy();
  expect(screen.getByText(/latest attempt did not complete/)).toBeTruthy();
  expect(screen.getByText("Fileserver · paused")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Estimate backup size" }));
  await waitFor(() => expect(client.estimate).toHaveBeenCalledOnce());
});
it("reports estimate capacity, missing sources and a validated owner rehearsal report", async () => {
  const state = data();
  state.enabled = false;
  state.keyConfirmed = false;
  state.restored = true;
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
      coverage: ["OCR source missing"],
    },
  };
  const report = {
    sourceInstallationId: uuid,
    snapshotId: uuid,
    completedAt: new Date().toISOString(),
    migrations: [],
    tableCount: 29,
    blobCount: 1,
    result: "passed" as const,
  };
  state.rehearsal = report;
  const act = vi.fn(async (work) => work());
  const view = render(<BackupHealth data={state} busy={false} unlocked act={act} />);
  expect(screen.getByText(/less than twice the size of one backup/)).toBeTruthy();
  expect(screen.getByText(/^3 full backups kept in total/)).toBeTruthy();
  expect(screen.getByText("OCR source missing")).toBeTruthy();
  expect(screen.getByText(/Last successful rehearsal:/)).toBeTruthy();
  expect(screen.getByText(/backup rehearse/).textContent).toContain("--snapshot SNAPSHOT_ID");
  const input = screen.getByLabelText("Rehearsal report (.json)");
  fireEvent.change(input, {
    target: { files: [{ size: 1000, text: async () => JSON.stringify(report) }] },
  });
  await waitFor(() => expect(client.recordRehearsal).toHaveBeenCalledWith(report));
  fireEvent.change(input, { target: { files: [] } });
  const errors: string[] = [];
  view.rerender(
    <BackupHealth
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
it("disables pending estimates and reminders stop after a recent rehearsal", () => {
  const state = data();
  state.rehearsal = {
    sourceInstallationId: uuid,
    snapshotId: uuid,
    completedAt: new Date().toISOString(),
    migrations: [],
    tableCount: 29,
    blobCount: 0,
    result: "passed",
  };
  state.estimate = { id: uuid, state: "pending", error: null, result: null };
  const view = render(
    <BackupHealth
      data={state}
      busy={false}
      unlocked
      act={async (work) => {
        await work();
      }}
    />,
  );
  expect(screen.getByRole("button", { name: "Estimating…" })).toHaveProperty("disabled", true);
  expect(screen.queryByLabelText("Backup health notices")).toBeNull();
  state.estimate = { id: uuid, state: "failed", error: "Estimate unavailable", result: null };
  state.rehearsal.completedAt = old;
  state.workerSeenAt = null;
  view.rerender(
    <BackupHealth
      data={state}
      busy
      unlocked={false}
      act={async (work) => {
        await work();
      }}
    />,
  );
  expect(screen.getByText("Estimate unavailable")).toBeTruthy();
  expect(screen.getByText(/Restore rehearsal due:/)).toBeTruthy();
  state.runs = [run];
  view.rerender(<BackupHealth data={state} busy unlocked={false} act={async () => {}} />);
  expect(screen.getByText(/backup rehearse/).textContent).toContain(`--snapshot ${uuid}`);
  expect(screen.getByText(/^Snapshot from/)).toBeTruthy();
});
