"use client";

import { useMountMappings } from "@/lib/api/scope-queries";
import { SharedFoldersCard } from "./shared-folders-card";
import { SystemPage } from "./system-page";

/**
 * Admin page: `System > Shared folders`. Reviewing and removing the
 * folder-level virtual folder mappings; new ones are created from a login's
 * unmapped mount on the Account page, where the suggestions live.
 */
export function SharedFoldersPage() {
  const { dataUpdatedAt } = useMountMappings();
  return (
    <SystemPage
      title="Shared folders"
      description="Virtual folder mappings shared by every login that mounts them."
      lastUpdated={dataUpdatedAt > 0 ? new Date(dataUpdatedAt) : null}
    >
      <SharedFoldersCard />
    </SystemPage>
  );
}
