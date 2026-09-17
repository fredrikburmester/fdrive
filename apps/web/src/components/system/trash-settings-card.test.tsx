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
  rulesConfirmed: false,
  strategy: "native",
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
function confirmRules() {
  fireEvent.click(screen.getByRole("checkbox", { name: /I configured and tested/ }));
}
function saveButton() {
  return screen.getByRole("button", { name: "Save and continue" }) as HTMLButtonElement;
}
describe("Trash settings", () => {
  it("requires rule confirmation and saves the provider-bound revision before continuing", () => {
    const next = vi.fn();
    render(<TrashSettingsCard provider={PROVIDER} onContinue={next} />);
    enable();
    expect(saveButton().disabled).toBe(true);
    confirmRules();
    expect(saveButton().disabled).toBe(false);
    fireEvent.click(saveButton());
    expect(mocks.mutate).toHaveBeenCalledWith(
      { ...saved, enabled: true, rulesConfirmed: true },
      expect.anything(),
    );
    expect(next).not.toHaveBeenCalled();
    act(() => mocks.mutate.mock.calls[0]?.[1].onSuccess());
    expect(next).toHaveBeenCalledOnce();
  });
  it("requires new confirmation when changing the folder", () => {
    render(<TrashSettingsCard provider={PROVIDER} onContinue={vi.fn()} />);
    enable();
    confirmRules();
    fireEvent.change(screen.getByLabelText("Trash folder"), { target: { value: "/recycle" } });
    expect(saveButton().disabled).toBe(true);
    expect(screen.getByRole("checkbox").getAttribute("aria-checked")).toBe("false");
  });
  it("discards invalid unsaved inputs when skipping", () => {
    const next = vi.fn();
    render(<TrashSettingsCard provider={PROVIDER} onContinue={next} />);
    enable();
    confirmRules();
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
    mocks.query.mockReturnValue({ data: { ...saved, enabled: true, rulesConfirmed: true } });
    render(<TrashSettingsCard provider={PROVIDER} onContinue={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Trash folder"), { target: { value: "/" } });
    fireEvent.click(screen.getByRole("button", { name: "Skip Trash" }));
    expect(mocks.mutate).toHaveBeenCalledWith(
      { ...saved, rulesConfirmed: true },
      expect.anything(),
    );
  });
  it("can disable Trash despite invalid unsaved fields", () => {
    mocks.query.mockReturnValue({ data: { ...saved, enabled: true, rulesConfirmed: true } });
    render(<TrashSettingsCard provider={PROVIDER} />);
    fireEvent.change(screen.getByLabelText("Trash folder"), { target: { value: "/" } });
    fireEvent.change(screen.getByLabelText("Retention in hours (optional)"), {
      target: { value: "-1" },
    });
    enable();
    const save = screen.getByRole("button", { name: "Save Trash settings" }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    expect(mocks.mutate).toHaveBeenCalledWith(
      { ...saved, rulesConfirmed: true },
      expect.anything(),
    );
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
  it("enables a provider that moves deletes itself without SFTPGo rules", () => {
    const next = vi.fn();
    mocks.query.mockReturnValue({ data: { ...saved, strategy: "move" }, refetch: mocks.refetch });
    render(<TrashSettingsCard provider={PROVIDER} onContinue={next} />);
    expect(
      screen.getByText("Restore deleted files that fdrive moved into a recycle folder."),
    ).toBeTruthy();
    expect(screen.queryByText(/SFTPGo/)).toBeNull();
    enable();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("link", { name: "Trash setup instructions" })).toBeNull();
    expect(screen.getByText(/fdrive creates it on the first delete/)).toBeTruthy();
    expect(saveButton().disabled).toBe(false);
    fireEvent.click(saveButton());
    expect(mocks.mutate).toHaveBeenCalledWith(
      { ...saved, strategy: "move", enabled: true },
      expect.anything(),
    );
  });
  it("cannot enable Trash for a provider without one", () => {
    mocks.query.mockReturnValue({ data: { ...saved, strategy: "none" }, refetch: mocks.refetch });
    render(<TrashSettingsCard provider={PROVIDER} />);
    expect(screen.getByText("This storage server has no Trash.")).toBeTruthy();
    expect(screen.getByText(/removes it permanently/)).toBeTruthy();
    const toggle = screen.getByRole("switch", { name: "Enable Trash" });
    expect(toggle.hasAttribute("disabled") || toggle.getAttribute("aria-disabled") === "true").toBe(
      true,
    );
    fireEvent.click(toggle);
    expect(screen.queryByLabelText("Trash folder")).toBeNull();
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

it("keeps two servers' forms on one page apart by their control ids", () => {
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
