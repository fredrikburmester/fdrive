// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  update: vi.fn(),
  mutate: vi.fn(),
  refetch: vi.fn(),
}));
vi.mock("@/lib/api/trash-settings-queries", () => ({
  useTrashSettings: () => mocks.query(),
  useUpdateTrashSettings: () => mocks.update(),
}));
const { TrashSettingsCard } = await import("./trash-settings-card");

function updating(state: { isPending?: boolean; isError?: boolean; error?: unknown } = {}) {
  mocks.update.mockReturnValue({
    mutate: mocks.mutate,
    isPending: false,
    isError: false,
    ...state,
  });
}

beforeEach(() => {
  mocks.query.mockReturnValue({ data: { retentionDays: 30 }, isError: false });
  updating();
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const days = () => screen.getByLabelText("Days in Trash") as HTMLInputElement;
const save = () => screen.getByRole("button", { name: "Save Trash settings" }) as HTMLButtonElement;

it("shows how long Trash keeps an item, with no switch and no folder to choose", () => {
  render(<TrashSettingsCard />);

  expect(screen.getByText("Trash")).toBeTruthy();
  expect(days().value).toBe("30");
  expect(screen.getByText("Items in Trash longer than this are deleted permanently.")).toBeTruthy();
  expect(screen.queryByRole("switch")).toBeNull();
  expect(screen.queryByLabelText("Trash folder")).toBeNull();
  expect(save().disabled).toBe(true);
});

it("saves a new number of days and drops the draft once saved", () => {
  render(<TrashSettingsCard />);

  fireEvent.change(days(), { target: { value: "7" } });
  expect(save().disabled).toBe(false);
  fireEvent.click(save());

  expect(mocks.mutate).toHaveBeenCalledWith({ retentionDays: 7 }, expect.anything());
  act(() => mocks.mutate.mock.calls[0]?.[1].onSuccess());
  expect(days().value).toBe("30");
});

it.each(["", "0", "1.5", "3651"])("refuses %j days", (value) => {
  render(<TrashSettingsCard />);

  fireEvent.change(days(), { target: { value } });

  expect(screen.getByText("Enter a whole number from 1 to 3650.")).toBeTruthy();
  expect(days().getAttribute("aria-invalid")).toBe("true");
  expect(save().disabled).toBe(true);
});

it("says while it saves and when saving failed", () => {
  updating({ isPending: true });
  const { unmount } = render(<TrashSettingsCard />);
  expect(screen.getByRole("button", { name: "Saving…" })).toBeTruthy();
  expect(days().disabled).toBe(true);
  unmount();

  updating({ isError: true, error: new Error("offline") });
  render(<TrashSettingsCard />);
  expect(screen.getByRole("alert").textContent).not.toBe("");
});

it("waits for the setting and offers a retry when it cannot be read", () => {
  mocks.query.mockReturnValue({ data: undefined, isError: false });
  const { container, unmount } = render(<TrashSettingsCard />);
  expect(container.querySelector('[data-slot="skeleton"]')).toBeTruthy();
  expect(screen.queryByLabelText("Days in Trash")).toBeNull();
  unmount();

  mocks.query.mockReturnValue({
    data: undefined,
    isError: true,
    error: new Error("offline"),
    refetch: mocks.refetch,
  });
  render(<TrashSettingsCard />);
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(mocks.refetch).toHaveBeenCalled();
});
