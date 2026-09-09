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
}));
vi.mock("@/lib/api/office-settings-queries", () => ({
  useSystemOffice: () => mocks.query(),
  useUpdateOfficeSettings: () => mocks.update(),
}));
vi.mock("@/lib/api/public-url-queries", () => ({
  useSystemPublicUrl: () => mocks.address(),
}));
const { OfficeSettingsCard, OfficeReview } = await import("./office-settings-card");
const providerId = "123e4567-e89b-42d3-a456-426614174000";
const configuration = {
  revision: 2,
  enabled: false,
  editingProviderId: null,
  editorUsernames: [],
  editingEnabled: false,
};
beforeEach(() => {
  mocks.address.mockReturnValue({ data: { revision: 1, url: "https://files.example" } });
  mocks.query.mockReturnValue({
    data: { configuration, product: "onlyoffice", activeProviderId: providerId, status: "off" },
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
it("saves explicit editing permission before advancing", () => {
  const next = vi.fn();
  render(<OfficeSettingsCard onContinue={next} />);
  toggle();
  fireEvent.click(screen.getByRole("switch", { name: "Allow document editing" }));
  fireEvent.change(screen.getByLabelText("Users allowed to edit"), { target: { value: "alice" } });
  fireEvent.click(save());
  expect(mocks.mutate).toHaveBeenCalledWith(
    {
      ...configuration,
      enabled: true,
      editingEnabled: true,
      editingProviderId: providerId,
      editorUsernames: ["alice"],
    },
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
    editingProviderId: providerId,
    editorUsernames: ["alice"],
  };
  mocks.query.mockReturnValue({
    data: {
      configuration: enabled,
      product: "onlyoffice",
      activeProviderId: providerId,
      status: "ready",
    },
  });
  render(<OfficeSettingsCard onContinue={vi.fn()} />);
  fireEvent.change(screen.getByLabelText("Users allowed to edit"), { target: { value: "" } });
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
      activeProviderId: providerId,
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

it("requires explicit editors and preserves multiline input while typing", () => {
  render(<OfficeSettingsCard onContinue={vi.fn()} />);
  toggle();
  fireEvent.click(screen.getByRole("switch", { name: "Allow document editing" }));
  expect(save().disabled).toBe(true);
  const editors = screen.getByLabelText("Users allowed to edit") as HTMLTextAreaElement;
  fireEvent.change(editors, { target: { value: "alice\n" } });
  expect(editors.value).toBe("alice\n");
  fireEvent.change(editors, { target: { value: "alice\n bob\n" } });
  fireEvent.click(save());
  expect(mocks.mutate.mock.calls[0]?.[0].editorUsernames).toEqual(["alice", "bob"]);
});

it("does not copy editor grants from a different SFTPGo provider", () => {
  mocks.query.mockReturnValue({
    data: {
      configuration: {
        ...configuration,
        enabled: true,
        editingEnabled: true,
        editingProviderId: "223e4567-e89b-42d3-a456-426614174000",
        editorUsernames: ["alice"],
      },
      product: "onlyoffice",
      activeProviderId: providerId,
      status: "ready",
    },
  });
  render(<OfficeSettingsCard onContinue={vi.fn()} />);
  const editing = screen.getByRole("switch", { name: "Allow document editing" });
  expect(editing.getAttribute("aria-checked")).toBe("false");
  fireEvent.click(save());
  expect(mocks.mutate.mock.calls[0]?.[0]).toMatchObject({
    editingEnabled: false,
    editingProviderId: null,
    editorUsernames: [],
  });
  fireEvent.click(editing);
  expect((screen.getByLabelText("Users allowed to edit") as HTMLTextAreaElement).value).toBe("");
  expect(save().disabled).toBe(true);
});

it("keeps the edited revision when background polling sees another owner's change", () => {
  const enabled = {
    ...configuration,
    enabled: true,
    editingEnabled: true,
    editingProviderId: providerId,
    editorUsernames: ["alice"],
  };
  const response = {
    configuration: enabled,
    product: "onlyoffice",
    activeProviderId: providerId,
    status: "ready",
  };
  mocks.query.mockReturnValue({ data: response });
  const next = vi.fn();
  const view = render(<OfficeSettingsCard onContinue={next} />);
  fireEvent.change(screen.getByLabelText("Users allowed to edit"), {
    target: { value: "alice\nbob" },
  });
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
