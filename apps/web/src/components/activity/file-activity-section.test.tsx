// @vitest-environment jsdom
import type { PersonalActivityEvent } from "@fdrive/contracts";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FileActivitySection } from "./file-activity-section";

const mocks = vi.hoisted(() => ({
  identity: "drive" as string | undefined,
  file: vi.fn(),
  history: vi.fn(),
}));
vi.mock("@/lib/api/client", () => ({ getTabIdentity: () => mocks.identity }));
vi.mock("@/lib/activity/queries", () => ({
  useActivityFileAt: mocks.file,
  useActivityHistory: mocks.history,
}));

const fileId = "00000000-0000-4000-8000-000000000001";
const now = new Date();

function event(patch: Partial<PersonalActivityEvent>): PersonalActivityEvent {
  return {
    id: crypto.randomUUID(),
    operationId: null,
    stage: "outcome",
    outcome: "success",
    provisional: false,
    action: "file.upload",
    count: 1,
    sortAt: now.toISOString(),
    subjects: [],
    before: null,
    after: { path: "/b.txt" },
    ...patch,
  } as PersonalActivityEvent;
}
function history(patch: Record<string, unknown> = {}) {
  return {
    isPending: false,
    isError: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
    data: undefined,
    ...patch,
  };
}
function feed(provisionalReads: PersonalActivityEvent[], items: PersonalActivityEvent[]) {
  return { pages: [{ provisionalReads, items }] };
}

beforeEach(() => {
  mocks.identity = "drive";
  mocks.file.mockReturnValue({ isPending: false, isError: false, data: fileId });
  mocks.history.mockReturnValue(history());
});
afterEach(cleanup);

it("lists the file's latest activity newest first, with its earlier location and failures", () => {
  const fetchNextPage = vi.fn();
  mocks.history.mockReturnValue(
    history({
      hasNextPage: true,
      fetchNextPage,
      data: feed(
        [event({ action: "file.inspect", count: 3, provisional: true, after: { path: "/b.txt" } })],
        [
          event({
            action: "file.rename",
            sortAt: new Date(now.getTime() - 60_000).toISOString(),
            before: { path: "/a.txt" },
          }),
          event({
            action: "file.move",
            outcome: "failed",
            sortAt: new Date(now.getTime() - 120_000).toISOString(),
            before: { path: "/old/b.txt" },
          }),
          event({
            action: "file.upload",
            sortAt: "2020-01-02T10:00:00Z",
            after: { path: "/a.txt" },
          }),
        ],
      ),
    }),
  );

  render(<FileActivitySection path="/b.txt" />);

  expect(mocks.file).toHaveBeenCalledWith("drive", "/b.txt");
  expect(mocks.history).toHaveBeenCalledWith({ limit: 10 }, `/files/${fileId}/events`);
  const items = within(screen.getByRole("region", { name: "Activity" })).getAllByRole("listitem");
  expect(items.map((item) => item.textContent)).toEqual([
    expect.stringMatching(/^Viewed info 3 times/),
    expect.stringMatching(/^Renamed.*From a\.txt$/),
    expect.stringMatching(/^Moved.*From \/old\/b\.txt.*failed$/),
    expect.stringMatching(/^Uploaded/),
  ]);
  expect(within(items[2] as HTMLElement).getByText("failed").className).toContain(
    "text-destructive",
  );
  expect(screen.getByRole("button", { name: "See all" }).getAttribute("href")).toBe(
    `/activity/files/${fileId}`,
  );
  fireEvent.click(screen.getByRole("button", { name: "Show more" }));
  expect(fetchNextPage).toHaveBeenCalledOnce();
});

it("waits for a file with no recorded history without loading any feed", () => {
  mocks.file.mockReturnValue({ isPending: false, isError: false, data: null });
  mocks.history.mockReturnValue(history({ isPending: true }));

  render(<FileActivitySection path="/new.txt" />);

  expect(mocks.history).toHaveBeenCalledWith({ limit: 10 }, null);
  expect(screen.getByText("No recorded activity yet.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "See all" })).toBeNull();
});

it("shows loading, failure and paging states", () => {
  mocks.file.mockReturnValue({ isPending: true, isError: false, data: undefined });
  const view = render(<FileActivitySection path="/a.txt" />);
  expect(screen.getByRole("status").textContent).toBe("Loading activity…");

  mocks.file.mockReturnValue({ isPending: false, isError: false, data: fileId });
  mocks.history.mockReturnValue(history({ isPending: true }));
  view.rerender(<FileActivitySection path="/a.txt" />);
  expect(screen.getByRole("status").textContent).toBe("Loading activity…");

  mocks.history.mockReturnValue(history({ isError: true }));
  view.rerender(<FileActivitySection path="/a.txt" />);
  expect(screen.getByText("Could not load activity.")).toBeTruthy();

  mocks.history.mockReturnValue(
    history({ hasNextPage: true, isFetchingNextPage: true, data: feed([], [event({})]) }),
  );
  view.rerender(<FileActivitySection path="/a.txt" />);
  expect(screen.getByRole("button", { name: "Loading…" }).hasAttribute("disabled")).toBe(true);
});

it("renders nothing without a login to look the path up in", () => {
  mocks.identity = undefined;

  const { container } = render(<FileActivitySection path="/a.txt" />);

  expect(container.innerHTML).toBe("");
});
