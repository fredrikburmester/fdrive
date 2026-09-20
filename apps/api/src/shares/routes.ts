import {
  ArchiveEntriesResponse,
  CreateShareRequest,
  PUBLIC_SHARE_SUFFIXES,
  ROUTES,
  ShareCredentialsRequest,
  ShareId,
  SharePath,
  ShareUploadPath,
  THUMB_SIZES,
  type ThumbSize,
  UpdateShareRequest,
} from "@fdrive/contracts";
import { toFsPath } from "@fdrive/core";
import type { IdentityRepo, IndexQueries } from "@fdrive/db";
import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { z } from "zod";
import { accountContext } from "../accounts/routes.ts";
import { recordFsAction } from "../activity/fs-context.js";
import type { PersonalActivityService } from "../activity/service.js";
import type { AppHono, AuthedHono } from "../app.ts";
import {
  peekArchive,
  UnreadableArchiveError,
  UnsupportedPeekFormatError,
} from "../archive/peek.ts";
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
  parseShareRange,
  RangeNotSatisfiableError,
  type ShareByteRange,
  type ShareDownloadOptions,
  type ShareDownloadResult,
} from "./access.ts";
import {
  SHARE_CREDENTIAL_COOKIE,
  SHARE_CREDENTIAL_SECONDS,
  type ShareCredential,
  type ShareCredentialCodec,
} from "./credentials.ts";
import type { ShareLimiter } from "./limiter.ts";
import { createSharePasswordCache } from "./password-cache.ts";
import { createSharePeekPort } from "./peek-adapter.ts";
import { type SharesService, shareCall } from "./service.ts";

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
/**
 * The download options a public request asks for. A well-formed multi-range
 * header is ignored as a whole, `If-Range` included, and the complete file
 * is sent; a malformed range is `bad_request`.
 */
export function publicDownloadOptions(c: Context): ShareDownloadOptions {
  const options: { range?: ShareByteRange; ifRange?: string; signal: AbortSignal } = {
    signal: c.req.raw.signal,
  };
  const header = c.req.header("range");
  if (header !== undefined) {
    const range = parseShareRange(header);
    if (range === null) return options;
    options.range = range;
  }
  const ifRange = c.req.header("if-range");
  if (ifRange !== undefined) options.ifRange = ifRange;
  return options;
}
export function attachment(name: string): string {
  return `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(name.replace(/\p{Cc}/gu, "")).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}
export function downloadHeaders(result: Omit<ShareDownloadResult, "body">, name: string): Headers {
  const headers = new Headers({
    "Content-Type": result.contentType ?? "application/octet-stream",
    "Content-Disposition": attachment(name),
    "Accept-Ranges": "bytes",
  });
  if (result.contentLength !== null) headers.set("Content-Length", String(result.contentLength));
  if (result.contentRange !== null) headers.set("Content-Range", result.contentRange);
  if (result.lastModified !== null) headers.set("Last-Modified", result.lastModified.toUTCString());
  return headers;
}
export function downloadResponse(result: ShareDownloadResult, name: string): Response {
  return new Response(result.body, {
    status: result.status,
    headers: downloadHeaders(result, name),
  });
}
/** The 416 for a range the file cannot satisfy, naming the size when the backend knew it. */
export function rangeNotSatisfiable(size: number | null): Response {
  return new Response(null, {
    status: 416,
    headers: size === null ? {} : { "Content-Range": `bytes */${size}` },
  });
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
    indexQueries: Pick<IndexQueries, "rootIdsByName" | "fileByPath" | "thumbnail">;
    resolver: Pick<ScopeResolver, "verifiedIndexScopes">;
    identities: Pick<IdentityRepo, "get">;
    /** The directory the indexer writes thumbnails into. `undefined` disables `/thumb` entirely. */
    thumbsDir: string | undefined;
    fileReader?: ThumbFileReader;
  },
): void {
  const base = withoutApiV1Prefix(ROUTES.shares);
  const pub = `${withoutApiV1Prefix(ROUTES.publicShares)}/:id`;
  const thumbFileReader = deps.fileReader ?? createNodeThumbFileReader();
  const passwordCache = createSharePasswordCache();
  groups.authed.get(base, (c) =>
    shareCall(async () => c.json(await deps.service.list(accountContext(c)))),
  );
  groups.authed.post(base, (c) =>
    shareCall(async () => {
      const input = accountContext(c);
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
            subjects: body.paths.map((path) => ({ path, identityId: input.principal.identityId })),
          },
          () => deps.service.create(input, body),
          (share) => ({
            shareId: share.id,
            ...(share.paths[0] ? { path: share.paths[0] } : {}),
            permissions: [share.scope],
            expiresAt: share.expiresAt,
          }),
        ),
        201,
      );
    }),
  );
  groups.authed.get(`${base}/:id`, (c) =>
    shareCall(async () => c.json(await deps.service.get(accountContext(c), shareId(c)))),
  );
  groups.authed.patch(`${base}/:id`, (c) =>
    shareCall(async () => {
      const input = accountContext(c);
      const previous = await deps.service.activitySnapshot(input, shareId(c));
      const patch = await publicBody(UpdateShareRequest, c, 32 * 1024 * 1024);
      const updated = await recordFsAction(
        deps.activity,
        c,
        {
          action: "share.update",
          requested: {
            ...(previous.paths[0] ? { path: previous.paths[0] } : {}),
            shareId: previous.id,
          },
          before: {
            ...(previous.paths[0] ? { path: previous.paths[0] } : {}),
            permissions: [previous.scope],
            expiresAt: previous.expiresAt,
          },
          subjects: [...new Set([...previous.paths, ...(patch.paths ?? [])])].map((path) => ({
            path,
            identityId: input.principal.identityId,
          })),
        },
        () => deps.service.update(input, shareId(c), patch),
        (share) => ({
          shareId: share.id,
          ...(share.paths[0] ? { path: share.paths[0] } : {}),
          permissions: [share.scope],
          expiresAt: share.expiresAt,
        }),
      );
      // The password may have changed: no memoized verification survives an update.
      passwordCache.invalidate(shareId(c));
      return c.json(updated);
    }),
  );
  groups.authed.delete(`${base}/:id`, (c) =>
    shareCall(async () => {
      const input = accountContext(c);
      const previous = await deps.service.activitySnapshot(input, shareId(c));
      await recordFsAction(
        deps.activity,
        c,
        {
          action: "share.revoke",
          requested: {
            shareId: previous.id,
            ...(previous.paths[0] ? { path: previous.paths[0] } : {}),
          },
          before: { permissions: [previous.scope], expiresAt: previous.expiresAt },
          subjects: previous.paths.map((path) => ({
            path,
            identityId: input.principal.identityId,
          })),
        },
        () => deps.service.remove(input, shareId(c)),
      );
      passwordCache.invalidate(shareId(c));
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
        () => shareCall(() => deps.service.publicShareExists(id)),
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
  /** The password cache is keyed by what the cookie carried, whichever form that was. */
  function credentialKey(provided: ShareCredential): string {
    return "password" in provided ? provided.password : `verified:${provided.verified}`;
  }
  function credentialCookie(c: Context, value: string, maxAge: number) {
    setCookie(c, SHARE_CREDENTIAL_COOKIE, value, {
      path: `${ROUTES.publicShares}/${shareId(c)}`,
      httpOnly: true,
      sameSite: "Lax",
      secure: cookieSecureFor(deps.config, c),
      maxAge,
    });
  }
  groups.public.get(pub, (c) =>
    shareCall(async () => c.json(await deps.service.publicMetadata(shareId(c), credential(c)))),
  );
  groups.public.post(`${pub}${PUBLIC_SHARE_SUFFIXES.credentials}`, (c) =>
    shareCall(async () => {
      const id = shareId(c);
      const body = await publicBody(ShareCredentialsRequest, c);
      const credential = await deps.service.credential(id, body.password);
      credentialCookie(c, deps.codec.encode(id, credential), SHARE_CREDENTIAL_SECONDS);
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
      const access = await deps.service.publicAccess(shareId(c), credential(c), "read");
      if (access.view.paths.length !== 1)
        throw new ApiHttpError("bad_request", "This share is an archive");
      const entries = await access.list(path);
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
  groups.public.get(`${pub}${PUBLIC_SHARE_SUFFIXES.archiveEntries}`, (c) =>
    shareCall(async () => {
      const path = publicPath(c);
      const access = await deps.service.publicAccess(shareId(c), credential(c), "read");
      // A limited link never peeks: every Range read the port issues is a
      // real download that would consume the link's own budget, the same
      // reasoning as the gallery refusing a limited link. An archive-of-many
      // share (`paths.length !== 1`) has no single archive file to peek
      // either. Both answer the same plain 403, never distinguishing why,
      // matching every other share-authorization failure on this route group.
      if (access.view.maxDownloads > 0 || access.view.paths.length !== 1) {
        throw new ApiHttpError("forbidden", "This share cannot be peeked");
      }
      const isSingleFile = path === "/";
      // `peekArchive` detects the archive format from its path's extension.
      // A single-file share's request path is always `/` (it names the
      // share, not the file), so the actual name with its extension comes
      // from the share's own shared path instead; the port reads the share
      // at `/` as every other public route does.
      const extensionPath = isSingleFile ? (access.view.paths[0] ?? path) : path;
      let result: Awaited<ReturnType<typeof peekArchive>>;
      try {
        result = await peekArchive({
          storage: createSharePeekPort({ access, isSingleFile }),
          path: extensionPath,
          maxBytes: deps.config.fdriveArchivePeekMaxBytes ?? DEFAULT_ARCHIVE_PEEK_MAX_BYTES,
          signal: c.req.raw.signal,
        });
      } catch (error) {
        // The access object has already mapped its backend's failures,
        // including a wrong password, to `ApiHttpError`; only the peek's
        // own verdicts on the archive are left to translate.
        if (
          error instanceof UnsupportedPeekFormatError ||
          error instanceof UnreadableArchiveError
        ) {
          throw new ApiHttpError("bad_request", error.message);
        }
        throw error;
      }
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
  // No `createReadAuthorizer` live probe on this route, unlike the authed
  // thumb route: the share itself is the authorization for anything under
  // it, and a live read probe here would either cost a download token (the
  // public share API has none for a bare storage check) or need the
  // owner's own credentials, neither of which a thumbnail should ever
  // require. Every failure below answers the same bare 404: whether the
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

    const id = shareId(c);
    let target: Awaited<ReturnType<SharesService["publicThumbTarget"]>>;
    try {
      target = await deps.service.publicThumbTarget(id);
    } catch {
      throw THUMB_NOT_FOUND();
    }
    if (target.scope !== "read" || target.unavailableReason !== null || target.paths.length !== 1)
      throw THUMB_NOT_FOUND();
    const sharedRoot = target.paths[0];
    if (sharedRoot === undefined) throw THUMB_NOT_FOUND();

    if (target.hasPassword) {
      const provided = credential(c);
      if (provided === undefined) throw THUMB_NOT_FOUND();
      let verified = passwordCache.get(id, credentialKey(provided));
      if (verified === undefined) {
        try {
          verified = await deps.service.verifySharePassword(id, provided);
        } catch {
          throw THUMB_NOT_FOUND();
        }
        passwordCache.set(id, credentialKey(provided), verified);
      }
      if (!verified) throw THUMB_NOT_FOUND();
    }

    const virtualPath = query.path === "/" ? sharedRoot : `${sharedRoot}${query.path}`;
    const identity = await deps.identities.get(target.identityId);
    if (identity === null) throw THUMB_NOT_FOUND();
    const verifiedScopes = await deps.resolver.verifiedIndexScopes(identity);
    if (!verifiedScopes.available) throw THUMB_NOT_FOUND();
    // `toFsPath` normalizes, and `normalizePath` throws for a segment over
    // 255 UTF-8 bytes, which `SharePath` (a 4096-character total bound with
    // no per-segment limit) happily allows through. Catch it here so an
    // over-long segment is the same bare 404 as everything else rather than
    // an unhandled 500 that tells the caller its path was the odd one out.
    let resolved: ReturnType<typeof toFsPath>;
    try {
      resolved = toFsPath(verifiedScopes.scopes, virtualPath);
    } catch {
      throw THUMB_NOT_FOUND();
    }
    if (resolved === null) throw THUMB_NOT_FOUND();

    const response = await serveThumb(
      c,
      { indexQueries: deps.indexQueries, thumbsDir: deps.thumbsDir, fileReader: thumbFileReader },
      { rootName: resolved.rootName, fsPath: resolved.fsPath, size: query.size },
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
  // HEAD is registered on its own rather than left to Hono's HEAD-as-GET
  // fallback, which would drop the body without cancelling the stream and
  // leave the upstream connection open until it drained.
  const download = (c: Context) =>
    shareCall(async () => {
      const path = publicPath(c);
      const options = publicDownloadOptions(c);
      const access = await deps.service.publicAccess(shareId(c), credential(c), "read");
      if (access.view.paths.length !== 1)
        throw new ApiHttpError("bad_request", "Use the archive download for this share");
      const name =
        path === "/"
          ? access.view.paths[0]?.split("/").at(-1) || "download"
          : path.slice(path.lastIndexOf("/") + 1);
      // A backend that can stat through the share answers HEAD from the
      // stat: no stream is opened and nothing is spent from its budget.
      if (c.req.method === "HEAD" && access.statFile !== undefined) {
        const stat = await access.statFile(path);
        return new Response(null, {
          status: 200,
          headers: downloadHeaders(
            {
              status: 200,
              contentLength: stat.size,
              contentRange: null,
              contentType: stat.contentType,
              lastModified: stat.modifiedAt,
            },
            name,
          ),
        });
      }
      let result: ShareDownloadResult;
      try {
        result = await access.download(path, options);
      } catch (error) {
        if (error instanceof RangeNotSatisfiableError) return rangeNotSatisfiable(error.size);
        throw error;
      }
      if (c.req.method === "HEAD") {
        await result.body.cancel();
        return new Response(null, {
          status: result.status,
          headers: downloadHeaders(result, name),
        });
      }
      return downloadResponse(result, name);
    });
  groups.public.get(`${pub}${PUBLIC_SHARE_SUFFIXES.download}`, download);
  groups.public.on("HEAD", `${pub}${PUBLIC_SHARE_SUFFIXES.download}`, download);
  groups.public.get(`${pub}${PUBLIC_SHARE_SUFFIXES.archive}`, (c) =>
    shareCall(async () => {
      const access = await deps.service.publicAccess(shareId(c), credential(c), "read");
      const body = await access.zip({ signal: c.req.raw.signal });
      return new Response(body, {
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": attachment(`${access.view.name}.zip`),
        },
      });
    }),
  );
  groups.public.put(`${pub}${PUBLIC_SHARE_SUFFIXES.upload}`, (c) =>
    shareCall(async () => {
      const path = publicPath(c, true);
      const maxBytes = deps.config.fdriveShareUploadMaxBytes;
      if (contentLengthExceeds(c.req.header("content-length"), maxBytes))
        throw new ApiHttpError("payload_too_large", "Share upload is too large");
      const access = await deps.service.publicAccess(shareId(c), credential(c), "write");
      if (access.view.paths.length !== 1)
        throw new ApiHttpError("bad_request", "Invalid upload share");
      const cap = c.req.raw.body === null ? null : capByteStream(c.req.raw.body, maxBytes);
      try {
        await access.upload(path.slice(1), cap?.stream ?? new Uint8Array(), {
          signal: c.req.raw.signal,
        });
      } catch (error) {
        if (cap?.exceeded() === true) {
          throw new ApiHttpError("payload_too_large", "Share upload is too large");
        }
        throw error;
      }
      return c.json({ ok: true });
    }),
  );
}
