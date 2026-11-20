// @vitest-environment jsdom
import type { SystemFeaturesResponse, SystemStorage } from "@fdrive/contracts";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  storage: vi.fn(),
  update: vi.fn(),
  mutate: vi.fn(),
  refetch: vi.fn(),
  features: vi.fn(),
  updateFeatures: vi.fn(),
  saveFeatures: vi.fn(),
  replace: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: mocks.replace }) }));
vi.mock("./public-url-card", () => ({ PublicUrlCard: () => <p>Server address row</p> }));
vi.mock("./trash-settings-card", () => ({ TrashSettingsCard: () => <p>Trash row</p> }));
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
  useSystemFeatures: () => mocks.features(),
  useUpdateFeatures: () => mocks.updateFeatures(),
}));
const { GeneralPage } = await import("./general-page");

const FOLDER: SystemStorage = {
  name: "Local folder",
  healthy: true,
  detail: "The storage root is a writable folder",
};

const VALUES: SystemFeaturesResponse["configuration"]["values"] = {
  thumbnails: true,
  textSearch: true,
  searchOcr: false,
  semanticSearch: false,
  imageSearch: false,
  pdfOcr: false,
};

/** The saved feature choices: a finished walkthrough, at revision 9. */
const FEATURES: SystemFeaturesResponse = {
  configuration: {
    version: 1,
    revision: 9,
    values: VALUES,
    walkthroughComplete: true,
    walkthroughStep: 8,
  },
  source: "settings",
  statuses: [],
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
  mocks.features.mockReturnValue({ data: FEATURES });
  mocks.updateFeatures.mockReturnValue({
    mutate: mocks.saveFeatures,
    isPending: false,
    isError: false,
  });
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

function nameInput(): HTMLInputElement {
  return screen.getByLabelText("Storage name") as HTMLInputElement;
}
function walkthroughButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: "Run walkthrough" }) as HTMLButtonElement;
}
function saveButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: "Save name" }) as HTMLButtonElement;
}

it("holds the installation-wide settings as rows: the address, the files folder, Trash and the walkthrough", () => {
  const { container } = render(<GeneralPage />);

  expect(screen.getByRole("heading", { name: "General" })).toBeTruthy();
  expect(
    screen.getByText("Settings for the whole installation. They apply to every user and login."),
  ).toBeTruthy();
  expect(screen.getByText("updated: 5")).toBeTruthy();
  expect(screen.getByText("Server address row")).toBeTruthy();
  expect(screen.getByText("Files folder")).toBeTruthy();
  expect(screen.getByText("Folder on this server, set by FDRIVE_STORAGE_ROOT.")).toBeTruthy();
  expect(screen.getByText("Shown under each username and in Finder.")).toBeTruthy();
  expect(screen.getByText("Trash row")).toBeTruthy();
  expect(screen.getByText("Setup walkthrough")).toBeTruthy();
  // A healthy folder says so in a word, with no health line, and nothing links elsewhere.
  expect(screen.getByText("Healthy").getAttribute("data-tone")).toBe("success");
  expect(screen.queryByText("Unavailable")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("link")).toBeNull();
  // Rows in one block, not titled sections or cards.
  expect(container.querySelector('[data-slot="page-section"]')).toBeNull();
  expect(container.querySelector('[data-slot="card"]')).toBeNull();
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

  expect(screen.getByText("Unavailable").getAttribute("data-tone")).toBe("danger");
  expect(screen.queryByText("Healthy")).toBeNull();
  expect(screen.getByRole("alert").textContent).toBe(reason);
  expect(screen.getByText("Trash row")).toBeTruthy();
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
  expect(screen.getByRole("alert").textContent).toBe("Couldn't load the files folderoffline");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(mocks.refetch).toHaveBeenCalledOnce();
});

it("runs the setup walkthrough again: marks it unfinished at its first step, then opens /setup", () => {
  render(<GeneralPage />);

  fireEvent.click(walkthroughButton());

  // The feature choices are sent back as they are: only the walkthrough's state changes.
  expect(mocks.saveFeatures).toHaveBeenCalledWith(
    { revision: 9, values: VALUES, walkthroughComplete: false, walkthroughStep: 0 },
    expect.anything(),
  );
  expect(mocks.replace).not.toHaveBeenCalled();
  act(() => mocks.saveFeatures.mock.calls[0]?.[1].onSuccess());
  expect(mocks.replace).toHaveBeenCalledWith("/setup");
});

it("keeps the walkthrough button off until the choices are known and while it saves", () => {
  mocks.features.mockReturnValue({ data: undefined });
  const { unmount } = render(<GeneralPage />);
  expect(walkthroughButton().disabled).toBe(true);
  fireEvent.click(walkthroughButton());
  expect(mocks.saveFeatures).not.toHaveBeenCalled();
  unmount();

  mocks.features.mockReturnValue({ data: FEATURES });
  mocks.updateFeatures.mockReturnValue({
    mutate: mocks.saveFeatures,
    isPending: true,
    isError: false,
  });
  render(<GeneralPage />);
  expect(walkthroughButton().disabled).toBe(true);
});

it("says why the walkthrough could not be started", () => {
  mocks.updateFeatures.mockReturnValue({
    mutate: mocks.saveFeatures,
    isPending: false,
    isError: true,
    error: new Error("revision conflict"),
  });
  render(<GeneralPage />);

  expect(screen.getByRole("alert").textContent).toBe("revision conflict");
  expect(mocks.replace).not.toHaveBeenCalled();
});
