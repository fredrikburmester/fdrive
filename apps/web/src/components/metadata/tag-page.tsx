"use client";

import { useSetFileTags, useTagFiles, useTags } from "@/lib/metadata/queries";
import { VirtualListing } from "./virtual-listing";

export interface TagPageProps {
  readonly id: string;
}

/**
 * The `/tags/[id]` page: every path currently tagged `id`, in a read-only
 * virtual listing. "Remove" on a missing path clears any (now-orphaned) tag
 * record for it, a best-effort cleanup since the file itself is gone.
 */
export function TagPage({ id }: TagPageProps) {
  const tagsQuery = useTags();
  const tag = tagsQuery.data?.find((candidate) => candidate.id === id);
  const filesQuery = useTagFiles(id);
  const setFileTags = useSetFileTags();
  const paths = filesQuery.data ?? [];

  return (
    <VirtualListing
      title={tag?.name ?? "Tag"}
      paths={paths}
      onRemoveMissing={(path) => setFileTags.mutate([{ path, tagIds: [] }])}
    />
  );
}
