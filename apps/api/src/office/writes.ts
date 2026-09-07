import { baseName, extensionOf, joinPath, parentPath } from "@fdrive/core";
import { requireOfficeEdit } from "./auth.ts";
import { requireMatchingLock, WopiError } from "./errors.ts";
import { decodeUtf7, lockHeader, requireFilename, suggestedFilename } from "./names.ts";
import {
  fileExists,
  mintedFields,
  mutationKey,
  officeLocation,
  publishOfficeChange,
} from "./service.ts";
import { contentVersion, withStagedUpload } from "./streams.ts";
import type { OfficeConfig, OfficeDeps, OpenedFile } from "./types.ts";
import { editorHostUrl } from "./urls.ts";
import { currentWriteFile } from "./write-file.ts";

async function uploadRequest(
  deps: OfficeDeps,
  opened: OpenedFile,
  path: string,
  request: Request,
  config: OfficeConfig,
  signal: AbortSignal,
): Promise<void> {
  const length = request.headers.get("Content-Length");
  if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length))))
    throw new WopiError(400);
  if (length !== null && Number(length) > config.maxBytes) throw new WopiError(413);
  const source =
    request.body ??
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
  await withStagedUpload(source, config.maxBytes, signal, async (body, size) => {
    if (length !== null && Number(length) !== size) throw new WopiError(400);
    await requireOfficeEdit(deps, opened.actor, opened.path);
    if (path !== opened.path) await requireOfficeEdit(deps, opened.actor, path);
    await opened.actor.storage.upload(path, body, { signal, contentLength: size });
  });
}
async function putFile(
  deps: OfficeDeps,
  config: OfficeConfig,
  initial: OpenedFile,
  request: Request,
  signal: AbortSignal,
): Promise<Response> {
  const provided = lockHeader(request.headers.get("X-WOPI-Lock"));
  const result = await deps.withWriteScope(initial.actor.identity.providerId, async (scope) => {
    const opened = await currentWriteFile(deps, scope.files, initial);
    return scope.locks.withFileLock(opened.file.id, async (locked) => {
      const current = await locked.get(deps.clock());
      const stat = await opened.actor.storage.statFile(opened.path);
      requireMatchingLock(current, provided, stat.size === 0);
      await uploadRequest(deps, opened, opened.path, request, config, signal);
      const content = await contentVersion(
        opened.actor.storage,
        opened.path,
        config.maxBytes,
        signal,
      );
      return {
        path: opened.path,
        response: new Response(null, {
          status: 200,
          headers: { "X-WOPI-ItemVersion": content.version },
        }),
      };
    });
  });
  publishOfficeChange(deps, initial.actor, result.path, "update");
  return result.response;
}
async function renameFile(
  deps: OfficeDeps,
  initial: OpenedFile,
  request: Request,
): Promise<Response> {
  const raw = request.headers.get("X-WOPI-RequestedName");
  if (raw === null) throw new WopiError(400);
  let name: string;
  try {
    name = requireFilename(decodeUtf7(raw));
  } catch {
    throw new WopiError(400, { "X-WOPI-InvalidFileNameError": "Invalid filename" });
  }
  const provided = lockHeader(request.headers.get("X-WOPI-Lock"));
  const result = await deps.withWriteScope(initial.actor.identity.providerId, async (scope) => {
    const opened = await currentWriteFile(deps, scope.files, initial);
    const sourceName = baseName(opened.path);
    const suffix = extensionOf(sourceName);
    const ext = suffix ? sourceName.slice(-suffix.length) : "";
    const full = requireFilename(`${name}${ext}`);
    const target = joinPath(parentPath(opened.path), full);
    const location = officeLocation(opened.actor, target);
    const response = await scope.locks.withFileLock(mutationKey(location), () =>
      scope.locks.withFileLock(opened.file.id, async (locked) => {
        requireMatchingLock(await locked.get(deps.clock()), provided);
        await requireOfficeEdit(deps, opened.actor, opened.path);
        await requireOfficeEdit(deps, opened.actor, target);
        if (target === opened.path) return Response.json({ Name: name });
        if (await fileExists(opened.actor, target))
          throw new WopiError(400, { "X-WOPI-InvalidFileNameError": "Name already exists" });
        await opened.actor.storage.move(opened.path, target);
        await scope.files.movePrefix({
          providerId: opened.file.providerId,
          rootName: opened.file.rootName,
          from: opened.file.path,
          to: location.path,
          at: deps.clock(),
        });
        return Response.json({ Name: name });
      }),
    );
    return { source: opened.path, target, response };
  });
  if (result.target !== result.source) {
    await deps.metadata.onMoved(initial.actor.identity.id, result.source, result.target, false);
    publishOfficeChange(deps, initial.actor, result.source, "move", result.target);
  }
  return result.response;
}
async function putRelative(
  deps: OfficeDeps,
  config: OfficeConfig,
  initial: OpenedFile,
  request: Request,
  signal: AbortSignal,
): Promise<Response> {
  const suggested = request.headers.get("X-WOPI-SuggestedTarget");
  const relative = request.headers.get("X-WOPI-RelativeTarget");
  if ((suggested === null) === (relative === null)) throw new WopiError(400);
  const raw = relative ?? suggested;
  if (raw === null) throw new WopiError(400);
  const decoded = decodeUtf7(raw);
  const overwriteHeader = request.headers.get("X-WOPI-OverwriteRelativeTarget");
  if (overwriteHeader !== null && overwriteHeader !== "true" && overwriteHeader !== "false")
    throw new WopiError(400);
  const overwrite = relative !== null && overwriteHeader === "true";
  const provided = lockHeader(request.headers.get("X-WOPI-Lock"));
  const result = await deps.withWriteScope(initial.actor.identity.providerId, async (scope) => {
    const opened = await currentWriteFile(deps, scope.files, initial);
    // PutRelative does not mutate the source. WOPI clients omit its lock header.
    if (provided !== undefined)
      await scope.locks.withFileLock(opened.file.id, async (locked) =>
        requireMatchingLock(await locked.get(deps.clock()), provided),
      );
    for (let attempt = 0; attempt < 1000; attempt++) {
      const name =
        relative === null
          ? suggestedFilename(opened.path, decoded, attempt)
          : requireFilename(decoded);
      const path = joinPath(parentPath(opened.path), name);
      const location = officeLocation(opened.actor, path);
      const result = await scope.locks.withFileLock(mutationKey(location), async () => {
        await requireOfficeEdit(deps, opened.actor, path);
        const exists = await fileExists(opened.actor, path);
        if (exists && !overwrite) {
          if (relative === null) return null;
          throw new WopiError(409, { "X-WOPI-Lock": "" });
        }
        const file = await scope.files.ensure(location);
        return scope.locks.withFileLock(file.id, async (locked) => {
          const current = await locked.get(deps.clock());
          if (current !== null) throw new WopiError(409, { "X-WOPI-Lock": current });
          // Recheck at the last possible moment. SFTPGo provides no atomic no-overwrite upload.
          if (!overwrite && (await fileExists(opened.actor, path))) {
            if (relative === null) return null;
            throw new WopiError(409, { "X-WOPI-Lock": "" });
          }
          await uploadRequest(deps, opened, path, request, config, signal);
          await contentVersion(opened.actor.storage, path, config.maxBytes, signal);
          const fields = mintedFields(deps, config, opened.actor, file, "edit");
          return {
            path,
            exists,
            response: Response.json({
              Name: baseName(path),
              Url: `${config.wopiUrl}/files/${file.id}?access_token=${encodeURIComponent(fields.formFields.access_token)}`,
              HostViewUrl: editorHostUrl(config, opened.actor.identity.id, path, "view"),
              HostEditUrl: editorHostUrl(config, opened.actor.identity.id, path, "edit"),
            }),
          };
        });
      });
      if (result !== null) return result;
    }
    throw new WopiError(500);
  });
  publishOfficeChange(deps, initial.actor, result.path, result.exists ? "update" : "create");
  return result.response;
}
export async function dispatchOfficeWrite(
  deps: OfficeDeps,
  config: OfficeConfig,
  opened: OpenedFile,
  request: Request,
  contents: boolean,
  signal: AbortSignal,
): Promise<Response> {
  const override = request.headers.get("X-WOPI-Override");
  if (override === null) throw new WopiError(400);
  if (contents) {
    if (override !== "PUT") throw new WopiError(501);
    if (opened.mode === "view") throw new WopiError(403);
    return putFile(deps, config, opened, request, signal);
  }
  if (override === "GET_LOCK")
    return new Response(null, {
      status: 200,
      headers: { "X-WOPI-Lock": (await deps.locks.get(opened.file.id, deps.clock())) ?? "" },
    });
  if (
    override === "LOCK" ||
    override === "REFRESH_LOCK" ||
    override === "UNLOCK" ||
    override === "UNLOCK_AND_RELOCK"
  ) {
    const lockId = lockHeader(request.headers.get("X-WOPI-Lock"), true);
    if (lockId === undefined) throw new WopiError(400);
    const oldLockId = lockHeader(
      request.headers.get("X-WOPI-OldLock"),
      override === "UNLOCK_AND_RELOCK",
    );
    if (opened.mode === "view") {
      if (override === "LOCK") return new Response(null, { status: 200 });
      throw new WopiError(403);
    }
    const operation =
      override === "REFRESH_LOCK"
        ? "refresh"
        : override === "UNLOCK"
          ? "unlock"
          : override === "UNLOCK_AND_RELOCK" || oldLockId !== undefined
            ? "relock"
            : "lock";
    const result = await deps.locks.apply({
      fileId: opened.file.id,
      operation,
      lockId,
      now: deps.clock(),
      ...(oldLockId === undefined ? {} : { oldLockId }),
    });
    if (!result.ok) throw new WopiError(409, { "X-WOPI-Lock": result.currentLock });
    return new Response(null, { status: 200 });
  }
  if (override !== "RENAME_FILE" && override !== "PUT_RELATIVE") throw new WopiError(501);
  if (opened.mode === "view") throw new WopiError(403);
  return override === "RENAME_FILE"
    ? renameFile(deps, opened, request)
    : putRelative(deps, config, opened, request, signal);
}
