// @vitest-environment jsdom
import type { EncryptedFolderInfo, TrashEntry } from "@fdrive/contracts";
import * as crypto from "@fdrive/crypto";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "@/lib/api/client";
import { keyStore } from "@/lib/encryption/keys";
import { TrashPage } from "./trash-page";

const report: TrashEntry = {
  id: "trash-1",
  name: "report.txt",
  originalPath: "/docs/report.txt",
  size: 12,
  deletedAt: "2026-01-01T00:00:00Z",
};

const fixtures = vi.hoisted(() => ({
  entries: [] as TrashEntry[],
  restore: vi.fn(),
  restorePending: false,
  restoreConflict: false,
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  retentionDays: 30 as number | undefined,
}));

vi.mock("sonner", () => ({
  toast: { success: fixtures.toastSuccess, error: fixtures.toastError },
}));
vi.mock("@/components/shell/page-header", () => ({ PageHeader: () => null }));
vi.mock("@/components/files/destination-picker", () => ({
  DestinationPicker: (props: {
    open: boolean;
    pending?: boolean;
    onConfirm: (folder: string) => void;
  }) =>
    props.open ? (
      <div role="dialog" aria-label="Restore to">
        <button
          type="button"
          disabled={props.pending}
          onClick={() => props.onConfirm("/elsewhere")}
        >
          {props.pending ? "Restoring…" : "Restore here"}
        </button>
      </div>
    ) : null,
}));
vi.mock("@/lib/api/trash-settings-queries", () => ({
  useTrashSettings: () => ({
    data:
      fixtures.retentionDays === undefined ? undefined : { retentionDays: fixtures.retentionDays },
  }),
}));
vi.mock("@/components/files/empty-state", () => ({ EmptyState: () => null }));
vi.mock("@/components/files/error-state", () => ({ ErrorState: () => null }));
vi.mock("@/lib/trash/queries", () => ({
  isRestoreConflict: () => fixtures.restoreConflict,
  useTrash: () => ({
    data: { entries: fixtures.entries, truncated: false },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
  useTrashRestore: () => ({ mutate: fixtures.restore, isPending: fixtures.restorePending }),
  useTrashPurge: () => ({ mutate: vi.fn(), isPending: false }),
  useTrashEmpty: () => ({ mutate: vi.fn(), isPending: false }),
}));

type RestoreCallbacks = {
  onSuccess: () => void;
  onError: (error: Error) => void;
  onSettled?: () => void;
};

function lastRestoreCallbacks(): RestoreCallbacks {
  const callbacks = fixtures.restore.mock.lastCall?.[1] as RestoreCallbacks | undefined;
  if (callbacks === undefined) {
    throw new Error("restore was not called");
  }
  return callbacks;
}

let client: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function renderPage() {
  return render(<TrashPage />, { wrapper });
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  fixtures.entries = [report];
  fixtures.restorePending = false;
  fixtures.restoreConflict = false;
  fixtures.retentionDays = 30;
});

afterEach(() => {
  cleanup();
  fixtures.restore.mockClear();
  fixtures.toastSuccess.mockClear();
  fixtures.toastError.mockClear();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

it("says when Trash deletes what it holds, once that setting has loaded", () => {
  const view = renderPage();
  expect(
    screen.getByText(
      "Files and folders you delete stay here until you restore them or delete them permanently. Items in Trash are deleted permanently after 30 days.",
    ),
  ).toBeTruthy();
  view.unmount();

  fixtures.retentionDays = undefined;
  renderPage();
  expect(
    screen.getByText(
      "Files and folders you delete stay here until you restore them or delete them permanently.",
    ),
  ).toBeTruthy();
});

function selectReport() {
  fireEvent.click(screen.getByRole("checkbox", { name: "Select report.txt" }));
}

it("uses the global grid default and restores the selected trash item", () => {
  window.localStorage.setItem("fdrive.view", JSON.stringify("grid"));
  renderPage();

  expect(document.querySelector('[data-slot="trash-grid"]')).not.toBeNull();
  fireEvent.click(screen.getByRole("checkbox", { name: "Select all" }));
  expect(screen.getByText("1 selected")).toBeDefined();
  selectReport();
  selectReport();
  const restore = screen.getByRole("button", { name: "Restore" });
  expect(restore).not.toHaveProperty("disabled", true);
  expect(restore.getAttribute("aria-busy")).not.toBe("true");
  fireEvent.click(restore);
  expect(fixtures.restore).toHaveBeenCalledWith(
    { ids: ["trash-1"] },
    expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
  );
});

it("shows a busy indicator on Restore while a toolbar restore is in flight", () => {
  const view = renderPage();
  selectReport();
  fireEvent.click(screen.getByRole("button", { name: "Restore" }));
  fixtures.restorePending = true;
  view.rerender(<TrashPage />);

  const busy = screen.getByRole("button", { name: "Restoring…" });
  expect(busy.hasAttribute("disabled")).toBe(true);
  expect(busy.getAttribute("aria-busy")).toBe("true");
  expect(busy.querySelector("svg.animate-spin")).not.toBeNull();
  expect(screen.queryByRole("button", { name: "Restore" })).toBeNull();
  expect(screen.getByRole("button", { name: "Restore to" }).hasAttribute("disabled")).toBe(true);
  fireEvent.click(busy);
  expect(fixtures.restore).toHaveBeenCalledTimes(1);

  fixtures.restorePending = false;
  view.rerender(<TrashPage />);
  expect(screen.getByRole("button", { name: "Restore" }).getAttribute("aria-busy")).not.toBe(
    "true",
  );
});

it("keeps the Restore to picker open, busy, until the restore succeeds", () => {
  const view = renderPage();
  selectReport();
  fireEvent.click(screen.getByRole("button", { name: "Restore to" }));
  const dialog = screen.getByRole("dialog", { name: "Restore to" });
  fireEvent.click(screen.getByRole("button", { name: "Restore here" }));
  expect(fixtures.restore).toHaveBeenCalledWith(
    { ids: ["trash-1"], target: "/elsewhere/report.txt" },
    expect.objectContaining({ onSettled: expect.any(Function) }),
  );

  fixtures.restorePending = true;
  view.rerender(<TrashPage />);
  expect(screen.getByRole("dialog", { name: "Restore to" })).toBe(dialog);
  expect(screen.getByRole("button", { name: "Restoring…" }).hasAttribute("disabled")).toBe(true);
  // The toolbar is disabled but does not claim the busy state for itself.
  const toolbarRestore = screen.getByRole("button", { name: "Restore" });
  expect(toolbarRestore.hasAttribute("disabled")).toBe(true);
  expect(toolbarRestore.getAttribute("aria-busy")).not.toBe("true");

  const callbacks = lastRestoreCallbacks();
  fixtures.restorePending = false;
  callbacks.onSuccess();
  callbacks.onSettled?.();
  view.rerender(<TrashPage />);
  expect(screen.queryByRole("dialog", { name: "Restore to" })).toBeNull();
  expect(fixtures.toastSuccess).toHaveBeenCalledWith("Restored 1 item.");
});

it("closes the Restore to picker on a conflict and offers it again from the toast", () => {
  fixtures.restoreConflict = true;
  const view = renderPage();
  selectReport();
  fireEvent.click(screen.getByRole("button", { name: "Restore to" }));
  fireEvent.click(screen.getByRole("button", { name: "Restore here" }));

  const callbacks = lastRestoreCallbacks();
  callbacks.onError(new Error("conflict"));
  callbacks.onSettled?.();
  view.rerender(<TrashPage />);
  expect(screen.queryByRole("dialog", { name: "Restore to" })).toBeNull();
  expect(fixtures.toastError).toHaveBeenCalledWith(
    'Could not restore "report.txt": a file already exists at that location.',
    expect.objectContaining({ action: expect.objectContaining({ label: "Restore to" }) }),
  );

  const action = fixtures.toastError.mock.lastCall?.[1].action as { onClick: () => void };
  action.onClick();
  view.rerender(<TrashPage />);
  expect(screen.getByRole("dialog", { name: "Restore to" })).toBeDefined();
});

describe("items from inside an encrypted folder", () => {
  async function encryptedTrash() {
    const account = await crypto.newKeyPair();
    const { marker, folder } = await crypto.createFolder(account.identity);
    const receipts = await crypto.encryptName("Receipts", folder.nameKey, folder.id);
    const taxes = await crypto.encryptName("Taxes 2026.pdf", folder.nameKey, folder.id);
    const parent = `/Private/${receipts}`;
    const entry: TrashEntry = {
      id: "trash-2",
      name: taxes,
      originalPath: `${parent}/${taxes}`,
      size: 2048,
      deletedAt: "2026-01-02T00:00:00Z",
    };
    const info: EncryptedFolderInfo = { path: "/Private", marker };
    vi.spyOn(apiClient, "encryptionStatus").mockResolvedValue({
      enabled: true,
      recipient: account.recipient,
      passwordKey: "AAAA",
      recoveryKey: "AAAA",
      devices: [],
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    fixtures.entries = [report, entry];
    return { account, entry, parent, info, taxes };
  }

  beforeEach(async () => {
    await keyStore.lock();
    await keyStore.refresh({ enabled: false });
  });

  it("shows decrypted names once this browser holds the key, and restores by id", async () => {
    const { account, entry, parent, info, taxes } = await encryptedTrash();
    const lookup = vi.spyOn(apiClient, "encryptedFolder").mockResolvedValue({ folder: info });
    await keyStore.unlocked(account.identity);
    renderPage();

    expect(await screen.findByText("Taxes 2026.pdf")).toBeDefined();
    expect(screen.getByText("/Private/Receipts")).toBeDefined();
    expect(screen.queryByText(taxes)).toBeNull();
    expect(lookup).toHaveBeenCalledWith(parent);
    expect(lookup).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("checkbox", { name: "Select Taxes 2026.pdf" }));
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    expect(fixtures.restore).toHaveBeenCalledWith({ ids: [entry.id] }, expect.anything());

    fixtures.restoreConflict = true;
    lastRestoreCallbacks().onError(new Error("conflict"));
    expect(fixtures.toastError).toHaveBeenCalledWith(
      'Could not restore "Taxes 2026.pdf": a file already exists at that location.',
      expect.anything(),
    );
  });

  it("shows decrypted names in the grid too", async () => {
    window.localStorage.setItem("fdrive.view", JSON.stringify("grid"));
    const { account, info } = await encryptedTrash();
    vi.spyOn(apiClient, "encryptedFolder").mockResolvedValue({ folder: info });
    await keyStore.unlocked(account.identity);
    renderPage();
    expect(await screen.findByText("Taxes 2026.pdf")).toBeDefined();
    expect(screen.getByText("/Private/Receipts")).toBeDefined();
  });

  it("shows an encrypted item while this browser is locked, without asking for its folder", async () => {
    const { taxes } = await encryptedTrash();
    const lookup = vi.spyOn(apiClient, "encryptedFolder");
    renderPage();

    await waitFor(() => expect(keyStore.get().status).toBe("locked"));
    expect(screen.getByText("Encrypted item")).toBeDefined();
    expect(screen.getByText("/Private/…")).toBeDefined();
    expect(screen.getByRole("checkbox", { name: "Select Encrypted item" })).toBeDefined();
    expect(screen.getByText("report.txt")).toBeDefined();
    expect(screen.queryByText(taxes)).toBeNull();
    expect(lookup).not.toHaveBeenCalled();
  });

  it("shows an encrypted item when its folder is gone or its marker does not open", async () => {
    const { account, info } = await encryptedTrash();
    const lookup = vi.spyOn(apiClient, "encryptedFolder").mockResolvedValue({ folder: null });
    await keyStore.unlocked(account.identity);
    const view = renderPage();
    await waitFor(() => expect(lookup).toHaveBeenCalled());
    expect(screen.getByText("Encrypted item")).toBeDefined();
    view.unmount();

    const stranger = await crypto.newKeyPair();
    const foreign = await crypto.createFolder(stranger.identity);
    lookup.mockResolvedValue({ folder: { ...info, marker: foreign.marker } });
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderPage();
    await waitFor(() => expect(lookup).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Encrypted item")).toBeDefined();
  });
});
