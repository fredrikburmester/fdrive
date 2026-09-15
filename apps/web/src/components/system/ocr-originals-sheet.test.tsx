// @vitest-environment jsdom
import type { OcrOriginal } from "@fdrive/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const useOcrOriginalsMock = vi.fn();
const restoreMutate = vi.fn();
const deleteMutate = vi.fn();

vi.mock("@/lib/api/system-queries", () => ({
  OCR_ORIGINALS_PAGE_SIZE: 25,
  useOcrOriginals: (query: string, offset: number, enabled: boolean) =>
    useOcrOriginalsMock(query, offset, enabled),
  useRestoreOcrOriginal: () => ({ mutate: restoreMutate, isPending: false }),
  useDeleteOcrOriginal: () => ({ mutate: deleteMutate, isPending: false }),
}));

import { OcrOriginalsSheet } from "./ocr-originals-sheet";

const ORIGINAL: OcrOriginal = {
  id: "0123456789abcdef_scan.pdf",
  root: "sftpgo",
  path: "fredrik/docs/scan.pdf",
  size: 1024,
  keptAt: "2026-09-07T03:00:00+00:00",
  sha256: "a".repeat(64),
  legacy: false,
  state: "ocred",
};

function mockPage(items: OcrOriginal[], total = items.length) {
  useOcrOriginalsMock.mockReturnValue({
    data: { items, total, offset: 0, limit: 25 },
    isPending: false,
    isError: false,
    error: null,
  });
}

function open() {
  fireEvent.click(screen.getByRole("button", { name: "Manage" }));
}

async function openRowMenu(name: string) {
  fireEvent.click(await screen.findByRole("button", { name: `Actions for ${name}` }));
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("OcrOriginalsSheet", () => {
  it("queries nothing until it is opened", () => {
    mockPage([ORIGINAL]);
    render(<OcrOriginalsSheet />);

    expect(useOcrOriginalsMock).not.toHaveBeenCalled();
  });

  it("lists a kept original with its source path and state", async () => {
    mockPage([ORIGINAL]);
    render(<OcrOriginalsSheet />);
    open();

    expect(await screen.findByText("fredrik/docs/scan.pdf")).toBeTruthy();
    expect(screen.getByText("OCR'd")).toBeTruthy();
    expect(screen.getByText("1–1 of 1")).toBeTruthy();
  });

  it("restores without an opt-in when the OCR output is still in place", async () => {
    mockPage([ORIGINAL]);
    render(<OcrOriginalsSheet />);
    open();
    await openRowMenu("fredrik/docs/scan.pdf");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Restore" }));

    expect(await screen.findByText("Restore the original?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));

    await waitFor(() => expect(restoreMutate).toHaveBeenCalled());
    expect(restoreMutate.mock.calls[0]?.[0]).toEqual({
      id: ORIGINAL.id,
      allowRecreate: false,
      allowOverwriteChanged: false,
    });
  });

  it("warns and opts in before overwriting a file changed since OCR", async () => {
    mockPage([{ ...ORIGINAL, state: "changed" }]);
    render(<OcrOriginalsSheet />);
    open();
    await openRowMenu("fredrik/docs/scan.pdf");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Restore" }));

    expect(await screen.findByText("Overwrite the changed file?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));

    await waitFor(() => expect(restoreMutate).toHaveBeenCalled());
    expect(restoreMutate.mock.calls[0]?.[0]).toEqual({
      id: ORIGINAL.id,
      allowRecreate: false,
      allowOverwriteChanged: true,
    });
  });

  it("warns and opts in before recreating a deleted file", async () => {
    mockPage([{ ...ORIGINAL, state: "missing" }]);
    render(<OcrOriginalsSheet />);
    open();
    await openRowMenu("fredrik/docs/scan.pdf");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Restore" }));

    expect(await screen.findByText("Recreate the deleted file?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));

    await waitFor(() => expect(restoreMutate).toHaveBeenCalled());
    expect(restoreMutate.mock.calls[0]?.[0]).toMatchObject({ allowRecreate: true });
  });

  it("confirms before deleting kept bytes", async () => {
    mockPage([ORIGINAL]);
    render(<OcrOriginalsSheet />);
    open();
    await openRowMenu("fredrik/docs/scan.pdf");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));

    expect(await screen.findByText("Delete this kept original?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(deleteMutate).toHaveBeenCalledWith(ORIGINAL.id, expect.anything()));
  });

  it("offers download but not restore for an original whose source is unknown", async () => {
    const unresolved = { ...ORIGINAL, root: null, path: null, state: null, legacy: true };
    mockPage([unresolved]);
    render(<OcrOriginalsSheet />);
    open();
    await openRowMenu(ORIGINAL.id);

    expect(screen.getByText("Source unknown")).toBeTruthy();
    expect(
      (await screen.findByRole("menuitem", { name: "Restore" })).getAttribute("data-disabled"),
    ).not.toBeNull();
    const download = screen.getByRole("menuitem", { name: "Download" });
    expect(download.getAttribute("href")).toContain(encodeURIComponent(ORIGINAL.id));
  });

  it("resets to the first page when the search changes", async () => {
    mockPage([ORIGINAL], 50);
    render(<OcrOriginalsSheet />);
    open();

    fireEvent.click(await screen.findByRole("button", { name: "Next" }));
    await waitFor(() => expect(useOcrOriginalsMock).toHaveBeenLastCalledWith("", 25, true));

    fireEvent.change(screen.getByLabelText("Search kept originals"), {
      target: { value: "scan" },
    });
    await waitFor(() => expect(useOcrOriginalsMock).toHaveBeenLastCalledWith("scan", 0, true));
  });

  it("explains an empty archive and an empty search apart", async () => {
    mockPage([]);
    const view = render(<OcrOriginalsSheet />);
    open();

    expect(await screen.findByText(/No originals are kept yet/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Search kept originals"), {
      target: { value: "nothing" },
    });
    expect(await screen.findByText("No kept original matches that search.")).toBeTruthy();
    view.unmount();
  });
});
