// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  copyShareLink,
  sharedPathInTrash,
  shareExpired,
  shareLinkUrl,
  shareState,
} from "./share-link";

const mocks = vi.hoisted(() => ({ gesture: vi.fn(), report: vi.fn() }));
vi.mock("@/lib/activity/gestures", () => ({
  activityGesture: (...args: unknown[]) => {
    mocks.gesture(...args);
    return mocks.report;
  },
}));

const ID = "00000000-0000-4000-8000-000000000001";
const NOW = Date.parse("2026-06-01T12:00:00Z");
const open = { paths: ["/report.pdf"], expiresAt: null, maxDownloads: 0, usedDownloads: 0 };

afterEach(() => {
  vi.clearAllMocks();
});

it("gives a link's public address on this origin", () => {
  expect(shareLinkUrl(ID)).toBe(new URL(`/s/${ID}`, window.location.origin).href);
});

it("copies the address and records the copy once the clipboard took it", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  mocks.report.mockResolvedValue(undefined);

  await copyShareLink({ id: ID, paths: ["/Inbox", "/Other"] });

  expect(writeText).toHaveBeenCalledWith(shareLinkUrl(ID));
  expect(mocks.gesture).toHaveBeenCalledWith("share.copy_link", "/Inbox", ID);
  expect(mocks.report).toHaveBeenCalledOnce();
});

it("rejects without recording anything when the clipboard refuses", async () => {
  const writeText = vi.fn().mockRejectedValue(new Error("denied"));
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

  await expect(copyShareLink({ id: ID, paths: [] })).rejects.toThrow("denied");

  // A link with no path reports the root.
  expect(mocks.gesture).toHaveBeenCalledWith("share.copy_link", "/", ID);
  expect(mocks.report).not.toHaveBeenCalled();
});

it("still copies when the copy could not be recorded", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  mocks.report.mockRejectedValue(new Error("offline"));

  await expect(copyShareLink({ id: ID, paths: ["/a"] })).resolves.toBeUndefined();
});

it("says a link is active until it expires, runs out or loses its files to Trash", () => {
  expect(shareState(open, NOW)).toEqual({ tone: "success", label: "Active" });
  expect(shareState({ ...open, expiresAt: "2026-06-01T12:00:01Z" }, NOW).label).toBe("Active");
  expect(shareState({ ...open, expiresAt: "2026-06-01T12:00:00Z" }, NOW)).toEqual({
    tone: "warning",
    label: "Expired",
  });
  expect(shareState({ ...open, maxDownloads: 5, usedDownloads: 4 }, NOW).label).toBe("Active");
  expect(shareState({ ...open, maxDownloads: 5, usedDownloads: 5 }, NOW)).toEqual({
    tone: "warning",
    label: "Limit reached",
  });
  // No limit: any number of downloads keeps it active.
  expect(shareState({ ...open, usedDownloads: 99 }, NOW).label).toBe("Active");
  // One shared path in Trash stops the whole link, whatever else is true of it.
  expect(
    shareState(
      {
        ...open,
        paths: ["/report.pdf", `/.trash/${ID}/notes.txt`],
        expiresAt: "2026-01-01T00:00:00Z",
      },
      NOW,
    ),
  ).toEqual({ tone: "warning", label: "In Trash" });
});

it("knows a path in Trash from one that only looks like it", () => {
  expect(sharedPathInTrash(`/.trash/${ID}/notes.txt`)).toBe(true);
  expect(sharedPathInTrash("/.trash")).toBe(true);
  expect(sharedPathInTrash("/.trashed/notes.txt")).toBe(false);
  expect(sharedPathInTrash("/docs/.trash/notes.txt")).toBe(false);
  expect(sharedPathInTrash("/")).toBe(false);
});

it("knows when a link's expiry has passed", () => {
  expect(shareExpired({ expiresAt: null }, NOW)).toBe(false);
  expect(shareExpired({ expiresAt: "2026-06-01T12:00:01Z" }, NOW)).toBe(false);
  expect(shareExpired({ expiresAt: "2026-06-01T11:59:59Z" }, NOW)).toBe(true);
  // Against the clock when no time is given.
  expect(shareExpired({ expiresAt: "2000-01-01T00:00:00Z" })).toBe(true);
});
