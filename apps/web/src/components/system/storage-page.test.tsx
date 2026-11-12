// @vitest-environment jsdom
import { type AdminProvider, type AdminProviderType, ApiClientError } from "@fdrive/contracts";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { allCapabilities, storageNote } from "@/lib/identity/capabilities";

/** The note for storage with none of the features only full storage has. */
const FILES_ONLY_NOTE = storageNote({ ...allCapabilities(false), trash: true }) as string;

/** The deployment's own folder: no address, pinned, and never an addable type. */
const FOLDER: AdminProvider = {
  id: "00000000-0000-4000-8000-000000000009",
  type: "local",
  label: "Local folder",
  baseUrl: "",
  config: {},
  enabled: true,
  managedByEnv: true,
  identityCount: 2,
  reachable: true,
  checkedAt: "2026-01-01T00:00:00.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
  capabilities: allCapabilities(true),
};
/** What WebDAV can do: files, Trash, zip and atomic moves. */
const WEBDAV_CAPABILITIES = {
  ...allCapabilities(false),
  trash: true,
  zip: true,
  atomicMove: true,
};
const S3_CAPABILITIES = { ...allCapabilities(false), trash: true };
const PRIMARY: AdminProvider = {
  ...FOLDER,
  id: "00000000-0000-4000-8000-00000000000b",
  type: "webdav",
  label: "Primary",
  baseUrl: "https://dav.example.com/",
  config: { prefix: "/files" },
  managedByEnv: false,
  capabilities: WEBDAV_CAPABILITIES,
};
const SPARE: AdminProvider = {
  ...PRIMARY,
  id: "00000000-0000-4000-8000-00000000000a",
  label: "Spare",
  baseUrl: "https://spare.example.com/",
  config: {},
  enabled: false,
  identityCount: 0,
  reachable: false,
};
const WEBDAV_TYPE: AdminProviderType = {
  type: "webdav",
  label: "WebDAV",
  configFields: [
    {
      name: "prefix",
      label: "Folder prefix",
      kind: "text",
      required: false,
      help: "The folder under the address that holds people's files.",
    },
  ],
  credentialFields: [],
  capabilities: WEBDAV_CAPABILITIES,
};

const S3_TYPE: AdminProviderType = {
  type: "s3",
  label: "S3",
  configFields: [],
  credentialFields: [],
  capabilities: S3_CAPABILITIES,
};

const mocks = vi.hoisted(() => ({
  providers: [] as unknown[],
  types: [] as unknown[],
  /** When set, `useAdminProviders` reports this error and no data. */
  listError: null as Error | null,
  create: { mutate: vi.fn(), isPending: false, isError: false, error: null },
  update: { mutate: vi.fn(), isPending: false, isError: false, error: null },
  remove: { mutate: vi.fn(), isPending: false, isError: false, error: null },
  test: {
    mutate: vi.fn(),
    reset: vi.fn(),
    isPending: false,
    isError: false,
    error: null,
    data: undefined as { ok: boolean; detail: string } | undefined,
  },
}));

vi.mock("./system-page", () => ({
  SystemPage: (props: {
    title: string;
    description: string;
    scope?: string;
    actions?: ReactNode;
    children: ReactNode;
  }) => (
    <div>
      <h1>{props.title}</h1>
      <p>{props.description}</p>
      <p>scope: {props.scope ?? "server"}</p>
      <div>{props.actions}</div>
      <div>{props.children}</div>
    </div>
  ),
}));
vi.mock("./trash-settings-card", () => ({
  TrashSettingsForm: ({ provider }: { provider: { label: string } }) => (
    <p>Trash form for {provider.label}</p>
  ),
}));
vi.mock("@/lib/api/system-queries", () => ({
  useAdminProviders: () =>
    mocks.listError === null
      ? {
          data: { providers: mocks.providers, types: mocks.types },
          isLoading: false,
          isError: false,
          error: null,
          dataUpdatedAt: 1,
        }
      : {
          data: undefined,
          isLoading: false,
          isError: true,
          error: mocks.listError,
          dataUpdatedAt: 0,
        },
  useAdminCreateProvider: () => mocks.create,
  useAdminUpdateProvider: () => mocks.update,
  useAdminDeleteProvider: () => mocks.remove,
  useAdminTestProvider: () => mocks.test,
}));
const { StoragePage } = await import("./storage-page");

function renderPage(providers: AdminProvider[], types: AdminProviderType[] = [WEBDAV_TYPE]) {
  mocks.providers = providers;
  mocks.types = types;
  return render(<StoragePage />);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.test.data = undefined;
  mocks.listError = null;
});

it("shows the empty state when the list is loaded and holds no servers", () => {
  renderPage([]);

  expect(screen.getByText("No storage servers")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("treats a 403 as a refusal, not an installation without servers", () => {
  mocks.listError = new ApiClientError("forbidden", "admin only", 403);
  renderPage([]);

  expect(screen.getByText("Administrators only")).toBeTruthy();
  expect(screen.queryByText("No storage servers")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect((screen.getByRole("button", { name: "Add provider" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
});

it("reports any other list failure instead of pretending the list is empty", () => {
  mocks.listError = new ApiClientError("upstream_unavailable", "down", 502);
  renderPage([]);

  expect(screen.getByRole("alert").textContent).toContain("fdrive can't reach the server");
  expect(screen.queryByText("No storage servers")).toBeNull();
  expect(screen.queryByText("Administrators only")).toBeNull();
});

it("lists each provider with its type, address, source, logins, and capabilities", () => {
  renderPage([PRIMARY]);

  expect(screen.getByRole("heading", { name: "Storage" })).toBeTruthy();
  expect(screen.getByText("Primary")).toBeTruthy();
  expect(screen.getByText("WebDAV")).toBeTruthy();
  expect(screen.getByText("https://dav.example.com/")).toBeTruthy();
  expect(screen.getByText("Reachable")).toBeTruthy();
  expect(screen.getByText("Settings")).toBeTruthy();
  expect(screen.getByText("2")).toBeTruthy();
  const supports = screen.getByText("Supports").parentElement as HTMLElement;
  expect(within(supports).getByText("Trash")).toBeTruthy();
  // `setModifiedAt` is false for this type, so the row says so instead of staying silent.
  expect(within(supports).queryByText("Keeps modification times")).toBeNull();
  const missing = screen.getByText("Not available").parentElement as HTMLElement;
  expect(within(missing).getByText("Keeps modification times")).toBeTruthy();
  expect(screen.getByText(FILES_ONLY_NOTE)).toBeTruthy();
});

it("shows the local folder without an address, with what it can do and its own Trash", () => {
  // The local folder is never an addable type: the row carries its own flags.
  renderPage([FOLDER]);

  expect(screen.getByText("Local folder")).toBeTruthy();
  expect(screen.getByRole("img", { name: "fdrive" })).toBeTruthy();
  expect(screen.getByText("Folder on this server, set by FDRIVE_STORAGE_ROOT.")).toBeTruthy();
  expect(screen.getByText("Deployment (locked)")).toBeTruthy();
  const supports = screen.getByText("Supports").parentElement as HTMLElement;
  for (const label of ["Search and thumbnails", "Shares", "Share with people", "Office", "Trash"]) {
    expect(within(supports).getByText(label)).toBeTruthy();
  }
  expect(screen.queryByText("Not available")).toBeNull();
  expect(screen.getByText("Trash form for Local folder")).toBeTruthy();
});

it("says plainly what files-only storage cannot do", () => {
  renderPage(
    [
      {
        ...SPARE,
        type: "s3",
        baseUrl: "https://s3.example.com/media",
        capabilities: S3_CAPABILITIES,
      },
    ],
    [WEBDAV_TYPE, S3_TYPE],
  );

  const missing = screen.getByText("Not available").parentElement as HTMLElement;
  for (const label of ["Search and thumbnails", "Shares", "Share with people", "Office"]) {
    expect(within(missing).getByText(label)).toBeTruthy();
  }
  expect(screen.getByText(FILES_ONLY_NOTE)).toBeTruthy();
});

it("names only the missing features for storage that has some of them", () => {
  renderPage([{ ...SPARE, capabilities: { ...WEBDAV_CAPABILITIES, shares: true } }]);

  expect(screen.queryByText(FILES_ONLY_NOTE)).toBeNull();
  expect(
    screen.getByText(
      "Search and thumbnails, sharing with people and Office aren't available on this storage.",
    ),
  ).toBeTruthy();
});

it("warns in the add dialog as soon as a files-only type is chosen", () => {
  renderPage([PRIMARY], [S3_TYPE]);

  fireEvent.click(screen.getByRole("button", { name: "Add provider" }));

  expect(within(screen.getByRole("dialog")).getByText(FILES_ONLY_NOTE)).toBeTruthy();
});

it("keeps each server's Trash settings on its own row, and none for a type without Trash", () => {
  renderPage([
    PRIMARY,
    { ...SPARE, type: "s3", capabilities: { ...allCapabilities(true), trash: false } },
  ]);

  expect(screen.getByText("Trash form for Primary")).toBeTruthy();
  expect(screen.queryByText("Trash form for Spare")).toBeNull();
  expect(screen.getByText("scope: storage")).toBeTruthy();
});

it("re-probes one provider and shows what the probe said", () => {
  const view = renderPage([PRIMARY]);

  fireEvent.click(screen.getByRole("button", { name: "Test Primary" }));
  expect(mocks.test.mutate).toHaveBeenCalledWith(PRIMARY.id);

  mocks.test.data = { ok: false, detail: "connect ECONNREFUSED" };
  view.rerender(<StoragePage />);
  expect(screen.getByText("Unreachable")).toBeTruthy();
  expect(screen.getByText("connect ECONNREFUSED")).toBeTruthy();
});

it("refuses to remove a provider that logins still use, and says why", () => {
  renderPage([PRIMARY]);

  const remove = screen.getByRole("button", { name: "Remove Primary" }) as HTMLButtonElement;
  expect(remove.disabled).toBe(true);
  expect(screen.getByText(/Logins still use this server/)).toBeTruthy();
});

it("never offers to remove the deployment's own folder", () => {
  renderPage([{ ...FOLDER, identityCount: 0 }]);

  const remove = screen.getByRole("button", { name: "Remove Local folder" }) as HTMLButtonElement;
  expect(remove.disabled).toBe(true);
  expect(
    screen.getByText(
      "Set by the deployment with FDRIVE_STORAGE_ROOT, so it cannot be removed here.",
    ),
  ).toBeTruthy();
});

it("removes an unused provider after a confirmation", () => {
  renderPage([{ ...SPARE, enabled: true }]);

  fireEvent.click(screen.getByRole("button", { name: "Remove Spare" }));
  expect(screen.getByRole("alertdialog")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  expect(mocks.remove.mutate).toHaveBeenCalledWith(SPARE.id);
});

it("warns before disabling the only enabled provider", () => {
  renderPage([{ ...SPARE, enabled: true }]);

  fireEvent.click(screen.getByRole("switch", { name: "Enable Spare" }));
  expect(mocks.update.mutate).not.toHaveBeenCalled();
  expect(screen.getByText(/Nobody can sign in until one is enabled again/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Disable" }));
  expect(mocks.update.mutate).toHaveBeenCalledWith({ id: SPARE.id, patch: { enabled: false } });
});

it("enables a disabled provider without a confirmation", () => {
  renderPage([PRIMARY, SPARE]);

  fireEvent.click(screen.getByRole("switch", { name: "Enable Spare" }));
  expect(mocks.update.mutate).toHaveBeenCalledWith({ id: SPARE.id, patch: { enabled: true } });
});

it("adds a provider with its type, name, address, and configuration", () => {
  renderPage([PRIMARY]);

  fireEvent.click(screen.getByRole("button", { name: "Add provider" }));
  // The closed Type trigger shows the type's label, not its raw value.
  expect(
    screen.getByRole("combobox", { name: "Type" }).querySelector('[data-slot="select-value"]')
      ?.textContent,
  ).toBe("WebDAV");
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: " Second " } });
  fireEvent.change(screen.getByLabelText("Address"), {
    target: { value: " https://second.example.com/ " },
  });
  fireEvent.change(screen.getByLabelText("Folder prefix"), { target: { value: "/media" } });
  fireEvent.click(screen.getByRole("button", { name: "Add" }));

  expect(mocks.create.mutate).toHaveBeenCalledWith(
    {
      type: "webdav",
      label: "Second",
      baseUrl: "https://second.example.com/",
      config: { prefix: "/media" },
    },
    expect.anything(),
  );
});

it("probes an unsaved candidate from the add dialog", () => {
  renderPage([PRIMARY]);

  fireEvent.click(screen.getByRole("button", { name: "Add provider" }));
  fireEvent.change(screen.getByLabelText("Address"), {
    target: { value: "https://second.example.com/" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Test" }));

  expect(mocks.test.mutate).toHaveBeenCalledWith({
    type: "webdav",
    baseUrl: "https://second.example.com/",
    config: {},
  });
});

it("keeps Add unavailable until the address is an http(s) URL", () => {
  renderPage([PRIMARY]);

  fireEvent.click(screen.getByRole("button", { name: "Add provider" }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Second" } });
  fireEvent.change(screen.getByLabelText("Address"), { target: { value: "second.example.com" } });

  expect((screen.getByRole("button", { name: "Add" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText("Enter the address as an http(s) URL.")).toBeTruthy();
});

it("locks the address of a provider logins use and saves only what changed", () => {
  renderPage([PRIMARY]);

  fireEvent.click(screen.getByRole("button", { name: "Edit Primary" }));
  const address = screen.getByLabelText("Address") as HTMLInputElement;
  expect(address.readOnly).toBe(true);
  expect(
    screen.getByText("Logins already use this server. Add a new provider for another address."),
  ).toBeTruthy();

  fireEvent.change(screen.getByLabelText("Folder prefix"), { target: { value: "/homes" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));

  expect(mocks.update.mutate).toHaveBeenCalledWith(
    { id: PRIMARY.id, patch: { config: { prefix: "/homes" } } },
    expect.anything(),
  );
});

it("only renames the local folder, which has no address or type to change", () => {
  renderPage([FOLDER]);

  fireEvent.click(screen.getByRole("button", { name: "Edit Local folder" }));
  const dialog = screen.getByRole("dialog");
  expect(
    within(dialog).getByText(
      "Folder on this server, set by FDRIVE_STORAGE_ROOT. Only its name can change here.",
    ),
  ).toBeTruthy();
  expect(within(dialog).queryByLabelText("Address")).toBeNull();
  expect(within(dialog).queryByRole("combobox", { name: "Type" })).toBeNull();

  fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Home" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

  expect(mocks.update.mutate).toHaveBeenCalledWith(
    { id: FOLDER.id, patch: { label: "Home" } },
    expect.anything(),
  );
});

it("leaves an unused provider's address editable", () => {
  renderPage([SPARE]);

  fireEvent.click(screen.getByRole("button", { name: "Edit Spare" }));
  const address = screen.getByLabelText("Address") as HTMLInputElement;
  expect(address.readOnly).toBe(false);
  expect(
    screen.getByText("The WebDAV URL people's files live under, such as https://dav.example.com/."),
  ).toBeTruthy();
});

it("invites the operator to add the first server when none is configured", () => {
  renderPage([]);

  expect(screen.getByText("No storage servers")).toBeTruthy();
});
