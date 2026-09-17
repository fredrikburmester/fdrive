// @vitest-environment jsdom
import type { PublicProvider } from "@fdrive/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { allCapabilities, FILES_ONLY_NOTE } from "@/lib/identity/capabilities";
import { ProviderPicker } from "./provider-picker";

afterEach(cleanup);

/** The text of the closed Select trigger named `name`, without its chevron icon. */
function triggerText(name: string): string | null {
  return (
    screen.getByRole("combobox", { name }).querySelector('[data-slot="select-value"]')
      ?.textContent ?? null
  );
}

const SEEDED: PublicProvider = {
  id: "b9c9c18d-0000-4000-8000-000000000001",
  type: "sftpgo",
  label: "",
  credentialFields: [],
  capabilities: allCapabilities(true),
};
const SECOND: PublicProvider = {
  id: "b9c9c18d-0000-4000-8000-000000000002",
  type: "sftpgo",
  label: "Archive server",
  credentialFields: [],
  capabilities: allCapabilities(true),
};

it("shows the selected provider's name in the closed trigger, not its id", () => {
  const { rerender } = render(
    <ProviderPicker
      id="server"
      providers={[SEEDED, SECOND]}
      value={SEEDED.id}
      onChange={vi.fn()}
    />,
  );
  expect(triggerText("Server")).toBe("SFTPGo");
  expect(triggerText("Server")).not.toContain(SEEDED.id);

  rerender(
    <ProviderPicker
      id="server"
      providers={[SEEDED, SECOND]}
      value={SECOND.id}
      onChange={vi.fn()}
    />,
  );
  expect(triggerText("Server")).toBe("Archive server");
});

it("shows the placeholder until a provider is chosen and reports the chosen id", async () => {
  const onChange = vi.fn();
  render(<ProviderPicker id="server" providers={[SEEDED, SECOND]} value="" onChange={onChange} />);
  expect(triggerText("Server")).toBe("Choose a server");

  fireEvent.click(screen.getByRole("combobox", { name: "Server" }));
  fireEvent.keyDown(await screen.findByRole("option", { name: /Archive server/ }), {
    key: "Enter",
  });
  expect(onChange).toHaveBeenCalledWith(SECOND.id);
});

it("says files only under a files-only choice and nothing under full storage", () => {
  const bucket: PublicProvider = {
    ...SECOND,
    type: "s3",
    capabilities: { ...allCapabilities(false), trash: true },
  };
  const { rerender } = render(
    <ProviderPicker id="p" providers={[SEEDED, bucket]} value={bucket.id} onChange={() => {}} />,
  );
  expect(screen.getByText(FILES_ONLY_NOTE)).toBeDefined();

  rerender(
    <ProviderPicker id="p" providers={[SEEDED, bucket]} value={SEEDED.id} onChange={() => {}} />,
  );
  expect(screen.queryByText(FILES_ONLY_NOTE)).toBeNull();
});
