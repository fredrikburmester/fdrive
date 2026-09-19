import { describe, expect, it } from "vitest";
import {
  ActivityFacts,
  ActivityFileResponse,
  ActivityLineageResponse,
  ActivityLocationsResponse,
  ActivityRevisionsResponse,
  ClientActivityRequest,
  PersonalActivityAction,
  PersonalActivityFilters,
  PersonalActivityResponse,
} from "./personal-activity";

const id = "00000000-0000-4000-8000-000000000001";
describe("personal activity contracts", () => {
  it("enumerates actions without a folder-visit or generic job-completion event", () => {
    expect(PersonalActivityAction.options).toHaveLength(37);
    expect(PersonalActivityAction.safeParse("folder.visit").success).toBe(false);
    expect(PersonalActivityAction.safeParse("job.completed").success).toBe(false);
  });
  it("rejects arbitrary payloads, content, paths outside the virtual namespace and malformed facts", () => {
    for (const bad of [
      { content: "bytes" },
      { password: "secret" },
      { path: "host/file" },
      { tags: [{ id, name: "tag", color: null, secret: "hidden" }] },
      { sha256: "not-a-digest" },
    ])
      expect(ActivityFacts.safeParse(bad).success).toBe(false);
    expect(
      ActivityFacts.parse({
        path: "/a",
        kind: "file",
        sha256: "a".repeat(64),
        view: "tree",
        tags: [{ id, name: "work", color: null }],
        permissions: ["read"],
      }).path,
    ).toBe("/a");
  });
  it("admits only reported gestures, never caller-supplied authorship or mutation outcomes", () => {
    const input = {
      identityId: id,
      requestId: id,
      at: "2026-09-14T10:00:00Z",
      path: "/a",
      action: "file.open",
    };
    expect(ClientActivityRequest.safeParse(input).success).toBe(true);
    for (const patch of [
      { accountId: id },
      { actorAccountId: id },
      { action: "file.delete" },
      { outcome: "success" },
    ])
      expect(ClientActivityRequest.safeParse({ ...input, ...patch }).success).toBe(false);
    expect(PersonalActivityFilters.parse({ limit: "100" }).limit).toBe(100);
    expect(PersonalActivityFilters.safeParse({ limit: "101" }).success).toBe(false);
    expect(PersonalActivityFilters.safeParse({ owner: id }).success).toBe(false);
  });
  it("validates private journey and paging response shapes", () => {
    expect(
      ActivityFileResponse.parse({
        id,
        identityId: id,
        label: "Storage",
        kind: "file",
        lastKnownPath: "/a",
        currentPath: null,
        availability: "unknown",
        lastConfirmedAt: null,
        revisionId: null,
      }).availability,
    ).toBe("unknown");
    expect(ActivityLineageResponse.parse({ items: [], nextCursor: null }).items).toEqual([]);
    expect(ActivityRevisionsResponse.parse({ items: [], nextCursor: null }).items).toEqual([]);
    expect(
      ActivityLocationsResponse.parse({ items: [{ identityId: id, label: "Retired" }] }).items,
    ).toHaveLength(1);
    expect(
      PersonalActivityResponse.parse({
        items: [],
        nextCursor: null,
        historyStartsAt: null,
        retainedFrom: null,
        coverage: { mutations: true, reads: true, observations: "refresh", observationGap: true },
      }).provisionalReads,
    ).toEqual([]);
  });
});
