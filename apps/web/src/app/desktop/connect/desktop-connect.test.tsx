// @vitest-environment jsdom
import { ApiClientError } from "@fdrive/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { apiClient } from "@/lib/api/client";
import { makeIdentity, makeMe } from "@/test-fixtures/identity";
import { DesktopConnect } from "./desktop-connect";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const identity = makeIdentity({ providerLabel: "Personal", username: "alice" });
function mount() {
  vi.spyOn(apiClient, "me").mockResolvedValue(makeMe({ identities: [identity] }));
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <DesktopConnect requestId="request" initialMe={makeMe({ identities: [identity] })} />
    </QueryClientProvider>,
  );
}
it("requires explicit login selection and displays approval without credentials", async () => {
  vi.spyOn(apiClient, "desktopPairing").mockResolvedValue({
    deviceName: "Mac",
    code: "ABCD1234",
    expiresAt: new Date().toISOString(),
    approved: false,
  });
  const approve = vi.spyOn(apiClient, "approveDesktopPairing").mockResolvedValue({ ok: true });
  mount();
  expect(
    ((await screen.findByRole("button", { name: "Allow selected logins" })) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  const checkbox = screen.getByRole("checkbox");
  fireEvent.click(checkbox);
  fireEvent.click(checkbox);
  expect(
    (screen.getByRole("button", { name: "Allow selected logins" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  fireEvent.click(checkbox);
  fireEvent.click(screen.getByRole("button", { name: "Allow selected logins" }));
  await screen.findByText("Connection approved");
  expect(approve).toHaveBeenCalledWith("request", [identity.id]);
  expect(screen.queryByRole("checkbox")).toBeNull();
});
it("keeps approval failures visible and prevents expired requests from being approved", async () => {
  const info = vi.spyOn(apiClient, "desktopPairing").mockResolvedValue({
    deviceName: "Mac",
    code: "ABCD1234",
    expiresAt: new Date().toISOString(),
    approved: false,
  });
  vi.spyOn(apiClient, "approveDesktopPairing").mockRejectedValue(
    new ApiClientError("not_found", "Request expired", 404),
  );
  mount();
  await screen.findByRole("checkbox");
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Allow selected logins" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toBeTruthy());
  cleanup();
  info.mockRejectedValue(new ApiClientError("not_found", "Request expired", 404));
  mount();
  await screen.findByRole("alert");
  expect(screen.queryByRole("button", { name: "Allow selected logins" })).toBeNull();
});

it("refreshes names in an open approval screen while keeping equal labels and usernames separate", async () => {
  vi.spyOn(apiClient, "desktopPairing").mockResolvedValue({
    deviceName: "Mac",
    code: "ABCD1234",
    expiresAt: new Date().toISOString(),
    approved: false,
  });
  const second = makeIdentity({
    id: "second-identity",
    providerId: "second-provider",
    providerLabel: "<b>Home storage</b>",
    username: "alice",
  });
  const fresh = makeMe({
    identities: [{ ...identity, providerLabel: "<b>Home storage</b>" }, second],
  });
  const me = vi
    .spyOn(apiClient, "me")
    .mockResolvedValue(makeMe({ identities: [identity, second] }));
  const approve = vi.spyOn(apiClient, "approveDesktopPairing").mockResolvedValue({ ok: true });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <DesktopConnect requestId="request" initialMe={makeMe({ identities: [identity, second] })} />
    </QueryClientProvider>,
  );
  await screen.findAllByRole("checkbox");
  me.mockResolvedValue(fresh);
  await client.invalidateQueries({ queryKey: ["auth", "me"] });
  await waitFor(() => expect(screen.getAllByText("<b>Home storage</b>")).toHaveLength(2));
  expect(screen.getAllByText("alice")).toHaveLength(2);
  expect(document.querySelector("b")).toBeNull();
  fireEvent.click(screen.getAllByRole("checkbox")[1] as HTMLElement);
  fireEvent.click(screen.getByRole("button", { name: "Allow selected logins" }));
  await screen.findByText("Connection approved");
  expect(approve).toHaveBeenCalledWith("request", [second.id]);
});
