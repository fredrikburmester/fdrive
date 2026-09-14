import type { DesktopRepo } from "@fdrive/db";
import type { MetadataService } from "../metadata/service.js";

/** All participating web/MCP/Office path changes update the desktop handle registry. */
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
    async onTrashed(identityId, path, directory) {
      await desktop.remove(identityId, path);
      await metadata.onTrashed(identityId, path, directory);
    },
  };
}
