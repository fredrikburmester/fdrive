import { dirnameOf, normalizePath } from "../path.js";
import { hasAction, hasAnyAction, resolvePermissions } from "./permissions.js";
import type { FakeShareRecord, FakeUserRecord } from "./state.js";
import { FakeState } from "./state.js";
import type { FakeSeed } from "./types.js";
import type { Volume, VolumeEntry, VolumeNode } from "./volume.js";
import { buildZip, type ZipEntryInput } from "./zip.js";

export type { FakeShareRecord, FakeState, FakeTokenRecord, FakeUserRecord } from "./state.js";
export type { FakeSeed, FakeSeedUser } from "./types.js";

export interface FakeSftpgoServer {
  fetch: typeof globalThis.fetch;
  readonly state: FakeState;
}

const JSON_HEADERS = { "Content-Type": "application/json" };
const WRITE_SCOPE = 2;
const REDACTED_PASSWORD_MARKER = "[**redacted**]";
/** Go's os.ModeDir bit combined with a typical directory permission bitmask. */
const DIR_MODE = 0x80000000 | 0o755;

function jsonResponse(
  status: number,
  body: unknown,
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}

function errorResponse(status: number, error: string): Response {
  return jsonResponse(status, { message: "", error });
}

function emptyResponse(status: number, extraHeaders?: Record<string, string>): Response {
  return extraHeaders
    ? new Response(null, { status, headers: extraHeaders })
    : new Response(null, { status });
}

function isValidPath(path: string): boolean {
  return path.startsWith("/") && !path.includes("\0");
}

function parseBasicAuth(header: string | null): { username: string; password: string } | null {
  if (header === null || !header.startsWith("Basic ")) {
    return null;
  }
  const decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf8");
  const separatorIndex = decoded.indexOf(":");
  if (separatorIndex === -1) {
    return null;
  }
  return {
    username: decoded.slice(0, separatorIndex),
    password: decoded.slice(separatorIndex + 1),
  };
}

function parseBearer(header: string | null): string | null {
  if (header === null || !header.startsWith("Bearer ")) {
    return null;
  }
  return header.slice("Bearer ".length);
}

function requireBearerUser(state: FakeState, request: Request): FakeUserRecord | Response {
  const token = parseBearer(request.headers.get("authorization"));
  if (token === null) {
    return errorResponse(401, "invalid token");
  }
  const record = state.tokens.get(token);
  if (!record || record.expiresAtMs <= state.now().getTime()) {
    return errorResponse(401, "invalid token");
  }
  const user = state.users.get(record.username);
  if (!user) {
    return errorResponse(401, "invalid token");
  }
  return user;
}

function permissionDenied(): Response {
  return errorResponse(403, "Permission denied");
}

function statusEntry(
  name: string,
  node: VolumeNode,
): {
  name: string;
  size: number;
  mode: number;
  last_modified: string;
} {
  if (node.kind === "dir") {
    return { name, size: 0, mode: DIR_MODE, last_modified: new Date(0).toISOString() };
  }
  return {
    name,
    size: node.content.length,
    mode: 0o644,
    last_modified: new Date(node.mtimeMs).toISOString(),
  };
}

interface ParsedRange {
  readonly start: number;
  readonly end: number;
}

function parseRange(header: string | null, size: number): ParsedRange | "unsatisfiable" | null {
  if (header === null) {
    return null;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match) {
    return "unsatisfiable";
  }
  // Both groups use `*`, so a successful match always captures a string (possibly empty), never
  // undefined; the cast just works around noUncheckedIndexedAccess not knowing that.
  const startText = match[1] as string;
  const endText = match[2] as string;
  if (startText === "" && endText === "") {
    return "unsatisfiable";
  }
  if (startText === "") {
    const suffixLength = Number(endText);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
      return "unsatisfiable";
    }
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }
  const start = Number(startText);
  const end = endText === "" ? size - 1 : Number(endText);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    return "unsatisfiable";
  }
  return { start, end: Math.min(end, size - 1) };
}

// Only ever called with an already-validated absolute path (starts with "/"), so
// slicing off the leading character always yields the rest of the path.
function stripLeadingSlash(path: string): string {
  const normalized = normalizePath(path);
  return normalized === "/" ? "" : normalized.slice(1);
}

/**
 * Joins a zip entry name with a child segment. An empty parent name (used
 * when flattening entries relative to a share's root directory) yields just
 * the child's own name, with no leading slash.
 */
function zipChildName(name: string, childName: string): string {
  return name === "" ? childName : `${name}/${childName}`;
}

function collectZipEntries(
  volume: Volume,
  path: string,
  name: string,
  entries: ZipEntryInput[],
): void {
  const node = volume.get(path);
  if (!node) {
    return;
  }
  if (node.kind === "file") {
    entries.push({ name, content: node.content, mtime: new Date(node.mtimeMs) });
    return;
  }
  // node.kind === "dir" above already confirms path is a directory that exists, so
  // listChildren() cannot return null here.
  const children = volume.listChildren(path) as VolumeEntry[];
  for (const child of children) {
    const childPath = path === "/" ? `/${child.name}` : `${path}/${child.name}`;
    collectZipEntries(volume, childPath, zipChildName(name, child.name), entries);
  }
}

// --- user filesystem handlers -------------------------------------------------

async function handleLogin(state: FakeState, request: Request): Promise<Response> {
  const auth = parseBasicAuth(request.headers.get("authorization"));
  if (!auth) {
    return errorResponse(401, "invalid credentials");
  }
  const user = state.users.get(auth.username);
  if (!user || user.password !== auth.password) {
    return errorResponse(401, "invalid credentials");
  }
  const token = state.generateToken();
  const expiresAtMs = state.now().getTime() + state.tokenTtlMs;
  state.tokens.set(token, { username: user.username, expiresAtMs });
  return jsonResponse(200, {
    access_token: token,
    expires_at: new Date(expiresAtMs).toISOString(),
  });
}

function handleLogout(state: FakeState, request: Request): Response {
  const userOrResponse = requireBearerUser(state, request);
  if (userOrResponse instanceof Response) {
    return userOrResponse;
  }
  // requireBearerUser succeeded above, which only happens for a well-formed "Bearer <token>"
  // header, so parseBearer on the same header is guaranteed to return a token here.
  const token = parseBearer(request.headers.get("authorization")) as string;
  state.tokens.delete(token);
  return emptyResponse(200);
}

function handleList(state: FakeState, user: FakeUserRecord, url: URL): Response {
  const path = url.searchParams.get("path");
  if (path === null || !isValidPath(path)) {
    return errorResponse(400, "invalid path");
  }
  if (!hasAction(resolvePermissions(user.permissions, path), "list")) {
    return permissionDenied();
  }
  const { volume, innerPath } = state.resolveVolume(user.username, path);
  const children = volume.listChildren(innerPath);
  if (children === null) {
    return volume.has(innerPath)
      ? errorResponse(400, "not a directory")
      : errorResponse(404, "not found");
  }
  const entries = children.map((entry) => statusEntry(entry.name, entry.node));
  // A virtual folder mount is never itself a real entry in the user's own
  // volume: resolveVolume() redirects every path under (and at) the mount's
  // virtualPath into the mounted folder, so a name collision here cannot
  // arise. Synthesize a directory entry for each mount rooted at `path`.
  for (const mountName of state.virtualFolderMountNamesAt(user.username, path)) {
    entries.push({
      name: mountName,
      size: 0,
      mode: DIR_MODE,
      last_modified: state.now().toISOString(),
    });
  }
  return jsonResponse(200, entries);
}

function handleMkdir(state: FakeState, user: FakeUserRecord, url: URL): Response {
  const path = url.searchParams.get("path");
  if (path === null || !isValidPath(path)) {
    return errorResponse(400, "invalid path");
  }
  if (!hasAction(resolvePermissions(user.permissions, path), "create_dirs")) {
    return permissionDenied();
  }
  const parents = url.searchParams.get("mkdir_parents") === "true";
  const { volume, innerPath } = state.resolveVolume(user.username, path);
  const result = volume.mkdir(innerPath, parents);
  if (result === "conflict") {
    // The real drakkan/sftpgo:v2.7.5 container does not classify the
    // underlying os.Mkdir "already exists" error as a conflict: it surfaces
    // as an unhandled 500. Matching that here (rather than a friendlier 409)
    // keeps the fake's mkdir behaviour identical to the container's.
    return errorResponse(500, "failed to create directory");
  }
  if (result === "not_found") {
    return errorResponse(404, "parent not found");
  }
  return emptyResponse(201);
}

// --- trash (recycle-folder) relocation ------------------------------------

/** True when `path` is `trashPath` itself or nested below it: deletes there stay permanent. */
function isUnderTrashPrefix(trashPath: string, path: string): boolean {
  const normalizedTrash = normalizePath(trashPath);
  const normalizedPath = normalizePath(path);
  return normalizedPath === normalizedTrash || normalizedPath.startsWith(`${normalizedTrash}/`);
}

/**
 * The recycle-folder target for a deleted virtual path: `<trashPath>/<original
 * dir>/<original name>/<ns>`, mirroring the real Event Manager rename
 * action's `{{.VirtualDirPath}}/{{.ObjectName}}/{{.Timestamp}}` template.
 */
function trashTargetPath(trashPath: string, virtualPath: string, ns: string): string {
  const normalized = normalizePath(virtualPath);
  return normalized === "/" ? `${trashPath}/${ns}` : `${trashPath}${normalized}/${ns}`;
}

/**
 * Moves the file at `innerPath` (whose full virtual path is `virtualPath`)
 * into the trash. Returns true when the relocation happened; false when the
 * target would land in a different volume than the source (a virtual-folder
 * mount boundary the real rename action does not cross either), leaving the
 * caller to fall back to a permanent delete.
 */
function tryMoveToTrash(
  state: FakeState,
  user: FakeUserRecord,
  volume: Volume,
  innerPath: string,
  virtualPath: string,
  trashPath: string,
): boolean {
  const ns = state.nextTrashTimestamp();
  const targetVirtual = trashTargetPath(trashPath, virtualPath, ns);
  const { volume: targetVolume, innerPath: targetInner } = state.resolveVolume(
    user.username,
    targetVirtual,
  );
  if (targetVolume !== volume) {
    return false;
  }
  return volume.move(innerPath, targetInner) === "ok";
}

interface TrashCandidate {
  readonly inner: string;
  readonly relative: string;
}

/** Recursively collects every file under `innerPath`, with its path relative to it. */
function collectFileRelativePaths(
  volume: Volume,
  innerPath: string,
  relative: string,
  out: TrashCandidate[],
): void {
  const node = volume.get(innerPath);
  if (!node) {
    return;
  }
  if (node.kind === "file") {
    out.push({ inner: innerPath, relative });
    return;
  }
  const children = volume.listChildren(innerPath) ?? [];
  for (const child of children) {
    const childInner = innerPath === "/" ? `/${child.name}` : `${innerPath}/${child.name}`;
    const childRelative = relative === "" ? child.name : `${relative}/${child.name}`;
    collectFileRelativePaths(volume, childInner, childRelative, out);
  }
}

function toVirtualPath(basePath: string, relative: string): string {
  return basePath === "/" ? `/${relative}` : `${basePath}/${relative}`;
}

/** Moves every file under a directory being deleted into the trash, one relocation per file. */
function relocateDirToTrash(
  state: FakeState,
  user: FakeUserRecord,
  volume: Volume,
  innerPath: string,
  virtualPath: string,
  trashPath: string,
): void {
  const candidates: TrashCandidate[] = [];
  collectFileRelativePaths(volume, innerPath, "", candidates);
  for (const candidate of candidates) {
    tryMoveToTrash(
      state,
      user,
      volume,
      candidate.inner,
      toVirtualPath(virtualPath, candidate.relative),
      trashPath,
    );
  }
}

function handleDeleteDir(state: FakeState, user: FakeUserRecord, url: URL): Response {
  const path = url.searchParams.get("path");
  if (path === null || !isValidPath(path)) {
    return errorResponse(400, "invalid path");
  }
  if (!hasAnyAction(resolvePermissions(user.permissions, path), ["delete", "delete_dirs"])) {
    return permissionDenied();
  }
  const { volume, innerPath } = state.resolveVolume(user.username, path);
  if (state.trash && !isUnderTrashPrefix(state.trash.path, path)) {
    relocateDirToTrash(state, user, volume, innerPath, path, state.trash.path);
  }
  const result = volume.deleteDir(innerPath);
  if (result === "not_found") {
    return errorResponse(404, "not found");
  }
  if (result === "bad_request") {
    return errorResponse(400, "not a directory");
  }
  return emptyResponse(200);
}

interface FileLookup {
  readonly volume: Volume;
  readonly innerPath: string;
  readonly node: Extract<VolumeNode, { kind: "file" }>;
}

function lookupFileForRead(
  state: FakeState,
  user: FakeUserRecord,
  path: string,
): FileLookup | Response {
  if (!hasAction(resolvePermissions(user.permissions, dirnameOf(path)), "download")) {
    return permissionDenied();
  }
  const { volume, innerPath } = state.resolveVolume(user.username, path);
  const node = volume.get(innerPath);
  if (!node) {
    return errorResponse(404, "not found");
  }
  if (node.kind !== "file") {
    return errorResponse(400, "is a directory");
  }
  return { volume, innerPath, node };
}

function fileReadHeaders(node: Extract<VolumeNode, { kind: "file" }>): Record<string, string> {
  return {
    "Last-Modified": new Date(node.mtimeMs).toUTCString(),
    "Content-Type": "application/octet-stream",
  };
}

function handleStat(state: FakeState, user: FakeUserRecord, url: URL): Response {
  const path = url.searchParams.get("path");
  if (path === null || !isValidPath(path)) {
    return errorResponse(400, "invalid path");
  }
  const lookup = lookupFileForRead(state, user, path);
  if (lookup instanceof Response) {
    return lookup;
  }
  return emptyResponse(200, {
    ...fileReadHeaders(lookup.node),
    "Content-Length": String(lookup.node.content.length),
  });
}

function handleDownload(
  state: FakeState,
  request: Request,
  user: FakeUserRecord,
  url: URL,
): Response {
  const path = url.searchParams.get("path");
  if (path === null || !isValidPath(path)) {
    return errorResponse(400, "invalid path");
  }
  const lookup = lookupFileForRead(state, user, path);
  if (lookup instanceof Response) {
    return lookup;
  }
  return respondWithFile(lookup.node, request.headers.get("range"));
}

function respondWithFile(
  node: Extract<VolumeNode, { kind: "file" }>,
  rangeHeader: string | null,
): Response {
  const range = parseRange(rangeHeader, node.content.length);
  if (range === "unsatisfiable") {
    return errorResponse(416, "range not satisfiable");
  }
  const headers = fileReadHeaders(node);
  if (range) {
    const body = node.content.slice(range.start, range.end + 1);
    return new Response(body, {
      status: 206,
      headers: {
        ...headers,
        "Content-Range": `bytes ${range.start}-${range.end}/${node.content.length}`,
        "Content-Length": String(body.length),
      },
    });
  }
  return new Response(node.content, {
    status: 200,
    headers: { ...headers, "Content-Length": String(node.content.length) },
  });
}

function handleDeleteFile(state: FakeState, user: FakeUserRecord, url: URL): Response {
  const path = url.searchParams.get("path");
  if (path === null || !isValidPath(path)) {
    return errorResponse(400, "invalid path");
  }
  if (
    !hasAnyAction(resolvePermissions(user.permissions, dirnameOf(path)), ["delete", "delete_files"])
  ) {
    return permissionDenied();
  }
  const { volume, innerPath } = state.resolveVolume(user.username, path);
  if (state.trash && !isUnderTrashPrefix(state.trash.path, path)) {
    if (tryMoveToTrash(state, user, volume, innerPath, path, state.trash.path)) {
      return emptyResponse(200);
    }
  }
  const result = volume.deleteFile(innerPath);
  if (result === "not_found") {
    return errorResponse(404, "not found");
  }
  if (result === "bad_request") {
    return errorResponse(400, "is a directory");
  }
  return emptyResponse(200);
}

async function handleUpload(
  state: FakeState,
  request: Request,
  user: FakeUserRecord,
  url: URL,
): Promise<Response> {
  const path = url.searchParams.get("path");
  if (path === null || !isValidPath(path)) {
    return errorResponse(400, "invalid path");
  }
  const perms = resolvePermissions(user.permissions, dirnameOf(path));
  if (!hasAction(perms, "upload")) {
    return permissionDenied();
  }
  const { volume, innerPath } = state.resolveVolume(user.username, path);
  if (volume.isFile(innerPath) && !hasAction(perms, "overwrite")) {
    return permissionDenied();
  }
  const mkdirParents = url.searchParams.get("mkdir_parents") === "true";
  const body = new Uint8Array(await request.arrayBuffer());
  const mtimeMs = readMtimeHeader(request, state);
  const result = volume.writeFile(innerPath, body, mtimeMs, mkdirParents);
  if (result === "not_found") {
    return errorResponse(404, "parent not found");
  }
  if (result === "bad_request") {
    return errorResponse(400, "target is a directory");
  }
  return emptyResponse(200);
}

function readMtimeHeader(request: Request, state: FakeState): number {
  const header = request.headers.get("x-sftpgo-mtime");
  if (header === null) {
    return state.now().getTime();
  }
  const parsed = Number(header);
  return Number.isFinite(parsed) ? parsed : state.now().getTime();
}

function handleMove(state: FakeState, user: FakeUserRecord, url: URL): Response {
  return handleRelocate(state, user, url, "move");
}

function handleCopy(state: FakeState, user: FakeUserRecord, url: URL): Response {
  return handleRelocate(state, user, url, "copy");
}

function handleRelocate(
  state: FakeState,
  user: FakeUserRecord,
  url: URL,
  kind: "move" | "copy",
): Response {
  const path = url.searchParams.get("path");
  const target = url.searchParams.get("target");
  if (path === null || target === null || !isValidPath(path) || !isValidPath(target)) {
    return errorResponse(400, "invalid path");
  }
  const { volume: sourceVolume, innerPath: sourceInner } = state.resolveVolume(user.username, path);
  const sourceNode = sourceVolume.get(sourceInner);
  if (!sourceNode) {
    return errorResponse(404, "not found");
  }

  const sourcePerms = resolvePermissions(user.permissions, dirnameOf(path));
  const targetPerms = resolvePermissions(user.permissions, dirnameOf(target));
  const allowed =
    kind === "move"
      ? isMoveAllowed(sourcePerms, targetPerms, sourceNode.kind === "dir")
      : isCopyAllowed(sourcePerms, targetPerms);
  if (!allowed) {
    return permissionDenied();
  }

  const { volume: targetVolume, innerPath: targetInner } = state.resolveVolume(
    user.username,
    target,
  );
  if (sourceVolume !== targetVolume) {
    return errorResponse(400, `cross-volume ${kind} is not supported`);
  }
  // The source's existence was already confirmed above and nothing else can run in between
  // (this handler is synchronous from here on), so relocate() cannot report "not_found".
  const result =
    kind === "move"
      ? sourceVolume.move(sourceInner, targetInner)
      : sourceVolume.copy(sourceInner, targetInner);
  if (result === "conflict") {
    return errorResponse(409, "already exists");
  }
  return emptyResponse(200);
}

function isMoveAllowed(
  sourcePerms: readonly string[],
  targetPerms: readonly string[],
  isDir: boolean,
): boolean {
  const renameAction = isDir ? "rename_dirs" : "rename_files";
  return (
    hasAnyAction(sourcePerms, ["rename", renameAction]) &&
    hasAnyAction(targetPerms, ["rename", renameAction])
  );
}

function isCopyAllowed(sourcePerms: readonly string[], targetPerms: readonly string[]): boolean {
  return (
    hasAction(sourcePerms, "copy") &&
    hasAction(sourcePerms, "download") &&
    hasAction(targetPerms, "copy") &&
    hasAction(targetPerms, "upload")
  );
}

async function handleSetModifiedAt(
  state: FakeState,
  request: Request,
  user: FakeUserRecord,
  url: URL,
): Promise<Response> {
  const path = url.searchParams.get("path");
  if (path === null || !isValidPath(path)) {
    return errorResponse(400, "invalid path");
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, "invalid body");
  }
  const modificationTime = (body as { modification_time?: unknown }).modification_time;
  if (typeof modificationTime !== "number") {
    return errorResponse(400, "invalid body");
  }
  const { volume, innerPath } = state.resolveVolume(user.username, path);
  const result = volume.setMtime(innerPath, modificationTime);
  if (result === "not_found") {
    return errorResponse(404, "not found");
  }
  if (result === "bad_request") {
    return errorResponse(400, "is a directory");
  }
  return emptyResponse(200);
}

async function handleZip(
  state: FakeState,
  request: Request,
  user: FakeUserRecord,
): Promise<Response> {
  let paths: unknown;
  try {
    paths = await request.json();
  } catch {
    return errorResponse(400, "invalid body");
  }
  if (
    !Array.isArray(paths) ||
    !paths.every((path): path is string => typeof path === "string" && isValidPath(path))
  ) {
    return errorResponse(400, "invalid body");
  }
  const entries: ZipEntryInput[] = [];
  for (const path of paths) {
    const { volume, innerPath } = state.resolveVolume(user.username, path);
    collectZipEntries(volume, innerPath, stripLeadingSlash(path), entries);
  }
  return new Response(buildZip(entries), {
    status: 200,
    headers: { "Content-Type": "application/zip" },
  });
}

function handleProfile(user: FakeUserRecord): Response {
  return jsonResponse(200, {
    email: `${user.username}@example.invalid`,
    description: "",
    allow_api_key_auth: false,
    public_keys: [],
  });
}

// --- shares (owner side) -------------------------------------------------

function shareToWire(share: FakeShareRecord): Record<string, unknown> {
  return {
    id: share.id,
    name: share.name,
    description: share.description,
    scope: share.scope,
    paths: share.paths,
    username: share.username,
    created_at: share.createdAt,
    updated_at: share.updatedAt,
    last_use_at: share.lastUseAt,
    expires_at: share.expiresAt,
    password: share.password,
    max_tokens: share.maxTokens,
    used_tokens: share.usedTokens,
    allow_from: share.allowFrom,
  };
}

interface ShareWireInput {
  name: string;
  description?: string;
  scope: number;
  paths: string[];
  password?: string;
  expires_at?: number;
  max_tokens?: number;
  allow_from?: string[];
}

async function readShareInput(request: Request): Promise<ShareWireInput | null> {
  try {
    return (await request.json()) as ShareWireInput;
  } catch {
    return null;
  }
}

function handleSharesList(state: FakeState, user: FakeUserRecord): Response {
  const shares = [...state.shares.values()].filter((share) => share.username === user.username);
  return jsonResponse(200, shares.map(shareToWire));
}

async function handleSharesCreate(
  state: FakeState,
  request: Request,
  user: FakeUserRecord,
): Promise<Response> {
  const input = await readShareInput(request);
  if (!input) {
    return errorResponse(400, "invalid body");
  }
  const id = state.generateId("share");
  const now = state.now().getTime();
  const record: FakeShareRecord = {
    id,
    name: input.name,
    description: input.description ?? "",
    scope: input.scope,
    paths: input.paths,
    username: user.username,
    createdAt: now,
    updatedAt: now,
    lastUseAt: 0,
    expiresAt: input.expires_at ?? 0,
    password: input.password ?? "",
    maxTokens: input.max_tokens ?? 0,
    usedTokens: 0,
    allowFrom: input.allow_from ?? [],
  };
  state.shares.set(id, record);
  return jsonResponse(201, shareToWire(record), { "X-Object-ID": id });
}

function findOwnedShare(
  state: FakeState,
  user: FakeUserRecord,
  id: string,
): FakeShareRecord | null {
  const share = state.shares.get(id);
  return share && share.username === user.username ? share : null;
}

function handleSharesGet(state: FakeState, user: FakeUserRecord, id: string): Response {
  const share = findOwnedShare(state, user, id);
  return share ? jsonResponse(200, shareToWire(share)) : errorResponse(404, "not found");
}

async function handleSharesUpdate(
  state: FakeState,
  request: Request,
  user: FakeUserRecord,
  id: string,
): Promise<Response> {
  const share = findOwnedShare(state, user, id);
  if (!share) {
    return errorResponse(404, "not found");
  }
  const input = await readShareInput(request);
  if (!input) {
    return errorResponse(400, "invalid body");
  }
  share.name = input.name;
  share.description = input.description ?? "";
  share.scope = input.scope;
  share.paths = input.paths;
  share.expiresAt = input.expires_at ?? 0;
  share.maxTokens = input.max_tokens ?? 0;
  share.allowFrom = input.allow_from ?? [];
  if (input.password !== undefined && input.password !== REDACTED_PASSWORD_MARKER) {
    share.password = input.password;
  }
  share.updatedAt = state.now().getTime();
  return emptyResponse(200);
}

function handleSharesRemove(state: FakeState, user: FakeUserRecord, id: string): Response {
  const share = findOwnedShare(state, user, id);
  if (!share) {
    return errorResponse(404, "not found");
  }
  state.shares.delete(id);
  return emptyResponse(200);
}

// --- shares (public side) -------------------------------------------------

function isShareExpired(share: FakeShareRecord, nowMs: number): boolean {
  return share.expiresAt !== 0 && share.expiresAt <= nowMs;
}

function isShareLimitReached(share: FakeShareRecord): boolean {
  return share.maxTokens > 0 && share.usedTokens >= share.maxTokens;
}

function touchShare(state: FakeState, share: FakeShareRecord): void {
  share.usedTokens += 1;
  share.lastUseAt = state.now().getTime();
}

function checkSharePassword(request: Request, share: FakeShareRecord): Response | null {
  if (share.password === "") {
    return null;
  }
  const auth = parseBasicAuth(request.headers.get("authorization"));
  if (!auth || auth.password !== share.password) {
    return errorResponse(401, "invalid credentials");
  }
  return null;
}

function loadActiveShare(
  state: FakeState,
  request: Request,
  id: string,
): FakeShareRecord | Response {
  const share = state.shares.get(id);
  if (!share) {
    return errorResponse(404, "not found");
  }
  if (isShareExpired(share, state.now().getTime()) || isShareLimitReached(share))
    return errorResponse(400, "share unavailable");
  if (
    (request.method === "GET" && share.scope === WRITE_SCOPE) ||
    (request.method === "POST" && share.scope !== WRITE_SCOPE)
  )
    return permissionDenied();
  const passwordError = checkSharePassword(request, share);
  if (passwordError) {
    return passwordError;
  }
  return share;
}

function resolveShareRoot(
  state: FakeState,
  share: FakeShareRecord,
): { volume: Volume; innerPath: string } | null {
  const sharePath = share.paths[0];
  if (share.paths.length !== 1 || sharePath === undefined) {
    return null;
  }
  return state.resolveVolume(share.username, sharePath);
}

function handlePublicList(state: FakeState, request: Request, id: string, url: URL): Response {
  const shareOrError = loadActiveShare(state, request, id);
  if (shareOrError instanceof Response) {
    return shareOrError;
  }
  const share = shareOrError;
  const root = resolveShareRoot(state, share);
  if (!root?.volume.isDir(root.innerPath)) {
    return errorResponse(400, "listing requires a single directory share");
  }
  const subPath = url.searchParams.get("path") ?? "/";
  if (!isValidPath(subPath)) {
    return errorResponse(400, "invalid path");
  }
  const targetInner =
    subPath === "/"
      ? root.innerPath
      : root.innerPath === "/"
        ? subPath
        : `${root.innerPath}${subPath}`;
  const children = root.volume.listChildren(targetInner);
  if (children === null) {
    return errorResponse(404, "not found");
  }
  return jsonResponse(
    200,
    children.map((entry) => statusEntry(entry.name, entry.node)),
  );
}

function handlePublicDownload(state: FakeState, request: Request, id: string, url: URL): Response {
  const shareOrError = loadActiveShare(state, request, id);
  if (shareOrError instanceof Response) {
    return shareOrError;
  }
  const share = shareOrError;
  const path = url.searchParams.get("path");
  if (path === null || !isValidPath(path)) {
    return errorResponse(400, "invalid path");
  }
  const root = resolveShareRoot(state, share);
  if (!root?.volume.isDir(root.innerPath))
    return errorResponse(400, "download requires a single directory share");
  const suffix = path === "/" ? "" : path;
  const innerPath = root.innerPath === "/" ? suffix || "/" : `${root.innerPath}${suffix}`;
  const node = root.volume.get(innerPath);
  if (!node) {
    return errorResponse(404, "not found");
  }
  if (node.kind !== "file") {
    return errorResponse(400, "is a directory");
  }
  touchShare(state, share);
  return respondWithFile(node, request.headers.get("range"));
}

function handlePublicSingleFile(state: FakeState, request: Request, id: string): Response {
  const share = loadActiveShare(state, request, id);
  if (share instanceof Response) return share;
  const root = resolveShareRoot(state, share);
  const node = root?.volume.get(root.innerPath);
  if (node?.kind !== "file") return handlePublicZip(state, request, id);
  touchShare(state, share);
  return respondWithFile(node, request.headers.get("range"));
}

function handlePublicZip(state: FakeState, request: Request, id: string): Response {
  const shareOrError = loadActiveShare(state, request, id);
  if (shareOrError instanceof Response) {
    return shareOrError;
  }
  const share = shareOrError;
  const entries: ZipEntryInput[] = [];
  const root = resolveShareRoot(state, share);
  if (root?.volume.isDir(root.innerPath)) {
    // A single-directory share is flattened relative to that directory (no
    // directory-name prefix on its entries), plus a "/" entry for the
    // directory itself, matching the real drakkan/sftpgo:v2.7.5 container.
    entries.push({ name: "/", content: new Uint8Array() });
    collectZipEntries(root.volume, root.innerPath, "", entries);
  } else {
    for (const path of share.paths) {
      const { volume, innerPath } = state.resolveVolume(share.username, path);
      collectZipEntries(volume, innerPath, stripLeadingSlash(path), entries);
    }
  }
  touchShare(state, share);
  return new Response(buildZip(entries), {
    status: 200,
    headers: { "Content-Type": "application/zip" },
  });
}

async function handlePublicUpload(
  state: FakeState,
  request: Request,
  id: string,
  fileName: string,
): Promise<Response> {
  const shareOrError = loadActiveShare(state, request, id);
  if (shareOrError instanceof Response) {
    return shareOrError;
  }
  const share = shareOrError;
  const root = resolveShareRoot(state, share);
  if (!root?.volume.isDir(root.innerPath)) {
    return errorResponse(400, "upload requires a single directory share");
  }
  if (fileName.length === 0 || fileName.includes("/") || fileName.includes("\0")) {
    return errorResponse(400, "invalid file name");
  }
  const targetPath = root.innerPath === "/" ? `/${fileName}` : `${root.innerPath}/${fileName}`;
  const body = new Uint8Array(await request.arrayBuffer());
  const mtimeMs = readMtimeHeader(request, state);
  // root.innerPath was just confirmed to be an existing directory, and it is the parent of
  // targetPath, so writeFile() cannot report "not_found" here.
  const result = root.volume.writeFile(targetPath, body, mtimeMs, false);
  if (result === "bad_request") {
    return errorResponse(400, "target is a directory");
  }
  touchShare(state, share);
  return emptyResponse(200);
}

// --- routing -------------------------------------------------------------

const SHARE_PATH_PREFIX = "/api/v2/shares/";

async function routePublicShare(
  state: FakeState,
  request: Request,
  url: URL,
  method: string,
): Promise<Response | null> {
  if (!url.pathname.startsWith(SHARE_PATH_PREFIX)) {
    return null;
  }
  const rest = url.pathname.slice(SHARE_PATH_PREFIX.length);
  const slashIndex = rest.indexOf("/");

  if (slashIndex === -1) {
    const id = decodeURIComponent(rest);
    if (method === "GET" && url.searchParams.get("compress") === "false")
      return handlePublicSingleFile(state, request, id);
    if (method === "GET" && url.searchParams.get("compress") === "true") {
      return handlePublicZip(state, request, id);
    }
    return errorResponse(404, "not found");
  }

  const id = decodeURIComponent(rest.slice(0, slashIndex));
  const sub = rest.slice(slashIndex + 1);
  if (sub === "dirs" && method === "GET") {
    return handlePublicList(state, request, id, url);
  }
  if (sub === "files" && method === "GET") {
    return handlePublicDownload(state, request, id, url);
  }
  if (method === "POST") {
    return handlePublicUpload(state, request, id, decodeURIComponent(decodeURIComponent(sub)));
  }
  return errorResponse(404, "not found");
}

const USER_SHARES_PREFIX = "/api/v2/user/shares";

async function routeUserShares(
  state: FakeState,
  request: Request,
  user: FakeUserRecord,
  url: URL,
  method: string,
): Promise<Response | null> {
  if (url.pathname === USER_SHARES_PREFIX) {
    if (method === "GET") {
      return handleSharesList(state, user);
    }
    if (method === "POST") {
      return handleSharesCreate(state, request, user);
    }
    return null;
  }
  if (url.pathname.startsWith(`${USER_SHARES_PREFIX}/`)) {
    const id = decodeURIComponent(url.pathname.slice(`${USER_SHARES_PREFIX}/`.length));
    if (method === "GET") {
      return handleSharesGet(state, user, id);
    }
    if (method === "PUT") {
      return handleSharesUpdate(state, request, user, id);
    }
    if (method === "DELETE") {
      return handleSharesRemove(state, user, id);
    }
  }
  return null;
}

async function routeAuthenticated(
  state: FakeState,
  request: Request,
  url: URL,
  method: string,
): Promise<Response> {
  const userOrResponse = requireBearerUser(state, request);
  if (userOrResponse instanceof Response) {
    return userOrResponse;
  }
  const user = userOrResponse;
  const path = url.pathname;

  if (path === "/api/v2/user/dirs") {
    if (method === "GET") return handleList(state, user, url);
    if (method === "POST") return handleMkdir(state, user, url);
    if (method === "DELETE") return handleDeleteDir(state, user, url);
  }
  if (path === "/api/v2/user/files") {
    if (method === "HEAD") return handleStat(state, user, url);
    if (method === "GET") return handleDownload(state, request, user, url);
    if (method === "DELETE") return handleDeleteFile(state, user, url);
  }
  if (path === "/api/v2/user/files/upload" && method === "POST") {
    return handleUpload(state, request, user, url);
  }
  if (path === "/api/v2/user/files/metadata" && method === "PATCH") {
    return handleSetModifiedAt(state, request, user, url);
  }
  if (path === "/api/v2/user/file-actions/move" && method === "POST") {
    return handleMove(state, user, url);
  }
  if (path === "/api/v2/user/file-actions/copy" && method === "POST") {
    return handleCopy(state, user, url);
  }
  if (path === "/api/v2/user/streamzip" && method === "POST") {
    return handleZip(state, request, user);
  }
  if (path === "/api/v2/user/profile" && method === "GET") {
    return handleProfile(user);
  }

  const sharesResponse = await routeUserShares(state, request, user, url, method);
  if (sharesResponse) {
    return sharesResponse;
  }

  return errorResponse(404, "not found");
}

async function handleRequest(state: FakeState, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();

  if (url.pathname === "/api/v2/user/token" && method === "GET") {
    return handleLogin(state, request);
  }
  if (url.pathname === "/api/v2/user/logout" && method === "GET") {
    return handleLogout(state, request);
  }

  const publicShareResponse = await routePublicShare(state, request, url, method);
  if (publicShareResponse) {
    return publicShareResponse;
  }

  if (url.pathname.startsWith("/api/v2/user/")) {
    return routeAuthenticated(state, request, url, method);
  }

  return errorResponse(404, "not found");
}

/** Creates an in-memory server that emulates enough of SFTPGo's user-facing REST API to test against. */
export function createFakeSftpgoServer(seed: FakeSeed): FakeSftpgoServer {
  const state = new FakeState(seed);
  const fetchImpl = (async (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ): Promise<Response> => {
    if (init?.signal?.aborted) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }
    const request = new Request(input, init);
    return handleRequest(state, request);
  }) as typeof globalThis.fetch;
  return { fetch: fetchImpl, state };
}
