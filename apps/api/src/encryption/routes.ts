import {
  ENCRYPTED_FOLDER_MARKER,
  ENCRYPTED_FOLDERS_HEADER,
  EncryptedEntriesQuery,
  type EncryptedEntry,
  EncryptedFolderCreateRequest,
  EncryptionPasswordRequest,
  EncryptionResetRequest,
  EncryptionSetupRequest,
  type EncryptionStatus,
  isEncryptedName,
  MAX_ENCRYPTED_ENTRIES,
  ROUTES,
} from "@fdrive/contracts";
import {
  baseName,
  type CoreError,
  isReservedPath,
  normalizePath,
  parentPath,
  type StorageProvider,
} from "@fdrive/core";
import type { ApiTokenRepo, EncryptionKeyRepo, EncryptionKeys } from "@fdrive/db";
import { SHARED_WITH_ME } from "@fdrive/local";
import type { MiddlewareHandler } from "hono";
import { activityRequestContext } from "../activity/fs-context.js";
import type { AppHono, AuthedHono } from "../app.js";
import { accountContext } from "../auth/account-context.js";
import { ApiHttpError } from "../errors.js";
import { type FileOperations, fileActor } from "../files/operations.js";
import { parseBody, runStorageCall } from "../fs/routes.js";
import { extractClientIp } from "../net.js";
import { encryptedFoldersOf, withEncryptedAccess } from "./guard.js";

const API_PREFIX = "/api/v1";
const route = (path: string) => path.slice(API_PREFIX.length);

/**
 * The web routes allowed inside encrypted folders: browsing, opening,
 * uploading, renaming, moving and copying within one, Trash, and the
 * path-keyed metadata that only names a path. Everything else, share links,
 * Office, AI, MCP, ZIP, archives, transcoding and thumbnails among them, is
 * refused by the storage guard because it is not here.
 */
export const ENCRYPTED_WEB_ROUTES: readonly string[] = [
  ROUTES.fs.list,
  ROUTES.fs.stat,
  ROUTES.fs.download,
  ROUTES.fs.upload,
  ROUTES.fs.mkdir,
  ROUTES.fs.move,
  ROUTES.fs.moveMany,
  ROUTES.fs.copy,
  ROUTES.fs.rename,
  ROUTES.fs.delete,
  ROUTES.fs.folderSize,
  ROUTES.fs.tags,
  ROUTES.favorites.base,
  ROUTES.folderViews.base,
  `${ROUTES.folderViews.base}/*`,
  ROUTES.recents.touch,
  ROUTES.trash.list,
  `${ROUTES.trash.list}/*`,
  ROUTES.encryption.base,
  `${ROUTES.encryption.base}/*`,
].map(route);

const allow: MiddlewareHandler = (_c, next) => withEncryptedAccess(() => next());

/** The Mac's routes are allowed only for an app that encrypts and decrypts, which says so. */
const allowEncryptingApp: MiddlewareHandler = (c, next) =>
  c.req.header(ENCRYPTED_FOLDERS_HEADER) === "1" ? withEncryptedAccess(() => next()) : next();

/** Registers the allowed list. Must run before the routes it allows are registered. */
export function registerEncryptedAccess(groups: {
  public: AppHono;
  authed: AuthedHono;
  v2: AppHono;
}): void {
  for (const path of ENCRYPTED_WEB_ROUTES) groups.authed.use(path, allow);
  groups.public.use("/desktop/*", allowEncryptingApp);
  groups.v2.use("/desktop/*", allowEncryptingApp);
}

export interface EncryptionRoutesDeps {
  readonly keys: EncryptionKeyRepo;
  readonly tokens: Pick<ApiTokenRepo, "delete">;
  readonly files: Pick<FileOperations, "mkdir">;
  /** Checks the sign-in password like a sign-in, behind the login limiter. */
  readonly reauthenticate: (
    accountId: string,
    identityId: string,
    password: string,
    ip: string,
  ) => Promise<void>;
  readonly trustedProxyHops: number;
}

function normalized(path: string): string {
  try {
    return normalizePath(path);
  } catch (error) {
    throw new ApiHttpError("bad_request", (error as CoreError).message);
  }
}

async function status(
  keys: EncryptionKeyRepo,
  found: EncryptionKeys | null,
): Promise<EncryptionStatus> {
  if (found === null) return { enabled: false };
  const devices = await keys.devices(found.identityId);
  return {
    enabled: true,
    recipient: found.recipient,
    passwordKey: found.passwordKey,
    recoveryKey: found.recoveryKey,
    devices: devices.map((device) => ({
      id: device.tokenId,
      name: device.name,
      createdAt: device.createdAt.toISOString(),
    })),
    createdAt: found.createdAt.toISOString(),
  };
}

/** Where a new encrypted folder may go: not inside another, Trash, the Mac's folder or Shared with me. */
async function checkNewFolder(path: string, folders: ReturnType<typeof encryptedFoldersOf>) {
  const name = baseName(path);
  if (path === "/" || name === ENCRYPTED_FOLDER_MARKER || isEncryptedName(name)) {
    throw new ApiHttpError("bad_request", "choose another name for the encrypted folder");
  }
  if (isReservedPath(path)) throw new ApiHttpError("bad_request", "fdrive keeps this folder");
  const top = path.split("/")[1];
  if (top === SHARED_WITH_ME) {
    throw new ApiHttpError("bad_request", "make encrypted folders in your own files");
  }
  const parent = parentPath(path);
  if ((await folders.isFolder(parent)) || (await folders.containing(parent)) !== null) {
    throw new ApiHttpError("bad_request", "an encrypted folder cannot go inside another");
  }
}

/** Every entry below an encrypted folder, folder by folder, at most {@link MAX_ENCRYPTED_ENTRIES}. */
async function walk(
  storage: StorageProvider,
  root: string,
): Promise<{ entries: EncryptedEntry[]; truncated: boolean }> {
  const entries: EncryptedEntry[] = [];
  const queue = [root];
  while (queue.length > 0) {
    const folder = queue.shift() as string;
    for (const entry of await storage.list(folder)) {
      if (entry.kind !== "file" && entry.kind !== "dir") continue;
      if (entries.length === MAX_ENCRYPTED_ENTRIES) return { entries, truncated: true };
      entries.push({ path: entry.path, kind: entry.kind });
      if (entry.kind === "dir") queue.push(entry.path);
    }
  }
  return { entries, truncated: false };
}

export function registerEncryptionRoutes(
  groups: { authed: AuthedHono },
  deps: EncryptionRoutesDeps,
) {
  const { authed } = groups;
  const reauth = (c: Parameters<typeof accountContext>[0], password: string) => {
    const { principal } = accountContext(c);
    return deps.reauthenticate(
      principal.accountId,
      principal.identityId,
      password,
      extractClientIp(c, deps.trustedProxyHops),
    );
  };

  authed.get(route(ROUTES.encryption.base), async (c) => {
    const { principal } = accountContext(c);
    return c.json(await status(deps.keys, await deps.keys.get(principal.identityId)));
  });

  authed.post(route(ROUTES.encryption.base), async (c) => {
    const body = await parseBody(EncryptionSetupRequest, c);
    await reauth(c, body.signInPassword);
    const { principal } = accountContext(c);
    const created = await deps.keys.create({
      identityId: principal.identityId,
      recipient: body.recipient,
      passwordKey: body.passwordKey,
      recoveryKey: body.recoveryKey,
    });
    if (created === null) throw new ApiHttpError("conflict", "encryption is already on");
    return c.json(await status(deps.keys, created), 201);
  });

  authed.put(route(ROUTES.encryption.password), async (c) => {
    const body = await parseBody(EncryptionPasswordRequest, c);
    await reauth(c, body.signInPassword);
    const { principal } = accountContext(c);
    if (!(await deps.keys.setPasswordKey(principal.identityId, body.passwordKey))) {
      throw new ApiHttpError("not_found", "encryption is not on");
    }
    return c.json({ ok: true });
  });

  authed.post(route(ROUTES.encryption.reset), async (c) => {
    const body = await parseBody(EncryptionResetRequest, c);
    await reauth(c, body.signInPassword);
    const { principal } = accountContext(c);
    await deps.keys.remove(principal.identityId);
    return c.json({ ok: true });
  });

  authed.delete(`${route(ROUTES.encryption.devices)}/:id`, async (c) => {
    const { principal } = accountContext(c);
    const id = c.req.param("id") ?? "";
    if (!(await deps.keys.removeDevice(principal.identityId, id))) {
      throw new ApiHttpError("not_found", "no such device");
    }
    // The Mac's token goes with its key, so it cannot ask for the key again.
    await deps.tokens.delete(id, principal.accountId);
    return c.json({ ok: true });
  });

  authed.post(route(ROUTES.encryption.folders), async (c) => {
    const body = await parseBody(EncryptedFolderCreateRequest, c);
    const { principal } = accountContext(c);
    const keys = await deps.keys.get(principal.identityId);
    if (keys === null) throw new ApiHttpError("bad_request", "turn encryption on first");
    if (body.marker.members[0]?.recipient !== keys.recipient) {
      throw new ApiHttpError("bad_request", "the folder must be encrypted for your key");
    }
    const path = normalized(body.path);
    const folders = encryptedFoldersOf(principal.storage);
    await checkNewFolder(path, folders);
    await runStorageCall(() =>
      deps.files.mkdir(fileActor(principal, activityRequestContext(c)), path),
    );
    try {
      await runStorageCall(() => folders.writeMarker(path, body.marker));
    } catch (error) {
      // Leave nothing that looks like an encrypted folder without its keys.
      await principal.storage.deleteEmptyDir(path).catch(() => undefined);
      throw error;
    }
    return c.json({ path, marker: body.marker }, 201);
  });

  authed.get(route(ROUTES.encryption.folder), async (c) => {
    const query = EncryptedEntriesQuery.safeParse(c.req.query());
    if (!query.success) throw new ApiHttpError("bad_request", "invalid query");
    const { principal } = accountContext(c);
    const folder = await runStorageCall(() =>
      encryptedFoldersOf(principal.storage).info(normalized(query.data.path)),
    );
    return c.json({ folder });
  });

  authed.get(route(ROUTES.encryption.entries), async (c) => {
    const query = EncryptedEntriesQuery.safeParse(c.req.query());
    if (!query.success) throw new ApiHttpError("bad_request", "invalid query");
    const { principal } = accountContext(c);
    const path = normalized(query.data.path);
    if (!(await encryptedFoldersOf(principal.storage).isFolder(path))) {
      throw new ApiHttpError("bad_request", "not an encrypted folder");
    }
    return c.json(await runStorageCall(() => walk(principal.storage, path)));
  });
}
