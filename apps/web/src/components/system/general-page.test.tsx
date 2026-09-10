// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("./public-url-card", () => ({ PublicUrlCard: () => <p>Server address card</p> }));
vi.mock("./trash-settings-card", () => ({ TrashSettingsCard: () => <p>Trash card</p> }));
vi.mock("./system-page", () => ({
  SystemPage: (props: { title: string; description: string; children: ReactNode }) => (
    <div>
      <h1>{props.title}</h1>
      <p>{props.description}</p>
      <div>{props.children}</div>
    </div>
  ),
}));
vi.mock("@/lib/api/public-url-queries", () => ({
  useSystemPublicUrl: () => ({ dataUpdatedAt: 1 }),
}));
const { GeneralPage } = await import("./general-page");
afterEach(cleanup);

it("keeps the server address and Trash on one page", () => {
  render(<GeneralPage />);

  expect(screen.getByRole("heading", { name: "General" })).toBeTruthy();
  expect(screen.getByText("Server address and Trash.")).toBeTruthy();
  expect(screen.getByText("Server address card")).toBeTruthy();
  expect(screen.getByText("Trash card")).toBeTruthy();
});

it("no longer administers the storage connection here", () => {
  render(<GeneralPage />);

  expect(screen.queryByText("SFTPGo connection")).toBeNull();
  expect(screen.queryByText("Home template")).toBeNull();
});

it("points an operator looking for the old connection card at Storage", () => {
  render(<GeneralPage />);

  const link = screen.getByRole("link", { name: "Storage" }) as HTMLAnchorElement;
  expect(link.getAttribute("href")).toBe("/system/storage");
});
