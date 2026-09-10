// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  provider: {
    id: "00000000-0000-4000-8000-000000000009",
    type: "sftpgo" as const,
    label: "original",
    baseUrl: "http://original",
    config: { homeTemplate: "sftpgo:/{username}" } as Record<string, string>,
    enabled: true,
    managedByEnv: false,
    identityCount: 1,
    reachable: true,
    checkedAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
  },
  test: {
    data: { ok: true, detail: "Reachable" },
    variables: { type: "sftpgo", baseUrl: "http://original" } as
      | string
      | { type: string; baseUrl: string },
    isPending: false,
    mutate: vi.fn(),
    reset: vi.fn(),
  },
  update: { mutate: vi.fn(), isPending: false },
}));
vi.mock("@/components/shell/page-header", () => ({
  PageHeader: () => null,
  useShellMe: () => ({
    data: { activeIdentityId: "alice", identities: [{ id: "alice", username: "alice" }] },
  }),
}));
vi.mock("./public-url-card", () => ({ PublicUrlCard: () => <p>Server address card</p> }));
vi.mock("./trash-settings-card", () => ({ TrashSettingsCard: () => <p>Trash card</p> }));
vi.mock("./system-page", () => ({
  SystemPage: (props: { title: string; description: string; children: ReactNode }) => (
    <div>
      <h1>{props.title}</h1>
      <p>{props.description}</p>
      <div>{props.children}</div>
    </div>
  ),
}));
vi.mock("@/lib/api/system-queries", () => ({
  useAdminProviders: () => ({
    data: { providers: [mocks.provider], types: [] },
    isLoading: false,
    dataUpdatedAt: 1,
  }),
  useAdminTestProvider: () => mocks.test,
  useAdminUpdateProvider: () => mocks.update,
}));
const { GeneralPage } = await import("./general-page");
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.provider.managedByEnv = false;
  mocks.test.variables = { type: "sftpgo", baseUrl: "http://original" };
});

it("gathers the address, SFTPGo connection, home template, and Trash on one page", () => {
  render(<GeneralPage />);

  expect(screen.getByRole("heading", { name: "General" })).toBeTruthy();
  expect(screen.getByText("Server address card")).toBeTruthy();
  expect(screen.getByText("SFTPGo connection")).toBeTruthy();
  expect(screen.getByText("Home template")).toBeTruthy();
  expect(screen.getByText("Trash card")).toBeTruthy();
});

it("requires a successful probe for the current candidate URL before saving", () => {
  const view = render(<GeneralPage />);
  fireEvent.change(screen.getByLabelText("SFTPGo address"), {
    target: { value: "http://candidate" },
  });
  expect(
    (screen.getByRole("button", { name: "Save connection" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Test new URL" }));
  expect(mocks.test.mutate).toHaveBeenCalledWith({ type: "sftpgo", baseUrl: "http://candidate" });
  mocks.test.variables = { type: "sftpgo", baseUrl: "http://candidate" };
  view.rerender(<GeneralPage />);
  fireEvent.click(screen.getByRole("button", { name: "Save connection" }));
  expect(mocks.update.mutate).toHaveBeenCalledWith({
    id: mocks.provider.id,
    patch: { baseUrl: "http://candidate" },
  });
});

it("explains when the deployment owns the connection URL", () => {
  mocks.provider.managedByEnv = true;
  render(<GeneralPage />);
  expect((screen.getByLabelText("SFTPGo address") as HTMLInputElement).disabled).toBe(true);
  expect(screen.getByText(/Remove SFTPGO_URL to manage the connection here/)).toBeTruthy();
});

it("saves an edited home template only once it plausibly parses", () => {
  render(<GeneralPage />);
  const template = screen.getByLabelText("Template");
  expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);

  fireEvent.change(template, { target: { value: "nonsense" } });
  expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);

  fireEvent.change(template, { target: { value: "sftpgo:/homes/{username}" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(mocks.update.mutate).toHaveBeenCalledWith({
    id: mocks.provider.id,
    patch: { config: { homeTemplate: "sftpgo:/homes/{username}" } },
  });
});
