// @vitest-environment jsdom
import type { PersonalActivityEvent } from "@fdrive/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EventMembers } from "./event-members";

const mocks = vi.hoisted(() => ({ activityRequest: vi.fn() }));
vi.mock("@/lib/activity/api", () => ({ activityRequest: mocks.activityRequest }));
vi.mock("@/lib/api/auth-queries", () => ({
  useMe: () => ({ data: { account: { id: "account" } } }),
}));

const EVENT_ID = "00000000-0000-4000-8000-000000000001";
const IDENTITY_ID = "00000000-0000-4000-8000-0000000000aa";
const FILE_ID = "00000000-0000-4000-8000-0000000000f1";

type Subject = PersonalActivityEvent["subjects"][number];

function subject(ordinal: number, overrides: Partial<Subject> = {}): Subject {
  return {
    fileId: FILE_ID,
    identityId: IDENTITY_ID,
    role: "affected",
    ordinal,
    path: `/docs/file-${ordinal}.txt`,
    revisionId: null,
    ...overrides,
  };
}

function event(overrides: Partial<PersonalActivityEvent>): PersonalActivityEvent {
  return {
    id: EVENT_ID,
    subjects: [],
    subjectsTruncated: false,
    ...overrides,
  } as PersonalActivityEvent;
}

function renderMembers(of: PersonalActivityEvent) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <EventMembers event={of} />
    </QueryClientProvider>,
  );
}

/** The files listed, each as its part in the event and where it is. */
function listed(): string[] {
  return screen.getAllByRole("listitem").map((item) => item.textContent ?? "");
}

beforeEach(() => {
  mocks.activityRequest.mockReset();
});
afterEach(cleanup);

it("shows nothing for an event about a single file", () => {
  const view = renderMembers(event({ subjects: [subject(0)] }));

  expect(view.container.textContent).toBe("");
  expect(mocks.activityRequest).not.toHaveBeenCalled();
});

it("lists the files an event names itself, without asking for more", () => {
  const view = renderMembers(
    event({
      subjects: [
        subject(0, { role: "source", path: "/docs/from.txt" }),
        subject(1, { role: "target", fileId: null, path: "/docs/to.txt" }),
        subject(2, { path: null }),
        subject(3, { fileId: null, path: null }),
      ],
    }),
  );

  expect(screen.getByRole("heading", { name: "Files involved (4)" })).toBeTruthy();
  expect(listed()).toEqual([
    "source/docs/from.txt",
    "target/docs/to.txt",
    "affectedFile journey",
    "affectedLocation unavailable",
  ]);
  // A file with a journey links to it, whether or not its location is known.
  expect(
    screen.getAllByRole("link").map((link) => [link.textContent, link.getAttribute("href")]),
  ).toEqual([
    ["/docs/from.txt", `/activity/files/${FILE_ID}`],
    ["File journey", `/activity/files/${FILE_ID}`],
  ]);
  // The list is in the open, not behind a disclosure.
  expect(view.container.querySelector("details, summary, [aria-expanded]")).toBeNull();
  expect(mocks.activityRequest).not.toHaveBeenCalled();
});

it("loads every file of an event that touched more than it names", async () => {
  mocks.activityRequest.mockImplementation(async (path: string) =>
    path.includes("cursor=")
      ? { items: [subject(2)], nextCursor: null }
      : { items: [subject(0), subject(1)], nextCursor: "next page" },
  );
  renderMembers(event({ subjects: [subject(0)], subjectsTruncated: true }));

  // Until the full list arrives the event's own files show, and the count is not claimed.
  expect(screen.getByRole("heading", { name: "Files involved" })).toBeTruthy();
  expect(listed()).toEqual(["affected/docs/file-0.txt"]);

  await waitFor(() =>
    expect(listed()).toEqual(["affected/docs/file-0.txt", "affected/docs/file-1.txt"]),
  );
  expect(mocks.activityRequest).toHaveBeenCalledWith(`/events/${EVENT_ID}/subjects`);

  fireEvent.click(screen.getByRole("button", { name: "More files" }));
  await waitFor(() => expect(listed()).toHaveLength(3));
  expect(mocks.activityRequest).toHaveBeenLastCalledWith(
    `/events/${EVENT_ID}/subjects?cursor=next%20page`,
  );
  expect(screen.queryByRole("button", { name: "More files" })).toBeNull();
});

it("keeps the files it has when the rest cannot be loaded", async () => {
  mocks.activityRequest.mockRejectedValue(new Error("offline"));
  renderMembers(event({ subjects: [subject(0)], subjectsTruncated: true }));

  expect((await screen.findByRole("alert")).textContent).toBe("Could not load all files.");
  expect(listed()).toEqual(["affected/docs/file-0.txt"]);
});
