// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsSheet, SystemSettingsButton } from "./settings-sheet";

afterEach(cleanup);

function mount(overrides: Partial<Parameters<typeof SettingsSheet>[0]> = {}): {
  onOpenChange: ReturnType<typeof vi.fn>;
  onReset: ReturnType<typeof vi.fn>;
} {
  const onOpenChange = vi.fn();
  const onReset = vi.fn();
  render(
    <SettingsSheet
      title="Indexer settings"
      description="Applied on the next scan."
      open
      onOpenChange={onOpenChange}
      dirty={false}
      invalid={false}
      pending={false}
      onSave={vi.fn()}
      onReset={onReset}
      {...overrides}
    >
      <p>Fields</p>
    </SettingsSheet>,
  );
  return { onOpenChange, onReset };
}

describe("SettingsSheet", () => {
  it("shows the title, description, body, and Save/Reset", () => {
    mount();

    expect(screen.getByText("Indexer settings")).toBeTruthy();
    expect(screen.getByText("Applied on the next scan.")).toBeTruthy();
    expect(screen.getByText("Fields")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Reset" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("closes without asking when the draft is clean", () => {
    const { onOpenChange } = mount();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.queryByText("Discard unsaved changes?")).toBeNull();
  });

  it("asks before closing a dirty draft and keeps the sheet open on Cancel", () => {
    const { onOpenChange, onReset } = mount({ dirty: true });

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(screen.getByText("Discard unsaved changes?")).toBeTruthy();
    expect(onOpenChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onReset).not.toHaveBeenCalled();
  });

  it("resets the draft and closes when the change is discarded", () => {
    const { onOpenChange, onReset } = mount({ dirty: true });

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));

    expect(onReset).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("closes a dirty draft without asking while a save is in flight", () => {
    const { onOpenChange } = mount({ dirty: true, pending: true });

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("lists why an invalid draft cannot be saved", () => {
    mount({ dirty: true, invalid: true, validationMessages: ["Workers must be 1-16."] });

    expect(screen.getByText("Workers must be 1-16.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("SystemSettingsButton", () => {
  it("opens the sheet when clicked", () => {
    const onClick = vi.fn();
    render(<SystemSettingsButton onClick={onClick} />);

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));

    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
