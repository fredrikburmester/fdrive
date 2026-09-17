// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  address: vi.fn(),
  update: vi.fn(),
  mutate: vi.fn(),
  refetch: vi.fn(),
  reset: vi.fn(),
  success: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { success: (m: string) => mocks.success(m) } }));
vi.mock("@/lib/api/office-settings-queries", () => ({
  useSystemOffice: () => mocks.query(),
  useUpdateOfficeSettings: () => mocks.update(),
}));
vi.mock("@/lib/api/public-url-queries", () => ({ useSystemPublicUrl: () => mocks.address() }));
vi.mock("./system-page", () => ({
  SystemPage: (props: {
    title: string;
    description: string;
    actions?: ReactNode;
    enabled?: boolean;
    children: ReactNode;
  }) =>
    props.enabled === false ? (
      <p>{props.title} is off</p>
    ) : (
      <div>
        <h1>{props.title}</h1>
        <p>{props.description}</p>
        <div>{props.actions}</div>
        <div>{props.children}</div>
      </div>
    ),
}));

const { OfficeSystemPage } = await import("./office-page");

const providerId = "123e4567-e89b-42d3-a456-426614174000";
const enabled = {
  revision: 2,
  enabled: true,
  editingEnabled: true,
  editingProviderId: providerId,
  editorUsernames: ["alice", "bob"],
};

function response(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      configuration: enabled,
      product: "onlyoffice",
      activeProviderId: providerId,
      activeProviderLabel: "Primary",
      status: "ready",
      ...overrides,
    },
    dataUpdatedAt: 1,
    refetch: mocks.refetch,
  };
}

beforeEach(() => {
  mocks.address.mockReturnValue({ data: { revision: 1, url: "https://files.example" } });
  mocks.query.mockReturnValue(response());
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

it("summarises the product, editing, and its editors", () => {
  render(<OfficeSystemPage />);

  expect(screen.getByText("Reachable")).toBeTruthy();
  expect(screen.getByText("ONLYOFFICE is ready.")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Office setup instructions" })).toBeTruthy();
  expect(screen.getByText(/Close open documents before disabling/)).toBeTruthy();
  expect(screen.getByText("Product")).toBeTruthy();
  expect(screen.getByText("Editing")).toBeTruthy();
  expect(screen.getByText("On")).toBeTruthy();
  // The stat card's label and the section's title.
  expect(screen.getAllByText("Editors")).toHaveLength(2);
  expect(screen.getByText("2")).toBeTruthy();
  expect(screen.getByText("alice")).toBeTruthy();
  expect(screen.getByText("bob")).toBeTruthy();
});

it("says everyone is view-only when editing is off", () => {
  mocks.query.mockReturnValue(
    response({
      configuration: { ...enabled, editingEnabled: false, editorUsernames: [] },
      status: "starting",
    }),
  );
  render(<OfficeSystemPage />);

  expect(screen.getByText("Everyone opens documents view-only.")).toBeTruthy();
  expect(screen.getByText("Unreachable")).toBeTruthy();
  expect(screen.getByText(/This resolves on its own/)).toBeTruthy();
});

it("replaces the page when Office is turned off", () => {
  mocks.query.mockReturnValue(
    response({ configuration: { ...enabled, enabled: false }, status: "off" }),
  );
  render(<OfficeSystemPage />);

  expect(screen.getByText("Office is off")).toBeTruthy();
});

it("edits and saves the editor list from the settings sheet", () => {
  render(<OfficeSystemPage />);

  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  fireEvent.change(screen.getByLabelText("Users allowed to edit"), {
    target: { value: "alice\ncarol" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));

  expect(mocks.mutate).toHaveBeenCalledWith(
    { ...enabled, editorUsernames: ["alice", "carol"] },
    expect.anything(),
  );

  mocks.mutate.mock.calls[0]?.[1].onSuccess();
  expect(mocks.success).toHaveBeenCalledWith("ONLYOFFICE settings saved.");
});

it("blocks a save that would enable Office without a server address", () => {
  mocks.address.mockReturnValue({ data: { revision: 0, url: null } });
  render(<OfficeSystemPage />);

  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  fireEvent.change(screen.getByLabelText("Users allowed to edit"), {
    target: { value: "alice\ncarol" },
  });

  expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  expect(
    screen.getByText("Set the server address on System > General before enabling Office."),
  ).toBeTruthy();
});
