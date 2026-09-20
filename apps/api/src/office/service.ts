import type {
  OfficeCreateDocumentRequest,
  OfficeCreateDocumentResponse,
  OfficeOpenRequest,
  OfficeOpenResponse,
  OfficeStatusResponse,
} from "@fdrive/contracts";
import {
  baseName,
  extensionOf,
  isStorageError,
  joinPath,
  parentPath,
  toFsPath,
} from "@fdrive/core";
import { recordOfficeAction, recordOfficeOpen } from "../activity/office.js";
import { browserActor, callbackFile, requireOfficeEdit } from "./auth.ts";
import { officeErrorResponse, WopiError } from "./errors.ts";
import { selectDiscoveryAction } from "./protocol/discovery.ts";
import { verifyProof } from "./protocol/proof.ts";
import { boundedStream, contentVersion } from "./streams.ts";
import { blankDocument } from "./templates.ts";
import type {
  BrowserOfficeInput,
  OfficeActor,
  OfficeConfig,
  OfficeDeps,
  OfficeFile,
  OpenedFile,
} from "./types.ts";
import { callbackProofUrl, editorHostUrl, officeActionUrl } from "./urls.ts";
import { dispatchOfficeWrite } from "./writes.ts";

export function officeLocation(
  actor: OfficeActor,
  path: string,
): { providerId: string; rootName: string; path: string } {
  const mapped = toFsPath(actor.scopes, path);
  if (mapped === null) throw new WopiError(404);
  return {
    providerId: actor.identity.providerId,
    rootName: mapped.rootName,
    path: mapped.fsPath.slice(1),
  };
}
export function mutationKey(location: {
  providerId: string;
  rootName: string;
  path: string;
}): string {
  return `office-target:${JSON.stringify([location.providerId, location.rootName, location.path])}`;
}
export async function fileExists(actor: OfficeActor, path: string): Promise<boolean> {
  try {
    await actor.storage.statFile(path);
    return true;
  } catch (error) {
    if (isStorageError(error) && error.kind === "not_found") return false;
    if (isStorageError(error) && error.kind === "bad_request") return true;
    throw error;
  }
}
export function publishOfficeChange(
  deps: OfficeDeps,
  actor: OfficeActor,
  path: string,
  op: "create" | "update" | "move",
  target?: string,
): void {
  deps.bus.publish({
    type: "fs",
    op,
    identityId: actor.identity.id,
    paths: [path],
    at: deps.clock().toISOString(),
    ...(target === undefined ? {} : { targetPaths: [target] }),
  });
}
export function officeSignal(config: OfficeConfig, request?: Request): AbortSignal {
  const deadline = AbortSignal.timeout(config.timeoutMs ?? 120000);
  return request === undefined ? deadline : AbortSignal.any([deadline, request.signal]);
}
export function mintedFields(
  deps: OfficeDeps,
  config: OfficeConfig,
  actor: OfficeActor,
  file: OfficeFile,
  mode: "view" | "edit",
) {
  const minted = deps.tokens.mint({
    fileId: file.id,
    identityId: actor.identity.id,
    sessionHash: actor.session.idHash,
    mode,
    now: deps.clock(),
    sessionExpiresAt: actor.session.expiresAt,
  });
  return {
    expiresAt: minted.expiresAt.toISOString(),
    formFields: {
      access_token: minted.token,
      access_token_ttl: String(minted.expiresAt.getTime()),
      ...(config.product === "onlyoffice"
        ? {
            docs_api_config: JSON.stringify({
              editorConfig: {
                customization: { forcesave: true, compactHeader: true, chat: false },
              },
            }),
          }
        : {}),
    },
  };
}
async function checkFileInfo(
  _deps: OfficeDeps,
  config: OfficeConfig,
  opened: OpenedFile,
  signal: AbortSignal,
): Promise<Response> {
  const { actor, file, path, mode } = opened;
  const content = await contentVersion(actor.storage, path, config.maxBytes, signal);
  const edit = mode === "edit";
  const folder = actor.session.activeIdentityId === actor.identity.id ? parentPath(path) : "/";
  const close = `${config.appUrl.replace(/\/$/, "")}/files${folder === "/" ? "" : folder.split("/").map(encodeURIComponent).join("/")}`;
  return Response.json({
    BaseFileName: baseName(path),
    OwnerId: file.providerId,
    UserId: actor.identity.id,
    UserFriendlyName: actor.identity.externalUsername,
    Size: content.size,
    Version: content.version,
    // ONLYOFFICE prefers this optional timestamp over Version for its view cache key.
    // Omit it there so same-mtime external writes invalidate through the content hash.
    ...(config.product === "collabora" && content.modifiedAt !== null
      ? { LastModifiedTime: content.modifiedAt.toISOString() }
      : {}),
    UserCanWrite: edit,
    UserCanRename: edit,
    ReadOnly: !edit,
    UserCanNotWriteRelative: !edit,
    SupportsLocks: true,
    SupportsGetLock: true,
    SupportsUpdate: true,
    SupportsRename: true,
    SupportsDeleteFile: false,
    BreadcrumbBrandName: "fdrive",
    BreadcrumbBrandUrl: config.appUrl,
    BreadcrumbFolderName: baseName(parentPath(path)),
    BreadcrumbFolderUrl: close,
    BreadcrumbDocName: baseName(path),
    CloseUrl: close,
    HostViewUrl: editorHostUrl(config, actor.identity.id, path, "view"),
    ...(opened.editAllowed
      ? { HostEditUrl: editorHostUrl(config, actor.identity.id, path, "edit") }
      : {}),
    PostMessageOrigin: new URL(config.appUrl).origin,
    FileNameMaxLength: 255,
  });
}
async function getContents(
  config: OfficeConfig,
  opened: OpenedFile,
  request: Request,
  signal: AbortSignal,
): Promise<Response> {
  const raw = request.headers.get("X-WOPI-MaxExpectedSize");
  let max = config.maxBytes;
  if (raw !== null) {
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new WopiError(400);
    if (opened.stat.size > Number(raw)) throw new WopiError(412);
    max = Math.min(max, Number(raw));
  }
  if (opened.stat.size > config.maxBytes) throw new WopiError(413);
  const result = await opened.actor.storage.download(opened.path, { signal });
  if (result.contentLength !== null && result.contentLength > max) {
    await result.body.cancel();
    throw new WopiError(raw === null ? 413 : 412);
  }
  const headers = new Headers({
    "Content-Type": result.contentType ?? "application/octet-stream",
    "Cache-Control": "no-store",
  });
  if (result.contentLength !== null) headers.set("Content-Length", String(result.contentLength));
  if (result.lastModified !== null) headers.set("Last-Modified", result.lastModified.toUTCString());
  return new Response(boundedStream(result.body, max, signal), { headers });
}
export function createOfficeService(deps: OfficeDeps) {
  async function configured(): Promise<{
    config: OfficeConfig;
    discovery: NonNullable<OfficeDeps["discovery"]>;
  }> {
    if (deps.resolveRuntime !== undefined) {
      const runtime = await deps.resolveRuntime();
      if (runtime === null) throw new WopiError(503);
      return runtime;
    }
    if (deps.config === null || deps.discovery === null) throw new WopiError(503);
    return { config: deps.config, discovery: deps.discovery };
  }
  return {
    async status(): Promise<OfficeStatusResponse> {
      const unavailable: OfficeStatusResponse = {
        available: false,
        product: deps.config?.product ?? null,
        extensions: { view: [], edit: [], convert: [] },
      };
      try {
        const { config, discovery } = await configured();
        const doc = await discovery.get();
        const extensions = { view: [] as string[], edit: [] as string[], convert: [] as string[] };
        for (const action of doc.actions) {
          if (
            action.extension &&
            (action.name === "view" || action.name === "edit" || action.name === "convert")
          ) {
            officeActionUrl(action.url, config, "probe");
            if (!extensions[action.name].includes(action.extension))
              extensions[action.name].push(action.extension);
          }
        }
        for (const list of Object.values(extensions)) list.sort();
        return { available: true, product: config.product, extensions };
      } catch {
        return unavailable;
      }
    },
    async open(input: BrowserOfficeInput, request: OfficeOpenRequest): Promise<OfficeOpenResponse> {
      const { config, discovery } = await configured();
      const actor = await browserActor(deps, input);
      if (request.mode !== "view") await requireOfficeEdit(deps, actor, request.path);
      const doc = await discovery.get();
      const action = selectDiscoveryAction(doc, extensionOf(baseName(request.path)), request.mode);
      if (action === undefined) throw new WopiError(400);
      await contentVersion(actor.storage, request.path, config.maxBytes, officeSignal(config));
      const file = await deps.files.ensure(officeLocation(actor, request.path));
      const actionUrl = officeActionUrl(action.url, config, file.id, request.ui);
      const fields = mintedFields(
        deps,
        config,
        actor,
        file,
        request.mode === "view" ? "view" : "edit",
      );
      await recordOfficeOpen(deps, actor, request.path, file.id, () =>
        deps.metadata.touchRecent(actor.identity.id, request.path),
      );
      return {
        fileId: file.id,
        identityId: actor.identity.id,
        path: request.path,
        mode: request.mode,
        actionUrl,
        editorOrigin: new URL(config.publicUrl).origin,
        ...fields,
      };
    },
    async create(
      input: BrowserOfficeInput,
      request: OfficeCreateDocumentRequest,
    ): Promise<OfficeCreateDocumentResponse> {
      const { config } = await configured();
      const actor = await browserActor(deps, input);
      const path = joinPath(request.parent, request.name);
      const location = officeLocation(actor, path);
      await requireOfficeEdit(deps, actor, path);
      const bytes = await blankDocument(extensionOf(request.name).slice(1));
      await deps.withWriteScope(actor.identity.providerId, (scope) =>
        scope.locks.withFileLock(mutationKey(location), async () => {
          await requireOfficeEdit(deps, actor, path);
          if (await fileExists(actor, path)) throw new WopiError(409, { "X-WOPI-Lock": "" });
          // SFTPGo HTTP uploads have no conditional-create primitive. This serializes
          // fdrive writers and rejects observed collisions; external SFTP writers can race.
          await requireOfficeEdit(deps, actor, path);
          if (await fileExists(actor, path)) throw new WopiError(409, { "X-WOPI-Lock": "" });
          const file = await scope.files.ensure(location);
          await recordOfficeAction(
            deps,
            actor,
            "file.create",
            path,
            path,
            file.id,
            () =>
              actor.storage.upload(path, bytes, {
                contentLength: bytes.byteLength,
                signal: officeSignal(config),
              }),
            { size: bytes.byteLength },
          );
        }),
      );
      publishOfficeChange(deps, actor, path, "create");
      return { identityId: actor.identity.id, path };
    },
    async callback(request: Request, fileId: string, contents: boolean): Promise<Response> {
      try {
        const { config, discovery } = await configured();
        const query = new URL(request.url).searchParams;
        const allTokens = query.getAll("access_token");
        if (allTokens.length !== 1) throw new WopiError(401);
        const token = allTokens[0];
        if (token === undefined) throw new WopiError(401);
        const claims = deps.tokens.verify(token, deps.clock());
        if (claims === null) throw new WopiError(401);
        const proofInput = {
          accessToken: token,
          url: callbackProofUrl(request.url, config),
          timestamp: request.headers.get("X-WOPI-TimeStamp") ?? "",
          ...(request.headers.has("X-WOPI-Proof")
            ? { proof: request.headers.get("X-WOPI-Proof") ?? "" }
            : {}),
          ...(request.headers.has("X-WOPI-ProofOld")
            ? { oldProof: request.headers.get("X-WOPI-ProofOld") ?? "" }
            : {}),
          nowMs: deps.clock().getTime(),
        };
        let proof = verifyProof({ ...proofInput, keys: (await discovery.get()).proofKeys });
        if (proof.refreshRecommended) {
          const refreshed = await discovery.refresh();
          proof = verifyProof({ ...proofInput, keys: refreshed.proofKeys });
        }
        if (!proof.valid) throw new WopiError(500);
        const opened = await callbackFile(deps, fileId, claims);
        const signal = officeSignal(config, request);
        if (request.method === "GET")
          return await (contents
            ? getContents(config, opened, request, signal)
            : checkFileInfo(deps, config, opened, signal));
        if (request.method !== "POST") throw new WopiError(501);
        return await dispatchOfficeWrite(deps, config, opened, request, contents, signal);
      } catch (error) {
        return officeErrorResponse(error);
      }
    },
  };
}
export type OfficeService = ReturnType<typeof createOfficeService>;
