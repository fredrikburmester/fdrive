// @vitest-environment jsdom
import type { PublicProvider } from "@fdrive/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { allCapabilities } from "@/lib/identity/capabilities";

const login = vi.hoisted(() => ({
  mutate: vi.fn(),
  reset: vi.fn(),
  isPending: false,
  isError: false,
  error: null,
}));
vi.mock("@/lib/api/auth-queries", () => ({ useLogin: () => login }));
const { LoginForm } = await import("./login-form");

const local: PublicProvider = {
  id: "00000000-0000-4000-8000-000000000001",
  type: "local",
  label: "files.example.org",
  credentialFields: [
    { name: "username", label: "Username", kind: "text", required: true },
    { name: "password", label: "Password", kind: "password", required: true },
    { name: "otp", label: "One-time code", kind: "otp", required: false, transient: true },
  ],
  capabilities: allCapabilities(true),
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("renders the storage's fields, names it, and submits its id with the credential", () => {
  render(<LoginForm providers={[local]} />);

  expect(screen.getByText("Sign in with your fdrive account on files.example.org")).toBeTruthy();
  expect(screen.queryByLabelText("Server")).toBeNull();
  fireEvent.change(screen.getByLabelText("Username"), { target: { value: "alice" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "pw" } });
  // The optional code stays behind its link until asked for, and is left
  // out of the credential while blank.
  expect(screen.queryByLabelText("One-time code")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

  expect(login.mutate).toHaveBeenCalledWith({
    providerId: local.id,
    credential: { username: "alice", password: "pw" },
  });
});

it("reveals the one-time code on request and sends it when filled", () => {
  render(<LoginForm providers={[local]} />);

  fireEvent.click(screen.getByRole("button", { name: "Use a one-time code" }));
  fireEvent.change(screen.getByLabelText("Username"), { target: { value: "alice" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "pw" } });
  fireEvent.change(screen.getByLabelText("One-time code"), { target: { value: "123456" } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

  expect(login.mutate).toHaveBeenCalledWith({
    providerId: local.id,
    credential: { username: "alice", password: "pw", otp: "123456" },
  });
});

it("falls back to the default fields and no provider id when the list is empty", () => {
  render(<LoginForm providers={[]} />);

  expect(screen.getByText("Sign in with your fdrive account")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Username"), { target: { value: "alice" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "pw" } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

  expect(login.mutate).toHaveBeenCalledWith({ credential: { username: "alice", password: "pw" } });
});

it("names the product alone for unnamed storage, with no picker and no storage note", () => {
  render(<LoginForm providers={[{ ...local, label: "" }]} />);

  expect(screen.getByText("Sign in with your fdrive account")).toBeTruthy();
  expect(screen.queryByLabelText("Server")).toBeNull();
  expect(screen.queryByRole("combobox")).toBeNull();
  expect(screen.queryByText(/available on this storage/)).toBeNull();
});

it("does not submit while a required field is blank", () => {
  render(<LoginForm providers={[local]} />);

  fireEvent.change(screen.getByLabelText("Username"), { target: { value: "alice" } });
  fireEvent.submit(screen.getByRole("button", { name: "Sign in" }).closest("form") as Element);

  expect(login.mutate).not.toHaveBeenCalled();
});
