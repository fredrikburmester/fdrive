import {
  CreateShareRequest,
  type FsEntry,
  MAX_SHARE_DOWNLOADS,
  type ManagedShare,
  type SharePresentation,
  UpdateShareRequest,
} from "@fdrive/contracts";

export type PasswordAction = "keep" | "change" | "remove";
export interface ShareFields {
  name: string;
  description: string;
  scope: "read" | "write";
  presentation: SharePresentation;
  expires: string;
  maxDownloads: string;
  password: string;
  passwordAction: PasswordAction;
}

/** Characters that read unambiguously out loud and on screen, for a generated password. */
const PASSWORD_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";

/** Maps random bytes to a password string. Pure so tests supply the bytes deterministically. */
export function passwordFromBytes(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => PASSWORD_CHARS.charAt(byte % PASSWORD_CHARS.length)).join("");
}

export function localDateInput(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) throw new Error("Choose a valid expiration time.");
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function initialShareFields(
  entries: readonly Pick<FsEntry, "name">[],
  share?: ManagedShare,
): ShareFields {
  return {
    name:
      share?.name ?? (entries.length === 1 ? (entries[0]?.name ?? "Shared files") : "Shared files"),
    description: share?.description ?? "",
    scope: share?.scope ?? "read",
    presentation: share?.presentation ?? "auto",
    expires: localDateInput(share?.expiresAt ?? null),
    maxDownloads: share?.maxDownloads ? String(share.maxDownloads) : "",
    password: "",
    passwordAction: share ? "keep" : "change",
  };
}

export function canUploadShare(entries: readonly Pick<FsEntry, "kind">[]): boolean {
  return entries.length === 1 && entries[0]?.kind === "dir";
}

/** PATCH omits the password unless the user explicitly changes or removes it. */
export function shareRequest(
  fields: ShareFields,
  entries: readonly Pick<FsEntry, "path" | "kind">[],
  editing: boolean,
): CreateShareRequest | UpdateShareRequest {
  if (fields.scope === "write" && !canUploadShare(entries))
    throw new Error("Upload-only links require one folder.");
  let expiresAt: string | null = null;
  if (fields.expires) {
    const date = new Date(fields.expires);
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(fields.expires) ||
      !Number.isFinite(date.getTime()) ||
      localDateInput(date.toISOString()) !== fields.expires
    ) {
      throw new Error("Choose a valid expiration time.");
    }
    expiresAt = date.toISOString();
  }
  if (fields.maxDownloads && !/^\d+$/.test(fields.maxDownloads))
    throw new Error("The download limit must be a whole number.");
  const maxDownloads = fields.maxDownloads ? Number(fields.maxDownloads) : 0;
  if (maxDownloads > MAX_SHARE_DOWNLOADS) throw new Error("The download limit is too large.");
  const password =
    editing && fields.passwordAction === "keep"
      ? undefined
      : fields.passwordAction === "remove"
        ? ""
        : fields.password;
  if (editing && fields.passwordAction === "change" && !password)
    throw new Error("Enter the new password or choose Remove password.");
  const input = {
    name: fields.name.trim(),
    description: fields.description,
    scope: fields.scope,
    presentation: fields.presentation,
    paths: entries.map((entry) => entry.path),
    expiresAt,
    maxDownloads,
    ...(password === undefined ? {} : { password }),
  };
  const parsed = (editing ? UpdateShareRequest : CreateShareRequest).safeParse(input);
  if (!parsed.success)
    throw new Error("Check the name, description, password, and selected files.");
  return parsed.data;
}
