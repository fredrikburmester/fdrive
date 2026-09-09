// @vitest-environment jsdom
import type { MeResponse } from "@fdrive/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { accountTransition } from "@/lib/account/transition";
import { apiClient } from "@/lib/api/client";
import { IdentitiesCard } from "./identities-card";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
const me: MeResponse = {
  account: { id: "a", displayName: "Ada" },
  identities: [
    { id: "one", username: "ada", providerType: "sftpgo", providerLabel: "Main" },
    { id: "two", username: "bob", providerType: "sftpgo", providerLabel: "Other" },
  ],
  activeIdentityId: "one",
  isAdmin: false,
};
afterEach(() => {
  cleanup();
  accountTransition.finish(false);
  vi.restoreAllMocks();
});

beforeEach(() => {
  // Each identity row loads its own index status; keep it pending here so
  // these tests stay about linking and unlinking.
  vi.spyOn(apiClient, "identityScope").mockImplementation(() => new Promise(() => {}));
});

it("confirms the exact login, explains retained files, and reports unlink conflicts", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  client.setQueryData(["auth", "me"], me);
  const unlink = vi
    .spyOn(apiClient, "unlinkIdentity")
    .mockRejectedValueOnce(new Error("Login changed elsewhere"));
  render(
    <QueryClientProvider client={client}>
      <IdentitiesCard />
    </QueryClientProvider>,
  );
  expect(screen.getByText("Active")).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Unlink bob" }));
  expect(screen.getByRole("dialog", { name: "Unlink bob?" })).toBeDefined();
  expect(screen.getByText(/Other. Files remain on the server/)).toBeDefined();
  // Unlinking re-authenticates: the button stays disabled until the owner's password is entered.
  expect(screen.getByRole("button", { name: "Unlink login" }).hasAttribute("disabled")).toBe(true);
  fireEvent.change(screen.getByLabelText("Your current password"), { target: { value: "mine" } });
  fireEvent.click(screen.getByRole("button", { name: "Unlink login" }));
  await waitFor(() => expect(screen.getByText("Login changed elsewhere")).toBeDefined());
  expect(unlink).toHaveBeenCalledWith("two", { currentPassword: "mine" });
  expect((screen.getByLabelText("Your current password") as HTMLInputElement).value).toBe("");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "Link login" }));
  expect(screen.getByRole("dialog", { name: "Link login" })).toBeDefined();
});

it("keeps the last identity linked, and disables controls while loading", async () => {
  vi.spyOn(apiClient, "me").mockImplementation(() => new Promise(() => {}));
  const client = new QueryClient();
  const { rerender } = render(
    <QueryClientProvider client={client}>
      <IdentitiesCard />
    </QueryClientProvider>,
  );
  expect(screen.getByRole("button", { name: "Link login" }).hasAttribute("disabled")).toBe(true);
  client.setQueryData(["auth", "me"], { ...me, identities: me.identities.slice(0, 1) });
  rerender(
    <QueryClientProvider client={client}>
      <IdentitiesCard />
    </QueryClientProvider>,
  );
  expect(screen.getByRole("button", { name: "Unlink ada" }).hasAttribute("disabled")).toBe(true);
});
