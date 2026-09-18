// @vitest-environment jsdom
import type { PublicProvider } from "@fdrive/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { allCapabilities, storageNote } from "@/lib/identity/capabilities";

/** The note for storage with none of the features fdrive builds on SFTPGo. */
const FILES_ONLY_NOTE = storageNote({ ...allCapabilities(false), trash: true }) as string;

const login = vi.hoisted(() => ({
  mutate: vi.fn(),
  reset: vi.fn(),
  isPending: false,
  isError: false,
  error: null,
}));
vi.mock("@/lib/api/auth-queries", () => ({ useLogin: () => login }));
const { LoginForm } = await import("./login-form");

const sftpgo: PublicProvider = {
  id: "00000000-0000-4000-8000-000000000001",
  type: "sftpgo",
  label: "files.example.org",
  credentialFields: [
    { name: "username", label: "Username", kind: "text", required: true },
    { name: "password", label: "Password", kind: "password", required: true },
    { name: "otp", label: "One-time code", kind: "otp", required: false, transient: true },
  ],
  capabilities: allCapabilities(true),
};
const other: PublicProvider = {
  id: "00000000-0000-4000-8000-000000000002",
  type: "sftpgo",
  label: "archive.example.org",
  credentialFields: [
    { name: "username", label: "Archive user", kind: "text", required: true },
    { name: "password", label: "Archive password", kind: "password", required: true },
  ],
  capabilities: allCapabilities(true),
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("renders one provider's fields, names it, and submits its id with the credential", () => {
  render(<LoginForm providers={[sftpgo]} />);

  expect(screen.getByText("Sign in with your SFTPGo account on files.example.org")).toBeTruthy();
  expect(screen.queryByLabelText("Server")).toBeNull();
  fireEvent.change(screen.getByLabelText("Username"), { target: { value: "alice" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "pw" } });
  // The optional code stays behind its link until asked for, and is left
  // out of the credential while blank.
  expect(screen.queryByLabelText("One-time code")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

  expect(login.mutate).toHaveBeenCalledWith({
    providerId: sftpgo.id,
    credential: { username: "alice", password: "pw" },
  });
});

it("reveals the one-time code on request and sends it when filled", () => {
  render(<LoginForm providers={[sftpgo]} />);

  fireEvent.click(screen.getByRole("button", { name: "Use a one-time code" }));
  fireEvent.change(screen.getByLabelText("Username"), { target: { value: "alice" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "pw" } });
  fireEvent.change(screen.getByLabelText("One-time code"), { target: { value: "123456" } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

  expect(login.mutate).toHaveBeenCalledWith({
    providerId: sftpgo.id,
    credential: { username: "alice", password: "pw", otp: "123456" },
  });
});

it("falls back to the default fields and no provider id when the list is empty", () => {
  render(<LoginForm providers={[]} />);

  expect(screen.getByText("Sign in with your account")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Username"), { target: { value: "alice" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "pw" } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

  expect(login.mutate).toHaveBeenCalledWith({ credential: { username: "alice", password: "pw" } });
});

it("shows a picker for several providers and renders the chosen one's fields", () => {
  render(<LoginForm providers={[sftpgo, other]} />);

  expect(screen.getByText("Choose a server and sign in")).toBeTruthy();
  expect(screen.getByLabelText("Server")).toBeTruthy();
  expect(screen.getByLabelText("Username")).toBeTruthy();
  expect(screen.queryByLabelText("Archive user")).toBeNull();
});

it("does not submit while a required field is blank", () => {
  render(<LoginForm providers={[sftpgo]} />);

  fireEvent.change(screen.getByLabelText("Username"), { target: { value: "alice" } });
  fireEvent.submit(screen.getByRole("button", { name: "Sign in" }).closest("form") as Element);

  expect(login.mutate).not.toHaveBeenCalled();
});

it("says a files-only storage is files only, and says nothing for full storage", () => {
  const bucket: PublicProvider = {
    ...other,
    type: "s3",
    label: "Media bucket",
    capabilities: { ...allCapabilities(false), trash: true },
  };
  const { unmount } = render(<LoginForm providers={[bucket]} />);
  expect(screen.getByText(FILES_ONLY_NOTE)).toBeTruthy();
  unmount();

  render(<LoginForm providers={[sftpgo]} />);
  expect(screen.queryByText(FILES_ONLY_NOTE)).toBeNull();
});
