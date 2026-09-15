import type { FsEntry, OrganizeProposal } from "@fdrive/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createOrganizeSessionStore,
  NO_EDITS,
  reviewChecked,
  reviewSuggestions,
  samePaths,
} from "./organize-session";

function entry(path: string): FsEntry {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return {
    name,
    path,
    kind: "file",
    size: 1,
    ext: "",
    mime: null,
    modifiedAt: "2026-01-01T00:00:00.000Z",
  };
}

const receipts = [entry("/inbox/a.pdf"), entry("/inbox/b.pdf")];
const photos = [entry("/inbox/c.jpg")];

describe("organize session store", () => {
  let store: ReturnType<typeof createOrganizeSessionStore>;
  beforeEach(() => {
    store = createOrganizeSessionStore();
  });

  it("resumes the session about the same selection and replaces it for another", () => {
    store.getState().open(receipts);
    const first = store.getState().session;
    store.getState().setInstructions("by year");
    store.getState().hide();
    expect(store.getState().session?.open).toBe(false);

    store.getState().open([...receipts]);
    const resumed = store.getState().session;
    expect(resumed?.key).toBe(first?.key);
    expect(resumed?.open).toBe(true);
    expect(resumed?.instructions).toBe("by year");

    store.getState().open(photos);
    const replaced = store.getState().session;
    expect(replaced?.key).not.toBe(first?.key);
    expect(replaced?.instructions).toBe("");
    expect(replaced?.entries).toBe(photos);
  });

  it("attaches a run only to the session that started it", () => {
    store.getState().open(receipts);
    const key = store.getState().session?.key as number;
    store.getState().open(photos);
    store.getState().setRunId(key, "stale");
    expect(store.getState().session?.runId).toBeNull();

    store.getState().setRunId(store.getState().session?.key as number, "run-2");
    expect(store.getState().session?.runId).toBe("run-2");
    store.getState().discard();
    store.getState().setRunId(key, "late");
    expect(store.getState().session).toBeNull();
  });

  it("starts over with the selection and instructions but no run or edits", () => {
    store.getState().open(receipts);
    store.getState().setInstructions("by year");
    store.getState().setRunId(store.getState().session?.key as number, "run-1");
    store.getState().setEdits({ ...NO_EDITS, checked: new Set(["/inbox/a.pdf"]) });
    store.getState().markNotified();
    store.getState().restart();
    expect(store.getState().session).toMatchObject({
      entries: receipts,
      instructions: "by year",
      runId: null,
      edits: NO_EDITS,
      notified: false,
    });
  });

  it("compares selections by path and order", () => {
    expect(samePaths(receipts, [...receipts])).toBe(true);
    expect(samePaths(receipts, [...receipts].reverse())).toBe(false);
    expect(samePaths(receipts, receipts.slice(0, 1))).toBe(false);
  });
});

describe("review helpers", () => {
  const proposal: OrganizeProposal = {
    summary: "",
    suggestions: [
      {
        path: "/inbox/a.pdf",
        kind: "file",
        destination: "/Finance",
        target: "/Finance/a.pdf",
        reason: "",
        newFolder: false,
        conflict: false,
      },
      {
        path: "/inbox/c.jpg",
        kind: "file",
        destination: "/Photos",
        target: "/Photos/c.jpg",
        reason: "",
        newFolder: false,
        conflict: true,
      },
    ],
    unchanged: [],
  };

  it("checks everything but conflicts until the person decides otherwise", () => {
    expect([...reviewChecked(proposal, NO_EDITS)]).toEqual(["/inbox/a.pdf"]);
    const chosen = new Set(["/inbox/c.jpg"]);
    expect(reviewChecked(proposal, { ...NO_EDITS, checked: chosen })).toBe(chosen);
    expect([
      ...reviewChecked(proposal, {
        ...NO_EDITS,
        checked: chosen,
        moved: new Set(["/inbox/c.jpg"]),
      }),
    ]).toEqual([]);
  });

  it("applies chosen folders and names and drops moved items", () => {
    const edits = {
      ...NO_EDITS,
      destinations: new Map([["/inbox/a.pdf", "/Archive"]]),
      names: new Map([["/inbox/c.jpg", "c (2).jpg"]]),
    };
    expect(reviewSuggestions(proposal, edits)).toMatchObject([
      { path: "/inbox/a.pdf", destination: "/Archive", target: "/Archive/a.pdf" },
      {
        path: "/inbox/c.jpg",
        destination: "/Photos",
        target: "/Photos/c (2).jpg",
        conflict: false,
      },
    ]);
    expect(
      reviewSuggestions(proposal, { ...edits, moved: new Set(["/inbox/a.pdf"]) }).map(
        (suggestion) => suggestion.path,
      ),
    ).toEqual(["/inbox/c.jpg"]);
  });
});
