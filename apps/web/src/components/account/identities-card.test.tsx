// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { accountTransition } from "@/lib/account/transition";
import { apiClient } from "@/lib/api/client";
import { allCapabilities, storageNote } from "@/lib/identity/capabilities";
import { makeIdentity, makeMe } from "@/test-fixtures/identity";
import { IdentitiesCard } from "./identities-card";

/** The note for storage with none of the features fdrive builds on SFTPGo. */
const FILES_ONLY_NOTE = storageNote({ ...allCapabilities(false), trash: true }) as string;

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
const me = makeMe({
  identities: [
    makeIdentity(),
    makeIdentity({ id: "two", username: "bob", providerLabel: "Other" }),
  ],
  activeIdentityId: "one",
});
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
  fireEvent.click(screen.getByRole("button", { name: "Remove bob" }));
  expect(screen.getByRole("dialog", { name: "Remove bob?" })).toBeDefined();
  expect(screen.getByText(/Other. Files remain on the server/)).toBeDefined();
  // Unlinking re-authenticates: the button stays disabled until the owner's password is entered.
  expect(screen.getByRole("button", { name: "Remove login" }).hasAttribute("disabled")).toBe(true);
  fireEvent.change(screen.getByLabelText("Your current password"), { target: { value: "mine" } });
  fireEvent.click(screen.getByRole("button", { name: "Remove login" }));
  await waitFor(() => expect(screen.getByText("Login changed elsewhere")).toBeDefined());
  expect(unlink).toHaveBeenCalledWith("two", { currentCredential: { password: "mine" } });
  expect((screen.getByLabelText("Your current password") as HTMLInputElement).value).toBe("");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "Add login" }));
  expect(screen.getByRole("dialog", { name: "Add login" })).toBeDefined();
});

it("names a key login by its storage and confirms removal with the key beneath", () => {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  client.setQueryData(["auth", "me"], {
    ...me,
    identities: [
      makeIdentity(),
      makeIdentity({
        id: "b2",
        providerType: "s3",
        username: "0041234abcdef",
        providerLabel: "Backblaze",
        capabilities: { scopeMapping: false, index: false, shares: false, office: false },
      }),
    ],
  });
  render(
    <QueryClientProvider client={client}>
      <IdentitiesCard />
    </QueryClientProvider>,
  );
  expect(screen.getByRole("img", { name: "S3" })).toBeDefined();
  // Only the S3 login is files only; the SFTPGo one carries no note.
  expect(screen.getAllByText(FILES_ONLY_NOTE)).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Remove Backblaze" }));
  expect(screen.getByRole("dialog", { name: "Remove Backblaze?" })).toBeDefined();
  expect(screen.getByText(/0041234abcdef. Files remain on the server/)).toBeDefined();
});

it("shows the index status only for logins whose provider maps virtual folders", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  const [ada, bob] = me.identities;
  if (ada === undefined || bob === undefined) throw new Error("fixture");
  client.setQueryData(["auth", "me"], {
    ...me,
    identities: [ada, { ...bob, capabilities: { ...bob.capabilities, scopeMapping: false } }],
  });
  const scope = vi.mocked(apiClient.identityScope);
  render(
    <QueryClientProvider client={client}>
      <IdentitiesCard />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(scope).toHaveBeenCalledTimes(1));
  expect(scope.mock.calls[0]?.[0]).toBe("one");
  expect(screen.getAllByRole("img", { name: "SFTPGo" })).toHaveLength(2);
});

it("keeps the last identity linked, and disables controls while loading", async () => {
  vi.spyOn(apiClient, "me").mockImplementation(() => new Promise(() => {}));
  const client = new QueryClient();
  const { rerender } = render(
    <QueryClientProvider client={client}>
      <IdentitiesCard />
    </QueryClientProvider>,
  );
  expect(screen.getByRole("button", { name: "Add login" }).hasAttribute("disabled")).toBe(true);
  client.setQueryData(["auth", "me"], { ...me, identities: me.identities.slice(0, 1) });
  rerender(
    <QueryClientProvider client={client}>
      <IdentitiesCard />
    </QueryClientProvider>,
  );
  expect(screen.getByRole("button", { name: "Remove ada" }).hasAttribute("disabled")).toBe(true);
});
