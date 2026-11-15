import type { DesktopRepo } from "@fdrive/db";
import type { MetadataService } from "../metadata/service.js";

/**
 * All participating web/MCP/Office path changes update the desktop handle
 * registry. Into Trash and back out are moves like any other, so an item
 * keeps its handle there: the Mac finds it in its Trash under the same one.
 * A delete for good retires it.
 */
export function withDesktopMetadata(
  metadata: MetadataService,
  desktop: Pick<DesktopRepo, "move" | "remove">,
): MetadataService {
  return {
    ...metadata,
    async onMoved(identityId, from, to, directory) {
      await desktop.move(identityId, from, to);
      await metadata.onMoved(identityId, from, to, directory);
    },
    async onDeleted(identityId, path, directory) {
      await desktop.remove(identityId, path);
      await metadata.onDeleted(identityId, path, directory);
    },
  };
}
