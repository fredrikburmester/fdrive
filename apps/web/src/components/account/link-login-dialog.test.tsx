// @vitest-environment jsdom
import type { MeResponse } from "@fdrive/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { accountTransition } from "@/lib/account/transition";
import { apiClient } from "@/lib/api/client";
import { LinkLoginDialog } from "./link-login-dialog";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
afterEach(() => {
  cleanup();
  accountTransition.finish(false);
  vi.restoreAllMocks();
});

it("clears password and OTP on close, rejects empty credentials, and never caches credentials", async () => {
  const client = new QueryClient();
  const onOpenChange = vi.fn();
  const link = vi.spyOn(apiClient, "linkIdentity").mockRejectedValue(new Error("Invalid login"));
  const { rerender } = render(
    <QueryClientProvider client={client}>
      <LinkLoginDialog open onOpenChange={onOpenChange} />
    </QueryClientProvider>,
  );
  const submit = screen.getByRole("button", { name: "Add login" });
  expect(submit.hasAttribute("disabled")).toBe(true);
  fireEvent.change(screen.getByLabelText("Username"), { target: { value: "ada" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "private-password" } });
  fireEvent.change(screen.getByLabelText("One-time code"), { target: { value: "123456" } });
  fireEvent.change(screen.getByLabelText("Your current password"), {
    target: { value: "my-password" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(onOpenChange).toHaveBeenCalledWith(false);
  rerender(
    <QueryClientProvider client={client}>
      <LinkLoginDialog open onOpenChange={onOpenChange} />
    </QueryClientProvider>,
  );
  expect((screen.getByLabelText("Password") as HTMLInputElement).value).toBe("");
  expect((screen.getByLabelText("One-time code") as HTMLInputElement).value).toBe("");
  expect((screen.getByLabelText("Your current password") as HTMLInputElement).value).toBe("");
  fireEvent.change(screen.getByLabelText("Username"), { target: { value: "ada" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "private-password" } });
  expect(submit.hasAttribute("disabled")).toBe(true);
  fireEvent.change(screen.getByLabelText("Your current password"), {
    target: { value: "my-password" },
  });
  fireEvent.click(submit);
  await waitFor(() => expect(screen.getByText("Invalid login")).toBeDefined());
  expect(link).toHaveBeenCalledWith({
    credential: { username: "ada", password: "private-password" },
    currentCredential: { password: "my-password" },
  });
  expect((screen.getByLabelText("Password") as HTMLInputElement).value).toBe("");
  expect((screen.getByLabelText("Your current password") as HTMLInputElement).value).toBe("");
  expect(client.getMutationCache().getAll()).toEqual([]);
});

it("disables repeated submission while pending and closes on success", async () => {
  let resolve: ((me: MeResponse) => void) | undefined;
  const link = vi.spyOn(apiClient, "linkIdentity").mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const onOpenChange = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <LinkLoginDialog open onOpenChange={onOpenChange} />
    </QueryClientProvider>,
  );
  fireEvent.change(screen.getByLabelText("Username"), { target: { value: "ada" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secret" } });
  fireEvent.change(screen.getByLabelText("Your current password"), { target: { value: "mine" } });
  fireEvent.click(screen.getByRole("button", { name: "Add login" }));
  await waitFor(() => expect(link).toHaveBeenCalledTimes(1));
  expect(screen.getByRole("button", { name: "Adding…" }).hasAttribute("disabled")).toBe(true);
  await act(async () => {
    resolve?.({
      account: { id: "a", displayName: "Ada" },
      identities: [],
      activeIdentityId: "i",
      isAdmin: false,
    });
  });
  expect(onOpenChange).toHaveBeenCalledWith(false);
});
