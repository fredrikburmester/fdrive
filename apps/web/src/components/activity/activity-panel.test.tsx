// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useJobsStore } from "@/lib/jobs/store";
import { useUploadStore } from "@/lib/upload/store";
import type { UploadItem, UploadStatus } from "@/lib/upload/types";
import { ActivityPanel } from "./activity-panel";

function makeItem(index: number, status: UploadStatus): UploadItem {
  return {
    id: `item-${index}`,
    file: new File(["x"], `file-${index}.txt`),
    targetPath: `/file-${index}.txt`,
    relativePath: `file-${index}.txt`,
    size: 1,
    status,
    progress: status === "done" ? 1 : 0,
    attempts: 1,
  };
}

describe("ActivityPanel", () => {
  beforeEach(() => {
    // `useIsMobile` reads `window.matchMedia`; jsdom does not implement it.
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    useUploadStore.setState({ state: { items: {}, order: [] } });
    useJobsStore.getState().reset();
  });

  it("bounds the upload list to a scrolling region instead of growing past the viewport", () => {
    const items = Array.from({ length: 30 }, (_, index) => makeItem(index, "done"));
    const order = items.map((item) => item.id);
    const byId = Object.fromEntries(items.map((item) => [item.id, item]));
    useUploadStore.setState({ state: { items: byId, order } });

    const { container } = render(<ActivityPanel />);

    const list = container.querySelector('[data-slot="activity-panel-list"]');
    expect(list).not.toBeNull();
    expect(list?.className).toContain("max-h-72");
    expect(list?.className).toContain("overflow-y-auto");

    const card = container.querySelector('[data-slot="activity-panel"]');
    expect(card?.className).toContain("max-h-[70vh]");
  });

  it("renders nothing when both queues are empty", () => {
    const { container } = render(<ActivityPanel />);
    expect(container.querySelector('[data-slot="activity-panel"]')).toBeNull();
  });
});
