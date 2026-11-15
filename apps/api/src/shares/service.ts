import {
  CreateShareRequest,
  isStreamedPreviewName,
  type ManagedShare,
  type PublicShare,
  type UpdateShareRequest,
} from "@fdrive/contracts";
import {
  baseName,
  isAtOrUnder,
  isReservedPath,
  isStorageError,
  joinPath,
  normalizePath,
  RESERVED_FOLDERS,
  type StorageProvider,
  uniqueNumberedName,
} from "@fdrive/core";
import type { PublicShareRecord, ShareRecord, ShareRepo } from "@fdrive/db";
import { SHARED_WITH_ME } from "@fdrive/local";
import {
  type PeekArchiveResult,
  peekArchive,
  UnreadableArchiveError,
  UnsupportedPeekFormatError,
} from "../archive/peek.ts";
import { ApiHttpError } from "../errors.ts";
import type { FileOperations } from "../files/operations.ts";
import { type DownloadOutcome, resolveDownload } from "../fs/routes.ts";
import type { ShareCredential } from "./credentials.ts";
import type { SharePasswords } from "./passwords.ts";
import {
  createShareZipSlots,
  DEFAULT_SHARE_ZIP_LIMITS,
  guardZipStream,
  type ShareZipLimits,
  ShareZipTimeoutError,
} from "./zip-limits.ts";

/** The owner's storage, with the zip a public archive needs. */
export type ShareStorage = StorageProvider & Required<Pick<StorageProvider, "zip">>;

/** A public share a visitor may use now: its row, and its owner's storage. */
export interface OpenShare {
  readonly row: PublicShareRecord;
  readonly storage: ShareStorage;
}

export interface SharesDeps {
  readonly shares: ShareRepo;
  /** The owner's storage as every feature gets it: the only way a share reaches bytes. */
  readonly storageFor: (identityId: string) => Promise<ShareStorage>;
  /** Stores a visitor's upload the way every change to files is made. */
  readonly files: Pick<FileOperations, "upload">;
  readonly passwords: SharePasswords;
  /** Ceilings on public archive downloads; each one left out keeps its default. */
  readonly zipLimits?: Partial<ShareZipLimits>;
  readonly clock: () => Date;
}

const SHARED_FOLDERS = `/${SHARED_WITH_ME}`;

/**
 * True when no link may reach canonical `path`: fdrive's own folders and
 * its Trash layout wherever it lies (`isReservedPath`), which a link
 * follows its item into, and `Shared with me`, which holds what other
 * users share with the owner, theirs to share.
 */
export function hiddenFromLinks(path: string): boolean {
  return isReservedPath(path) || isAtOrUnder(SHARED_FOLDERS, path);
}

/**
 * True when `paths` cannot be one archive: two of them would land on the
 * same name in it (compared as a case-insensitive file system would), or
 * one lies inside another, so its files would be in it twice. The archive
 * names each shared path by its base name, as the storage's zip does.
 */
export function archiveConflict(paths: readonly string[]): boolean {
  if (paths.length < 2) return false;
  const names = new Set<string>();
  for (const path of paths) {
    if (paths.some((other) => other !== path && isAtOrUnder(other, path))) return true;
    const name = path
      .slice(path.lastIndexOf("/") + 1)
      .normalize("NFC")
      .toLowerCase();
    if (names.has(name)) return true;
    names.add(name);
  }
  return false;
}

/**
 * Runs one share operation for a visitor or its owner. A missing path and a
 * path of the wrong kind keep their meaning; every other failure is the
 * owner's storage misbehaving, which a visitor is told nothing about beyond
 * "unavailable": never a password error, never a sign-in prompt, never the
 * storage's own message.
 */
export async function shareCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ApiHttpError) throw error;
    if (isStorageError(error)) {
      if (error.kind === "not_found") throw new ApiHttpError("not_found", "Share unavailable");
      if (error.kind === "bad_request")
        throw new ApiHttpError("bad_request", "Share operation rejected by storage");
      if (error.kind === "storage_limit_reached")
        throw new ApiHttpError("storage_limit_reached", "Storage limit reached");
    }
    throw new ApiHttpError("upstream_unavailable", "Share storage unavailable");
  }
}

/** Why the share admits nothing now, or `null` while it still does. */
export function unavailableReason(
  row: Pick<ShareRecord, "expiresAt" | "maxDownloads" | "usedDownloads">,
  now: Date,
): "expired" | "limit" | null {
  if (row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime()) return "expired";
  if (row.maxDownloads > 0 && row.usedDownloads >= row.maxDownloads) return "limit";
  return null;
}

/** The share as its owner sees it. */
export function managedShare(row: ShareRecord): ManagedShare {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    scope: row.scope,
    paths: [...row.paths],
    publicPath: `/s/${row.id}`,
    hasPassword: row.hasPassword,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    maxDownloads: row.maxDownloads,
    usedDownloads: row.usedDownloads,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    presentation: row.presentation,
  };
}

const UNAVAILABLE = () => new ApiHttpError("not_found", "Share unavailable");
const INVALID_PATH = () => new ApiHttpError("bad_request", "Invalid shared path");
const PASSWORD_REJECTED = () =>
  new ApiHttpError("unauthorized", "Share password required or incorrect", {
    reason: "password",
  });
const LIMIT_REACHED = () =>
  new ApiHttpError("forbidden", "Share download limit reached", { reason: "limit" });
/** How many taken names an upload steps past before it gives up. */
const UPLOAD_NAME_ATTEMPTS = 1000;

function canonical(path: string): string {
  try {
    return normalizePath(path);
  } catch {
    throw INVALID_PATH();
  }
}

/**
 * Public links: rows in `app.shares` that fdrive serves through their
 * owner's storage, which a share reaches only through the identity storage
 * factory, only inside its paths, and only for the operations its scope
 * allows. Each public request reads the row once (`load`), proves the
 * visitor may use it (`authorize`), then acts on what that returned. The
 * password, expiry and download limit are fdrive's to enforce: a download,
 * a preview, a peek or an archive counts once, after storage answered.
 */
export function createSharesService(deps: SharesDeps) {
  const zipLimits: ShareZipLimits = { ...DEFAULT_SHARE_ZIP_LIMITS, ...deps.zipLimits };
  const zipSlots = createShareZipSlots(zipLimits.perShare);

  async function storage(identityId: string): Promise<ShareStorage> {
    try {
      return await deps.storageFor(identityId);
    } catch {
      throw new ApiHttpError("upstream_unavailable", "Share storage unavailable");
    }
  }
  /**
   * Every shared path, canonical and outside the folders no link reaches;
   * several must be able to share one archive, the only way they are served.
   */
  function admittedPaths(paths: readonly string[]): string[] {
    const admitted = paths.map((path) => {
      const shared = canonical(path);
      if (hiddenFromLinks(shared))
        throw new ApiHttpError(
          "forbidden",
          "The Trash and folders shared with you can't be shared",
        );
      return shared;
    });
    if (archiveConflict(admitted))
      throw new ApiHttpError(
        "bad_request",
        "Two shared items overlap or have the same name. Share them from one folder instead.",
      );
    return admitted;
  }
  /**
   * A single-path share must name something that exists, and an upload
   * share a directory. Many paths are an archive. A share whose item went
   * where no link reaches (the Trash, say: links follow their item there)
   * is as unavailable as one whose item is gone.
   */
  async function layout(
    identityId: string,
    scope: ShareRecord["scope"],
    paths: readonly string[],
  ): Promise<PublicShare["layout"]> {
    if (paths.some(hiddenFromLinks)) throw UNAVAILABLE();
    const path = paths[0];
    if (path === undefined || paths.length !== 1) return "archive";
    const stat = await shareCall(async () => (await storage(identityId)).stat(path));
    if (scope === "write") {
      if (stat.kind !== "dir")
        throw new ApiHttpError("bad_request", "An upload share must name a directory");
      return "directory";
    }
    return stat.kind === "dir" ? "directory" : "single-file";
  }
  /** Whether `credential` was issued for the password the share has now. */
  function unlocked(row: PublicShareRecord, credential: ShareCredential | undefined): boolean {
    return (
      row.passwordHash === null || credential?.verified === deps.passwords.version(row.passwordHash)
    );
  }
  /**
   * The owner's path for `path`, relative to a single-path share's item (`/`
   * is the item itself): refused outside it and inside a folder no link
   * reaches.
   */
  function resolve(row: PublicShareRecord, path: string): string {
    const root = row.paths.length === 1 ? row.paths[0] : undefined;
    if (root === undefined) throw new ApiHttpError("bad_request", "This share is an archive");
    const base = canonical(root);
    let target: string;
    try {
      target = path === "/" ? base : joinPath(base, path);
    } catch {
      throw INVALID_PATH();
    }
    if (!isAtOrUnder(base, target)) throw INVALID_PATH();
    if (hiddenFromLinks(target)) throw UNAVAILABLE();
    return target;
  }
  /** Spends one of the share's downloads; refused once its limit or expiry stops it. */
  async function consume(row: PublicShareRecord): Promise<void> {
    if ((await deps.shares.consume(row.id, deps.clock())) === null) throw LIMIT_REACHED();
  }
  /**
   * The shared paths an archive walks. A path that became hidden is gone;
   * a restricted folder inside a shared folder would ride along with it, so
   * such a share is refused rather than trusted to skip it; and two paths
   * that would collide in the archive are refused rather than both written.
   */
  function archivePaths(row: PublicShareRecord): string[] {
    const paths = row.paths.map(canonical);
    if (paths.some(hiddenFromLinks)) throw UNAVAILABLE();
    const restricted = [...RESERVED_FOLDERS, SHARED_FOLDERS];
    if (restricted.some((folder) => paths.some((path) => isAtOrUnder(path, folder))))
      throw new ApiHttpError(
        "forbidden",
        "A share that holds the Trash or folders shared with its owner can't be downloaded as an archive",
      );
    if (archiveConflict(paths))
      throw new ApiHttpError(
        "bad_request",
        "Two shared items overlap or have the same name, so they can't be one archive",
      );
    return paths;
  }

  return {
    async list(identityId: string): Promise<{ items: ManagedShare[] }> {
      const rows = await deps.shares.listOwned(identityId, { limit: 1000 });
      return { items: rows.map(managedShare) };
    },
    /** The share `identityId` owns, read once; history's before comes from it. */
    async owned(identityId: string, id: string): Promise<ShareRecord> {
      const row = await deps.shares.getOwned(identityId, id);
      if (row === null) throw UNAVAILABLE();
      return row;
    },
    async create(identityId: string, body: CreateShareRequest): Promise<ManagedShare> {
      const paths = admittedPaths(body.paths);
      await layout(identityId, body.scope, paths);
      const passwordHash =
        body.password === undefined || body.password === ""
          ? null
          : await deps.passwords.hash(body.password);
      const row = await deps.shares.insert({
        identityId,
        name: body.name,
        description: body.description,
        scope: body.scope,
        paths,
        expiresAt: body.expiresAt === null ? null : new Date(body.expiresAt),
        maxDownloads: body.maxDownloads,
        presentation: body.presentation,
        passwordHash,
        at: deps.clock(),
      });
      return managedShare(row);
    },
    /** A patch is merged onto the row and re-validated as a whole request. */
    async update(row: ShareRecord, patch: UpdateShareRequest): Promise<ManagedShare> {
      const base: CreateShareRequest = {
        name: row.name,
        description: row.description,
        paths: [...row.paths],
        scope: row.scope,
        expiresAt: row.expiresAt?.toISOString() ?? null,
        maxDownloads: row.maxDownloads,
        presentation: row.presentation,
      };
      const merged = CreateShareRequest.parse({ ...base, ...patch });
      const paths = admittedPaths(merged.paths);
      // An empty password removes it; an absent one keeps what is stored.
      const passwordHash =
        merged.password === undefined
          ? undefined
          : merged.password === ""
            ? null
            : await deps.passwords.hash(merged.password);
      const updated = await deps.shares.updateOwned(row.identityId, row.id, {
        name: merged.name,
        description: merged.description,
        scope: merged.scope,
        paths,
        expiresAt: merged.expiresAt === null ? null : new Date(merged.expiresAt),
        maxDownloads: merged.maxDownloads,
        presentation: merged.presentation,
        ...(passwordHash === undefined ? {} : { passwordHash }),
        at: deps.clock(),
      });
      if (updated === null) throw UNAVAILABLE();
      return managedShare(updated);
    },
    async remove(row: ShareRecord): Promise<void> {
      await deps.shares.removeOwned(row.identityId, row.id);
    },

    /** Cheap local admission check for the public route limiter. */
    async exists(id: string): Promise<boolean> {
      return (await deps.shares.get(id)) !== null;
    },
    /** The share's row: the one read a public request makes, with what verifying needs. */
    async load(id: string): Promise<PublicShareRecord> {
      const row = await deps.shares.get(id);
      if (row === null) throw UNAVAILABLE();
      return row;
    },
    /**
     * Possessing a share's UUID reveals nothing about it: for a
     * password-protected share the name, description, file name, layout,
     * expiry and download counts are withheld until the credential verifies.
     * The password is checked when the cookie is issued, so a write share
     * reveals itself to a verified visitor too. Nothing can be served from
     * an unavailable share, so nothing is checked or revealed either.
     */
    async metadata(
      row: PublicShareRecord,
      credential: ShareCredential | undefined,
    ): Promise<PublicShare> {
      const unavailable = unavailableReason(row, deps.clock());
      const hasPassword = row.passwordHash !== null;
      const revealed = !hasPassword || (unavailable === null && unlocked(row, credential));
      const kind = revealed ? await layout(row.identityId, row.scope, row.paths) : "directory";
      return {
        name: revealed ? row.name : "",
        description: revealed ? row.description : "",
        scope: row.scope,
        layout: kind,
        presentation: row.presentation,
        fileName:
          revealed && kind === "single-file" ? (row.paths[0]?.split("/").at(-1) ?? null) : null,
        hasPassword,
        credentialPresent:
          credential !== undefined && (unavailable !== null || unlocked(row, credential)),
        expiresAt: revealed ? (row.expiresAt?.toISOString() ?? null) : null,
        maxDownloads: revealed ? row.maxDownloads : 0,
        usedDownloads: revealed ? row.usedDownloads : 0,
        unavailableReason: unavailable,
      };
    },
    /**
     * The one place the password is checked: wrong is refused now, right
     * earns a marker for the current password that every later request
     * compares against the row it already read, never a hash.
     */
    async credential(row: PublicShareRecord, password: string): Promise<ShareCredential> {
      if (row.passwordHash !== null && !(await deps.passwords.verify(password, row.passwordHash)))
        throw PASSWORD_REJECTED();
      return { verified: deps.passwords.version(row.passwordHash) };
    },
    /**
     * Whether the thumb route may serve a thumbnail of this share: a
     * readable single-path share, available, whose password the credential
     * opens. Thumbnails never count.
     */
    showsThumbnails(row: PublicShareRecord, credential: ShareCredential | undefined): boolean {
      return (
        row.scope === "read" &&
        row.paths.length === 1 &&
        unavailableReason(row, deps.clock()) === null &&
        unlocked(row, credential)
      );
    },
    /**
     * The share as the visitor may use it for `scope`, once its expiry, its
     * download limit and the visitor's credential allow it. A request a
     * preview already counted (`counted`) passes the limit that preview may
     * have reached.
     */
    async authorize(
      row: PublicShareRecord,
      credential: ShareCredential | undefined,
      scope: "read" | "write",
      counted = false,
    ): Promise<OpenShare> {
      if (row.scope !== scope)
        throw new ApiHttpError("forbidden", "This share does not allow this operation");
      const reason = unavailableReason(row, deps.clock());
      if (reason === "expired")
        throw new ApiHttpError("forbidden", "Share expired", { reason: "expired" });
      if (reason === "limit" && !counted) throw LIMIT_REACHED();
      if (!unlocked(row, credential)) throw PASSWORD_REJECTED();
      return { row, storage: await storage(row.identityId) };
    },
    async entries(share: OpenShare, path: string) {
      const entries = await shareCall(() => share.storage.list(resolve(share.row, path)));
      return entries.filter((entry) => !hiddenFromLinks(entry.path));
    },
    /** The file at `path`, for a HEAD answered without opening it or counting. */
    stat(share: OpenShare, path: string) {
      return shareCall(() => share.storage.statFile(resolve(share.row, path)));
    },
    /**
     * The file at `path`, its Range and If-Range handled as the fs download
     * route handles them, counted once storage answered unless a preview
     * already counted it.
     */
    async download(
      share: OpenShare,
      path: string,
      request: {
        readonly range: string | null;
        readonly ifRange: string | undefined;
        readonly signal: AbortSignal;
        readonly counted: boolean;
      },
    ): Promise<DownloadOutcome> {
      const target = resolve(share.row, path);
      const outcome = await shareCall(() =>
        resolveDownload(share.storage, target, request.range, request.ifRange, request.signal),
      );
      if (outcome.kind === "stream" && !request.counted) {
        try {
          await consume(share.row);
        } catch (error) {
          await outcome.result.body.cancel();
          throw error;
        }
      }
      return outcome;
    },
    /**
     * Opens a preview of the audio or video at `path`, the only files a
     * viewer streams in Range reads: one download, counted now, however many
     * reads follow. Anything else the page previews is one plain download.
     */
    async preview(share: OpenShare, path: string): Promise<void> {
      const target = resolve(share.row, path);
      if (!isStreamedPreviewName(baseName(target)))
        throw new ApiHttpError("bad_request", "Only audio and video open as a preview");
      await shareCall(() => share.storage.statFile(target));
      await consume(share.row);
    },
    /** Lists the archive at `path` without extracting it: one download, however many reads. */
    async peek(
      share: OpenShare,
      path: string,
      options: { readonly maxBytes: number; readonly signal: AbortSignal },
    ): Promise<PeekArchiveResult> {
      const target = resolve(share.row, path);
      const result = await shareCall(async () => {
        try {
          return await peekArchive({ storage: share.storage, path: target, ...options });
        } catch (error) {
          if (
            error instanceof UnsupportedPeekFormatError ||
            error instanceof UnreadableArchiveError
          )
            throw new ApiHttpError("bad_request", error.message);
          throw error;
        }
      });
      await consume(share.row);
      return result;
    },
    /**
     * Every shared path as one zip stream, counted as one download. The
     * stream ends early, in error, once the visitor leaves or a ceiling on
     * its time or size is passed.
     */
    async zip(share: OpenShare, signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
      const paths = archivePaths(share.row);
      const release = zipSlots.acquire(share.row.id);
      if (release === null)
        throw new ApiHttpError(
          "rate_limited",
          "This share is already being downloaded as an archive. Try again shortly.",
        );
      const timeout = new AbortController();
      const timer = setTimeout(
        () => timeout.abort(new ShareZipTimeoutError()),
        zipLimits.timeoutMs,
      );
      timer.unref();
      const done = () => {
        clearTimeout(timer);
        release();
      };
      const both = AbortSignal.any([signal, timeout.signal]);
      let source: ReadableStream<Uint8Array> | undefined;
      try {
        source = await shareCall(() => share.storage.zip(paths, { signal: both }));
        await consume(share.row);
        return guardZipStream(source, { maxBytes: zipLimits.maxBytes, signal: both, done });
      } catch (error) {
        done();
        await source?.cancel();
        throw error;
      }
    },
    /**
     * Stores `body` as `name` in the shared folder, never over a file: a
     * taken name is refused by storage before it reads the body, and the
     * next numbered name is tried (`photo (2).jpg`). Returns the name it
     * landed on. Counted once stored; a refusal then cannot take the file
     * back and only turns the next upload away.
     */
    async upload(
      share: OpenShare,
      name: string,
      body: ReadableStream<Uint8Array> | Uint8Array,
      signal: AbortSignal,
    ): Promise<string> {
      // A visitor's upload is the owner's file, but never the owner's history.
      const visitor = { identityId: share.row.identityId, storage: share.storage, recorded: null };
      const taken = new Set<string>();
      const stored = await shareCall(async () => {
        for (;;) {
          const candidate = uniqueNumberedName(name, taken);
          try {
            await deps.files.upload(visitor, resolve(share.row, `/${candidate}`), body, {
              signal,
              action: "file.upload",
            });
            return candidate;
          } catch (error) {
            if (!isStorageError(error) || error.kind !== "conflict") throw error;
            // Storage holds the body's reader once it has started reading it, and
            // then there is nothing left to store under another name.
            if (
              (body instanceof ReadableStream && body.locked) ||
              taken.size >= UPLOAD_NAME_ATTEMPTS
            )
              throw new ApiHttpError(
                "conflict",
                "That name was just taken. Upload the file again.",
              );
            taken.add(candidate);
          }
        }
      });
      await deps.shares.consume(share.row.id, deps.clock());
      return stored;
    },
  };
}
export type SharesService = ReturnType<typeof createSharesService>;
