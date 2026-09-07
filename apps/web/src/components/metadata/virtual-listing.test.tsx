// @vitest-environment jsdom
import type { FsEntry } from "@fdrive/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Button } from "@/components/ui/button";
import { VirtualListing } from "./virtual-listing";

const fixtures = vi.hoisted(() => ({
  entries: [
    {
      name: "a.txt",
      path: "/a.txt",
      kind: "file",
      size: 1,
      ext: ".txt",
      mime: "text/plain",
      modifiedAt: "2026-01-01T00:00:00Z",
    },
    {
      name: "b.txt",
      path: "/other/b.txt",
      kind: "file",
      size: 1,
      ext: ".txt",
      mime: "text/plain",
      modifiedAt: "2026-01-01T00:00:00Z",
    },
  ] satisfies FsEntry[],
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/metadata/queries", () => ({
  useResolvedEntries: () => ({
    entries: fixtures.entries.map((entry) => ({ path: entry.path, entry })),
    isLoading: false,
  }),
  useTags: () => ({ data: [] }),
  useSetFileTags: () => ({ mutate: vi.fn() }),
  useToggleFavorite: () => ({ mutate: vi.fn() }),
}));
vi.mock("@/lib/metadata/deps", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/metadata/deps")>()),
  useRename: () => ({ mutate: vi.fn() }),
  useDelete: () => ({ mutate: vi.fn() }),
  useDuplicate: () => ({ mutate: vi.fn() }),
  useTrashStatus: () => ({ data: undefined }),
  PageHeader: () => null,
  RenameDialog: () => null,
  DeleteDialog: () => null,
  FileList: ({
    entries,
    onContextAction,
    onToggleSelectAll,
  }: {
    entries: FsEntry[];
    onContextAction: (action: "share", entry: FsEntry) => void;
    onToggleSelectAll: () => void;
  }) => (
    <>
      <Button onClick={onToggleSelectAll}>Select both</Button>
      <Button
        onClick={() => {
          const first = entries[0];
          if (first) onContextAction("share", first);
        }}
      >
        Share selection
      </Button>
    </>
  ),
}));
vi.mock("@/components/shares/share-dialog", () => ({
  ShareDialog: ({ entries, onClose }: { entries: FsEntry[]; onClose: () => void }) => (
    <section aria-label="Share selection">
      {entries.map((entry) => (
        <span key={entry.path}>{entry.path}</span>
      ))}
      <Button onClick={onClose}>Close share</Button>
    </section>
  ),
}));
afterEach(cleanup);
it("opens Share with canonical context selection and discards dialog state on close", () => {
  render(
    <VirtualListing
      title="Recents"
      paths={fixtures.entries.map((entry) => entry.path)}
      onRemoveMissing={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Share selection" }));
  expect(screen.getByRole("region", { name: "Share selection" }).textContent).toContain("/a.txt");
  expect(screen.getByRole("region", { name: "Share selection" }).textContent).not.toContain(
    "/other/b.txt",
  );
  fireEvent.click(screen.getByRole("button", { name: "Close share" }));
  expect(screen.queryByRole("region", { name: "Share selection" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Select both" }));
  fireEvent.click(screen.getByRole("button", { name: "Share selection" }));
  expect(screen.getByRole("region", { name: "Share selection" }).textContent).toContain(
    "/other/b.txt",
  );
});
