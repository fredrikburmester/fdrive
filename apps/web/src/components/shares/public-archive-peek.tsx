"use client";

import {
  ArchiveEntriesSkeleton,
  ArchiveEntriesView,
} from "@/components/preview/archive-entries-view";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import { useShareArchiveEntries } from "@/lib/shares/public-queries";

/**
 * Peeks a shared archive's entries without extracting it, reusing the same presentational
 * table (`ArchiveEntriesView`) the logged-in preview shows. Entries never link anywhere and
 * there are no Extract/Download actions on individual members: a shared archive's members are
 * not individually downloadable, only the archive itself (through the share's own download or
 * ZIP action, rendered elsewhere).
 */
export function PublicArchivePeek({
  id,
  path,
  name,
  size,
  generation,
  onClose,
}: {
  id: string;
  path: string;
  name: string;
  size: number | undefined;
  generation: number;
  onClose: () => void;
}) {
  const query = useShareArchiveEntries(id, path, generation);
  return (
    <section
      aria-label={`Archive entries for ${name}`}
      className="overflow-hidden rounded-xl border bg-background"
    >
      <div className="flex items-center justify-between gap-3 border-b px-4 py-2">
        <span className="truncate text-sm font-medium">{name}</span>
        <Button size="sm" variant="ghost" onClick={onClose}>
          Close preview
        </Button>
      </div>
      <div className="h-[min(65vh,44rem)]">
        {query.status === "pending" ? (
          <ArchiveEntriesSkeleton />
        ) : query.status === "error" ? (
          <div className="p-5">
            <FieldError>{query.error.message}</FieldError>
          </div>
        ) : (
          <ArchiveEntriesView name={name} size={size} data={query.data} />
        )}
      </div>
    </section>
  );
}
