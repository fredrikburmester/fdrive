// @vitest-environment jsdom
import type { AdminProvider } from "@fdrive/contracts";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { allCapabilities } from "@/lib/identity/capabilities";

const mocks = vi.hoisted(() => ({
  providers: vi.fn(),
  update: vi.fn(),
  mutate: vi.fn(),
  refetch: vi.fn(),
}));
vi.mock("./public-url-card", () => ({ PublicUrlCard: () => <p>Server address card</p> }));
vi.mock("./trash-settings-card", () => ({
  TrashSettingsCard: (props: { provider: { id: string; label: string } }) => (
    <p>Trash card for {props.provider.label}</p>
  ),
}));
vi.mock("./system-page", () => ({
  SystemPage: (props: {
    title: string;
    description: string;
    lastUpdated: Date | null;
    children: ReactNode;
  }) => (
    <div>
      <h1>{props.title}</h1>
      <p>{props.description}</p>
      <p>updated: {props.lastUpdated?.getTime() ?? "never"}</p>
      <div>{props.children}</div>
    </div>
  ),
}));
vi.mock("@/lib/api/public-url-queries", () => ({
  useSystemPublicUrl: () => ({ dataUpdatedAt: 1 }),
}));
vi.mock("@/lib/api/system-queries", () => ({
  useAdminProviders: () => mocks.providers(),
  useAdminUpdateProvider: () => mocks.update(),
}));
const { GeneralPage } = await import("./general-page");

const FOLDER: AdminProvider = {
  id: "00000000-0000-4000-8000-00000000000a",
  type: "local",
  label: "Local folder",
  baseUrl: "",
  config: {},
  enabled: true,
  managedByEnv: true,
  capabilities: allCapabilities(true),
  identityCount: 3,
  reachable: true,
  checkedAt: "2026-01-01T00:00:00.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
};

function withProviders(providers: AdminProvider[]) {
  mocks.providers.mockReturnValue({
    data: { providers },
    isError: false,
    dataUpdatedAt: 5,
    refetch: mocks.refetch,
  });
}

beforeEach(() => {
  withProviders([FOLDER]);
  mocks.update.mockReturnValue({ mutate: mocks.mutate, isPending: false, isError: false });
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

function nameInput(): HTMLInputElement {
  return screen.getByLabelText("Name") as HTMLInputElement;
}
function saveButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: "Save name" }) as HTMLButtonElement;
}

it("holds the installation-wide settings: the address, the files folder and its Trash", () => {
  render(<GeneralPage />);

  expect(screen.getByRole("heading", { name: "General" })).toBeTruthy();
  expect(screen.getByText("Settings for the whole installation.")).toBeTruthy();
  expect(screen.getByText("updated: 5")).toBeTruthy();
  expect(screen.getByText("Server address card")).toBeTruthy();
  expect(screen.getByText("Storage")).toBeTruthy();
  expect(screen.getByText("Folder on this server, set by FDRIVE_STORAGE_ROOT.")).toBeTruthy();
  expect(screen.getByText("Shown on the login page and in Finder.")).toBeTruthy();
  expect(screen.getByText("Trash card for Local folder")).toBeTruthy();
  // A reachable folder needs no reachability line, and nothing links elsewhere.
  expect(screen.queryByText("Unreachable")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("link")).toBeNull();
});

it("renames the storage with the trimmed name, and only once it changed", () => {
  render(<GeneralPage />);

  expect(nameInput().value).toBe("Local folder");
  expect(saveButton().disabled).toBe(true);
  fireEvent.change(nameInput(), { target: { value: "  Local folder  " } });
  expect(saveButton().disabled).toBe(true);
  fireEvent.change(nameInput(), { target: { value: "  Home storage  " } });
  expect(saveButton().disabled).toBe(false);
  fireEvent.click(saveButton());

  expect(mocks.mutate).toHaveBeenCalledWith(
    { id: FOLDER.id, patch: { label: "Home storage" } },
    expect.anything(),
  );
  act(() => mocks.mutate.mock.calls[0]?.[1].onSuccess());
  // The draft is dropped: the field shows the saved name again until the list refetches.
  expect(nameInput().value).toBe("Local folder");
});

it("refuses a blank name with the API's message", () => {
  render(<GeneralPage />);

  fireEvent.change(nameInput(), { target: { value: "   " } });

  expect(screen.getByText("Enter a name for this storage.")).toBeTruthy();
  expect(nameInput().getAttribute("aria-invalid")).toBe("true");
  expect(saveButton().disabled).toBe(true);
  fireEvent.click(saveButton());
  expect(mocks.mutate).not.toHaveBeenCalled();
});

it("shows the save in flight and a refused rename", () => {
  mocks.update.mockReturnValue({
    mutate: mocks.mutate,
    isPending: true,
    isError: true,
    error: new Error("boom"),
  });
  render(<GeneralPage />);

  expect(screen.getByRole("button", { name: "Saving…" })).toBeTruthy();
  expect(nameInput().disabled).toBe(true);
  expect(screen.getByRole("alert")).toBeTruthy();
});

it("says when fdrive cannot reach the folder", () => {
  withProviders([{ ...FOLDER, reachable: false }]);
  render(<GeneralPage />);

  expect(screen.getByText("Unreachable")).toBeTruthy();
  expect(screen.getByRole("alert").textContent).toBe(
    "fdrive can't reach this folder. Check that FDRIVE_STORAGE_ROOT exists and is writable.",
  );
});

it("leaves the Trash card out for storage without Trash", () => {
  withProviders([{ ...FOLDER, capabilities: { ...allCapabilities(true), trash: false } }]);
  render(<GeneralPage />);

  expect(screen.queryByText(/Trash card/)).toBeNull();
});

it("tells the operator to set FDRIVE_STORAGE_ROOT when there is no folder", () => {
  withProviders([]);
  render(<GeneralPage />);

  expect(
    screen.getByText(
      "This installation has no files folder. Set FDRIVE_STORAGE_ROOT and restart fdrive.",
    ),
  ).toBeTruthy();
  expect(screen.queryByLabelText("Name")).toBeNull();
});

it("shows a placeholder while loading and a retry when the list fails", () => {
  mocks.providers.mockReturnValue({ data: undefined, isError: false, dataUpdatedAt: 0 });
  const { container, unmount } = render(<GeneralPage />);
  expect(container.querySelector('[data-slot="skeleton"]')).toBeTruthy();
  expect(screen.getByText("updated: 1")).toBeTruthy();
  unmount();

  mocks.providers.mockReturnValue({
    data: undefined,
    isError: true,
    error: new Error("offline"),
    dataUpdatedAt: 0,
    refetch: mocks.refetch,
  });
  render(<GeneralPage />);
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(mocks.refetch).toHaveBeenCalledOnce();
});
