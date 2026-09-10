import { expect, it } from "vitest";
import {
  AccountFavoritesResponse,
  AccountIdentityId,
  AccountSearchResponse,
  LinkIdentityRequest,
  SwitchIdentityRequest,
} from "./accounts.ts";

const identityId = "123e4567-e89b-42d3-a456-426614174000";
it("bounds strict credential requests and canonical identity selection", () => {
  const link = {
    credential: { username: "alice", password: "secret", otp: "123456" },
    currentCredential: { password: "mine" },
  };
  expect(LinkIdentityRequest.parse(link)).toEqual(link);
  expect(LinkIdentityRequest.parse({ ...link, providerId: identityId })).toEqual({
    ...link,
    providerId: identityId,
  });
  for (const invalid of [
    { credential: { username: "a", password: "x".repeat(4097) }, currentCredential: {} },
    { credential: { username: 1 }, currentCredential: {} },
    { credential: {}, currentCredential: {}, accountId: identityId },
    // The signed-in login's own credential is mandatory.
    { credential: { username: "a", password: "x" } },
    { credential: {}, currentCredential: { password: "x".repeat(4097) } },
    { providerId: "nope", credential: {}, currentCredential: {} },
  ])
    expect(LinkIdentityRequest.safeParse(invalid).success).toBe(false);
  expect(SwitchIdentityRequest.parse({ identityId })).toEqual({ identityId });
  expect(AccountIdentityId.safeParse(identityId.toUpperCase()).success).toBe(false);
  expect(SwitchIdentityRequest.safeParse({ identityId, accountId: identityId }).success).toBe(
    false,
  );
});
it("requires identity provenance and exposes partial-result failures", () => {
  const item = { identityId, path: "/a", kind: "file", addedAt: "2026-09-06T00:00:00Z" };
  expect(
    AccountFavoritesResponse.parse({ items: [item], unavailableIdentityIds: [] }).items,
  ).toHaveLength(1);
  expect(
    AccountFavoritesResponse.safeParse({
      items: [{ ...item, identityId: undefined }],
      unavailableIdentityIds: [],
    }).success,
  ).toBe(false);
  expect(
    AccountFavoritesResponse.safeParse({
      items: Array.from({ length: 1001 }, () => item),
      unavailableIdentityIds: [],
    }).success,
  ).toBe(false);
  expect(
    AccountSearchResponse.parse({
      query: "a",
      sections: { folders: [], files: [], content: [] },
      degraded: false,
      unavailable: true,
      tookMs: 0,
      unavailableIdentityIds: [identityId],
    }).unavailableIdentityIds,
  ).toEqual([identityId]);
});
