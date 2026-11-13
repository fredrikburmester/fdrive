// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  update: vi.fn(),
  mutate: vi.fn(),
  refetch: vi.fn(),
  reset: vi.fn(),
}));
vi.mock("@/lib/api/trash-settings-queries", () => ({
  useSystemTrash: () => mocks.query(),
  useUpdateTrashSettings: () => mocks.update(),
}));
const { TrashSettingsCard, TrashSettingsForm, TrashReview } = await import("./trash-settings-card");
const saved = {
  providerId: "00000000-0000-4000-8000-000000000001",
  revision: 3,
  enabled: false,
  path: "/.trash",
  retentionHours: null,
  strategy: "move",
} as const;
const PROVIDER = { id: saved.providerId, label: "Primary" };
beforeEach(() => {
  mocks.query.mockReturnValue({ data: saved, refetch: mocks.refetch });
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
function enable() {
  fireEvent.click(screen.getByRole("switch", { name: "Enable Trash" }));
}
function saveButton() {
  return screen.getByRole("button", { name: "Save and continue" }) as HTMLButtonElement;
}
describe("Trash settings", () => {
  it("saves the provider-bound revision before continuing", () => {
    const next = vi.fn();
    render(<TrashSettingsCard provider={PROVIDER} onContinue={next} />);
    enable();
    expect(saveButton().disabled).toBe(false);
    fireEvent.click(saveButton());
    expect(mocks.mutate).toHaveBeenCalledWith({ ...saved, enabled: true }, expect.anything());
    expect(next).not.toHaveBeenCalled();
    act(() => mocks.mutate.mock.calls[0]?.[1].onSuccess());
    expect(next).toHaveBeenCalledOnce();
  });
  it("saves an edited folder", () => {
    render(<TrashSettingsCard provider={PROVIDER} onContinue={vi.fn()} />);
    enable();
    fireEvent.change(screen.getByLabelText("Trash folder"), { target: { value: "/recycle" } });
    fireEvent.click(saveButton());
    expect(mocks.mutate).toHaveBeenCalledWith(
      { ...saved, enabled: true, path: "/recycle" },
      expect.anything(),
    );
  });
  it("discards invalid unsaved inputs when skipping", () => {
    const next = vi.fn();
    render(<TrashSettingsCard provider={PROVIDER} onContinue={next} />);
    enable();
    fireEvent.change(screen.getByLabelText("Trash folder"), { target: { value: "/" } });
    fireEvent.change(screen.getByLabelText("Retention in hours (optional)"), {
      target: { value: "-1" },
    });
    expect(saveButton().disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Skip Trash" }));
    expect(mocks.mutate).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });
  it("disables previously enabled integration when skipping without saving invalid draft", () => {
    mocks.query.mockReturnValue({ data: { ...saved, enabled: true } });
    render(<TrashSettingsCard provider={PROVIDER} onContinue={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Trash folder"), { target: { value: "/" } });
    fireEvent.click(screen.getByRole("button", { name: "Skip Trash" }));
    expect(mocks.mutate).toHaveBeenCalledWith(saved, expect.anything());
  });
  it("can disable Trash despite invalid unsaved fields", () => {
    mocks.query.mockReturnValue({ data: { ...saved, enabled: true } });
    render(<TrashSettingsCard provider={PROVIDER} />);
    fireEvent.change(screen.getByLabelText("Trash folder"), { target: { value: "/" } });
    fireEvent.change(screen.getByLabelText("Retention in hours (optional)"), {
      target: { value: "-1" },
    });
    enable();
    const save = screen.getByRole("button", { name: "Save Trash settings" }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    expect(mocks.mutate).toHaveBeenCalledWith(saved, expect.anything());
  });
  it("reports errors and reloads saved settings without advancing", () => {
    const next = vi.fn();
    mocks.update.mockReturnValue({
      mutate: mocks.mutate,
      reset: mocks.reset,
      isError: true,
      error: new Error("conflict"),
    });
    render(<TrashSettingsCard provider={PROVIDER} onContinue={next} />);
    expect(screen.getByRole("alert")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reload saved settings" }));
    expect(mocks.refetch).toHaveBeenCalledOnce();
    expect(mocks.reset).toHaveBeenCalledOnce();
    expect(next).not.toHaveBeenCalled();
  });
  it("lets an owner continue when optional settings cannot be fetched", () => {
    const next = vi.fn();
    mocks.query.mockReturnValue({
      isError: true,
      error: new Error("offline"),
      refetch: mocks.refetch,
    });
    render(<TrashSettingsCard provider={PROVIDER} onContinue={next} />);
    fireEvent.click(screen.getByRole("button", { name: "Continue without changing Trash" }));
    expect(next).toHaveBeenCalledOnce();
    expect(mocks.mutate).not.toHaveBeenCalled();
  });
  it("explains that fdrive moves deletes into Trash, with nothing to confirm first", () => {
    render(<TrashSettingsCard provider={PROVIDER} onContinue={vi.fn()} />);
    expect(
      screen.getByText("Restore deleted files that fdrive moved into a recycle folder."),
    ).toBeTruthy();
    expect(
      screen.getByText("Deleting a file moves it into the Trash folder instead of removing it."),
    ).toBeTruthy();
    enable();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText(/fdrive creates it on the first delete/)).toBeTruthy();
    expect(screen.getByText(/fdrive does not delete old items automatically/)).toBeTruthy();
  });
  it("cannot enable Trash for storage without one", () => {
    mocks.query.mockReturnValue({ data: { ...saved, strategy: "none" }, refetch: mocks.refetch });
    render(<TrashSettingsCard provider={PROVIDER} />);
    expect(screen.getByText("This storage has no Trash.")).toBeTruthy();
    expect(screen.getByText(/removes it permanently/)).toBeTruthy();
    const toggle = screen.getByRole("switch", { name: "Enable Trash" });
    expect(toggle.hasAttribute("disabled") || toggle.getAttribute("aria-disabled") === "true").toBe(
      true,
    );
    fireEvent.click(toggle);
    expect(screen.queryByLabelText("Trash folder")).toBeNull();
  });
  it("titles the card and adds a description only when given one", () => {
    const { unmount } = render(<TrashSettingsCard provider={PROVIDER} />);
    expect(screen.getByText("Trash")).toBeTruthy();
    expect(screen.queryByText(/System > General/)).toBeNull();
    unmount();
    render(
      <TrashSettingsCard
        provider={PROVIDER}
        description="You can change this later under System > General."
      />,
    );
    expect(screen.getByText("You can change this later under System > General.")).toBeTruthy();
  });
  it("offers a settings save outside onboarding and reviews persisted state", () => {
    render(
      <>
        <TrashSettingsCard provider={PROVIDER} />
        <TrashReview provider={PROVIDER} />
      </>,
    );
    expect(screen.getByRole("button", { name: "Save Trash settings" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Skip Trash" })).toBeNull();
    expect(screen.getByText("Off")).toBeTruthy();
  });
});

it("keeps two forms on one page apart by their control ids", () => {
  const other = { ...saved, providerId: "00000000-0000-4000-8000-000000000002" };
  mocks.query.mockImplementation(() => ({ data: saved, refetch: mocks.refetch }));
  render(
    <>
      <TrashSettingsForm provider={PROVIDER} />
      <TrashSettingsForm provider={{ id: other.providerId, label: "Spare" }} />
    </>,
  );
  const switches = screen.getAllByRole("switch", { name: "Enable Trash" });
  expect(switches).toHaveLength(2);
  expect(new Set(switches.map((element) => element.id)).size).toBe(2);
});
