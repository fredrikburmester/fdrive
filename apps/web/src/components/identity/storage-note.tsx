import type { ProviderCapabilities } from "@fdrive/contracts";
import { FieldDescription } from "@/components/ui/field";
import { storageNote } from "@/lib/identity/capabilities";

/**
 * One line under a storage choice naming the features it lacks compared to
 * SFTPGo storage, so nobody learns it from a missing button. Renders nothing
 * for storage that lacks none, or while the choice is still unknown.
 */
export function StorageNote({
  capabilities,
}: {
  readonly capabilities: ProviderCapabilities | undefined;
}) {
  if (capabilities === undefined) return null;
  const note = storageNote(capabilities);
  if (note === null) return null;
  return <FieldDescription>{note}</FieldDescription>;
}
