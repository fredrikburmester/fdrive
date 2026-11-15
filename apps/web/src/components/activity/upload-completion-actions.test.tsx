// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { UploadItem } from "@/lib/upload/types";
import { UploadCompletionActions } from "./upload-completion-actions";

const state = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: state.push }) }));
const item: UploadItem = {
  id: "1",
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
});
it("shows the destination folder and opens or reveals the upload", () => {
  render(<UploadCompletionActions item={item} />);
  expect(screen.getByText("/docs")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Show in folder" }));
  expect(state.push).toHaveBeenCalledWith("/files/docs?select=a%20%26%20b.txt");
  fireEvent.click(screen.getByRole("button", { name: "Open" }));
  expect(state.push).toHaveBeenCalledWith("/view/docs/a%20%26%20b.txt");
});
