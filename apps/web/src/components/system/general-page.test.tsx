// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("./public-url-card", () => ({ PublicUrlCard: () => <p>Server address card</p> }));
vi.mock("./system-page", () => ({
  SystemPage: (props: {
    title: string;
    description: string;
    scope?: string;
    children: ReactNode;
  }) => (
    <div>
      <h1>{props.title}</h1>
      <p>{props.description}</p>
      <p>scope: {props.scope ?? "server"}</p>
      <div>{props.children}</div>
    </div>
  ),
}));
vi.mock("@/lib/api/public-url-queries", () => ({
  useSystemPublicUrl: () => ({ dataUpdatedAt: 1 }),
}));
const { GeneralPage } = await import("./general-page");
afterEach(cleanup);

it("keeps only installation-wide settings: the server address", () => {
  render(<GeneralPage />);

  expect(screen.getByRole("heading", { name: "General" })).toBeTruthy();
  expect(screen.getByText("Settings for the whole installation.")).toBeTruthy();
  expect(screen.getByText("scope: server")).toBeTruthy();
  expect(screen.getByText("Server address card")).toBeTruthy();
});

it("no longer administers per-server settings here", () => {
  render(<GeneralPage />);

  expect(screen.queryByText("SFTPGo connection")).toBeNull();
  expect(screen.queryByText("Home template")).toBeNull();
  expect(screen.queryByRole("switch", { name: "Enable Trash" })).toBeNull();
});

it("points an operator looking for the connection or Trash at Storage", () => {
  render(<GeneralPage />);

  expect(screen.getByText(/Storage servers and their Trash are managed under/)).toBeTruthy();
  const link = screen.getByRole("link", { name: "Storage" }) as HTMLAnchorElement;
  expect(link.getAttribute("href")).toBe("/system/storage");
});
