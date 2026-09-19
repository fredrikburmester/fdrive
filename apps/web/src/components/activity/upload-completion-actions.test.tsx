// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { UploadItem } from "@/lib/upload/types";
import { UploadCompletionActions } from "./upload-completion-actions";

const state = vi.hoisted(() => ({ push: vi.fn(), switch: vi.fn(), linked: true }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: state.push }) }));
vi.mock("@/lib/api/auth-queries", () => ({
  useMe: () => ({
    data: {
      activeIdentityId: "other",
      identities: state.linked
        ? [{ id: "upload", username: "me", providerLabel: "Home drive" }]
        : [],
    },
  }),
}));
vi.mock("@/lib/account/use-identities", () => ({
  useIdentityActions: () => ({ switch: state.switch, pending: false }),
}));
const item: UploadItem & { identityId: string } = {
  id: "1",
  identityId: "upload",
  file: new File(["x"], "a & b.txt"),
  targetPath: "/docs/a & b.txt",
  relativePath: "a & b.txt",
  size: 1,
  status: "done",
  progress: 1,
  attempts: 1,
};
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  state.linked = true;
});
it("shows the destination and switches to its captured login before reveal", async () => {
  render(<UploadCompletionActions item={item} />);
  expect(screen.getByText("me · Home drive · /docs")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Show in folder" }));
  await waitFor(() =>
    expect(state.switch).toHaveBeenCalledWith("upload", "/files/docs?select=a%20%26%20b.txt"),
  );
  expect(state.push).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Open" }));
  await waitFor(() =>
    expect(state.switch).toHaveBeenCalledWith("upload", "/view/docs/a%20%26%20b.txt"),
  );
});
it("keeps historical destination visible when the login was unlinked", () => {
  state.linked = false;
  render(<UploadCompletionActions item={item} />);
  expect(screen.getByText("Login no longer linked")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Open" }).hasAttribute("disabled")).toBe(true);
});
