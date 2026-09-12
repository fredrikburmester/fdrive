// @vitest-environment jsdom

import { ApiClientError, type OfficeOpenResponse } from "@fdrive/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { makeIdentity, makeMe } from "@/test-fixtures/identity";
import { OfficePage } from "./office-page";

const mocks = vi.hoisted(() => ({ me: vi.fn(), open: vi.fn(), client: vi.fn(), push: vi.fn() }));
vi.mock("@/lib/api/auth-queries", () => ({ useMe: mocks.me }));
vi.mock("@/lib/api/office-queries", () => ({ officeClientForIdentity: mocks.client }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("@/components/shell/page-header", () => ({
  PageHeader: ({ breadcrumbs, actions }: { breadcrumbs: ReactNode; actions: ReactNode }) => (
    <header>
      {breadcrumbs}
      {actions}
    </header>
  ),
}));
const me = makeMe({
  account: { id: "account", displayName: "Ada" },
  identities: [makeIdentity({ id: "identity", providerLabel: "Storage" })],
  activeIdentityId: "identity",
});
const descriptor: OfficeOpenResponse = {
  fileId: "file",
  identityId: "identity",
  path: "/folder/file.docx",
  mode: "view",
  actionUrl: "https://editor.test/edit",
  editorOrigin: "https://editor.test",
  formFields: { access_token: "unit-test-token" },
  expiresAt: "2099-01-01T00:00:00.000Z",
};
beforeEach(() => {
  mocks.open.mockReset();
  mocks.me.mockReturnValue({ data: me, isPending: false });
  mocks.open.mockResolvedValue(descriptor);
  mocks.client.mockReturnValue({
    officeOpen: mocks.open,
    downloadUrl: (path: string) =>
      `/api/download?identity=identity&path=${encodeURIComponent(path)}`,
  });
  vi.spyOn(HTMLFormElement.prototype, "submit").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.useRealTimers();
  window.history.replaceState(null, "", "/");
});
async function send(data: unknown) {
  await waitFor(() => expect(HTMLFormElement.prototype.submit).toHaveBeenCalledTimes(1));
  const frame = screen.getByTitle<HTMLIFrameElement>("Office document");
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: descriptor.editorOrigin,
        source: frame.contentWindow,
        data,
      }),
    );
  });
}
it("checks account ownership before issuing an office request", () => {
  mocks.me.mockReturnValue({ data: me, isPending: true });
  const { rerender } = render(<OfficePage identityId="other" path={descriptor.path} mode="view" />);
  expect(screen.getByRole("status").textContent).toContain("Checking");
  mocks.me.mockReturnValue({ data: me, isPending: false });
  rerender(<OfficePage identityId="other" path={descriptor.path} mode="view" />);
  expect(screen.getByRole("alert").textContent).toContain("not available to your account");
  expect(mocks.client).not.toHaveBeenCalled();
});
it("opens explicit view using the route identity and handles close/edit messages", async () => {
  render(<OfficePage identityId="identity" path={descriptor.path} mode="view" />);
  await screen.findByTitle("Office document");
  expect(mocks.client).toHaveBeenCalledWith("identity");
  expect(mocks.open).toHaveBeenCalledWith({ path: descriptor.path, mode: "view" });
  expect(screen.getByRole("button", { name: "Download" }).getAttribute("href")).toContain(
    "identity=identity",
  );
  await send({ MessageId: "UI_Edit" });
  expect(mocks.push).toHaveBeenLastCalledWith("/office/identity/folder/file.docx?mode=edit");
  await send({ MessageId: "UI_Close" });
  expect(mocks.push).toHaveBeenLastCalledWith("/files/folder");
});
it("keeps non-active owned identities scoped and returns to files root", async () => {
  mocks.me.mockReturnValue({ data: { ...me, activeIdentityId: "another" }, isPending: false });
  render(<OfficePage identityId="identity" path={descriptor.path} mode="view" />);
  await screen.findByTitle("Office document");
  expect(mocks.client).toHaveBeenCalledWith("identity");
  expect(screen.getByRole("button", { name: "Back to files" }).getAttribute("href")).toBe("/files");
});
it("confirms a rename against the same file ID without resubmitting the editor form", async () => {
  render(<OfficePage identityId="identity" path={descriptor.path} mode="view" />);
  await screen.findByTitle("Office document");
  mocks.open.mockResolvedValueOnce({ ...descriptor, path: "/folder/new.docx", fileId: "wrong" });
  await send({ MessageId: "File_Rename", Values: { NewName: "new" } });
  await waitFor(() => expect(mocks.open).toHaveBeenCalledTimes(2));
  expect(screen.queryByText("new.docx")).toBeNull();
  mocks.open.mockResolvedValueOnce({ ...descriptor, path: "/folder/new.docx" });
  await send({ MessageId: "File_Rename", Values: { NewName: "new" } });
  await screen.findByText("new.docx");
  expect(window.location.pathname).toBe("/office/identity/folder/new.docx");
  expect(HTMLFormElement.prototype.submit).toHaveBeenCalledTimes(1);
  expect(mocks.open).toHaveBeenLastCalledWith({ path: "/folder/new.docx", mode: "view" });
});
it("ignores unsafe save-as targets and accepts only same-origin office routes", async () => {
  render(<OfficePage identityId="identity" path={descriptor.path} mode="view" />);
  await screen.findByTitle("Office document");
  await send({ MessageId: "UI_Hyperlink", Values: { Url: "https://evil.test/phish" } });
  expect(mocks.push).not.toHaveBeenCalled();
  await send({
    MessageId: "UI_Hyperlink",
    Values: { Url: `${window.location.origin}/office/identity/new.docx?mode=edit` },
  });
  expect(mocks.push).toHaveBeenCalledWith("/office/identity/new.docx?mode=edit");
});
it("rejects mismatched descriptors and retries denied opens with standard errors", async () => {
  mocks.open.mockResolvedValueOnce({ ...descriptor, identityId: "another" });
  render(<OfficePage identityId="identity" path={descriptor.path} mode="view" />);
  expect((await screen.findByRole("alert")).textContent).toContain("could not be verified");
  expect(HTMLFormElement.prototype.submit).not.toHaveBeenCalled();
  mocks.open.mockRejectedValueOnce(new ApiClientError("forbidden", "private internal detail", 403));
  fireEvent.click(screen.getByRole("button", { name: "Reopen document" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("permission"));
  expect(screen.queryByText("private internal detail")).toBeNull();
});
it("expires an open descriptor and exposes a deliberate reopen", async () => {
  mocks.open.mockResolvedValueOnce({
    ...descriptor,
    expiresAt: new Date(Date.now() + 1000).toISOString(),
  });
  render(<OfficePage identityId="identity" path={descriptor.path} mode="view" />);
  await screen.findByTitle("Office document");
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("expired"), {
    timeout: 2000,
  });
  expect(screen.queryByTitle("Office document")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Reopen document" }));
  await screen.findByTitle("Office document");
});
it("ignores a rename response after the host page unmounts", async () => {
  const { unmount } = render(
    <OfficePage identityId="identity" path={descriptor.path} mode="view" />,
  );
  await screen.findByTitle("Office document");
  const pending: { resolve?: (value: OfficeOpenResponse) => void } = {};
  mocks.open.mockReturnValueOnce(
    new Promise<OfficeOpenResponse>((resolve) => {
      pending.resolve = resolve;
    }),
  );
  await send({ MessageId: "File_Rename", Values: { NewName: "new" } });
  await waitFor(() => expect(mocks.open).toHaveBeenCalledTimes(2));
  unmount();
  await act(async () => {
    pending.resolve?.({ ...descriptor, path: "/folder/new.docx" });
  });
  expect(window.location.pathname).toBe("/");
});
