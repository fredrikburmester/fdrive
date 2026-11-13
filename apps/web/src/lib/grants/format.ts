import {
  ApiClientError,
  type GrantAccess,
  type OwnedGrant,
  type ReceivedGrant,
} from "@fdrive/contracts";
import { describeApiError } from "@/lib/api/errors";

/** How each access level reads in a select and next to a shared folder. */
export const GRANT_ACCESS_LABELS: Readonly<Record<GrantAccess, string>> = {
  read: "Can view",
  write: "Can edit",
};

/** The access levels in the order a select offers them. */
export const GRANT_ACCESS_OPTIONS: readonly GrantAccess[] = ["read", "write"];

/** "alice · Can view": who shares a folder with this login, and what it may do there. */
export function receivedGrantCaption(grant: Pick<ReceivedGrant, "owner" | "access">): string {
  return `${grant.owner} · ${GRANT_ACCESS_LABELS[grant.access]}`;
}

/** The caption for a folder in `Shared with me`, or `null` for anything not shared with this login. */
export function sharedFolderCaption(
  path: string,
  received: readonly Pick<ReceivedGrant, "path" | "owner" | "access">[],
): string | null {
  const grant = received.find((candidate) => candidate.path === path);
  return grant === undefined ? null : receivedGrantCaption(grant);
}

/** The grants of `owned` on one folder, by username. */
export function grantsOnFolder(owned: readonly OwnedGrant[], path: string): OwnedGrant[] {
  return owned
    .filter((grant) => grant.path === path)
    .sort((a, b) => a.username.localeCompare(b.username));
}

/** The people a folder can still be shared with: everyone but those who already have it. */
export function peopleToAdd(
  usernames: readonly string[],
  current: readonly Pick<OwnedGrant, "username">[],
): string[] {
  const taken = new Set(current.map((grant) => grant.username));
  return usernames.filter((username) => !taken.has(username));
}

/** The server's own sentence, capitalized and stopped, for a refusal worth reading as is. */
function sentence(message: string): string {
  const text = `${message.charAt(0).toUpperCase()}${message.slice(1)}`;
  return text.endsWith(".") ? text : `${text}.`;
}

/**
 * A failed grant change as a sentence. The API names what it refused ("only
 * folders can be shared", "no such user"), so those are shown as written;
 * anything else reads like every other API error.
 */
export function describeGrantError(error: unknown): string {
  if (
    error instanceof ApiClientError &&
    (error.kind === "bad_request" || error.kind === "not_found") &&
    error.message.length > 0
  ) {
    return sentence(error.message);
  }
  return describeApiError(error);
}

/** The storage's refusals inside `Shared with me`, by the start of its message. */
const SHARED_REFUSALS: readonly (readonly [prefix: string, text: string])[] = [
  ["this folder is shared read-only", "This folder is shared with you to view only."],
  [
    "a shared folder is changed by its owner",
    "Only the owner can rename, move or delete a shared folder.",
  ],
  [
    "only folders others share can be in",
    "Only folders others share with you go in Shared with me.",
  ],
  ["Shared with me cannot be copied", "Shared with me can't be copied. Copy a folder inside it."],
];

/**
 * A clear sentence for the storage refusing a change in or around a folder
 * shared with this login, or `null` for any other refusal.
 */
export function sharedFolderRefusal(message: string): string | null {
  return SHARED_REFUSALS.find(([prefix]) => message.startsWith(prefix))?.[1] ?? null;
}
