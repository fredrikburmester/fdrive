// @vitest-environment jsdom
import { ApiClientError } from "@fdrive/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { apiClient } from "@/lib/api/client";
import { makeIdentity } from "@/test-fixtures/identity";
import { DesktopConnect } from "./desktop-connect";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const identity = makeIdentity({ providerLabel: "Personal", username: "alice" });
function mount() {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <DesktopConnect requestId="request" identities={[identity]} />
    </QueryClientProvider>,
  );
}
it("defaults v2 grants to read and sends only explicitly selected write access", async () => {
  vi.spyOn(apiClient, "desktopPairing").mockResolvedValue({
    deviceName: "Mac",
    code: "ABCD1234",
    expiresAt: new Date().toISOString(),
    approved: false,
    supportsWrites: true,
  });
  const approve = vi.spyOn(apiClient, "approveDesktopPairing").mockResolvedValue({ ok: true });
  mount();
  fireEvent.click(await screen.findByRole("checkbox"));
  const access = screen.getByRole("combobox", { name: "Personal access" });
  expect((access as HTMLSelectElement).value).toBe("read");
  fireEvent.change(access, { target: { value: "full" } });
  fireEvent.change(access, { target: { value: "read" } });
  fireEvent.change(access, { target: { value: "full" } });
  fireEvent.click(screen.getByRole("button", { name: "Allow selected logins" }));
  await screen.findByText("Connection approved");
  expect(approve).toHaveBeenCalledWith("request", [identity.id], { [identity.id]: "full" });
});
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
