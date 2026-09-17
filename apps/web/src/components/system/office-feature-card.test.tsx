// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
vi.mock("@/lib/api/public-url-queries", () => ({ useSystemPublicUrl: () => mocks.address() }));

const { OfficeFeatureCard } = await import("./office-feature-card");

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
    data: {
      configuration,
      product: "onlyoffice",
      activeProviderId: providerId,
      activeProviderLabel: "Primary",
      status: "off",
    },
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

it("shows the product, its status, and a link to the Office page", () => {
  render(<OfficeFeatureCard />);

  expect(screen.getByText("ONLYOFFICE")).toBeTruthy();
  expect(screen.getByText("off")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Open Office" }).getAttribute("href")).toBe(
    "/system/office",
  );
});

it("saves the whole configuration with only `enabled` changed", () => {
  render(<OfficeFeatureCard />);

  fireEvent.click(screen.getByRole("switch", { name: "Enable ONLYOFFICE" }));
  fireEvent.click(screen.getByRole("button", { name: "Save ONLYOFFICE settings" }));

  expect(mocks.mutate).toHaveBeenCalledWith({ ...configuration, enabled: true }, expect.anything());
});

it("turns Office off without touching the saved editor grants", () => {
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
      activeProviderLabel: "Primary",
      status: "ready",
    },
    refetch: mocks.refetch,
  });
  render(<OfficeFeatureCard />);

  fireEvent.click(screen.getByRole("switch", { name: "Enable ONLYOFFICE" }));
  fireEvent.click(screen.getByRole("button", { name: "Save ONLYOFFICE settings" }));

  expect(mocks.mutate).toHaveBeenCalledWith({ ...enabled, enabled: false }, expect.anything());
});

it("refuses to enable Office without a server address", () => {
  mocks.address.mockReturnValue({ data: { revision: 0, url: null } });
  render(<OfficeFeatureCard />);

  fireEvent.click(screen.getByRole("switch", { name: "Enable ONLYOFFICE" }));

  expect(screen.getByRole("alert").textContent).toContain("server address");
  expect(
    (screen.getByRole("button", { name: "Save ONLYOFFICE settings" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});

it("keeps editor management off this card", () => {
  render(<OfficeFeatureCard />);

  fireEvent.click(screen.getByRole("switch", { name: "Enable ONLYOFFICE" }));

  expect(screen.queryByRole("switch", { name: "Allow document editing" })).toBeNull();
  expect(screen.queryByLabelText("Users allowed to edit")).toBeNull();
});
