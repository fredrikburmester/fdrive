import {
  ArchiveEntriesResponse,
  CreateShareRequest,
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
import type { DownloadOptions, DownloadResult } from "@fdrive/sftpgo";
import { SftpgoError } from "@fdrive/sftpgo";
import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { z } from "zod";
import { accountContext } from "../accounts/routes.ts";
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
  SHARE_CREDENTIAL_COOKIE,
  SHARE_CREDENTIAL_SECONDS,
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
export function publicDownloadOptions(c: Context): DownloadOptions {
  const options: DownloadOptions = { signal: c.req.raw.signal };
  const range = c.req.header("range");
  if (range !== undefined) {
    if (!/^bytes=(?:[0-9]+-[0-9]*|-[0-9]+)$/.test(range))
      throw new ApiHttpError("bad_request", "Unsupported byte range");
    const [start, end] = range.slice(6).split("-");
    if (
      (start && !Number.isSafeInteger(Number(start))) ||
      (end && !Number.isSafeInteger(Number(end))) ||
      (start && end && Number(end) < Number(start)) ||
      (!start && Number(end) === 0)
    )
      throw new ApiHttpError("bad_request", "Unsupported byte range");
    options.rangeHeader = range;
  }
  const ifRange = c.req.header("if-range");
  if (ifRange !== undefined) options.ifRange = ifRange;
  return options;
}
export function attachment(name: string): string {
  return `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(name.replace(/\p{Cc}/gu, "")).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}
export function downloadResponse(result: DownloadResult, name: string): Response {
  const headers = new Headers({
    "Content-Type": result.contentType ?? "application/octet-stream",
    "Content-Disposition": attachment(name),
  });
  if (result.contentLength !== null) headers.set("Content-Length", String(result.contentLength));
  if (result.contentRange !== null) headers.set("Content-Range", result.contentRange);
  if (result.lastModified !== null) headers.set("Last-Modified", result.lastModified.toUTCString());
  return new Response(result.body, { status: result.status, headers });
}
export async function publicCall<T>(fn: () => Promise<T>, hasPassword: boolean): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (
      error instanceof SftpgoError &&
      hasPassword &&
      (error.kind === "unauthorized" || error.kind === "forbidden")
    )
      throw new ApiHttpError("unauthorized", "Share password required or incorrect", {
        reason: "password",
      });
    return shareCall(async () => {
      throw error;
    });
  }
}
export function registerSharesRoutes(
  groups: { public: AppHono; authed: AuthedHono },
  deps: {
    service: SharesService;
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
      return c.json(
        await deps.service.create(input, await publicBody(CreateShareRequest, c, 32 * 1024 * 1024)),
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
      return c.json(
        await deps.service.update(
          input,
          shareId(c),
          await publicBody(UpdateShareRequest, c, 32 * 1024 * 1024),
        ),
      );
    }),
  );
  groups.authed.delete(`${base}/:id`, (c) =>
    shareCall(async () => {
      await deps.service.remove(accountContext(c), shareId(c));
      return c.json({ ok: true });
    }),
  );
  groups.public.use(`${withoutApiV1Prefix(ROUTES.publicShares)}/*`, async (c, next) => {
    const id = shareId(c);
    if (
      !deps.limiter.allow(
        extractClientIp(c, deps.config.fdriveTrustedProxyHops),
        id,
        c.req.method === "POST" && c.req.path.endsWith("/credentials"),
      )
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
  function password(c: Context) {
    return deps.codec.decode(shareId(c), getCookie(c, SHARE_CREDENTIAL_COOKIE));
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
    shareCall(async () =>
      c.json(await deps.service.publicMetadata(shareId(c), password(c) !== undefined)),
    ),
  );
  groups.public.post(`${pub}/credentials`, (c) =>
    shareCall(async () => {
      const id = shareId(c);
      const body = await publicBody(ShareCredentialsRequest, c);
      await deps.service.publicMetadata(id, false);
      credentialCookie(c, deps.codec.encode(id, body.password), SHARE_CREDENTIAL_SECONDS);
      return c.json({ ok: true });
    }),
  );
  groups.public.delete(`${pub}/credentials`, (c) => {
    credentialCookie(c, "", 0);
    return c.json({ ok: true });
  });
  groups.public.get(`${pub}/entries`, (c) =>
    shareCall(async () => {
      const path = publicPath(c);
      const { share, api } = await deps.service.publicAccess(shareId(c), password(c), "read");
      if (share.paths.length !== 1)
        throw new ApiHttpError("bad_request", "This share is an archive");
      const entries = await publicCall(() => api.list(path), share.hasPassword);
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
  groups.public.get(`${pub}/archive-entries`, (c) =>
    shareCall(async () => {
      const path = publicPath(c);
      const { share, api } = await deps.service.publicAccess(shareId(c), password(c), "read");
      // A limited link never peeks: every Range read the port issues is a
      // real SFTPGo download that would consume the link's own budget, the
      // same reasoning as the gallery refusing a limited link. An
      // archive-of-many share (`paths.length !== 1`) has no single archive
      // file to peek either. Both answer the same plain 403, never
      // distinguishing why, matching every other share-authorization
      // failure on this route group.
      if (share.maxTokens > 0 || share.paths.length !== 1) {
        throw new ApiHttpError("forbidden", "This share cannot be peeked");
      }
      // Not wrapped in `publicCall`: unlike a single `api.list`/`download`
      // call, `peekArchive` issues several Range reads through the adapter,
      // so a wrong-password `SftpgoError` is recognized inline below
      // instead of losing its type through `publicCall`'s own `shareCall`
      // fallback for anything else, which would answer `upstream_unavailable`
      // even for a peek-specific error such as an unsupported extension.
      const isSingleFile = path === "/";
      // `peekArchive` detects the archive format from its path's extension.
      // A single-file share's request path is always `/` (it names the
      // share, not the file), so the actual name with its extension comes
      // from the share's own shared path instead, matching `/download`'s
      // `path === "/"` convention for which SFTPGo call to make.
      const extensionPath = isSingleFile ? (share.paths[0] ?? path) : path;
      let result: Awaited<ReturnType<typeof peekArchive>>;
      try {
        result = await peekArchive({
          storage: createSharePeekPort({ api, isSingleFile }),
          path: extensionPath,
          maxBytes: deps.config.fdriveArchivePeekMaxBytes ?? DEFAULT_ARCHIVE_PEEK_MAX_BYTES,
          signal: c.req.raw.signal,
        });
      } catch (error) {
        if (
          error instanceof UnsupportedPeekFormatError ||
          error instanceof UnreadableArchiveError
        ) {
          throw new ApiHttpError("bad_request", error.message);
        }
        if (
          error instanceof SftpgoError &&
          share.hasPassword &&
          (error.kind === "unauthorized" || error.kind === "forbidden")
        ) {
          throw new ApiHttpError("unauthorized", "Share password required or incorrect", {
            reason: "password",
          });
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
  groups.public.get(`${pub}/thumb`, async (c) => {
    if (deps.thumbsDir === undefined) throw THUMB_NOT_FOUND();

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
      const provided = password(c);
      if (provided === undefined) throw THUMB_NOT_FOUND();
      let verified = passwordCache.get(id, provided);
      if (verified === undefined) {
        try {
          verified = await deps.service.verifySharePassword(
            target.identityId,
            target.sftpgoShareId,
            provided,
          );
        } catch {
          throw THUMB_NOT_FOUND();
        }
        passwordCache.set(id, provided, verified);
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
  groups.public.get(`${pub}/download`, (c) =>
    shareCall(async () => {
      const path = publicPath(c);
      const options = publicDownloadOptions(c);
      const { share, api } = await deps.service.publicAccess(shareId(c), password(c), "read");
      if (share.paths.length !== 1)
        throw new ApiHttpError("bad_request", "Use the archive download for this share");
      const result = await publicCall(
        () => (path === "/" ? api.downloadFile(options) : api.download(path, options)),
        share.hasPassword,
      );
      return downloadResponse(
        result,
        path === "/"
          ? share.paths[0]?.split("/").at(-1) || "download"
          : path.slice(path.lastIndexOf("/") + 1),
      );
    }),
  );
  groups.public.get(`${pub}/archive`, (c) =>
    shareCall(async () => {
      const { share, api } = await deps.service.publicAccess(shareId(c), password(c), "read");
      const body = await publicCall(() => api.zip({ signal: c.req.raw.signal }), share.hasPassword);
      return new Response(body, {
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": attachment(`${share.name}.zip`),
        },
      });
    }),
  );
  groups.public.put(`${pub}/upload`, (c) =>
    shareCall(async () => {
      const path = publicPath(c, true);
      const maxBytes = deps.config.fdriveShareUploadMaxBytes;
      if (contentLengthExceeds(c.req.header("content-length"), maxBytes))
        throw new ApiHttpError("payload_too_large", "Share upload is too large");
      const { share, api } = await deps.service.publicAccess(shareId(c), password(c), "write");
      if (share.paths.length !== 1) throw new ApiHttpError("bad_request", "Invalid upload share");
      const cap = c.req.raw.body === null ? null : capByteStream(c.req.raw.body, maxBytes);
      try {
        await publicCall(
          () =>
            api.upload(path.slice(1), cap?.stream ?? new Uint8Array(), {
              signal: c.req.raw.signal,
            }),
          share.hasPassword,
        );
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
