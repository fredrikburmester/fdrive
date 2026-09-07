import { toFsPath } from "@fdrive/core";
import type { Identity, IdentityRepo } from "@fdrive/db";
import type { IndexerEventPayload } from "../events/indexer-listener.js";
import type { MetadataService } from "../metadata/service.js";
import type { ConfiguredMappingsResult } from "../scoping/types.ts";
import type { OfficeFileRepo } from "./types.ts";

export async function applyOfficeStorageEvent(
  files: OfficeFileRepo,
  providerId: string,
  event: IndexerEventPayload,
): Promise<void> {
  const at = new Date(event.at);
  if (event.kind === "moved" && event.target_path !== null)
    await files.movePrefix({
      providerId,
      rootName: event.root,
      from: event.path,
      to: event.target_path,
      at,
    });
  else if (event.kind === "deleted")
    await files.deletePrefix({ providerId, rootName: event.root, path: event.path, at });
}
/**
 * Wraps `metadata` so a user-initiated move/delete (from the fs or trash
 * routes) also updates the office file registry, using the same trusted
 * `configuredMappings` an office actor's requests use (never a raw
 * home-template computation with no override support, and never a
 * database/config fetch beyond the one `configuredMappings` call itself).
 */
export function withOfficeMetadata(
  metadata: MetadataService,
  files: OfficeFileRepo,
  identities: Pick<IdentityRepo, "get">,
  configuredMappings: (identity: Identity) => Promise<ConfiguredMappingsResult>,
  clock: () => Date,
): MetadataService {
  async function location(identityId: string, path: string) {
    const identity = await identities.get(identityId);
    if (identity === null) return null;
    const configured = await configuredMappings(identity);
    if (!configured.available) return null;
    const mapped = toFsPath(configured.scopes, path);
    return mapped === null
      ? null
      : {
          providerId: configured.providerId,
          rootName: mapped.rootName,
          path: mapped.fsPath.slice(1),
        };
  }
  return {
    ...metadata,
    async onMoved(identityId, from, to, isDir) {
      const source = await location(identityId, from);
      const target = await location(identityId, to);
      if (source !== null) {
        if (
          target !== null &&
          source.providerId === target.providerId &&
          source.rootName === target.rootName
        )
          await files.movePrefix({ ...source, from: source.path, to: target.path, at: clock() });
        else await files.deletePrefix({ ...source, at: clock() });
      }
      await metadata.onMoved(identityId, from, to, isDir);
    },
    async onDeleted(identityId, path, isDir) {
      const source = await location(identityId, path);
      if (source !== null) await files.deletePrefix({ ...source, at: clock() });
      await metadata.onDeleted(identityId, path, isDir);
    },
  };
}
