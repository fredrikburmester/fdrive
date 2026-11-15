import { z } from "zod";

/**
 * A local username is also its home folder's name: a letter or digit first,
 * then letters, digits and `._@~-`, up to 255 characters.
 */
export const LOCAL_USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@~-]{0,254}$/;

export const LocalUsername = z
  .string()
  .trim()
  .regex(
    LOCAL_USERNAME_PATTERN,
    "Use letters, digits and . _ @ ~ - only, starting with a letter or digit.",
  );

/** The shortest password fdrive accepts for a local user. */
export const LOCAL_PASSWORD_MIN_LENGTH = 8;

export const LocalPassword = z
  .string()
  .min(LOCAL_PASSWORD_MIN_LENGTH, `Use at least ${LOCAL_PASSWORD_MIN_LENGTH} characters.`)
  .max(1024, "Use 1024 characters or fewer.");

/** A storage limit in bytes. */
export const StorageLimit = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/** One local user as `GET /api/v1/admin/users` lists it. */
export const AdminUser = z.object({
  username: z.string(),
  disabled: z.boolean(),
  /** Whether the user's account is an administrator. */
  isAdmin: z.boolean(),
  /** True for the signed-in administrator's own user, which they cannot disable or remove. */
  isYou: z.boolean(),
  createdAt: z.iso.datetime(),
  lastLoginAt: z.iso.datetime().nullable(),
  /** Bytes in their folder, as the search index counts them; `null` while the folder is not indexed. */
  storageUsed: z.number().int().nonnegative().nullable(),
  /** The most bytes their folder may hold, or `null` for no limit. */
  storageLimit: StorageLimit.nullable(),
});
export type AdminUser = z.infer<typeof AdminUser>;

export const AdminUsersResponse = z.object({
  users: z.array(AdminUser),
});
export type AdminUsersResponse = z.infer<typeof AdminUsersResponse>;

export const AdminUserCreateRequest = z.strictObject({
  username: LocalUsername,
  password: LocalPassword,
  isAdmin: z.boolean().optional(),
});
export type AdminUserCreateRequest = z.infer<typeof AdminUserCreateRequest>;

/** A new password, the disabled flag, the administrator flag or the storage limit (`null` for none); any subset. */
export const AdminUserUpdateRequest = z.strictObject({
  password: LocalPassword.optional(),
  disabled: z.boolean().optional(),
  isAdmin: z.boolean().optional(),
  storageLimit: StorageLimit.nullable().optional(),
});
export type AdminUserUpdateRequest = z.infer<typeof AdminUserUpdateRequest>;

/** Body for `POST /api/v1/auth/password`: the signed-in local user changes their own password. */
export const ChangePasswordRequest = z.strictObject({
  currentPassword: z.string().min(1).max(1024),
  newPassword: LocalPassword,
});
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequest>;
