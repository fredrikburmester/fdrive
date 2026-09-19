import type { PersonalActivityEvent } from "@fdrive/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { activityFeed, activityFile, activityLocations, activityRequest } from "./api";
import { activityLabels, activityPath, collapseActivity } from "./history";

const id = "00000000-0000-4000-8000-000000000001";
afterEach(() => vi.unstubAllGlobals());
it("sends private uncached requests, encodes filters and validates API shapes", async () => {
  const feed = {
    items: [],
    nextCursor: null,
    historyStartsAt: null,
    retainedFrom: null,
    coverage: { mutations: true, reads: true, observations: "refresh", observationGap: true },
  };
  const fetcher = vi.fn(async (_url: string, _init: RequestInit) => Response.json(feed));
  vi.stubGlobal("fetch", fetcher);
  expect(
    await activityFeed({ q: "/old name", action: "file.move", cursor: undefined }),
  ).toMatchObject(feed);
  expect(fetcher).toHaveBeenLastCalledWith(
    "/api/v1/activity?q=%2Fold+name&action=file.move",
    expect.objectContaining({ credentials: "same-origin", cache: "no-store" }),
  );
  await activityFeed({ q: "" }, "/files/file/events");
  expect(fetcher.mock.calls.at(-1)?.[0]).toBe("/api/v1/activity/files/file/events?");
  fetcher.mockResolvedValueOnce(
    Response.json({ error: { kind: "forbidden", message: "Login removed" } }, { status: 403 }),
  );
  await expect(
    activityRequest("/", { method: "POST", headers: { "x-extra": "ok" } }),
  ).rejects.toThrow("Login removed");
  expect(fetcher).toHaveBeenLastCalledWith(
    "/api/v1/activity/",
    expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ "x-extra": "ok" }),
    }),
  );
  fetcher.mockResolvedValueOnce(Response.json({}, { status: 500 }));
  await expect(activityRequest("/")).rejects.toThrow("Could not load your activity");
  const file = {
    id,
    identityId: id,
    label: "Drive",
    kind: "file",
    lastKnownPath: "/a",
    currentPath: null,
    availability: "unknown",
    lastConfirmedAt: null,
    revisionId: null,
  };
  fetcher.mockResolvedValueOnce(Response.json(file));
  expect(await activityFile(id)).toEqual(file);
  fetcher.mockResolvedValueOnce(
    Response.json({ items: [{ identityId: id, label: "Previous drive" }] }),
  );
  expect(await activityLocations()).toEqual([{ identityId: id, label: "Previous drive" }]);
  fetcher.mockResolvedValueOnce(Response.json({ global: "invalid" }));
  await expect(activityFeed({})).rejects.toThrow();
});

function event(patch: Partial<PersonalActivityEvent>): PersonalActivityEvent {
  return {
    id,
    operationId: null,
    stage: "outcome",
    provisional: false,
    sortAt: "2026-09-14T00:00:00Z",
    subjects: [],
    before: null,
    after: null,
    ...patch,
  } as PersonalActivityEvent;
}
it("collapses paginated intents into outcomes, keeps unrelated observations and sorts deterministically", () => {
  const intent = event({ id: "intent", operationId: "op", stage: "intent" });
  const outcome = event({ id: "outcome", operationId: "op" });
  const observation = event({ id: "unknown", sortAt: "2026-09-15T00:00:00Z" });
  expect(collapseActivity([intent, observation, outcome, intent])).toEqual([observation, outcome]);
  const pending = event({ provisional: true });
  const sealed = event({});
  expect(collapseActivity([pending, sealed])).toEqual([sealed]);
  expect(collapseActivity([event({ id: "a" }), event({ id: "b" })]).map((row) => row.id)).toEqual([
    "b",
    "a",
  ]);
  expect(Object.keys(activityLabels)).toHaveLength(37);
});
it("uses recorded destination, prior path and subject evidence without inventing a location", () => {
  const subject = {
    fileId: id,
    identityId: id,
    revisionId: null,
    ordinal: 0,
    role: "target" as const,
    path: "/target",
  };
  expect(activityPath(event({ after: { targetPath: "/new", path: "/old" } }))).toBe("/new");
  expect(activityPath(event({ after: { path: "/after" } }))).toBe("/after");
  expect(activityPath(event({ subjects: [subject] }))).toBe("/target");
  expect(activityPath(event({ before: { path: "/before" } }))).toBe("/before");
  expect(activityPath(event({ subjects: [{ ...subject, role: "affected" }] }))).toBe("/target");
  expect(activityPath(event({}))).toBeNull();
});
