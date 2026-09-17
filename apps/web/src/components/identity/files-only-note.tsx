import type { ProviderCapabilities } from "@fdrive/contracts";
import { FieldDescription } from "@/components/ui/field";
import { FILES_ONLY_NOTE, isFilesOnly } from "@/lib/identity/capabilities";

/**
 * One line under a storage choice that cannot search, share or open Office
 * files, so nobody learns it from a missing button. Renders nothing for
 * full storage or while the choice is still unknown.
 */
export function FilesOnlyNote({
  capabilities,
}: {
  readonly capabilities: ProviderCapabilities | undefined;
}) {
  if (capabilities === undefined || !isFilesOnly(capabilities)) return null;
  return <FieldDescription>{FILES_ONLY_NOTE}</FieldDescription>;
}
