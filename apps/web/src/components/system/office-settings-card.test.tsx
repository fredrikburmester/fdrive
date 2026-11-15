// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  address: vi.fn(),
  update: vi.fn(),
  mutate: vi.fn(),
  refetch: vi.fn(),
  reset: vi.fn(),
  users: vi.fn(),
}));
vi.mock("@/lib/api/office-settings-queries", () => ({
  useSystemOffice: () => mocks.query(),
  useUpdateOfficeSettings: () => mocks.update(),
}));
vi.mock("@/lib/api/public-url-queries", () => ({
  useSystemPublicUrl: () => mocks.address(),
}));
vi.mock("@/lib/api/system-queries", () => ({
  useAdminUsers: () => mocks.users(),
}));
const { OfficeSettingsCard, OfficeReview } = await import("./office-settings-card");
const configuration = {
  revision: 2,
  enabled: false,
  editorUsernames: [],
  editingEnabled: false,
};
const user = (username: string) => ({
  username,
  disabled: false,
  isAdmin: false,
  isYou: false,
  createdAt: "2026-11-15T00:00:00.000Z",
  lastLoginAt: null,
});
beforeEach(() => {
  mocks.address.mockReturnValue({ data: { revision: 1, url: "https://files.example" } });
  mocks.users.mockReturnValue({ data: { users: ["alice", "bob", "carol"].map(user) } });
  mocks.query.mockReturnValue({
    data: { configuration, product: "onlyoffice", status: "off" },
    refetch: mocks.refetch,
  });
  mocks.update.mockReturnValue({
    mutate: mocks.mutate,
    reset: mocks.reset,
    isPending: false,
    isError: false,
  });
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const toggle = () => fireEvent.click(screen.getByRole("switch", { name: "Enable ONLYOFFICE" }));
const save = () => screen.getByRole("button", { name: "Save and continue" }) as HTMLButtonElement;
const editor = (username: string) => screen.getByRole("checkbox", { name: username });
it("saves explicit editing permission before advancing", () => {
  const next = vi.fn();
  render(<OfficeSettingsCard onContinue={next} />);
  toggle();
  fireEvent.click(screen.getByRole("switch", { name: "Allow document editing" }));
  fireEvent.click(editor("alice"));
  fireEvent.click(save());
  expect(mocks.mutate).toHaveBeenCalledWith(
    { ...configuration, enabled: true, editingEnabled: true, editorUsernames: ["alice"] },
    expect.anything(),
  );
  expect(next).not.toHaveBeenCalled();
  act(() => mocks.mutate.mock.calls[0]?.[1].onSuccess());
  expect(next).toHaveBeenCalledOnce();
});
it("refuses to enable without a server address, but allows skipping without saving drafts", () => {
  mocks.address.mockReturnValue({ data: { revision: 0, url: null } });
  const next = vi.fn();
  render(<OfficeSettingsCard onContinue={next} />);
  toggle();
  expect(save().disabled).toBe(true);
  expect(screen.getByRole("alert").textContent).toContain("server address");
  fireEvent.click(screen.getByRole("button", { name: "Skip ONLYOFFICE" }));
  expect(mocks.mutate).not.toHaveBeenCalled();
  expect(next).toHaveBeenCalledOnce();
});
it("can disable with invalid fields hidden", () => {
  const enabled = {
    ...configuration,
    enabled: true,
    editingEnabled: true,
    editorUsernames: ["alice"],
  };
  mocks.query.mockReturnValue({
    data: { configuration: enabled, product: "onlyoffice", status: "ready" },
  });
  render(<OfficeSettingsCard onContinue={vi.fn()} />);
  fireEvent.click(editor("alice"));
  toggle();
  expect(save().disabled).toBe(false);
  fireEvent.click(save());
  expect(mocks.mutate).toHaveBeenCalledWith({ ...enabled, enabled: false }, expect.anything());
});
it("shows readiness and does not require startup to finish onboarding", () => {
  mocks.query.mockReturnValue({
    data: {
      configuration: { ...configuration, enabled: true },
      product: "onlyoffice",
      status: "starting",
    },
  });
  render(<OfficeSettingsCard onContinue={vi.fn()} />);
  expect(screen.getByRole("status").textContent).toContain("You can finish setup");
  expect(save().disabled).toBe(false);
});
it("lets the owner skip an unavailable optional settings endpoint", () => {
  const next = vi.fn();
  mocks.query.mockReturnValue({
    isError: true,
    error: new Error("offline"),
    refetch: mocks.refetch,
  });
  render(<OfficeSettingsCard onContinue={next} />);
  fireEvent.click(screen.getByRole("button", { name: "Continue without changing ONLYOFFICE" }));
  expect(next).toHaveBeenCalledOnce();
});
it("supports settings after setup and reviews saved choices", () => {
  render(
    <>
      <OfficeSettingsCard />
      <OfficeReview />
    </>,
  );
  expect(screen.getByRole("button", { name: "Save ONLYOFFICE settings" })).toBeTruthy();
  expect(screen.getByText("Off")).toBeTruthy();
});
it("preserves errors without advancing and lets the owner reload", () => {
  const next = vi.fn();
  mocks.update.mockReturnValue({
    isError: true,
    error: new Error("Conflict"),
    mutate: mocks.mutate,
    reset: mocks.reset,
  });
  render(<OfficeSettingsCard onContinue={next} />);
  fireEvent.click(screen.getByRole("button", { name: "Reload saved settings" }));
  expect(mocks.reset).toHaveBeenCalledOnce();
  expect(mocks.refetch).toHaveBeenCalledOnce();
  expect(next).not.toHaveBeenCalled();
});

it("requires explicit editors chosen from fdrive's users", () => {
  render(<OfficeSettingsCard onContinue={vi.fn()} />);
  toggle();
  fireEvent.click(screen.getByRole("switch", { name: "Allow document editing" }));
  expect(save().disabled).toBe(true);
  expect(screen.getByRole("alert").textContent).toContain("choose at least one user");
  expect(screen.getAllByRole("checkbox")).toHaveLength(3);
  fireEvent.click(editor("bob"));
  fireEvent.click(editor("alice"));
  fireEvent.click(editor("carol"));
  fireEvent.click(editor("carol"));
  expect(editor("carol").getAttribute("aria-checked")).toBe("false");
  fireEvent.click(save());
  expect(mocks.mutate.mock.calls[0]?.[0].editorUsernames).toEqual(["bob", "alice"]);
});

it("drops a saved editor who is no longer one of fdrive's users", () => {
  mocks.query.mockReturnValue({
    data: {
      configuration: {
        ...configuration,
        enabled: true,
        editingEnabled: true,
        editorUsernames: ["alice", "removed"],
      },
      product: "onlyoffice",
      status: "ready",
    },
  });
  render(<OfficeSettingsCard onContinue={vi.fn()} />);
  expect(editor("alice").getAttribute("aria-checked")).toBe("true");
  expect(screen.queryByRole("checkbox", { name: "removed" })).toBeNull();
  fireEvent.click(save());
  expect(mocks.mutate.mock.calls[0]?.[0].editorUsernames).toEqual(["alice"]);
});

it("says while the users load, and offers a retry when they cannot", () => {
  mocks.query.mockReturnValue({
    data: {
      configuration: {
        ...configuration,
        enabled: true,
        editingEnabled: true,
        editorUsernames: ["alice"],
      },
      product: "onlyoffice",
      status: "ready",
    },
  });
  mocks.users.mockReturnValue({ data: undefined });
  const view = render(<OfficeSettingsCard onContinue={vi.fn()} />);
  expect(screen.getByText("Loading users…")).toBeTruthy();
  const refetch = vi.fn();
  mocks.users.mockReturnValue({ isError: true, error: new Error("offline"), refetch });
  view.rerender(<OfficeSettingsCard onContinue={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(refetch).toHaveBeenCalledOnce();
});

it("keeps the edited revision when background polling sees another owner's change", () => {
  const enabled = {
    ...configuration,
    enabled: true,
    editingEnabled: true,
    editorUsernames: ["alice"],
  };
  const response = { configuration: enabled, product: "onlyoffice", status: "ready" };
  mocks.query.mockReturnValue({ data: response });
  const next = vi.fn();
  const view = render(<OfficeSettingsCard onContinue={next} />);
  fireEvent.click(editor("bob"));
  mocks.query.mockReturnValue({
    data: { ...response, configuration: { ...enabled, revision: 3, editorUsernames: ["carol"] } },
  });
  view.rerender(<OfficeSettingsCard onContinue={next} />);
  fireEvent.click(save());
  expect(mocks.mutate.mock.calls[0]?.[0]).toMatchObject({
    revision: 2,
    editorUsernames: ["alice", "bob"],
  });
});
