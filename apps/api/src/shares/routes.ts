import {
  ArchiveEntriesResponse,
  CreateShareRequest,
  type ManagedShare,
  PUBLIC_SHARE_SUFFIXES,
  ROUTES,
  ShareCredentialsRequest,
  ShareId,
  SharePath,
  type SharePreviewResponse,
  ShareUploadPath,
  type ShareUploadResponse,
  THUMB_SIZES,
  type ThumbSize,
  UpdateShareRequest,
} from "@fdrive/contracts";
import {
  type Download,
  extensionOf,
  mimeFromExtension,
  normalizePath,
  toFsPath,
} from "@fdrive/core";
import type { IdentityRepo, IndexQueries, ShareRecord } from "@fdrive/db";
import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { z } from "zod";
import { recordFsAction } from "../activity/fs-context.js";
import type { PersonalActivityService } from "../activity/service.js";
import type { AppHono, AuthedHono } from "../app.ts";
import { accountContext } from "../auth/account-context.ts";
import { withoutApiV1Prefix } from "../auth/routes.ts";
import { cookieSecureFor } from "../auth/sessions.ts";
import type { AppConfig } from "../config.ts";
import { DEFAULT_ARCHIVE_PEEK_MAX_BYTES } from "../config.ts";
import { ApiHttpError } from "../errors.ts";
import { extractClientIp } from "../net.ts";
import type { ScopeResolver } from "../scoping/resolver.ts";
import {
  createNodeThumbFileReader,
  serveThumb,
  THUMB_NOT_FOUND,
  type ThumbFileReader,
} from "../thumbs/serve.ts";
import {
  newShareVisitor,
  SHARE_CREDENTIAL_COOKIE,
  SHARE_CREDENTIAL_SECONDS,
  SHARE_VISITOR_COOKIE,
  type ShareCredentialCodec,
  shareVisitor,
} from "./credentials.ts";
import type { ShareLimiter } from "./limiter.ts";
import { hiddenFromLinks, managedShare, type SharesService, shareCall } from "./service.ts";

export async function publicBody<T>(
  schema: z.ZodType<T>,
  c: Context,
  maxBytes = 16384,
): Promise<T> {
  const reader = c.req.raw.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader !== undefined) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel();
          throw new ApiHttpError("payload_too_large", "Share request is too large");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
  } catch {
    throw new ApiHttpError("bad_request", "Invalid JSON");
  }
  const result = schema.safeParse(body);
  if (!result.success) throw new ApiHttpError("bad_request", "Invalid share request");
  return result.data;
}
/**
 * True when `contentLengthHeader` parses as a number greater than
 * `maxBytes`. A missing or non-numeric header returns false: the ceiling is
 * still enforced as bytes actually arrive (see `capByteStream`), so a
 * caller cannot bypass it by omitting or lying about `Content-Length`, only
 * skip this cheap early rejection.
 */
export function contentLengthExceeds(
  contentLengthHeader: string | undefined,
  maxBytes: number,
): boolean {
  if (contentLengthHeader === undefined) {
    return false;
  }
  const value = Number(contentLengthHeader);
  return Number.isFinite(value) && value > maxBytes;
}

/** A byte-counted wrapper around a `ReadableStream`, see `capByteStream`. */
export interface CappedByteStream {
  readonly stream: ReadableStream<Uint8Array>;
  /** True once the wrapped stream has read more than `maxBytes` total. */
  exceeded(): boolean;
}

/**
 * Wraps `source` so reading stops (the wrapped stream closes) once more
 * than `maxBytes` total have been read, and `exceeded()` starts reporting
 * true. Enforced while streaming rather than by buffering the whole body
 * first, since a share upload can legitimately be gigabytes: this bounds
 * how much an attacker who omits or lies about `Content-Length` can push
 * through before the upload is cut off, without ever holding the full body
 * in memory. Errors the wrapped stream (rather than just closing it) once
 * the cap is hit, so a downstream consumer sees a failed upload instead of
 * quietly accepting a truncated one as if it were complete.
 */
export function capByteStream(
  source: ReadableStream<Uint8Array>,
  maxBytes: number,
): CappedByteStream {
  const reader = source.getReader();
  let size = 0;
  let exceeded = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      size += value.byteLength;
      if (size > maxBytes) {
        exceeded = true;
        await reader.cancel();
        controller.error(new Error("upload exceeds the configured byte ceiling"));
        return;
      }
      controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return { stream, exceeded: () => exceeded };
}

export function publicPath(c: Context, upload = false): string {
  const query = new URL(c.req.url).searchParams;
  if (query.getAll("path").length > 1) throw new ApiHttpError("bad_request", "Invalid shared path");
  const result = (upload ? ShareUploadPath : SharePath).safeParse(query.get("path") ?? "/");
  if (!result.success) throw new ApiHttpError("bad_request", "Invalid shared path");
  return result.data;
}
/**
 * Parses `?path=&size=` for the public thumb route. Unlike `publicPath`,
 * every failure (a repeated `path`, a path that fails `SharePath`, a `size`
 * outside `THUMB_SIZES`) returns `null` rather than throwing a `400`: the
 * route must answer every failure the same bare 404, never a distinguishing
 * `bad_request`.
 */
export function publicThumbQuery(c: Context): { path: string; size: ThumbSize } | null {
  const query = new URL(c.req.url).searchParams;
  if (query.getAll("path").length > 1) return null;
  const path = SharePath.safeParse(query.get("path") ?? "/");
  if (!path.success) return null;
  const size = THUMB_SIZES.find((candidate) => String(candidate) === query.get("size"));
  if (size === undefined) return null;
  return { path: path.data, size };
}
export function shareId(c: Context): string {
  const id = ShareId.safeParse(
    c.req.param("id") ?? c.req.path.slice(`${ROUTES.publicShares}/`.length).split("/")[0],
  );
  if (!id.success) throw new ApiHttpError("bad_request", "Invalid share ID");
  return id.data;
}
export function attachment(name: string): string {
  return `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(name.replace(/\p{Cc}/gu, "")).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}
/** A shared file's headers, its type from its name. */
export function downloadHeaders(result: Omit<Download, "body">, name: string): Headers {
  const headers = new Headers({
    "Content-Type": mimeFromExtension(extensionOf(name)) ?? "application/octet-stream",
    "Content-Disposition": attachment(name),
    "Content-Length": String(result.contentLength),
    "Last-Modified": result.lastModified.toUTCString(),
    "Accept-Ranges": "bytes",
  });
  if (result.contentRange !== null) headers.set("Content-Range", result.contentRange);
  return headers;
}
export function downloadResponse(result: Download, name: string): Response {
  return new Response(result.body, {
    status: result.status,
    headers: downloadHeaders(result, name),
  });
}
/** The 416 for a range the file cannot satisfy, naming its size when known, as the fs route does. */
export function rangeNotSatisfiable(size: number | null): Response {
  return new Response(null, {
    status: 416,
    headers: size === null ? {} : { "Content-Range": `bytes */${size}` },
  });
}
/** What history records of a share: never its password or its secret URL. */
function shareFacts(
  share: Pick<ShareRecord | ManagedShare, "paths" | "scope"> & {
    readonly expiresAt: Date | string | null;
  },
) {
  const expiresAt =
    share.expiresAt instanceof Date ? share.expiresAt.toISOString() : share.expiresAt;
  return {
    ...(share.paths[0] ? { path: share.paths[0] } : {}),
    permissions: [share.scope],
    expiresAt,
  };
}
export function registerSharesRoutes(
  groups: { public: AppHono; authed: AuthedHono },
  deps: {
    service: SharesService;
    /** Records share mutations. Passwords and secret URLs are never facts. */
    activity?: PersonalActivityService;
    thumbnailsEnabled?: () => Promise<boolean>;
    codec: ShareCredentialCodec;
    limiter: ShareLimiter;
    config: AppConfig;
    indexQueries: Pick<IndexQueries, "fileByPath" | "thumbnail">;
    resolver: Pick<ScopeResolver, "scopesFor">;
    identities: Pick<IdentityRepo, "get">;
    /** The directory the indexer writes thumbnails into. `undefined` disables `/thumb` entirely. */
    thumbsDir: string | undefined;
    fileReader?: ThumbFileReader;
  },
): void {
  const base = withoutApiV1Prefix(ROUTES.shares);
  const pub = `${withoutApiV1Prefix(ROUTES.publicShares)}/:id`;
  const thumbFileReader = deps.fileReader ?? createNodeThumbFileReader();
  const owner = (c: Parameters<typeof accountContext>[0]) => accountContext(c).principal.identityId;
  groups.authed.get(base, (c) => shareCall(async () => c.json(await deps.service.list(owner(c)))));
  groups.authed.post(base, (c) =>
    shareCall(async () => {
      const identityId = owner(c);
      const body = await publicBody(CreateShareRequest, c, 32 * 1024 * 1024);
      return c.json(
        await recordFsAction(
          deps.activity,
          c,
          {
            action: "share.create",
            requested: {
              ...(body.paths[0] ? { path: body.paths[0] } : {}),
              permissions: [body.scope],
              expiresAt: body.expiresAt ?? null,
            },
            subjects: body.paths.map((path) => ({ path, identityId })),
          },
          () => deps.service.create(identityId, body),
          (share) => ({ shareId: share.id, ...shareFacts(share) }),
        ),
        201,
      );
    }),
  );
  groups.authed.get(`${base}/:id`, (c) =>
    shareCall(async () => c.json(managedShare(await deps.service.owned(owner(c), shareId(c))))),
  );
  // The share is read once; history's before is that row, its after what the change returned.
  groups.authed.patch(`${base}/:id`, (c) =>
    shareCall(async () => {
      const identityId = owner(c);
      const row = await deps.service.owned(identityId, shareId(c));
      const patch = await publicBody(UpdateShareRequest, c, 32 * 1024 * 1024);
      const updated = await recordFsAction(
        deps.activity,
        c,
        {
          action: "share.update",
          requested: { ...(row.paths[0] ? { path: row.paths[0] } : {}), shareId: row.id },
          before: shareFacts(row),
          subjects: [...new Set([...row.paths, ...(patch.paths ?? [])])].map((path) => ({
            path,
            identityId,
          })),
        },
        () => deps.service.update(row, patch),
        (share) => ({ shareId: share.id, ...shareFacts(share) }),
      );
      return c.json(updated);
    }),
  );
  groups.authed.delete(`${base}/:id`, (c) =>
    shareCall(async () => {
      const identityId = owner(c);
      const row = await deps.service.owned(identityId, shareId(c));
      const { path: _path, ...before } = shareFacts(row);
      await recordFsAction(
        deps.activity,
        c,
        {
          action: "share.revoke",
          requested: { shareId: row.id, ...(row.paths[0] ? { path: row.paths[0] } : {}) },
          before,
          subjects: row.paths.map((path) => ({ path, identityId })),
        },
        () => deps.service.remove(row),
      );
      return c.json({ ok: true });
    }),
  );
  groups.public.use(`${withoutApiV1Prefix(ROUTES.publicShares)}/*`, async (c, next) => {
    const id = shareId(c);
    if (
      !(await deps.limiter.allow(
        extractClientIp(c, deps.config.fdriveTrustedProxyHops),
        id,
        c.req.method === "POST" && c.req.path.endsWith("/credentials"),
        () => shareCall(() => deps.service.exists(id)),
      ))
    )
      throw new ApiHttpError("rate_limited", "Too many share requests");
    await next();
    // Everything public a share serves is `no-store` by default, except a
    // handler that deliberately set its own `Cache-Control`: only the thumb
    // route does, and it must, because a `no-store` thumbnail is re-fetched
    // for every tile on every render and makes preloading the neighbouring
    // lightbox images impossible (the preload could never be reused, so it
    // would only add requests). Thumbnails are safe to cache briefly: they
    // are derived, content-addressed by sha256, and never counted against
    // the link's download budget. Full downloads stay `no-store`.
    if (c.res.headers.get("Cache-Control") === null) c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Content-Type-Options", "nosniff");
  });
  function credential(c: Context) {
    return deps.codec.decode(shareId(c), getCookie(c, SHARE_CREDENTIAL_COOKIE));
  }
  function shareCookie(c: Context, name: string, value: string, maxAge: number) {
    setCookie(c, name, value, {
      path: `${ROUTES.publicShares}/${shareId(c)}`,
      httpOnly: true,
      sameSite: "Lax",
      secure: cookieSecureFor(deps.config, c),
      maxAge,
    });
  }
  function credentialCookie(c: Context, value: string, maxAge: number) {
    shareCookie(c, SHARE_CREDENTIAL_COOKIE, value, maxAge);
  }
  /** This browser's visitor name for the share, if it has one. */
  function visitor(c: Context): string | undefined {
    return shareVisitor(getCookie(c, SHARE_VISITOR_COOKIE));
  }
  /** This browser's visitor name for the share, given one on its first preview. */
  function visitorGiven(c: Context): string {
    const known = visitor(c);
    if (known !== undefined) return known;
    const given = newShareVisitor();
    shareCookie(c, SHARE_VISITOR_COOKIE, given, SHARE_CREDENTIAL_SECONDS);
    return given;
  }
  /** The share for this request, read once, as the visitor may use it for `scope`. */
  async function authorized(c: Context, scope: "read" | "write", counted = false) {
    const row = await deps.service.load(shareId(c));
    return deps.service.authorize(row, credential(c), scope, counted);
  }
  groups.public.get(pub, (c) =>
    shareCall(async () =>
      c.json(await deps.service.metadata(await deps.service.load(shareId(c)), credential(c))),
    ),
  );
  groups.public.post(`${pub}${PUBLIC_SHARE_SUFFIXES.credentials}`, (c) =>
    shareCall(async () => {
      const id = shareId(c);
      const body = await publicBody(ShareCredentialsRequest, c);
      const issued = await deps.service.credential(await deps.service.load(id), body.password);
      credentialCookie(c, deps.codec.encode(id, issued), SHARE_CREDENTIAL_SECONDS);
      return c.json({ ok: true });
    }),
  );
  groups.public.delete(`${pub}${PUBLIC_SHARE_SUFFIXES.credentials}`, (c) => {
    credentialCookie(c, "", 0);
    return c.json({ ok: true });
  });
  groups.public.get(`${pub}${PUBLIC_SHARE_SUFFIXES.entries}`, (c) =>
    shareCall(async () => {
      const path = publicPath(c);
      const entries = await deps.service.entries(await authorized(c, "read"), path);
      return c.json({
        items: entries.map((entry) => ({
          name: entry.name,
          kind: entry.kind,
          size: entry.size,
          modifiedAt: entry.modifiedAt.toISOString(),
        })),
      });
    }),
  );
  // A peek is one open, counted once however many reads it takes.
  groups.public.get(`${pub}${PUBLIC_SHARE_SUFFIXES.archiveEntries}`, (c) =>
    shareCall(async () => {
      const path = publicPath(c);
      const result = await deps.service.peek(await authorized(c, "read"), path, {
        maxBytes: deps.config.fdriveArchivePeekMaxBytes ?? DEFAULT_ARCHIVE_PEEK_MAX_BYTES,
        signal: c.req.raw.signal,
      });
      const responseBody: ArchiveEntriesResponse = ArchiveEntriesResponse.parse({
        format: result.format,
        entries: result.entries.map((entry) => ({
          path: entry.path,
          kind: entry.kind,
          size: entry.size,
          modifiedAt: entry.modifiedAt?.toISOString() ?? null,
        })),
        truncated: result.truncated,
      });
      return c.json(responseBody);
    }),
  );
  // The share itself is the authorization for anything under it, and a
  // thumbnail comes from the index cache, never from the owner's storage.
  // Every failure below answers the same bare 404: whether the
  // share does not exist, is a write share, an archive, expired, or
  // limit-reached, whether the password is wrong or missing, whether the
  // path fails to resolve, or whether the file is not indexed, this route
  // must never become an oracle for which of those it was.
  groups.public.get(`${pub}${PUBLIC_SHARE_SUFFIXES.thumb}`, async (c) => {
    if (
      deps.thumbsDir === undefined ||
      (deps.thumbnailsEnabled !== undefined && !(await deps.thumbnailsEnabled()))
    )
      throw THUMB_NOT_FOUND();

    const query = publicThumbQuery(c);
    if (query === null) throw THUMB_NOT_FOUND();

    const row = await deps.service.load(shareId(c)).catch(() => null);
    const sharedRoot = row?.paths[0];
    if (
      row === null ||
      sharedRoot === undefined ||
      !deps.service.showsThumbnails(row, credential(c))
    )
      throw THUMB_NOT_FOUND();

    const virtualPath = query.path === "/" ? sharedRoot : `${sharedRoot}${query.path}`;
    // The index covers the Trash and folders shared in too, so their thumbnails are refused here.
    let hidden: boolean;
    try {
      hidden = hiddenFromLinks(normalizePath(virtualPath));
    } catch {
      hidden = true;
    }
    if (hidden) throw THUMB_NOT_FOUND();
    const identity = await deps.identities.get(row.identityId);
    if (identity === null) throw THUMB_NOT_FOUND();
    const scopes = await deps.resolver.scopesFor(identity.username);
    // `toFsPath` normalizes, and `normalizePath` throws for a segment over
    // 255 UTF-8 bytes, which `SharePath` (a 4096-character total bound with
    // no per-segment limit) happily allows through. Catch it here so an
    // over-long segment is the same bare 404 as everything else rather than
    // an unhandled 500 that tells the caller its path was the odd one out.
    let fsPath: string | null;
    try {
      fsPath = toFsPath(scopes, virtualPath);
    } catch {
      throw THUMB_NOT_FOUND();
    }
    if (fsPath === null) throw THUMB_NOT_FOUND();

    const response = await serveThumb(
      c,
      { indexQueries: deps.indexQueries, thumbsDir: deps.thumbsDir, fileReader: thumbFileReader },
      { fsPath, size: query.size },
    );
    // Overrides the tail's `private, no-store` (right for the authed route,
    // where a permission change must never be served stale) with a short
    // private window: a gallery re-renders its tiles constantly and the
    // lightbox preloads its neighbours, and both are pointless against a
    // store that refuses to keep anything. Bounded at a minute so revoking
    // a link still takes effect promptly, and `private` keeps it out of any
    // shared proxy cache.
    response.headers.set("Cache-Control", "private, max-age=60");
    return response;
  });
  // Opens a preview of audio or video, counted here, up front, and refused
  // once the link has nothing left. For a few minutes the returned token lets
  // the download URL serve that one file's Range reads to this browser (its
  // visitor cookie) without counting again; no one else, no other file.
  groups.public.post(`${pub}${PUBLIC_SHARE_SUFFIXES.preview}`, (c) =>
    shareCall(async () => {
      const path = publicPath(c);
      await deps.service.preview(await authorized(c, "read"), path);
      const response: SharePreviewResponse = {
        token: deps.codec.previewToken(shareId(c), path, visitorGiven(c)),
      };
      return c.json(response);
    }),
  );
  // HEAD is registered on its own rather than left to Hono's HEAD-as-GET
  // fallback, which would drop the body without cancelling the stream and
  // leave the file open until it drained. It answers from a stat: no stream
  // is opened and nothing is spent from the share's budget.
  const download = (c: Context) =>
    shareCall(async () => {
      const path = publicPath(c);
      const preview = new URL(c.req.url).searchParams.get("preview");
      const previewed = preview !== null;
      const by = visitor(c);
      if (
        preview !== null &&
        (by === undefined || !deps.codec.previewed(shareId(c), path, by, preview))
      )
        throw new ApiHttpError("forbidden", "This preview has ended. Open it again.");
      const share = await authorized(c, "read", previewed);
      const name =
        path === "/"
          ? share.row.paths[0]?.split("/").at(-1) || "download"
          : path.slice(path.lastIndexOf("/") + 1);
      if (c.req.method === "HEAD") {
        const stat = await deps.service.stat(share, path);
        return new Response(null, {
          status: 200,
          headers: downloadHeaders(
            {
              status: 200,
              contentLength: stat.size,
              contentRange: null,
              lastModified: stat.modifiedAt,
            },
            name,
          ),
        });
      }
      const outcome = await deps.service.download(share, path, {
        range: c.req.header("range") ?? null,
        ifRange: c.req.header("if-range"),
        signal: c.req.raw.signal,
        counted: previewed,
      });
      if (outcome.kind === "range-not-satisfiable") return rangeNotSatisfiable(outcome.size);
      return downloadResponse(outcome.result, name);
    });
  groups.public.get(`${pub}${PUBLIC_SHARE_SUFFIXES.download}`, download);
  groups.public.on("HEAD", `${pub}${PUBLIC_SHARE_SUFFIXES.download}`, download);
  // HEAD on its own again: the HEAD-as-GET fallback would start an archive,
  // spend a download and hold one of the share's archive slots until the
  // unread stream timed out. It checks access and opens nothing.
  const archive = (c: Context) =>
    shareCall(async () => {
      const share = await authorized(c, "read");
      const headers = {
        "Content-Type": "application/zip",
        "Content-Disposition": attachment(`${share.row.name}.zip`),
      };
      if (c.req.method === "HEAD") return new Response(null, { headers });
      return new Response(await deps.service.zip(share, c.req.raw.signal), { headers });
    });
  groups.public.get(`${pub}${PUBLIC_SHARE_SUFFIXES.archive}`, archive);
  groups.public.on("HEAD", `${pub}${PUBLIC_SHARE_SUFFIXES.archive}`, archive);
  groups.public.put(`${pub}${PUBLIC_SHARE_SUFFIXES.upload}`, (c) =>
    shareCall(async () => {
      const path = publicPath(c, true);
      const maxBytes = deps.config.fdriveShareUploadMaxBytes;
      if (contentLengthExceeds(c.req.header("content-length"), maxBytes))
        throw new ApiHttpError("payload_too_large", "Share upload is too large");
      const share = await authorized(c, "write");
      const cap = c.req.raw.body === null ? null : capByteStream(c.req.raw.body, maxBytes);
      let name: string;
      try {
        name = await deps.service.upload(
          share,
          path.slice(1),
          cap?.stream ?? new Uint8Array(),
          c.req.raw.signal,
        );
      } catch (error) {
        if (cap?.exceeded() === true) {
          throw new ApiHttpError("payload_too_large", "Share upload is too large");
        }
        throw error;
      }
      const response: ShareUploadResponse = { name };
      return c.json(response);
    }),
  );
}
