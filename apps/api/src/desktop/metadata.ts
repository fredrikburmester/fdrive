import { isReservedPath } from "@fdrive/core";
import type { DesktopRepo } from "@fdrive/db";
import type { MetadataService } from "../metadata/service.js";

/**
 * All participating web/MCP/Office path changes update the desktop handle
 * registry. The Mac never reaches fdrive's own folders, so an item moved into
 * one, Trash say, is gone for it, as a deleted one is: its handle retires,
 * and a restore brings the item back under a new one.
 */
export function withDesktopMetadata(
  metadata: MetadataService,
  desktop: Pick<DesktopRepo, "move" | "remove">,
): MetadataService {
  return {
    ...metadata,
    async onMoved(identityId, from, to, directory) {
      if (isReservedPath(to)) await desktop.remove(identityId, from);
      else await desktop.move(identityId, from, to);
      await metadata.onMoved(identityId, from, to, directory);
    },
    async onDeleted(identityId, path, directory) {
      await desktop.remove(identityId, path);
      await metadata.onDeleted(identityId, path, directory);
    },
  };
}
