import { z } from "zod";
import { LocalUsername } from "./users.ts";

/** What a person a folder is shared with may do: look, or also change what is in it. */
export const GrantAccess = z.enum(["read", "write"]);
export type GrantAccess = z.infer<typeof GrantAccess>;

/** A folder of yours shared with another user of this storage. */
export const OwnedGrant = z.object({
  id: z.uuid(),
  /** The folder in your files. */
  path: z.string(),
  /** Who it is shared with. */
  username: z.string(),
  access: GrantAccess,
  createdAt: z.iso.datetime(),
});
export type OwnedGrant = z.infer<typeof OwnedGrant>;

/** A folder another user shares with you, as it appears in your files. */
export const ReceivedGrant = z.object({
  id: z.uuid(),
  /** Who shares it. */
  owner: z.string(),
  /** Its name under `Shared with me`. */
  name: z.string(),
  /** Where it is in your files: `/Shared with me/<name>`. */
  path: z.string(),
  access: GrantAccess,
  createdAt: z.iso.datetime(),
});
export type ReceivedGrant = z.infer<typeof ReceivedGrant>;

/**
 * `GET /api/v1/grants`. `available` is false for a login whose storage
 * cannot share folders between its users (anything but the local folder).
 */
export const GrantsResponse = z.object({
  available: z.boolean(),
  owned: z.array(OwnedGrant),
  received: z.array(ReceivedGrant),
});
export type GrantsResponse = z.infer<typeof GrantsResponse>;

/** `POST /api/v1/grants`: share one of your folders, or change who may change it. */
export const CreateGrantRequest = z.strictObject({
  path: z.string().min(1).max(4096),
  username: LocalUsername,
  access: GrantAccess,
});
export type CreateGrantRequest = z.infer<typeof CreateGrantRequest>;

/** `PATCH /api/v1/grants/:id`: the owner changes the access. */
export const UpdateGrantRequest = z.strictObject({
  access: GrantAccess,
});
export type UpdateGrantRequest = z.infer<typeof UpdateGrantRequest>;

/** `GET /api/v1/grants/people`: the other active users a folder can be shared with. */
export const GrantPeopleResponse = z.object({
  usernames: z.array(z.string()),
});
export type GrantPeopleResponse = z.infer<typeof GrantPeopleResponse>;
