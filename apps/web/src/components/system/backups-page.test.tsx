// @vitest-environment jsdom
import { ApiClientError, type BackupsResponse } from "@fdrive/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  invalidate: vi.fn(),
  client: {
    estimate: vi.fn(),
    recordRehearsal: vi.fn(),
    unlock: vi.fn(),
    key: vi.fn(),
    confirm: vi.fn(),
    create: vi.fn(),
    downloadUrl: vi.fn(),
    destination: vi.fn(),
    testDestination: vi.fn(),
    removeDestination: vi.fn(),
    destinationSchedule: vi.fn(),
    schedule: vi.fn(),
    pin: vi.fn(),
    remove: vi.fn(),
    cancel: vi.fn(),
    retry: vi.fn(),
    verify: vi.fn(),
  },
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("@/lib/api/backup-queries", () => ({
  useBackups: () => mocks.query(),
  backupClient: mocks.client,
  backupQueryKey: ["backups"],
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: mocks.invalidate }),
}));
vi.mock("@/lib/api/auth-queries", () => ({
  useMe: () => ({
    data: { identity: { id: "identity", username: "owner" } },
  }),
}));
vi.mock("./system-page", () => ({
  SystemPage: ({
    children,
    badges,
    actions,
    footer,
    title,
  }: {
    children: ReactNode;
    badges?: ReactNode;
    actions?: ReactNode;
    footer?: ReactNode;
    title: string;
  }) => (
    <main>
      <h1>{title}</h1>
      <div data-testid="badges">{badges}</div>
      <div data-testid="actions">{actions}</div>
      {children}
      <footer data-testid="footer">{footer}</footer>
    </main>
  ),
}));
vi.mock("age-encryption", () => ({
  generateIdentity: async () => "AGE-SECRET-KEY-test",
  identityToRecipient: async () => "age-public",
  Decrypter: class {
    addIdentity() {}
    async decrypt() {
      return "proof";
    }
  },
}));
const { BackupsPage } = await import("./backups-page");
const schedule = {
  frequency: "manual" as const,
  timezone: "UTC",
  hour: 3,
  daily: 7,
  weekly: 4,
  monthly: 12,
};
function data(): BackupsResponse {
  return {
    enabled: true,
    owner: true,
    installationId: "install",
    recipient: "age-public",
    keyConfirmed: true,
    schedule,
    nextRunAt: null,
    restored: false,
    destinations: [],
    runs: [],
  };
}
let state: BackupsResponse;
beforeEach(() => {
  vi.clearAllMocks();
  state = data();
  mocks.query.mockImplementation(() => ({
    data: state,
    isPending: false,
    error: null,
    dataUpdatedAt: 0,
  }));
  mocks.client.key.mockResolvedValue({ challenge: btoa("encrypted") });
  mocks.client.downloadUrl.mockReturnValue("/backup");
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => "blob:test"),
  });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const BUCKET_ID = "f9c0b4ba-7b67-4e2f-abf3-08d1a0e6d652";
function bucket(): BackupsResponse["destinations"][number] {
  return {
    id: BUCKET_ID,
    name: "Bucket",
    type: "s3",
    location: "bucket/fdrive",
    enabled: true,
    testedAt: null,
    schedule: null,
    nextRunAt: null,
    retainedProbe: null,
  };
}
function backup(): BackupsResponse["runs"][number] {
  return {
    id: "run",
    createdAt: "2026-09-14T00:00:00.000Z",
    completedAt: "2026-09-14T00:05:00.000Z",
    state: "complete",
    bytes: "1024",
    sha256: null,
    error: null,
    pinned: false,
    coverage: [],
    downloadable: true,
    verifiedAt: null,
    verificationRequested: false,
    verificationError: null,
    deliveries: [],
  };
}
async function unlock() {
  fireEvent.change(screen.getByLabelText("Current password"), {
    target: { value: "owner-password" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Unlock backups" }));
  await screen.findByText("Unlocked");
}
/** The sheet is split into tabs; everything but the header and footer sits on one of them. */
function openTab(name: "Overview" | "Destinations" | "History" | "Recovery") {
  fireEvent.click(
    within(screen.getByRole("group", { name: "Backup sections" })).getByRole("button", { name }),
  );
}
/** Opens the menu at the end of a table row and picks `item`. */
async function rowAction(row: string | RegExp, item: string) {
  fireEvent.click(await screen.findByRole("button", { name: row }));
  fireEvent.click(await screen.findByRole("menuitem", { name: item }));
}
const RUN_MENU = /^Actions for the backup from /;
it("carries health, the lock and the one action in the sheet's header, and restore in its footer", () => {
  const view = render(<BackupsPage />);
  const badges = within(screen.getByTestId("badges"));
  // No worker heartbeat and no rehearsal yet.
  expect(badges.getByText("Needs attention").dataset.tone).toBe("warning");
  expect(badges.getByText("Locked").dataset.tone).toBe("off");
  expect(badges.queryByText("Last rehearsal passed")).toBeNull();
  const actions = within(screen.getByTestId("actions")).getAllByRole("button");
  expect(actions.map((button) => button.textContent)).toEqual(["Back up now"]);
  const footer = within(screen.getByTestId("footer"));
  expect(footer.getByText(/The files folder needs its own backup/)).toBeTruthy();
  expect(footer.getByText("Open restore").getAttribute("href")).toBe("/restore");
  state.workerSeenAt = new Date().toISOString();
  state.runs = [backup()];
  state.rehearsal = {
    sourceInstallationId: BUCKET_ID,
    snapshotId: BUCKET_ID,
    completedAt: new Date().toISOString(),
    migrations: [],
    tableCount: 29,
    blobCount: 0,
    result: "passed",
  };
  view.rerender(<BackupsPage />);
  expect(badges.getByText("Healthy").dataset.tone).toBe("success");
  expect(badges.getByText("Last rehearsal passed").dataset.tone).toBe("neutral");
  state.runs = [{ ...backup(), state: "failed" }];
  view.rerender(<BackupsPage />);
  expect(badges.getByText("Failed").dataset.tone).toBe("danger");
});
it("requires fresh owner authentication before preparing a local or remote backup", async () => {
  render(<BackupsPage />);
  expect(screen.getByRole("button", { name: "Back up now" })).toHaveProperty("disabled", true);
  // Why it is disabled sits right under the header until the owner unlocks.
  expect(screen.getByText(/^Confirm your password to back up now/)).toBeTruthy();
  await unlock();
  expect(mocks.client.unlock).toHaveBeenCalledWith("owner-password");
  expect(screen.queryByText(/^Confirm your password to back up now/)).toBeNull();
  expect(screen.queryByText("Locked")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Back up now" }));
  await waitFor(() =>
    expect(mocks.client.create).toHaveBeenCalledWith({ destinationIds: [], metadataOnly: false }),
  );
  openTab("History");
  fireEvent.click(screen.getByRole("button", { name: "Prepare local download" }));
  await waitFor(() => expect(mocks.client.create).toHaveBeenCalledTimes(2));
  fireEvent.click(screen.getByRole("button", { name: "Prepare database-only download" }));
  const dialog = await screen.findByRole("alertdialog");
  expect(within(dialog).getByText(/Recovery files are excluded/)).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Create backup" }));
  await waitFor(() =>
    expect(mocks.client.create).toHaveBeenLastCalledWith({
      destinationIds: [],
      metadataOnly: true,
    }),
  );
});
it("backs up to the enabled destinations only", async () => {
  state.destinations = [bucket(), { ...bucket(), id: "paused", name: "Paused", enabled: false }];
  render(<BackupsPage />);
  await unlock();
  fireEvent.click(screen.getByRole("button", { name: "Back up now" }));
  await waitFor(() =>
    expect(mocks.client.create).toHaveBeenCalledWith({
      destinationIds: [BUCKET_ID],
      metadataOnly: false,
    }),
  );
});
it("shows a test object kept by bucket retention with its deadline", () => {
  state.destinations = [
    {
      ...bucket(),
      retainedProbe: { name: "probe-kept", retentionUntil: "2030-01-01T00:00:00.000Z" },
    },
  ];
  render(<BackupsPage />);
  openTab("Destinations");
  expect(screen.getByText(/Bucket retention keeps the test object probe-kept until/)).toBeTruthy();
});
it("reports destination test results and when each destination was last tested", async () => {
  const destination = bucket();
  state.destinations = [
    destination,
    { ...destination, id: "other", name: "Tested", testedAt: "2026-09-14T08:00:00.000Z" },
  ];
  render(<BackupsPage />);
  openTab("Destinations");
  const untested = screen.getByText("Bucket").closest("tr") as HTMLElement;
  expect(within(untested).getByText("Not tested yet")).not.toBeNull();
  // Nothing was copied there yet, so the row does not claim to be healthy.
  expect(within(untested).getByText("None yet")).not.toBeNull();
  expect(within(untested).getByText("No copy yet").dataset.tone).toBe("neutral");
  const tested = screen.getByText("Tested").closest("tr") as HTMLElement;
  expect(within(tested).getByText(/^Last tested: /)).not.toBeNull();
  // Locked: a row's actions wait for the owner's password.
  expect(screen.getByRole("button", { name: "Actions for Bucket" })).toHaveProperty(
    "disabled",
    true,
  );
  await unlock();
  await rowAction("Actions for Bucket", "Test");
  await waitFor(() =>
    expect(mocks.toast.success).toHaveBeenCalledWith("Bucket passed the test", expect.anything()),
  );
  expect(mocks.client.testDestination).toHaveBeenCalledWith(destination.id);
  expect(mocks.invalidate).toHaveBeenCalledWith({ queryKey: ["backups"] });
  mocks.client.testDestination.mockRejectedValueOnce(new Error("Access denied"));
  await rowAction("Actions for Bucket", "Test");
  await waitFor(() =>
    expect(mocks.toast.error).toHaveBeenCalledWith("Bucket failed the test", {
      description: "Access denied",
    }),
  );
  expect(screen.getByRole("alert").textContent).toContain("Access denied");
});
it("shows a destination's own failure, schedule and pause in its row", () => {
  const late = "2020-01-01T00:00:00.000Z";
  state.destinations = [
    { ...bucket(), schedule: { ...schedule, frequency: "hourly" }, nextRunAt: late },
    { ...bucket(), id: "paused", name: "Second bucket", enabled: false },
  ];
  state.runs = [
    {
      ...backup(),
      state: "partial",
      deliveries: [
        {
          destinationId: BUCKET_ID,
          name: "Bucket",
          state: "failed",
          error: "Credential expired",
          verifiedAt: null,
        },
      ],
    },
  ];
  render(<BackupsPage />);
  openTab("Destinations");
  const failed = screen.getByText("Bucket").closest("tr") as HTMLElement;
  expect(within(failed).getByText("Failed").dataset.tone).toBe("danger");
  expect(within(failed).getByText("Credential expired")).toBeTruthy();
  expect(within(failed).getByText("Delivery overdue by more than 15 minutes.")).toBeTruthy();
  expect(within(failed).getByText("Own schedule: Every hour")).toBeTruthy();
  expect(within(failed).getByText(/^Next /)).toBeTruthy();
  const paused = screen.getByText("Second bucket").closest("tr") as HTMLElement;
  expect(within(paused).getByText("Paused").dataset.tone).toBe("off");
  expect(within(paused).queryByText("Credential expired")).toBeNull();
});
it("explains the destination schedule and saves a separate policy in place of the list", async () => {
  state.destinations = [bucket()];
  render(<BackupsPage />);
  openTab("Destinations");
  expect(screen.getByText("Installation schedule: Manual only")).toBeTruthy();
  await unlock();
  await rowAction("Actions for Bucket", "Edit schedule");
  const form = screen.getByRole("form", { name: "Schedule for Bucket" });
  // The list makes way for the form until it is saved or cancelled.
  expect(screen.queryByRole("table")).toBeNull();
  expect(form.textContent).toContain("Manual only, keeps 7 daily, 4 weekly and 12 monthly backups");
  expect(within(form).queryByLabelText("Monthly backups")).toBeNull();
  fireEvent.click(within(form).getByRole("button", { name: "Own schedule" }));
  expect(form.textContent).toContain("There is no monthly schedule");
  fireEvent.change(within(form).getByLabelText("Monthly backups"), {
    target: { value: "24" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save destination schedule" }));
  await waitFor(() =>
    expect(mocks.client.destinationSchedule).toHaveBeenCalledWith(BUCKET_ID, {
      ...schedule,
      monthly: 24,
    }),
  );
  expect(await screen.findByText("Installation schedule: Manual only")).toBeTruthy();
  // Back on the installation schedule, and cancelling changes nothing.
  await rowAction("Actions for Bucket", "Edit schedule");
  fireEvent.click(screen.getByRole("button", { name: "Save destination schedule" }));
  await waitFor(() =>
    expect(mocks.client.destinationSchedule).toHaveBeenLastCalledWith(BUCKET_ID, null),
  );
  await screen.findByRole("table");
  await rowAction("Actions for Bucket", "Edit schedule");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("form", { name: "Schedule for Bucket" })).toBeNull();
  expect(mocks.client.destinationSchedule).toHaveBeenCalledTimes(2);
});
it("creates a private recovery kit and confirms the key without submitting it to backup settings", async () => {
  state.keyConfirmed = false;
  render(<BackupsPage />);
  await unlock();
  openTab("Recovery");
  fireEvent.click(screen.getByRole("button", { name: "Create and download recovery key" }));
  await screen.findByLabelText("Paste the saved recovery key to confirm");
  expect(mocks.client.key).toHaveBeenCalledWith("age-public");
  // The pasted key survives a look at another tab.
  fireEvent.change(screen.getByLabelText("Paste the saved recovery key to confirm"), {
    target: { value: "AGE-SECRET-KEY-test" },
  });
  openTab("Overview");
  openTab("Recovery");
  fireEvent.click(screen.getByRole("button", { name: "Confirm saved key" }));
  await waitFor(() => expect(mocks.client.confirm).toHaveBeenCalledWith("proof"));
});
it("shows a confirmed key and asks before rotating it", async () => {
  render(<BackupsPage />);
  await unlock();
  openTab("Recovery");
  expect(screen.getByText("Confirmed").dataset.tone).toBe("success");
  expect(screen.getByText("age-public")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Rotate recovery key" }));
  const dialog = await screen.findByRole("alertdialog");
  expect(within(dialog).getByText(/Keep every old recovery key/)).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Rotate recovery key" }));
  expect(await screen.findByText("Create and download recovery key")).toBeTruthy();
  expect(screen.queryByText("Confirmed")).toBeNull();
});
it("adds a bucket as the only kind of destination and offers no configuration ZIPs", async () => {
  render(<BackupsPage />);
  await unlock();
  openTab("Destinations");
  expect(screen.getByText(/^No remote destinations/)).toBeTruthy();
  expect(screen.queryByText("Additional configuration files")).toBeNull();
  expect(screen.queryByLabelText("Configuration ZIP")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Add destination" }));
  expect(screen.queryByLabelText("Destination type")).toBeNull();
  expect(screen.queryByLabelText("Private backup directory")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Backblaze B2" }));
  for (const [label, value] of [
    ["Name", "Offsite"],
    ["Bucket", "private-backups"],
    ["Access key ID", "key-id"],
    ["Secret access key", "secret-key"],
  ] as const)
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  fireEvent.submit(screen.getByRole("form", { name: "New destination" }));
  await waitFor(() =>
    expect(mocks.client.destination).toHaveBeenCalledWith({
      type: "s3",
      name: "Offsite",
      endpoint: "https://s3.us-west-004.backblazeb2.com",
      region: "us-west-004",
      bucket: "private-backups",
      prefix: "fdrive-backups",
      pathStyle: false,
      accessKeyId: "key-id",
      secretAccessKey: "secret-key",
    }),
  );
  // Saved: the form makes way for the list again.
  expect(await screen.findByText(/^No remote destinations/)).toBeTruthy();
  expect(screen.queryByRole("form", { name: "New destination" })).toBeNull();
});
it("cancels a new destination, and sends path-style addressing when it is switched on", async () => {
  render(<BackupsPage />);
  await unlock();
  openTab("Destinations");
  fireEvent.click(screen.getByRole("button", { name: "Add destination" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("form", { name: "New destination" })).toBeNull();
  expect(mocks.client.destination).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Add destination" }));
  fireEvent.click(screen.getByRole("button", { name: "Backblaze B2" }));
  fireEvent.click(screen.getByRole("button", { name: "AWS S3" }));
  fireEvent.click(screen.getByRole("switch", { name: "Use path-style addressing" }));
  for (const [label, value] of [
    ["Name", "MinIO"],
    ["Bucket", "backups"],
    ["Key prefix", "fdrive"],
    ["Access key ID", "key-id"],
    ["Secret access key", "secret-key"],
  ] as const)
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  fireEvent.submit(screen.getByRole("form", { name: "New destination" }));
  await waitFor(() =>
    expect(mocks.client.destination).toHaveBeenCalledWith({
      type: "s3",
      name: "MinIO",
      endpoint: "https://s3.amazonaws.com",
      region: "us-east-1",
      bucket: "backups",
      prefix: "fdrive",
      pathStyle: true,
      accessKeyId: "key-id",
      secretAccessKey: "secret-key",
    }),
  );
});
it("saves schedules and shows failure states without claiming restore verification", async () => {
  state.runs = [
    {
      ...backup(),
      completedAt: null,
      state: "partial",
      error: "Bucket unavailable",
      coverage: ["OCR source missing"],
      deliveries: [
        {
          destinationId: "dest",
          name: "Offsite",
          state: "failed",
          error: "Could not connect",
          verifiedAt: null,
        },
      ],
    },
  ];
  render(<BackupsPage />);
  await unlock();
  openTab("History");
  const row = screen.getByText("OCR source missing").closest("tr") as HTMLElement;
  expect(within(row).getByText("Partial").dataset.tone).toBe("warning");
  expect(within(row).getByText("Bucket unavailable")).not.toBeNull();
  expect(within(row).getByText("Offsite: failed — Could not connect")).not.toBeNull();
  expect(within(row).queryByText(/Bytes verified/)).toBeNull();
  expect(within(row).getByLabelText("Download backup").getAttribute("href")).toBe("/backup");
  await rowAction(RUN_MENU, "Retry destinations");
  await waitFor(() => expect(mocks.client.retry).toHaveBeenCalledWith("run"));
  await rowAction(RUN_MENU, "Verify bytes");
  await waitFor(() => expect(mocks.client.verify).toHaveBeenCalledWith("run"));
  openTab("Overview");
  fireEvent.change(screen.getByLabelText("Timezone"), { target: { value: "Europe/Stockholm" } });
  fireEvent.click(screen.getByRole("button", { name: "Save schedule" }));
  await waitFor(() =>
    expect(mocks.client.schedule).toHaveBeenCalledWith({
      ...schedule,
      timezone: "Europe/Stockholm",
    }),
  );
});
it("offers Cancel for a running backup, and no deletion for a pinned one", async () => {
  state.runs = [
    {
      ...backup(),
      id: "running",
      createdAt: "2026-09-15T00:00:00.000Z",
      completedAt: null,
      state: "transferring",
      downloadable: false,
    },
    {
      ...backup(),
      id: "kept",
      pinned: true,
      verifiedAt: "2026-09-14T01:00:00.000Z",
      verificationRequested: true,
    },
  ];
  render(<BackupsPage />);
  await unlock();
  openTab("History");
  const [running, kept] = screen.getAllByRole("button", { name: RUN_MENU });
  if (!running || !kept) throw Error("Row menus missing");
  const runningRow = running.closest("tr") as HTMLElement;
  expect(within(runningRow).getByText("Transferring").dataset.tone).toBe("neutral");
  expect(within(runningRow).getByText("Download only")).toBeTruthy();
  expect(within(runningRow).queryByLabelText("Download backup")).toBeNull();
  const keptRow = kept.closest("tr") as HTMLElement;
  expect(within(keptRow).getByText("Complete").dataset.tone).toBe("success");
  expect(within(keptRow).getByText("Pinned")).toBeTruthy();
  expect(within(keptRow).getByText("Verifying")).toBeTruthy();
  expect(within(keptRow).getByText(/^Bytes verified /)).toBeTruthy();
  fireEvent.click(running);
  const cancel = await screen.findByRole("menuitem", { name: "Cancel" });
  expect(screen.queryByRole("menuitem", { name: "Delete backup" })).toBeNull();
  expect(screen.getByRole("menuitem", { name: "Verify bytes" }).getAttribute("aria-disabled")).toBe(
    "true",
  );
  fireEvent.click(cancel);
  await waitFor(() => expect(mocks.client.cancel).toHaveBeenCalledWith("running"));
  fireEvent.click(kept);
  const unpin = await screen.findByRole("menuitem", { name: "Unpin" });
  expect(
    screen.getByRole("menuitem", { name: "Delete backup" }).getAttribute("aria-disabled"),
  ).toBe("true");
  expect(screen.getByRole("menuitem", { name: "Verifying…" }).getAttribute("aria-disabled")).toBe(
    "true",
  );
  fireEvent.click(unpin);
  await waitFor(() => expect(mocks.client.pin).toHaveBeenCalledWith("kept", false));
});
it("asks before removing a destination or deleting a backup", async () => {
  state.destinations = [bucket()];
  state.runs = [backup()];
  render(<BackupsPage />);
  await unlock();
  openTab("Destinations");
  await rowAction("Actions for Bucket", "Remove destination");
  let dialog = await screen.findByRole("alertdialog");
  expect(within(dialog).getByText("Remove Bucket?")).toBeTruthy();
  expect(within(dialog).getByText(/stops copying backups to it/)).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(mocks.client.removeDestination).not.toHaveBeenCalled();
  await rowAction("Actions for Bucket", "Remove destination");
  dialog = await screen.findByRole("alertdialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Remove destination" }));
  await waitFor(() => expect(mocks.client.removeDestination).toHaveBeenCalledWith(BUCKET_ID));
  openTab("History");
  await rowAction(RUN_MENU, "Keep");
  await waitFor(() => expect(mocks.client.pin).toHaveBeenCalledWith("run", true));
  await rowAction(RUN_MENU, "Delete backup");
  dialog = await screen.findByRole("alertdialog");
  expect(within(dialog).getByText(/A copy locked at a destination stays/)).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete backup" }));
  await waitFor(() => expect(mocks.client.remove).toHaveBeenCalledWith("run"));
});
it("returns expired sensitive access to reauthentication and displays request failures", async () => {
  mocks.client.create.mockRejectedValueOnce(
    new ApiClientError("reauth_required", "Confirm password", 401),
  );
  render(<BackupsPage />);
  await unlock();
  fireEvent.click(screen.getByRole("button", { name: "Back up now" }));
  await screen.findByRole("alert");
  expect(screen.getByRole("button", { name: "Unlock backups" })).not.toBeNull();
  expect(screen.getByText("Locked")).toBeTruthy();
});
it("renders loading and owner-only failures", () => {
  mocks.query.mockReturnValue({ isPending: true, data: null, error: null, dataUpdatedAt: 0 });
  const page = render(<BackupsPage />);
  expect(screen.getByRole("status")).toHaveProperty(
    "textContent",
    expect.stringContaining("Loading backups"),
  );
  // Nothing to act on until the page has loaded.
  expect(screen.queryByRole("button", { name: "Back up now" })).toBeNull();
  expect(screen.getByTestId("footer").textContent).toBe("");
  mocks.query.mockReturnValue({
    isPending: false,
    data: null,
    error: Error("Only the installation owner can manage backups"),
    dataUpdatedAt: 0,
  });
  page.rerender(<BackupsPage />);
  expect(screen.getByRole("alert")).toHaveProperty(
    "textContent",
    expect.stringContaining("installation owner"),
  );
});
it("says so calmly when the server refuses backups to this account or has none set up", () => {
  mocks.query.mockReturnValue({
    isPending: false,
    data: null,
    error: new ApiClientError("forbidden", "Only the installation owner can manage backups", 403),
    dataUpdatedAt: 0,
  });
  const page = render(<BackupsPage />);
  expect(within(screen.getByTestId("badges")).getByText("Unavailable").dataset.tone).toBe("off");
  expect(screen.getByText("Backups are not available here")).toBeTruthy();
  expect(screen.getByText("Only the installation owner can manage backups.")).toBeTruthy();
  // A refusal is a state, not a failure, and it leaves nothing to press.
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("group", { name: "Backup sections" })).toBeNull();
  expect(screen.queryByRole("button")).toBeNull();
  mocks.query.mockReturnValue({
    isPending: false,
    data: null,
    error: new ApiClientError(
      "unsupported",
      "Configure persistent backup storage to enable backups",
      501,
    ),
    dataUpdatedAt: 0,
  });
  page.rerender(<BackupsPage />);
  expect(screen.getByText("Configure persistent backup storage to enable backups.")).toBeTruthy();
});
