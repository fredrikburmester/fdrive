// @vitest-environment jsdom
import type { FsEntry } from "@fdrive/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OfficePreview } from "./office-preview";
import { Unsupported } from "./unsupported";

const mocks = vi.hoisted(() => ({ me: vi.fn(), status: vi.fn() }));
vi.mock("@/lib/api/auth-queries", () => ({ useMe: mocks.me }));
vi.mock("@/lib/api/office-queries", () => ({ useOfficeStatus: mocks.status }));
const entry: FsEntry = {
  name: "Office Å %20.docx",
  path: "/Office Å %20.docx",
  kind: "file",
  ext: ".docx",
  mime: null,
  size: 10,
  modifiedAt: "2026-09-07T00:00:00Z",
};
beforeEach(() => {
  mocks.me.mockReturnValue({
    data: { activeIdentityId: "alice", identities: [{ id: "alice" }, { id: "bob" }] },
  });
  mocks.status.mockReturnValue({
    data: {
      available: true,
      product: "onlyoffice",
      extensions: { view: ["docx", "custom"], edit: ["docx"], convert: [] },
    },
  });
});
afterEach(cleanup);
it("offers a safe View link for office and discovered unsupported formats, preserving download", () => {
  const view = render(<OfficePreview entry={entry} downloadUrl="/download" />);
  expect(screen.getByRole("button", { name: "View in office" }).getAttribute("href")).toBe(
    "/office/alice/Office%20%C3%85%20%2520.docx?mode=view",
  );
  expect(screen.getByRole("button", { name: "Download" }).getAttribute("href")).toBe("/download");
  expect(screen.queryByRole("button", { name: "Edit in office" })).toBeNull();
  view.rerender(
    <OfficePreview
      entry={{ ...entry, name: "file.custom", path: "/file.custom", ext: ".custom" }}
      downloadUrl="/download"
    />,
  );
  expect(screen.getByRole("button", { name: "View in office" }).getAttribute("href")).toBe(
    "/office/alice/file.custom?mode=view",
  );
});
it("captures the initial identity and hides its action if that identity is removed", () => {
  const view = render(<OfficePreview entry={entry} downloadUrl="/download" />);
  mocks.me.mockReturnValue({
    data: { activeIdentityId: "bob", identities: [{ id: "alice" }, { id: "bob" }] },
  });
  view.rerender(<OfficePreview entry={entry} downloadUrl="/download" />);
  expect(screen.getByRole("button", { name: "View in office" }).getAttribute("href")).toContain(
    "/office/alice/",
  );
  mocks.me.mockReturnValue({ data: { activeIdentityId: "bob", identities: [{ id: "bob" }] } });
  view.rerender(<OfficePreview entry={entry} downloadUrl="/download" />);
  expect(screen.queryByRole("button", { name: "View in office" })).toBeNull();
});
it("waits for identity and capability data, retaining a truthful unavailable fallback", () => {
  mocks.me.mockReturnValue({ data: undefined });
  mocks.status.mockReturnValue({ data: undefined });
  const view = render(<OfficePreview entry={entry} downloadUrl="/download" />);
  expect(
    screen.getByText("Office preview is unavailable. Download to open this file."),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: "View in office" })).toBeNull();
  mocks.me.mockReturnValue({ data: { activeIdentityId: "alice", identities: [{ id: "alice" }] } });
  mocks.status.mockReturnValue({
    data: { available: true, extensions: { view: ["docx"], edit: [], convert: [] } },
  });
  view.rerender(<OfficePreview entry={entry} downloadUrl="/download" />);
  expect(screen.getByRole("button", { name: "View in office" })).toBeTruthy();
});
it("retains unsupported reasons and never promises future editing", () => {
  const view = render(
    <Unsupported
      name="file"
      size={1}
      kind="none"
      reason="Unsupported format"
      downloadUrl="/download"
    />,
  );
  expect(screen.getByText("Unsupported format")).toBeTruthy();
  view.rerender(
    <Unsupported name="file" size={1} kind="archive" reason={null} downloadUrl="/download" />,
  );
  expect(screen.getByText("This file cannot be previewed.")).toBeTruthy();
});
it.each([false, true])(
  "requires discovered view capability even when edit exists (available=%s)",
  (available) => {
    mocks.status.mockReturnValue({
      data: { available, extensions: { view: [], edit: ["docx"], convert: [] } },
    });
    render(<OfficePreview entry={entry} downloadUrl="/download" />);
    expect(screen.queryByRole("button", { name: "View in office" })).toBeNull();
    expect(screen.getByRole("button", { name: "Download" })).toBeTruthy();
  },
);
