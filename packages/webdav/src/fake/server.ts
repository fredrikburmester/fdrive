import { encodePath, isWithin, parentOf, segmentsOf } from "../path.js";
import { type FakeFile, type FakeNode, FakeVolume } from "./volume.js";

export interface FakeWebdavUser {
  readonly username: string;
  readonly password: string;
  /** Every write method answers 403 for this user. */
  readonly readOnly?: boolean;
}

export interface FakeWebdavOptions {
  readonly users: readonly FakeWebdavUser[];
  /** The only origin the fake answers; any other host fails like an unreachable network. */
  readonly origin?: string;
  /** The path the DAV tree is mounted under, e.g. "/dav". Defaults to "/". */
  readonly prefix?: string;
  /** Whether `href` values are absolute URLs or absolute paths. Defaults to "path". */
  readonly hrefStyle?: "path" | "absolute";
  /** `D:`-prefixed elements (default) or a default `xmlns="DAV:"` namespace. */
  readonly namespaceStyle?: "prefixed" | "default";
  /** Files to seed, by provider path; parents are created. */
  readonly files?: Readonly<Record<string, string>>;
  /** The `DAV` header `OPTIONS` returns; `null` omits it. Defaults to "1, 2". */
  readonly dav?: string | null;
  /** Whether an unauthenticated `OPTIONS` is answered. Defaults to true. */
  readonly anonymousOptions?: boolean;
  /** The `WWW-Authenticate` challenge on 401. Defaults to a Basic realm. */
  readonly challenge?: string | null;
  /** When set, every request is answered with a 302 to this location. */
  readonly redirectTo?: string;
  /** Whether `Range` is honoured. Defaults to true. */
  readonly rangeSupport?: boolean;
  readonly now?: () => Date;
}

export interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

export interface FakeWebdavServer {
  readonly fetch: typeof globalThis.fetch;
  readonly volume: FakeVolume;
  /** Every request received, in order, for asserting on headers. */
  readonly requests: RecordedRequest[];
}

interface ServerState {
  readonly options: Required<
    Omit<FakeWebdavOptions, "files" | "redirectTo" | "dav" | "challenge">
  > & {
    readonly dav: string | null;
    readonly challenge: string | null;
    readonly redirectTo: string | undefined;
  };
  readonly volume: FakeVolume;
  readonly requests: RecordedRequest[];
}

const ALLOW = "OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, MKCOL, COPY, MOVE";

class BadEncoding extends Error {}

function xmlEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function prefixOf(state: ServerState): string {
  const prefix = state.options.prefix;
  return prefix.endsWith("/") ? prefix : `${prefix}/`;
}

/** The provider path a request pathname addresses, `null` outside the prefix. */
function pathOf(state: ServerState, pathname: string): string | null {
  const prefix = prefixOf(state);
  if (`${pathname}/` === prefix) return "/";
  if (!pathname.startsWith(prefix)) return null;
  const segments = segmentsOf(pathname.slice(prefix.length)).map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      throw new BadEncoding(segment);
    }
  });
  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

function hrefFor(state: ServerState, path: string, isDir: boolean): string {
  const encoded = `${prefixOf(state)}${encodePath(path)}`;
  const withSlash = isDir && path !== "/" ? `${encoded}/` : encoded;
  return state.options.hrefStyle === "absolute" ? `${state.options.origin}${withSlash}` : withSlash;
}

function etagOf(node: FakeNode): string {
  return node.kind === "file"
    ? `"${node.content.byteLength}-${node.modifiedAt.getTime()}"`
    : `"dir-${node.modifiedAt.getTime()}"`;
}

function responseXml(state: ServerState, path: string, node: FakeNode): string {
  const t = (name: string) => (state.options.namespaceStyle === "prefixed" ? `D:${name}` : name);
  const name = segmentsOf(path).at(-1) ?? "";
  const props = [
    `<${t("resourcetype")}>${node.kind === "dir" ? `<${t("collection")}/>` : ""}</${t("resourcetype")}>`,
    node.kind === "file"
      ? `<${t("getcontentlength")}>${node.content.byteLength}</${t("getcontentlength")}>`
      : "",
    node.kind === "file" && node.contentType !== null
      ? `<${t("getcontenttype")}>${xmlEscape(node.contentType)}</${t("getcontenttype")}>`
      : "",
    `<${t("getlastmodified")}>${node.modifiedAt.toUTCString()}</${t("getlastmodified")}>`,
    `<${t("getetag")}>${xmlEscape(etagOf(node))}</${t("getetag")}>`,
    `<${t("displayname")}>${xmlEscape(name)}</${t("displayname")}>`,
  ].join("");
  return (
    `<${t("response")}><${t("href")}>${xmlEscape(hrefFor(state, path, node.kind === "dir"))}</${t("href")}>` +
    `<${t("propstat")}><${t("prop")}>${props}</${t("prop")}>` +
    `<${t("status")}>HTTP/1.1 200 OK</${t("status")}></${t("propstat")}></${t("response")}>`
  );
}

function multistatus(state: ServerState, entries: readonly [string, FakeNode][]): Response {
  const prefixed = state.options.namespaceStyle === "prefixed";
  const open = prefixed ? '<D:multistatus xmlns:D="DAV:">' : '<multistatus xmlns="DAV:">';
  const close = prefixed ? "</D:multistatus>" : "</multistatus>";
  const body =
    '<?xml version="1.0" encoding="utf-8"?>' +
    open +
    entries.map(([path, node]) => responseXml(state, path, node)).join("") +
    close;
  return new Response(body, {
    status: 207,
    headers: { "Content-Type": 'application/xml; charset="utf-8"' },
  });
}

function status(code: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status: code, headers });
}

function unauthorized(state: ServerState): Response {
  const headers: Record<string, string> = {};
  if (state.options.challenge !== null) headers["WWW-Authenticate"] = state.options.challenge;
  return status(401, headers);
}

function parseBasicAuth(header: string | null): { username: string; password: string } | null {
  if (header === null || !header.startsWith("Basic ")) return null;
  const decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator === -1) return null;
  return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
}

function authenticate(state: ServerState, request: Request): FakeWebdavUser | null {
  const parsed = parseBasicAuth(request.headers.get("authorization"));
  if (parsed === null) return null;
  const user = state.options.users.find((candidate) => candidate.username === parsed.username);
  return user !== undefined && user.password === parsed.password ? user : null;
}

function optionsResponse(state: ServerState): Response {
  const headers: Record<string, string> = { Allow: ALLOW, "MS-Author-Via": "DAV" };
  if (state.options.dav !== null) headers.DAV = state.options.dav;
  return status(200, headers);
}

function propfind(state: ServerState, request: Request, path: string): Response {
  const depth = request.headers.get("depth") ?? "infinity";
  if (depth !== "0" && depth !== "1") return status(403);
  const node = state.volume.get(path);
  if (node === undefined) return status(404);
  const entries: [string, FakeNode][] = [[path, node]];
  if (depth === "1" && node.kind === "dir") {
    for (const child of state.volume.children(path)) {
      entries.push([child, state.volume.get(child) as FakeNode]);
    }
  }
  return multistatus(state, entries);
}

interface Slice {
  readonly start: number;
  readonly end: number;
}

/** Resolves a single `bytes=` range against `size`; `null` to ignore it, `"unsatisfiable"` for 416. */
function resolveRange(header: string | null, size: number): Slice | "unsatisfiable" | null {
  if (header === null) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (match === null) return null;
  // Both capture groups are `\d*`, which always match (possibly empty).
  const startText = match[1] as string;
  const endText = match[2] as string;
  if (startText === "" && endText === "") return null;
  if (startText === "") {
    const suffix = Number(endText);
    if (suffix === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(startText);
  if (start >= size) return "unsatisfiable";
  const end = endText === "" ? size - 1 : Math.min(Number(endText), size - 1);
  if (end < start) return null;
  return { start, end };
}

function fileHeaders(node: FakeFile): Record<string, string> {
  const headers: Record<string, string> = {
    "Accept-Ranges": "bytes",
    "Last-Modified": node.modifiedAt.toUTCString(),
    ETag: etagOf(node),
  };
  if (node.contentType !== null) headers["Content-Type"] = node.contentType;
  return headers;
}

function get(state: ServerState, request: Request, path: string, head: boolean): Response {
  const node = state.volume.get(path);
  if (node === undefined) return status(404);
  if (node.kind === "dir") return status(405, { Allow: ALLOW });
  const size = node.content.byteLength;
  const headers = fileHeaders(node);
  const ifRange = request.headers.get("if-range");
  const rangeApplies =
    state.options.rangeSupport &&
    (ifRange === null || ifRange === etagOf(node) || ifRange === node.modifiedAt.toUTCString());
  const range = rangeApplies ? resolveRange(request.headers.get("range"), size) : null;
  if (range === "unsatisfiable") {
    return status(416, { "Content-Range": `bytes */${size}` });
  }
  if (range !== null) {
    headers["Content-Range"] = `bytes ${range.start}-${range.end}/${size}`;
    headers["Content-Length"] = String(range.end - range.start + 1);
    return new Response(head ? null : node.content.slice(range.start, range.end + 1), {
      status: 206,
      headers,
    });
  }
  headers["Content-Length"] = String(size);
  return new Response(head ? null : node.content.slice(), { status: 200, headers });
}

async function put(state: ServerState, request: Request, path: string): Promise<Response> {
  if (path === "/") return status(405, { Allow: ALLOW });
  const existing = state.volume.get(path);
  if (existing?.kind === "dir") return status(405, { Allow: ALLOW });
  if (!state.volume.isDir(parentOf(path))) return status(409);
  if (existing !== undefined && request.headers.get("if-none-match") === "*") return status(412);
  const content = new Uint8Array(await request.arrayBuffer());
  const mtime = request.headers.get("x-oc-mtime");
  const modifiedAt =
    mtime !== null && /^\d+$/.test(mtime) ? new Date(Number(mtime) * 1000) : undefined;
  state.volume.putFile(path, content, {
    contentType: request.headers.get("content-type"),
    ...(modifiedAt === undefined ? {} : { modifiedAt }),
  });
  const headers: Record<string, string> = {};
  if (modifiedAt !== undefined) headers["X-OC-Mtime"] = "accepted";
  return status(existing === undefined ? 201 : 204, headers);
}

async function mkcol(state: ServerState, request: Request, path: string): Promise<Response> {
  if (state.volume.has(path)) return status(405, { Allow: ALLOW });
  if (!state.volume.isDir(parentOf(path))) return status(409);
  if ((await request.arrayBuffer()).byteLength > 0) return status(415);
  state.volume.mkdir(path);
  return status(201);
}

function remove(state: ServerState, path: string): Response {
  if (path === "/") return status(403);
  if (!state.volume.has(path)) return status(404);
  state.volume.remove(path);
  return status(204);
}

function destinationOf(state: ServerState, request: Request): string | Response {
  const header = request.headers.get("destination");
  if (header === null) return status(400);
  let url: URL;
  try {
    url = new URL(header, state.options.origin);
  } catch {
    return status(400);
  }
  if (url.origin !== state.options.origin) return status(502);
  let path: string | null;
  try {
    path = pathOf(state, url.pathname);
  } catch {
    return status(400);
  }
  return path === null ? status(502) : path;
}

function copyMove(
  state: ServerState,
  request: Request,
  path: string,
  method: "COPY" | "MOVE",
): Response {
  const node = state.volume.get(path);
  if (node === undefined) return status(404);
  if (path === "/") return status(403);
  const destination = destinationOf(state, request);
  if (destination instanceof Response) return destination;
  if (destination === path || destination === "/") return status(403);
  if (node.kind === "dir" && isWithin(path, destination)) return status(403);
  const existing = state.volume.has(destination);
  if (existing && request.headers.get("overwrite")?.toUpperCase() === "F") return status(412);
  if (!state.volume.isDir(parentOf(destination))) return status(409);
  if (existing) state.volume.remove(destination);
  if (method === "MOVE") state.volume.move(path, destination);
  else state.volume.copy(path, destination, { shallow: request.headers.get("depth") === "0" });
  return status(existing ? 204 : 201);
}

async function handle(state: ServerState, request: Request): Promise<Response> {
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });
  state.requests.push({ method: request.method, url: request.url, headers });

  const url = new URL(request.url);
  if (url.origin !== state.options.origin) {
    throw new TypeError(`fetch failed: unknown host ${url.host}`);
  }
  if (state.options.redirectTo !== undefined) {
    return status(302, { Location: state.options.redirectTo });
  }
  let path: string | null;
  try {
    path = pathOf(state, url.pathname);
  } catch {
    return status(400);
  }
  if (path === null) return status(404);

  const user = authenticate(state, request);
  if (request.method === "OPTIONS") {
    return user !== null || state.options.anonymousOptions
      ? optionsResponse(state)
      : unauthorized(state);
  }
  if (user === null) return unauthorized(state);

  switch (request.method) {
    case "PROPFIND":
      return propfind(state, request, path);
    case "GET":
      return get(state, request, path, false);
    case "HEAD":
      return get(state, request, path, true);
  }
  if (user.readOnly === true) return status(403);
  switch (request.method) {
    case "PUT":
      return put(state, request, path);
    case "MKCOL":
      return mkcol(state, request, path);
    case "DELETE":
      return remove(state, path);
    case "COPY":
    case "MOVE":
      return copyMove(state, request, path, request.method);
    default:
      return status(405, { Allow: ALLOW });
  }
}

/**
 * An in-memory RFC 4918 class 1 server behind Basic authentication, exposed
 * as a `fetch` function. Answers only its own origin; a request anywhere
 * else rejects like an unreachable host, so confinement tests can prove a
 * client never leaves the endpoint.
 */
export function createFakeWebdavServer(options: FakeWebdavOptions): FakeWebdavServer {
  const now = options.now ?? (() => new Date());
  const volume = new FakeVolume(now);
  for (const [path, content] of Object.entries(options.files ?? {})) {
    volume.mkdirAll(parentOf(path));
    volume.putFile(path, new TextEncoder().encode(content), { contentType: "text/plain" });
  }
  const state: ServerState = {
    options: {
      users: options.users,
      origin: options.origin ?? "http://webdav.test",
      prefix: options.prefix ?? "/",
      hrefStyle: options.hrefStyle ?? "path",
      namespaceStyle: options.namespaceStyle ?? "prefixed",
      dav: options.dav === undefined ? "1, 2" : options.dav,
      anonymousOptions: options.anonymousOptions ?? true,
      challenge: options.challenge === undefined ? 'Basic realm="fake"' : options.challenge,
      redirectTo: options.redirectTo,
      rangeSupport: options.rangeSupport ?? true,
      now,
    },
    volume,
    requests: [],
  };
  const fetchImpl = (async (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ): Promise<Response> => {
    if (init?.signal?.aborted) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }
    return handle(state, new Request(input, init));
  }) as typeof globalThis.fetch;
  return { fetch: fetchImpl, volume, requests: state.requests };
}
