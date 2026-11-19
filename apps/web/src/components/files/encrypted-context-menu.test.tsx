// @vitest-environment jsdom
import type { FsEntry } from "@fdrive/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EntryMetadataSection } from "@/components/metadata/entry-metadata-section";
import { FileContextMenu } from "./file-context-menu";

vi.mock("@/lib/metadata/queries", () => ({
  useTags: () => ({ data: [] }),
  useSetFileTags: () => ({ mutate: vi.fn() }),
  useToggleFavorite: () => ({ mutate: vi.fn() }),
  useTagMutations: () => ({ createTag: { mutate: vi.fn() } }),
}));

const STORED = `fe1-${"a".repeat(47)}`;

function file(path: string): FsEntry {
  return {
    path,
    name: "notes.txt",
    kind: "file",
    size: 1,
    ext: ".txt",
    mime: null,
    modifiedAt: "2026-01-01T00:00:00.000Z",
  };
}

afterEach(cleanup);

describe("inside an encrypted folder", () => {
  it("offers no Tags or Favorites in the context menu, and does outside", async () => {
    for (const encrypted of [true, false]) {
      render(
        <FileContextMenu entry={file(`/Vault/${STORED}`)} encrypted={encrypted} onAction={vi.fn()}>
          <span>File</span>
        </FileContextMenu>,
      );
      fireEvent.contextMenu(screen.getByText("File"));
      await screen.findByRole("menuitem", { name: "Rename" });
      expect(screen.queryByRole("menuitem", { name: "Add to Favorites" }) === null).toBe(encrypted);
      expect(screen.queryByRole("menuitem", { name: "Tags" }) === null).toBe(encrypted);
      cleanup();
    }
  });

  it("leaves the inspector's tags and favorite out", () => {
    const { container } = render(<EntryMetadataSection entries={[file(`/Vault/${STORED}`)]} />);
    expect(container.innerHTML).toBe("");
    render(<EntryMetadataSection entries={[file("/notes.txt")]} />);
    expect(screen.getByText("Favorite")).toBeDefined();
  });
});
