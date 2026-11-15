// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const login = vi.hoisted(() => ({
  mutate: vi.fn(),
  reset: vi.fn(),
  isPending: false,
  isError: false,
  error: null as unknown,
}));
vi.mock("@/lib/api/auth-queries", () => ({ useLogin: () => login }));
const { LoginForm } = await import("./login-form");

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  login.isError = false;
  login.error = null;
});

it("asks for a username and a password and submits exactly those", () => {
  render(<LoginForm />);

  expect(screen.getByText("Sign in with your fdrive account")).toBeTruthy();
  expect(screen.queryByLabelText("Server")).toBeNull();
  expect(screen.queryByRole("combobox")).toBeNull();
  expect(screen.queryByText(/one-time code/i)).toBeNull();
  fireEvent.change(screen.getByLabelText("Username"), { target: { value: "alice" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "pw" } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

  expect(login.mutate).toHaveBeenCalledWith({ username: "alice", password: "pw" });
});

it("does not submit while either field is blank", () => {
  render(<LoginForm />);
  const form = screen.getByRole("button", { name: "Sign in" }).closest("form") as Element;

  fireEvent.change(screen.getByLabelText("Username"), { target: { value: "alice" } });
  fireEvent.submit(form);
  fireEvent.change(screen.getByLabelText("Username"), { target: { value: "" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "pw" } });
  fireEvent.submit(form);

  expect(login.mutate).not.toHaveBeenCalled();
});

it("shows the server's sentence when it refuses what was typed", async () => {
  const { ApiClientError } = await import("@fdrive/contracts");
  login.isError = true;
  login.error = new ApiClientError("unauthorized", "invalid username or password", 401);
  render(<LoginForm />);

  expect(screen.getByText("Invalid username or password.")).toBeTruthy();
});
