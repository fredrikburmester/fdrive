// @vitest-environment jsdom
import type { FsEntry } from "@fdrive/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreviewShell } from "./preview-shell";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  stat: vi.fn<(path: string) => Promise<FsEntry>>(),
  list: vi.fn<(path: string) => Promise<{ entries: FsEntry[] }>>(),
  touchRecent: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));

// `@/lib/preview/deps` re-exports the real API client, whose module graph
// this test has no use for; the pure URL/key helpers are kept real so the
// asserted hrefs are the ones the app actually navigates to.
vi.mock("@/lib/preview/deps", async () => {
  const { pathToHref, viewHref } = await import("@/lib/files/path-url");
  const { queryKeys } = await import("@/lib/api/keys");
  return {
    queryKeys,
    pathToHref,
    viewHref,
    apiClient: {
      stat: (path: string) => mocks.stat(path),
      list: (path: string) => mocks.list(path),
      downloadUrl: (path: string) => `https://files.test${path}`,
    },
    useTouchRecent: () => ({ mutate: mocks.touchRecent }),
  };
});

// Stands in for whichever viewer the shell mounts, rendering one of each
// focus target the guard has to tell apart. The reported bug came from the
// archive viewer's "Filter entries" box (`archive-entries-view.tsx`), which
// is a plain text input like this one.
vi.mock("./preview-viewer", () => ({
  PreviewViewer: () => (
    <div>
      <input aria-label="Filter entries" />
      <textarea aria-label="Notes" />
      <input type="checkbox" aria-label="Select all" />
      <div contentEditable suppressContentEditableWarning data-testid="comment-host">
        <span data-testid="comment-child">typed text</span>
      </div>
    </div>
  ),
}));

vi.mock("@/components/inspector/inspector", () => ({ Inspector: () => null }));

function file(name: string): FsEntry {
  return {
    name,
    path: `/docs/${name}`,
    kind: "file",
    size: 128,
    modifiedAt: "2026-01-01T00:00:00.000Z",
    ext: ".txt",
    mime: "text/plain",
  };
}

/** Previews `/docs/b.txt`: an editable kind with both a previous and a next sibling. */
async function renderShell() {
  const entries = [file("a.txt"), file("b.txt"), file("c.txt")];
  mocks.stat.mockResolvedValue(file("b.txt"));
  mocks.list.mockResolvedValue({ entries });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <PreviewShell path="/docs/b.txt" />
    </QueryClientProvider>,
  );
  await screen.findByText("b.txt");
}

beforeEach(() => {
  mocks.push.mockClear();
  mocks.stat.mockReset();
  mocks.list.mockReset();
});

afterEach(cleanup);

describe("PreviewShell shortcuts with nothing editable focused", () => {
  it("navigates back to the parent folder on Escape", async () => {
    await renderShell();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(mocks.push).toHaveBeenCalledWith("/files/docs");
  });

  it("steps to the previous and next sibling on the arrow keys", async () => {
    await renderShell();
    fireEvent.keyDown(document.body, { key: "ArrowLeft" });
    expect(mocks.push).toHaveBeenCalledWith("/view/docs/a.txt");
    fireEvent.keyDown(document.body, { key: "ArrowRight" });
    expect(mocks.push).toHaveBeenCalledWith("/view/docs/c.txt");
  });

  it("opens the editor on Cmd/Ctrl+E, in either case", async () => {
    await renderShell();
    fireEvent.keyDown(document.body, { key: "e", metaKey: true });
    fireEvent.keyDown(document.body, { key: "E", ctrlKey: true });
    expect(mocks.push).toHaveBeenCalledTimes(2);
    expect(mocks.push).toHaveBeenNthCalledWith(1, "/edit/docs/b.txt");
    expect(mocks.push).toHaveBeenNthCalledWith(2, "/edit/docs/b.txt");
  });

  it("still fires when a checkbox has focus, which consumes no text", async () => {
    await renderShell();
    const checkbox = screen.getByLabelText("Select all");
    fireEvent.keyDown(checkbox, { key: "ArrowRight" });
    fireEvent.keyDown(checkbox, { key: "Escape" });
    expect(mocks.push).toHaveBeenNthCalledWith(1, "/view/docs/c.txt");
    expect(mocks.push).toHaveBeenNthCalledWith(2, "/files/docs");
  });
});

describe("PreviewShell shortcuts with an editable target focused", () => {
  it("leaves Escape and the arrow keys to a focused text input", async () => {
    await renderShell();
    const filter = screen.getByLabelText("Filter entries");
    fireEvent.keyDown(filter, { key: "ArrowLeft" });
    fireEvent.keyDown(filter, { key: "ArrowRight" });
    fireEvent.keyDown(filter, { key: "Escape" });
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("leaves Cmd+E to a focused text input", async () => {
    await renderShell();
    fireEvent.keyDown(screen.getByLabelText("Filter entries"), { key: "e", metaKey: true });
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("leaves the shortcuts to a focused textarea", async () => {
    await renderShell();
    const notes = screen.getByLabelText("Notes");
    fireEvent.keyDown(notes, { key: "ArrowLeft" });
    fireEvent.keyDown(notes, { key: "Escape" });
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("leaves the shortcuts to a contenteditable host and to nodes inside it", async () => {
    await renderShell();
    fireEvent.keyDown(screen.getByTestId("comment-host"), { key: "ArrowRight" });
    fireEvent.keyDown(screen.getByTestId("comment-child"), { key: "Escape" });
    expect(mocks.push).not.toHaveBeenCalled();
  });
});
