import { describe, expect, it } from "vitest";
import {
  CreateGrantRequest,
  GrantAccess,
  GrantPeopleResponse,
  GrantsResponse,
  OwnedGrant,
  ReceivedGrant,
  UpdateGrantRequest,
} from "./grants.ts";

const ID = "123e4567-e89b-42d3-a456-426614174000";
const AT = "2026-01-01T00:00:00.000Z";

describe("grant contracts", () => {
  const owned = { id: ID, path: "/Projects", username: "bob", access: "read", createdAt: AT };
  const received = {
    id: ID,
    owner: "carol",
    name: "Photos (carol)",
    path: "/Shared with me/Photos (carol)",
    access: "write",
    createdAt: AT,
  };

  it("has read and write access only", () => {
    expect(GrantAccess.options).toEqual(["read", "write"]);
    expect(GrantAccess.safeParse("admin").success).toBe(false);
  });

  it("parses owned and received shares and the list", () => {
    expect(OwnedGrant.parse(owned)).toEqual(owned);
    expect(OwnedGrant.safeParse({ ...owned, id: "nope" }).success).toBe(false);
    expect(ReceivedGrant.parse(received)).toEqual(received);
    expect(ReceivedGrant.safeParse({ ...received, owner: undefined }).success).toBe(false);
    const list = { available: true, owned: [owned], received: [received] };
    expect(GrantsResponse.parse(list)).toEqual(list);
    expect(GrantsResponse.safeParse({ owned: [], received: [] }).success).toBe(false);
  });

  it("shares a folder with a valid username and access", () => {
    const create = { path: "/Projects", username: "bob", access: "write" };
    expect(CreateGrantRequest.parse(create)).toEqual(create);
    expect(CreateGrantRequest.parse({ ...create, username: " bob " }).username).toBe("bob");
    expect(CreateGrantRequest.safeParse({ ...create, path: "" }).success).toBe(false);
    expect(CreateGrantRequest.safeParse({ ...create, path: "x".repeat(4097) }).success).toBe(false);
    expect(CreateGrantRequest.safeParse({ ...create, username: "../bob" }).success).toBe(false);
    expect(CreateGrantRequest.safeParse({ ...create, access: "owner" }).success).toBe(false);
    expect(CreateGrantRequest.safeParse({ ...create, extra: 1 }).success).toBe(false);
  });

  it("changes only the access", () => {
    expect(UpdateGrantRequest.parse({ access: "read" })).toEqual({ access: "read" });
    expect(UpdateGrantRequest.safeParse({}).success).toBe(false);
    expect(UpdateGrantRequest.safeParse({ access: "read", path: "/x" }).success).toBe(false);
  });

  it("lists people by username", () => {
    expect(GrantPeopleResponse.parse({ usernames: ["bob"] })).toEqual({ usernames: ["bob"] });
    expect(GrantPeopleResponse.safeParse({ usernames: [1] }).success).toBe(false);
  });
});
