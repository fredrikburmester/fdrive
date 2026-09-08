// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connection: {
    baseUrl: "http://original",
    host: "original",
    source: "settings",
    homeTemplate: "sftpgo:/{username}",
    reachable: true,
  },
  test: {
    data: { ok: true, detail: "Reachable" },
    variables: "http://original",
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
vi.mock("@/lib/api/system-queries", () => ({
  useAdminConnection: () => ({ data: mocks.connection, isLoading: false }),
  useAdminTestConnection: () => mocks.test,
  useAdminUpdateConnection: () => mocks.update,
}));
vi.mock("./setup-users", () => ({ SetupUsers: () => null }));
const { ConnectionPage } = await import("./connection-page");
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.connection.source = "settings";
  mocks.test.variables = "http://original";
});

it("requires a successful probe for the current candidate URL before saving", () => {
  const view = render(<ConnectionPage />);
  fireEvent.change(screen.getByLabelText("Server URL"), { target: { value: "http://candidate" } });
  expect(
    (screen.getByRole("button", { name: "Save connection" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Test new URL" }));
  expect(mocks.test.mutate).toHaveBeenCalledWith("http://candidate");
  mocks.test.variables = "http://candidate";
  view.rerender(<ConnectionPage />);
  fireEvent.click(screen.getByRole("button", { name: "Save connection" }));
  expect(mocks.update.mutate).toHaveBeenCalledWith({ baseUrl: "http://candidate" });
});

it("explains when the deployment owns the connection URL", () => {
  mocks.connection.source = "env";
  render(<ConnectionPage />);
  expect((screen.getByLabelText("Server URL") as HTMLInputElement).disabled).toBe(true);
  expect(screen.getByText(/Remove SFTPGO_URL to manage the connection here/)).toBeTruthy();
});
