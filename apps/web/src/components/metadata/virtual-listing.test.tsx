// @vitest-environment jsdom
import type { FsEntry, ReceivedGrant } from "@fdrive/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Button } from "@/components/ui/button";
import { VirtualListing } from "./virtual-listing";

const fixtures = vi.hoisted(() => {
  const file: FsEntry = {
    name: "a.txt",
    path: "/a.txt",
    kind: "file",
    size: 1,
    ext: ".txt",
    mime: "text/plain",
    modifiedAt: "2026-01-01T00:00:00Z",
  };
  const other: FsEntry = {
    name: "b.txt",
    path: "/other/b.txt",
    kind: "file",
    size: 1,
    ext: ".txt",
    mime: "text/plain",
    modifiedAt: "2026-01-01T00:00:00Z",
  };
  const folder: FsEntry = {
    name: "photos",
    path: "/photos",
    kind: "dir",
    size: 0,
    ext: "",
    mime: null,
    modifiedAt: "2026-01-01T00:00:00Z",
  };
  return {
    file,
    other,
    folder,
    files: [file, other],
    /** What `useResolvedEntries` hands the component; set per test. */
    shown: { entries: [] as FsEntry[] },
    downloadUrl: vi.fn((path: string) => `/api/v1/fs/download?path=${encodeURIComponent(path)}`),
    zip: vi.fn(),
    /** What `useReceivedGrants` hands the component. */
    received: [] as ReceivedGrant[],
  };
});
vi.mock("@/lib/grants/queries", () => ({ useReceivedGrants: () => fixtures.received }));
vi.mock("@/components/grants/share-with-people-dialog", () => ({
  ShareWithPeopleDialog: ({ folder, onClose }: { folder: FsEntry; onClose: () => void }) => (
    <section aria-label="Share with people">
      <span>{folder.path}</span>
      <Button onClick={onClose}>Close people</Button>
    </section>
  ),
}));
vi.mock("@/components/grants/leave-shared-folder-dialog", () => ({
  LeaveSharedFolderDialog: ({
    grant,
    onClose,
  }: {
    grant: ReceivedGrant | null;
    onClose: () => void;
  }) =>
    grant === null ? null : (
      <section aria-label="Leave">
        <span>{`Leave ${grant.name} from ${grant.owner}`}</span>
        <Button onClick={onClose}>Close leave</Button>
      </section>
    ),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/lib/metadata/queries", () => ({
  useResolvedEntries: () => ({
    entries: fixtures.shown.entries.map((entry) => ({ path: entry.path, entry })),
    isLoading: false,
  }),
  useTags: () => ({ data: [] }),
  useSetFileTags: () => ({ mutate: vi.fn() }),
  useToggleFavorite: () => ({ mutate: vi.fn() }),
}));
vi.mock("@/lib/metadata/deps", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/metadata/deps")>()),
  apiClient: { downloadUrl: fixtures.downloadUrl, zip: fixtures.zip },
  useRename: () => ({ mutate: vi.fn() }),
  useDelete: () => ({ mutate: vi.fn() }),
  useDuplicate: () => ({ mutate: vi.fn() }),
  useMe: () => ({ data: undefined }),
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
vi.mock("@/components/files/virtual-file-listing", () => ({
  VirtualFileListing: ({
    entries,
    onContextAction,
    received,
  }: {
    entries: FsEntry[];
    onContextAction: (
      action: "share" | "download" | "shareWithPeople" | "leave",
      entry: FsEntry,
      context: readonly FsEntry[],
    ) => void;
    received: readonly ReceivedGrant[];
  }) => {
    const first = entries[0];
    if (first === undefined) return null;
    return (
      <>
        <span>{`${received.length} shared with me`}</span>
        <Button onClick={() => onContextAction("shareWithPeople", first, [first])}>
          Share first with people
        </Button>
        <Button onClick={() => onContextAction("leave", first, [first])}>Leave first</Button>
        <Button onClick={() => onContextAction("share", first, [first])}>Share selection</Button>
        <Button onClick={() => onContextAction("share", first, entries)}>Share both</Button>
        {entries.map((entry) => (
          <Button key={entry.path} onClick={() => onContextAction("download", entry, [entry])}>
            {`Download ${entry.name}`}
          </Button>
        ))}
        <Button onClick={() => onContextAction("download", first, entries)}>Download all</Button>
      </>
    );
  },
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

/** Every hidden anchor the component clicked, in order. */
const clicks: { href: string | null; download: string | null; rel: string | null }[] = [];
const objectUrls = { created: 0, revoked: [] as string[] };
const OBJECT_URL = "blob:fdrive/archive";
const originalCreateObjectUrl = URL.createObjectURL;
const originalRevokeObjectUrl = URL.revokeObjectURL;

function zipResponse(): Response {
  return {
    ok: true,
    status: 200,
    blob: async () => new Blob(["zip"]),
  } as unknown as Response;
}

function renderListing() {
  render(
    <VirtualListing
      title="Favorites"
      paths={fixtures.shown.entries.map((entry) => entry.path)}
      onRemoveMissing={vi.fn()}
    />,
  );
}

beforeEach(() => {
  clicks.length = 0;
  objectUrls.created = 0;
  objectUrls.revoked = [];
  fixtures.shown.entries = fixtures.files;
  fixtures.received = [];
  fixtures.downloadUrl.mockClear();
  fixtures.zip.mockReset();
  fixtures.zip.mockResolvedValue(zipResponse());
  URL.createObjectURL = vi.fn(() => {
    objectUrls.created += 1;
    return OBJECT_URL;
  });
  URL.revokeObjectURL = vi.fn((url: string) => {
    objectUrls.revoked.push(url);
  });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clicks.push({
      href: this.getAttribute("href"),
      download: this.getAttribute("download"),
      rel: this.getAttribute("rel"),
    });
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  URL.createObjectURL = originalCreateObjectUrl;
  URL.revokeObjectURL = originalRevokeObjectUrl;
});

it("opens Share with canonical context selection and discards dialog state on close", () => {
  renderListing();
  fireEvent.click(screen.getByRole("button", { name: "Share selection" }));
  expect(screen.getByRole("region", { name: "Share selection" }).textContent).toContain("/a.txt");
  expect(screen.getByRole("region", { name: "Share selection" }).textContent).not.toContain(
    "/other/b.txt",
  );
  fireEvent.click(screen.getByRole("button", { name: "Close share" }));
  expect(screen.queryByRole("region", { name: "Share selection" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Share both" }));
  expect(screen.getByRole("region", { name: "Share selection" }).textContent).toContain(
    "/other/b.txt",
  );
});

it("streams a single file straight from the download URL, without a zip request", async () => {
  renderListing();

  fireEvent.click(screen.getByRole("button", { name: "Download a.txt" }));
  await Promise.resolve();

  expect(fixtures.downloadUrl.mock.calls).toEqual([["/a.txt", { inline: false }]]);
  expect(fixtures.zip).not.toHaveBeenCalled();
  // The saved filename comes from the API's `Content-Disposition: attachment;
  // filename="a.txt"`, exactly as in the main file browser, so no client-side
  // `download` attribute is needed.
  expect(clicks).toEqual([
    { href: "/api/v1/fs/download?path=%2Fa.txt", download: null, rel: "noopener" },
  ]);
  expect(objectUrls.created).toBe(0);
});

it("zips a folder instead of navigating to the file download URL", async () => {
  fixtures.shown.entries = [fixtures.folder];
  renderListing();

  fireEvent.click(screen.getByRole("button", { name: "Download photos" }));
  await vi.waitFor(() => expect(clicks.length).toBe(1));

  expect(fixtures.zip.mock.calls).toEqual([[["/photos"], "photos.zip"]]);
  expect(fixtures.downloadUrl).not.toHaveBeenCalled();
  expect(clicks).toEqual([{ href: OBJECT_URL, download: "photos.zip", rel: "noopener" }]);
  expect(objectUrls.revoked).toEqual([OBJECT_URL]);
});

it("zips the whole context selection, not just the right-clicked row", async () => {
  fixtures.shown.entries = [fixtures.file, fixtures.folder];
  renderListing();

  fireEvent.click(screen.getByRole("button", { name: "Download all" }));
  await vi.waitFor(() => expect(clicks.length).toBe(1));

  expect(fixtures.zip.mock.calls).toEqual([[["/a.txt", "/photos"], "archive.zip"]]);
  expect(clicks).toEqual([{ href: OBJECT_URL, download: "archive.zip", rel: "noopener" }]);
});

it("reports a failed zip with the file browser's download error toast", async () => {
  const { toast } = await import("sonner");
  fixtures.shown.entries = [fixtures.folder];
  fixtures.zip.mockRejectedValue(new Error("offline"));
  renderListing();

  fireEvent.click(screen.getByRole("button", { name: "Download photos" }));
  await vi.waitFor(() => expect(toast.error).toHaveBeenCalled());

  expect(toast.error).toHaveBeenCalledWith("Could not download the selection.");
  expect(clicks).toEqual([]);
});

it("shares a folder with people and leaves a folder shared with this login", () => {
  const shared: FsEntry = { ...fixtures.folder, name: "Trip", path: "/Shared with me/Trip" };
  fixtures.shown.entries = [shared];
  fixtures.received = [
    {
      id: "00000000-0000-4000-8000-0000000000aa",
      owner: "alice",
      name: "Trip",
      path: "/Shared with me/Trip",
      access: "read",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  ];
  renderListing();

  expect(screen.getByText("1 shared with me")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Share first with people" }));
  expect(screen.getByRole("region", { name: "Share with people" }).textContent).toContain(
    "/Shared with me/Trip",
  );
  fireEvent.click(screen.getByRole("button", { name: "Close people" }));
  expect(screen.queryByRole("region", { name: "Share with people" })).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Leave first" }));
  expect(screen.getByText("Leave Trip from alice")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Close leave" }));
  expect(screen.queryByText("Leave Trip from alice")).toBeNull();
});
