// @vitest-environment jsdom
import type { SystemStorage } from "@fdrive/contracts";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  storage: vi.fn(),
  update: vi.fn(),
  mutate: vi.fn(),
  refetch: vi.fn(),
}));
vi.mock("./public-url-card", () => ({ PublicUrlCard: () => <p>Server address card</p> }));
vi.mock("./trash-settings-card", () => ({ TrashSettingsCard: () => <p>Trash card</p> }));
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
  useSystemStorage: () => mocks.storage(),
  useUpdateSystemStorage: () => mocks.update(),
}));
const { GeneralPage } = await import("./general-page");

const FOLDER: SystemStorage = {
  id: "00000000-0000-4000-8000-00000000000a",
  name: "Local folder",
  healthy: true,
  detail: "The storage root is a writable folder",
};

function withStorage(storage: SystemStorage) {
  mocks.storage.mockReturnValue({
    data: storage,
    isError: false,
    dataUpdatedAt: 5,
    refetch: mocks.refetch,
  });
}

beforeEach(() => {
  withStorage(FOLDER);
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

it("holds the installation-wide settings: the address, the files folder and Trash", () => {
  render(<GeneralPage />);

  expect(screen.getByRole("heading", { name: "General" })).toBeTruthy();
  expect(screen.getByText("Settings for the whole installation.")).toBeTruthy();
  expect(screen.getByText("updated: 5")).toBeTruthy();
  expect(screen.getByText("Server address card")).toBeTruthy();
  expect(screen.getByText("Storage")).toBeTruthy();
  expect(screen.getByText("Folder on this server, set by FDRIVE_STORAGE_ROOT.")).toBeTruthy();
  expect(screen.getByText("Shown under each username and in Finder.")).toBeTruthy();
  expect(screen.getByText("Trash card")).toBeTruthy();
  // A healthy folder needs no health line, and nothing links elsewhere.
  expect(screen.queryByText("Unavailable")).toBeNull();
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

  expect(mocks.mutate).toHaveBeenCalledWith({ name: "Home storage" }, expect.anything());
  act(() => mocks.mutate.mock.calls[0]?.[1].onSuccess());
  // The draft is dropped: the field shows the saved name again until it refetches.
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

it("says why fdrive cannot use the folder", () => {
  const reason = "The files folder is missing. Check FDRIVE_FILES_DIR.";
  withStorage({ ...FOLDER, healthy: false, detail: reason });
  render(<GeneralPage />);

  expect(screen.getByText("Unavailable")).toBeTruthy();
  expect(screen.getByRole("alert").textContent).toBe(reason);
  expect(screen.getByText("Trash card")).toBeTruthy();
});

it("shows a placeholder while loading and a retry when the storage fails to load", () => {
  mocks.storage.mockReturnValue({ data: undefined, isError: false, dataUpdatedAt: 0 });
  const { container, unmount } = render(<GeneralPage />);
  expect(container.querySelector('[data-slot="skeleton"]')).toBeTruthy();
  expect(screen.getByText("updated: 1")).toBeTruthy();
  unmount();

  mocks.storage.mockReturnValue({
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
