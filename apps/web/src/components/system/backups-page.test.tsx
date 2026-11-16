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
    actions,
    title,
  }: {
    children: ReactNode;
    actions: ReactNode;
    title: string;
  }) => (
    <main>
      <h1>{title}</h1>
      {actions}
      {children}
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
async function unlock() {
  fireEvent.change(screen.getByLabelText("Current password"), {
    target: { value: "owner-password" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Unlock backups" }));
  await screen.findByText("Backup controls unlocked.");
}
it("requires fresh owner authentication before preparing a local or remote backup", async () => {
  render(<BackupsPage />);
  expect(screen.getByRole("button", { name: "Back up now" })).toHaveProperty("disabled", true);
  await unlock();
  expect(mocks.client.unlock).toHaveBeenCalledWith("owner-password");
  fireEvent.click(screen.getByRole("button", { name: "Back up now" }));
  await waitFor(() =>
    expect(mocks.client.create).toHaveBeenCalledWith({ destinationIds: [], metadataOnly: false }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Prepare local download" }));
  await waitFor(() => expect(mocks.client.create).toHaveBeenCalledTimes(2));
  fireEvent.click(screen.getByRole("button", { name: "Database only" }));
  await screen.findByRole("alertdialog");
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  await waitFor(() =>
    expect(mocks.client.create).toHaveBeenLastCalledWith({
      destinationIds: [],
      metadataOnly: true,
    }),
  );
});
it("shows a test object kept by bucket retention with its deadline", () => {
  state.destinations = [
    {
      id: "f9c0b4ba-7b67-4e2f-abf3-08d1a0e6d652",
      name: "Bucket",
      type: "s3",
      location: "bucket/fdrive",
      enabled: true,
      testedAt: null,
      schedule: null,
      nextRunAt: null,
      retainedProbe: { name: "probe-kept", retentionUntil: "2030-01-01T00:00:00.000Z" },
    },
  ];
  render(<BackupsPage />);
  expect(screen.getByText(/Bucket retention keeps the test object probe-kept until/)).toBeTruthy();
});
it("reports destination test results and when each destination was last tested", async () => {
  const destination = {
    id: "f9c0b4ba-7b67-4e2f-abf3-08d1a0e6d652",
    name: "Bucket",
    type: "s3",
    location: "bucket/fdrive",
    enabled: true,
    testedAt: null,
    schedule: null,
    nextRunAt: null,
    retainedProbe: null,
  };
  state.destinations = [
    destination,
    { ...destination, id: "other", name: "Tested", testedAt: "2026-09-14T08:00:00.000Z" },
  ];
  render(<BackupsPage />);
  expect(screen.getByText("Not tested yet")).not.toBeNull();
  expect(screen.getByText(/Last tested:/)).not.toBeNull();
  await unlock();
  const [test] = screen.getAllByRole("button", { name: "Test" });
  if (!test) throw Error("Test button missing");
  fireEvent.click(test);
  await waitFor(() =>
    expect(mocks.toast.success).toHaveBeenCalledWith("Bucket passed the test", expect.anything()),
  );
  expect(mocks.client.testDestination).toHaveBeenCalledWith(destination.id);
  expect(mocks.invalidate).toHaveBeenCalledWith({ queryKey: ["backups"] });
  mocks.client.testDestination.mockRejectedValueOnce(new Error("Access denied"));
  fireEvent.click(test);
  await waitFor(() =>
    expect(mocks.toast.error).toHaveBeenCalledWith("Bucket failed the test", {
      description: "Access denied",
    }),
  );
  expect(screen.getByRole("alert").textContent).toContain("Access denied");
});
it("explains the destination schedule and saves a separate policy inside its card", async () => {
  state.destinations = [
    {
      id: "f9c0b4ba-7b67-4e2f-abf3-08d1a0e6d652",
      name: "Bucket",
      type: "s3",
      location: "bucket/fdrive",
      enabled: true,
      testedAt: null,
      schedule: null,
      nextRunAt: null,
      retainedProbe: null,
    },
  ];
  render(<BackupsPage />);
  expect(screen.getByText("Unlock owner access below to back up now")).toBeTruthy();
  expect(screen.getByText("Installation schedule: Manual only")).toBeTruthy();
  await unlock();
  expect(screen.queryByText(/to back up now$/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Edit schedule" }));
  const form = screen.getByRole("form", { name: "Schedule for Bucket" });
  expect(form.textContent).toContain("Manual only, keeps 7 daily, 4 weekly and 12 monthly backups");
  fireEvent.click(screen.getByRole("radio", { name: "A separate schedule for this destination" }));
  expect(form.textContent).toContain("There is no monthly schedule");
  fireEvent.change(within(form).getByLabelText("Monthly backups"), {
    target: { value: "24" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save destination schedule" }));
  await waitFor(() =>
    expect(mocks.client.destinationSchedule).toHaveBeenCalledWith(
      "f9c0b4ba-7b67-4e2f-abf3-08d1a0e6d652",
      { ...schedule, monthly: 24 },
    ),
  );
});
it("creates a private recovery kit and confirms the key without submitting it to backup settings", async () => {
  state.keyConfirmed = false;
  render(<BackupsPage />);
  await unlock();
  fireEvent.click(screen.getByRole("button", { name: "Create and download recovery key" }));
  await screen.findByLabelText("Paste the saved recovery key to confirm");
  expect(mocks.client.key).toHaveBeenCalledWith("age-public");
  fireEvent.change(screen.getByLabelText("Paste the saved recovery key to confirm"), {
    target: { value: "AGE-SECRET-KEY-test" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Confirm saved key" }));
  await waitFor(() => expect(mocks.client.confirm).toHaveBeenCalledWith("proof"));
});
it("adds a bucket as the only kind of destination and offers no configuration ZIPs", async () => {
  render(<BackupsPage />);
  await unlock();
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
  const form = screen.getByRole("button", { name: "Test and save" }).closest("form");
  if (!form) throw Error("Destination form missing");
  fireEvent.submit(form);
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
});
it("saves schedules and shows failure states without claiming restore verification", async () => {
  state.runs = [
    {
      id: "run",
      createdAt: "2026-09-14Z",
      completedAt: null,
      state: "partial",
      bytes: "1024",
      sha256: null,
      error: "Bucket unavailable",
      pinned: false,
      coverage: ["OCR source missing"],
      downloadable: true,
      verifiedAt: null,
      verificationRequested: false,
      verificationError: null,
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
  expect(screen.getByText("OCR source missing")).not.toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry destinations" }));
  await waitFor(() => expect(mocks.client.retry).toHaveBeenCalledWith("run"));
  fireEvent.click(screen.getByRole("button", { name: "Verify bytes" }));
  await waitFor(() => expect(mocks.client.verify).toHaveBeenCalledWith("run"));
  fireEvent.change(screen.getByLabelText("Timezone"), { target: { value: "Europe/Stockholm" } });
  fireEvent.click(screen.getByRole("button", { name: "Save schedule" }));
  await waitFor(() =>
    expect(mocks.client.schedule).toHaveBeenCalledWith({
      ...schedule,
      timezone: "Europe/Stockholm",
    }),
  );
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
});
it("renders loading and owner-only failures", () => {
  mocks.query.mockReturnValue({ isPending: true, data: null, error: null, dataUpdatedAt: 0 });
  const page = render(<BackupsPage />);
  expect(screen.getByRole("status")).toHaveProperty(
    "textContent",
    expect.stringContaining("Loading backups"),
  );
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
