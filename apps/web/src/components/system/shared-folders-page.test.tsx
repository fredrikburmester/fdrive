// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@/lib/api/scope-queries", () => ({
  useMountMappings: () => ({ dataUpdatedAt: 1 }),
}));
vi.mock("./shared-folders-card", () => ({
  SharedFoldersCard: () => <p>Shared folders card</p>,
}));
vi.mock("./system-page", () => ({
  SystemPage: (props: { title: string; children: ReactNode }) => (
    <div>
      <h1>{props.title}</h1>
      <div>{props.children}</div>
    </div>
  ),
}));
const { SharedFoldersPage } = await import("./shared-folders-page");
afterEach(cleanup);

it("gives the shared folder mappings their own System page", () => {
  render(<SharedFoldersPage />);

  expect(screen.getByRole("heading", { name: "Shared folders" })).toBeTruthy();
  expect(screen.getByText("Shared folders card")).toBeTruthy();
});
