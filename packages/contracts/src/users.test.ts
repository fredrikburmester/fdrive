import { describe, expect, it } from "vitest";
import {
  AdminUser,
  AdminUserCreateRequest,
  AdminUsersResponse,
  AdminUserUpdateRequest,
  ChangePasswordRequest,
  LOCAL_PASSWORD_MIN_LENGTH,
  LocalPassword,
  LocalUsername,
} from "./users.ts";

const AT = "2026-01-01T00:00:00.000Z";

describe("LocalUsername", () => {
  it("accepts names that can be a home folder, trimmed", () => {
    for (const name of ["alice", "Bob2", "a", "j.doe_1@example~x-y", "x".repeat(255)]) {
      expect(LocalUsername.parse(name)).toBe(name);
    }
    expect(LocalUsername.parse("  alice ")).toBe("alice");
  });

  it("rejects empty, dot-led, path-like and over-long names", () => {
    for (const name of [
      "",
      " ",
      ".hidden",
      "-x",
      "_x",
      "a/b",
      "a\\b",
      "a b",
      "..",
      "x".repeat(256),
    ]) {
      expect(LocalUsername.safeParse(name).success).toBe(false);
    }
  });
});

describe("LocalPassword", () => {
  it("bounds the length", () => {
    expect(LocalPassword.safeParse("x".repeat(LOCAL_PASSWORD_MIN_LENGTH)).success).toBe(true);
    expect(LocalPassword.safeParse("x".repeat(LOCAL_PASSWORD_MIN_LENGTH - 1)).success).toBe(false);
    expect(LocalPassword.safeParse("x".repeat(1024)).success).toBe(true);
    expect(LocalPassword.safeParse("x".repeat(1025)).success).toBe(false);
  });
});

describe("admin user contracts", () => {
  const user = {
    username: "alice",
    disabled: false,
    isAdmin: true,
    isYou: true,
    adminByDeployment: false,
    createdAt: AT,
    lastLoginAt: null,
  };

  it("parses a user and the list, with or without a last sign-in", () => {
    expect(AdminUser.parse(user)).toEqual(user);
    expect(AdminUser.parse({ ...user, lastLoginAt: AT }).lastLoginAt).toBe(AT);
    expect(AdminUser.safeParse({ ...user, createdAt: "yesterday" }).success).toBe(false);
    expect(AdminUsersResponse.parse({ available: false, users: [] })).toEqual({
      available: false,
      users: [],
    });
    expect(AdminUsersResponse.safeParse({ users: [user] }).success).toBe(false);
  });

  it("creates a user with an optional administrator flag and nothing else", () => {
    const create = { username: "bob", password: "correct-horse" };
    expect(AdminUserCreateRequest.parse(create)).toEqual(create);
    expect(AdminUserCreateRequest.parse({ ...create, isAdmin: true })).toEqual({
      ...create,
      isAdmin: true,
    });
    expect(AdminUserCreateRequest.safeParse({ ...create, password: "short" }).success).toBe(false);
    expect(AdminUserCreateRequest.safeParse({ ...create, username: "a/b" }).success).toBe(false);
    expect(AdminUserCreateRequest.safeParse({ ...create, disabled: true }).success).toBe(false);
  });

  it("updates any subset of password, disabled and administrator", () => {
    expect(AdminUserUpdateRequest.parse({})).toEqual({});
    const patch = { password: "new-password", disabled: true, isAdmin: false };
    expect(AdminUserUpdateRequest.parse(patch)).toEqual(patch);
    expect(AdminUserUpdateRequest.safeParse({ password: "short" }).success).toBe(false);
    expect(AdminUserUpdateRequest.safeParse({ username: "carol" }).success).toBe(false);
  });

  it("changes one's own password: any current password, a valid new one", () => {
    const body = { currentPassword: "x", newPassword: "new-password" };
    expect(ChangePasswordRequest.parse(body)).toEqual(body);
    expect(ChangePasswordRequest.safeParse({ ...body, currentPassword: "" }).success).toBe(false);
    expect(ChangePasswordRequest.safeParse({ ...body, newPassword: "short" }).success).toBe(false);
    expect(ChangePasswordRequest.safeParse({ ...body, extra: 1 }).success).toBe(false);
  });
});
