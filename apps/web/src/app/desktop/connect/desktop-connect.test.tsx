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
function mount(client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  vi.spyOn(apiClient, "me").mockResolvedValue(makeMe({ identity }));
  render(
    <QueryClientProvider client={client}>
      <DesktopConnect requestId="request" initialMe={makeMe({ identity })} />
    </QueryClientProvider>,
  );
  return client;
}
function pairing(supportsWrites?: true) {
  return vi.spyOn(apiClient, "desktopPairing").mockResolvedValue({
    deviceName: "Mac",
    code: "ABCD1234",
    expiresAt: new Date().toISOString(),
    approved: false,
    ...(supportsWrites ? { supportsWrites } : {}),
  });
}
it("defaults a writable Mac to read and sends only the access chosen", async () => {
  pairing(true);
  const approve = vi.spyOn(apiClient, "approveDesktopPairing").mockResolvedValue({ ok: true });
  mount();
  const access = await screen.findByRole("combobox", { name: "Access" });
  expect((access as HTMLSelectElement).value).toBe("read");
  fireEvent.change(access, { target: { value: "full" } });
  fireEvent.change(access, { target: { value: "read" } });
  fireEvent.change(access, { target: { value: "full" } });
  fireEvent.click(screen.getByRole("button", { name: "Allow this Mac" }));
  await screen.findByText("Connection approved");
  expect(approve).toHaveBeenCalledWith("request", "full");
});
it("connects a read-only Mac to the signed-in login without offering writes", async () => {
  pairing();
  const approve = vi.spyOn(apiClient, "approveDesktopPairing").mockResolvedValue({ ok: true });
  mount();
  await screen.findByRole("button", { name: "Allow this Mac" });
  expect(screen.getByText("Personal")).toBeDefined();
  expect(screen.getByText("alice")).toBeDefined();
  expect(screen.queryByRole("combobox", { name: "Access" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Allow this Mac" }));
  await screen.findByText("Connection approved");
  expect(approve).toHaveBeenCalledWith("request", "read");
  expect(screen.queryByRole("button", { name: "Allow this Mac" })).toBeNull();
});
it("keeps approval failures visible and prevents expired requests from being approved", async () => {
  const info = pairing();
  vi.spyOn(apiClient, "approveDesktopPairing").mockRejectedValue(
    new ApiClientError("not_found", "Request expired", 404),
  );
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Allow this Mac" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toBeTruthy());
  cleanup();
  info.mockRejectedValue(new ApiClientError("not_found", "Request expired", 404));
  mount();
  await screen.findByRole("alert");
  expect(screen.queryByRole("button", { name: "Allow this Mac" })).toBeNull();
});
it("refreshes the login's names in an open approval screen as plain text", async () => {
  pairing();
  const client = mount();
  await screen.findByText("Personal");
  vi.spyOn(apiClient, "me").mockResolvedValue(
    makeMe({ identity: { ...identity, providerLabel: "<b>Home storage</b>" } }),
  );
  await client.invalidateQueries({ queryKey: ["auth", "me"] });
  await waitFor(() => expect(screen.getByText("<b>Home storage</b>")).toBeDefined());
  expect(document.querySelector("b")).toBeNull();
});
