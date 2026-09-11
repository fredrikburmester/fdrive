// @vitest-environment jsdom
import type { FsEntry, ManagedShare } from "@fdrive/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ShareDialog } from "./share-dialog";

const calls = vi.hoisted(() => ({ create: vi.fn(), update: vi.fn() }));
vi.mock("@/lib/shares/management", () => ({ useShareManagement: () => calls }));
const entry: FsEntry = {
  name: "a.txt",
  path: "/a.txt",
  kind: "file",
  size: 1,
  modifiedAt: "2026-01-01T00:00:00Z",
  ext: ".txt",
  mime: "text/plain",
};
const share: ManagedShare = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Link",
  description: "",
  scope: "read",
  paths: [entry.path],
  publicPath: "/s/00000000-0000-4000-8000-000000000001",
  hasPassword: true,
  expiresAt: null,
  maxDownloads: 0,
  usedDownloads: 0,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  presentation: "auto",
};
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
it("clears transient password immediately, returns a copyable public link and closes", async () => {
  let resolve: (value: ManagedShare) => void = () => {};
  calls.create.mockImplementation(
    () =>
      new Promise<ManagedShare>((done) => {
        resolve = done;
      }),
  );
  const close = vi.fn();
  const copy = vi
    .fn()
    .mockRejectedValueOnce(new Error("Clipboard unavailable"))
    .mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: copy } });
  render(<ShareDialog entries={[entry]} onClose={close} />);
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "transient-password" } });
  fireEvent.click(screen.getByRole("button", { name: "Create link" }));
  expect((screen.getByLabelText("Password") as HTMLInputElement).value).toBe("");
  expect((screen.getByLabelText("Password") as HTMLInputElement).type).toBe("password");
  expect(calls.create).toHaveBeenCalledWith(
    expect.objectContaining({ password: "transient-password", paths: ["/a.txt"] }),
  );
  resolve(share);
  await screen.findByRole("dialog", { name: "Share link ready" });
  fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
  await screen.findByText("Could not copy the link. Select and copy it below.");
  fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
  expect(copy).toHaveBeenLastCalledWith(`http://localhost:3000${share.publicPath}`);
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(close).toHaveBeenCalledOnce();
});
it("editing a name preserves the existing password and keeps API failures visible", async () => {
  calls.update.mockRejectedValue(new Error("Permission denied"));
  render(<ShareDialog entries={[entry]} share={share} onClose={vi.fn()} />);
  expect(screen.queryByLabelText("New password")).toBeNull();
  fireEvent.change(screen.getByLabelText("Link name"), { target: { value: "Renamed" } });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await screen.findByText("Permission denied");
  expect(calls.update).toHaveBeenCalledWith(share.id, expect.objectContaining({ name: "Renamed" }));
  expect(calls.update.mock.calls[0]?.[1]).not.toHaveProperty("password");
});

it("shows friendly access and password labels for every selected option", async () => {
  const view = render(
    <ShareDialog entries={[{ ...entry, kind: "dir" }]} share={share} onClose={vi.fn()} />,
  );
  expect(screen.getByRole("combobox", { name: "Access" }).textContent).toContain("Can view");
  expect(screen.getByRole("combobox", { name: "Password protection" }).textContent).toContain(
    "Keep existing password",
  );
  fireEvent.click(screen.getByRole("combobox", { name: "Access" }));
  fireEvent.keyDown(await screen.findByRole("option", { name: "Can upload" }), { key: "Enter" });
  expect(screen.getByRole("combobox", { name: "Access" }).textContent).toContain("Can upload");
  view.unmount();
  for (const label of ["Change password", "Remove password"]) {
    const passwordView = render(<ShareDialog entries={[entry]} share={share} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("combobox", { name: "Password protection" }));
    fireEvent.keyDown(await screen.findByRole("option", { name: label }), { key: "Enter" });
    expect(screen.getByRole("combobox", { name: "Password protection" }).textContent).toContain(
      label,
    );
    passwordView.unmount();
  }
  render(
    <ShareDialog entries={[entry]} share={{ ...share, hasPassword: false }} onClose={vi.fn()} />,
  );
  expect(screen.getByRole("combobox", { name: "Password protection" }).textContent).toContain(
    "Keep without password",
  );
}, 15000);
it("shows a friendly Show as label for every presentation option", async () => {
  render(<ShareDialog entries={[entry]} share={share} onClose={vi.fn()} />);
  expect(screen.getByRole("combobox", { name: "Show as" }).textContent).toContain("Automatic");
  fireEvent.click(screen.getByRole("combobox", { name: "Show as" }));
  fireEvent.keyDown(await screen.findByRole("option", { name: "Gallery" }), { key: "Enter" });
  expect(screen.getByRole("combobox", { name: "Show as" }).textContent).toContain("Gallery");
});
it("generates a random visible password and reveals it via the eye toggle", async () => {
  render(<ShareDialog entries={[entry]} onClose={vi.fn()} />);
  const password = screen.getByLabelText("Password") as HTMLInputElement;
  expect(password.type).toBe("password");
  fireEvent.click(screen.getByRole("button", { name: "Generate" }));
  expect(password.type).toBe("text");
  expect(password.value).toHaveLength(20);
  fireEvent.click(screen.getByRole("button", { name: "Hide password" }));
  expect(password.type).toBe("password");
  fireEvent.click(screen.getByRole("button", { name: "Show password" }));
  expect(password.type).toBe("text");
});
