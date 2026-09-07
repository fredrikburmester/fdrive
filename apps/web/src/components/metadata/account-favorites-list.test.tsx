// @vitest-environment jsdom
import type { MeResponse } from "@fdrive/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AccountFavoritesList } from "./account-favorites-list";

const me: MeResponse = {
  account: { id: "a", displayName: "Ada" },
  identities: [
    { id: "one", username: "ada", providerType: "sftpgo", providerLabel: "Main" },
    { id: "two", username: "bob", providerType: "sftpgo", providerLabel: "Other" },
  ],
  activeIdentityId: "one",
  isAdmin: false,
};
afterEach(cleanup);
it("renders both duplicate paths with ownership, partial errors, and explicit navigation targets", () => {
  const onNavigate = vi.fn();
  render(
    <AccountFavoritesList
      me={me}
      pending={false}
      onNavigate={onNavigate}
      response={{
        items: [
          { identityId: "one", path: "/same.txt", kind: "file", addedAt: "2026-01-01T00:00:00Z" },
          { identityId: "two", path: "/same.txt", kind: "dir", addedAt: "2026-01-01T00:00:00Z" },
        ],
        unavailableIdentityIds: ["two"],
      }}
    />,
  );
  const rows = screen.getAllByRole("button", { name: "same.txt" });
  expect(rows).toHaveLength(2);
  expect(screen.getByText("ada · Main")).toBeDefined();
  expect(screen.getByRole("status").textContent).toContain("bob · Other");
  const second = rows[1];
  if (!second) throw new Error("missing second row");
  fireEvent.click(second);
  expect(onNavigate).toHaveBeenCalledWith("two", "/same.txt", "dir");
  const reveal = screen.getAllByRole("button", { name: "Reveal in folder" })[0];
  if (!reveal) throw new Error("missing reveal");
  fireEvent.click(reveal);
  expect(onNavigate).toHaveBeenCalledWith("one", "/same.txt", "reveal");
  expect(document.querySelector("img")).toBeNull();
});
it("shows an empty state without removing inaccessible favorites", () => {
  render(
    <AccountFavoritesList
      me={me}
      pending
      response={{ items: [], unavailableIdentityIds: [] }}
      onNavigate={vi.fn()}
    />,
  );
  expect(screen.getByText("No favorites available.")).toBeDefined();
});
