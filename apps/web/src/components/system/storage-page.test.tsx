// @vitest-environment jsdom
import type { AdminProvider, AdminProviderType } from "@fdrive/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { allCapabilities } from "@/lib/identity/capabilities";

const PRIMARY: AdminProvider = {
  id: "00000000-0000-4000-8000-000000000009",
  type: "sftpgo",
  label: "Primary",
  baseUrl: "http://sftpgo:8080",
  config: { homeTemplate: "sftpgo:/{username}" },
  enabled: true,
  managedByEnv: true,
  identityCount: 2,
  reachable: true,
  checkedAt: "2026-01-01T00:00:00.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
};
const SPARE: AdminProvider = {
  ...PRIMARY,
  id: "00000000-0000-4000-8000-00000000000a",
  label: "Spare",
  baseUrl: "http://spare:8080",
  config: {},
  enabled: false,
  managedByEnv: false,
  identityCount: 0,
  reachable: false,
};
const SFTPGO_TYPE: AdminProviderType = {
  type: "sftpgo",
  label: "SFTPGo",
  configFields: [
    {
      name: "homeTemplate",
      label: "Home template",
      kind: "text",
      required: false,
      help: 'Written as "<root>:<path>".',
    },
  ],
  credentialFields: [],
  capabilities: { ...allCapabilities(true), setModifiedAt: false },
};

const mocks = vi.hoisted(() => ({
  providers: [] as unknown[],
  types: [] as unknown[],
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
    actions?: ReactNode;
    children: ReactNode;
  }) => (
    <div>
      <h1>{props.title}</h1>
      <p>{props.description}</p>
      <div>{props.actions}</div>
      <div>{props.children}</div>
    </div>
  ),
}));
vi.mock("@/lib/api/system-queries", () => ({
  useAdminProviders: () => ({
    data: { providers: mocks.providers, types: mocks.types },
    isLoading: false,
    dataUpdatedAt: 1,
  }),
  useAdminCreateProvider: () => mocks.create,
  useAdminUpdateProvider: () => mocks.update,
  useAdminDeleteProvider: () => mocks.remove,
  useAdminTestProvider: () => mocks.test,
}));

const { StoragePage } = await import("./storage-page");

function renderPage(providers: AdminProvider[], types: AdminProviderType[] = [SFTPGO_TYPE]) {
  mocks.providers = providers;
  mocks.types = types;
  return render(<StoragePage />);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.test.data = undefined;
});

it("lists each provider with its type, address, source, logins, and capabilities", () => {
  renderPage([PRIMARY]);

  expect(screen.getByRole("heading", { name: "Storage" })).toBeTruthy();
  expect(screen.getByText("Primary")).toBeTruthy();
  expect(screen.getByText("SFTPGo")).toBeTruthy();
  expect(screen.getByText("http://sftpgo:8080")).toBeTruthy();
  expect(screen.getByText("Reachable")).toBeTruthy();
  expect(screen.getByText("Environment (locked)")).toBeTruthy();
  expect(screen.getByText("2")).toBeTruthy();
  expect(screen.getByText("Trash")).toBeTruthy();
  // `setModifiedAt` is false for this type, so its chip stays off the row.
  expect(screen.queryByText("Keeps modification times")).toBeNull();
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
  expect(screen.getByText(/Remove SFTPGO_URL to manage this server here/)).toBeTruthy();
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
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: " Second " } });
  fireEvent.change(screen.getByLabelText("Address"), {
    target: { value: " http://second:8080 " },
  });
  fireEvent.change(screen.getByLabelText("Home template"), {
    target: { value: "sftpgo:/second/{username}" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add" }));

  expect(mocks.create.mutate).toHaveBeenCalledWith(
    {
      type: "sftpgo",
      label: "Second",
      baseUrl: "http://second:8080",
      config: { homeTemplate: "sftpgo:/second/{username}" },
    },
    expect.anything(),
  );
});

it("probes an unsaved candidate from the add dialog", () => {
  renderPage([PRIMARY]);

  fireEvent.click(screen.getByRole("button", { name: "Add provider" }));
  fireEvent.change(screen.getByLabelText("Address"), { target: { value: "http://second:8080" } });
  fireEvent.click(screen.getByRole("button", { name: "Test" }));

  expect(mocks.test.mutate).toHaveBeenCalledWith({
    type: "sftpgo",
    baseUrl: "http://second:8080",
    config: {},
  });
});

it("keeps Add unavailable until the address is an http(s) URL", () => {
  renderPage([PRIMARY]);

  fireEvent.click(screen.getByRole("button", { name: "Add provider" }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Second" } });
  fireEvent.change(screen.getByLabelText("Address"), { target: { value: "second:8080" } });

  expect((screen.getByRole("button", { name: "Add" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/Enter the address as an http\(s\) URL/)).toBeTruthy();
});

it("locks the address of an env-managed provider and saves only what changed", () => {
  renderPage([PRIMARY]);

  fireEvent.click(screen.getByRole("button", { name: "Edit Primary" }));
  const address = screen.getByLabelText("Address") as HTMLInputElement;
  expect(address.readOnly).toBe(true);
  expect(
    screen.getByText("Set by the deployment. Remove SFTPGO_URL to manage the address here."),
  ).toBeTruthy();

  fireEvent.change(screen.getByLabelText("Home template"), {
    target: { value: "sftpgo:/homes/{username}" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));

  expect(mocks.update.mutate).toHaveBeenCalledWith(
    { id: PRIMARY.id, patch: { config: { homeTemplate: "sftpgo:/homes/{username}" } } },
    expect.anything(),
  );
});

it("explains that logins pin the address of a provider the deployment does not own", () => {
  renderPage([{ ...SPARE, identityCount: 3 }]);

  fireEvent.click(screen.getByRole("button", { name: "Edit Spare" }));
  expect(
    screen.getByText("Logins already use this server. Add a new provider for another address."),
  ).toBeTruthy();
});

it("invites the operator to add the first server when none is configured", () => {
  renderPage([]);

  expect(screen.getByText("No storage servers")).toBeTruthy();
});
