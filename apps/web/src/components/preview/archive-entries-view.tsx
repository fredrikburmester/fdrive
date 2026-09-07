"use client";

import type { ArchiveEntriesResponse } from "@fdrive/contracts";
import { FolderIcon, SearchIcon } from "lucide-react";
import { Fragment, type ReactNode, useState } from "react";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { filterArchiveEntries, groupArchiveEntries } from "@/lib/archive/grouping";
import { formatBytes, formatDate } from "@/lib/format";

export const ARCHIVE_FORMAT_LABELS: Readonly<Record<string, string>> = {
  zip: "ZIP archive",
  tar: "TAR archive",
  "tar.gz": "gzip-compressed TAR archive",
  "tar.zst": "zstd-compressed TAR archive",
};

/** Placeholder row widths, cycled so the skeleton reads as a real table
 * instead of one uniform block. */
const SKELETON_ROW_WIDTHS = [92, 80, 88, 65, 95, 72, 84, 60];

/** Shared loading placeholder for both the logged-in and public archive views. */
export function ArchiveEntriesSkeleton() {
  return (
    <div className="flex h-full flex-col gap-4 p-4">
      <div className="flex items-center gap-3">
        <Skeleton className="size-9 shrink-0 rounded-md" />
        <div className="flex flex-1 flex-col gap-2">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-3 w-28" />
        </div>
      </div>
      <div className="flex flex-col gap-2">
        {SKELETON_ROW_WIDTHS.map((width, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a static, never-reordered list of placeholder widths
          <Skeleton key={index} className="h-8" style={{ width: `${width}%` }} />
        ))}
      </div>
    </div>
  );
}

export interface ArchiveEntriesViewProps {
  /** The archive's own display name (a file name, not a path within it). */
  readonly name: string;
  /** The archive's own byte size; omitted when unknown, such as a public single-file share
   * peek, where the share's own metadata carries no size. */
  readonly size?: number | undefined;
  readonly data: ArchiveEntriesResponse;
  /**
   * Extra controls shown beside the search box, such as Extract/Download for the logged-in
   * view. Omitted entirely for a public peek, which offers no actions on the archive's members.
   */
  readonly actions?: ReactNode;
}

/**
 * The entries table shared by the logged-in archive preview (`ArchivePreview`) and the public
 * share peek (`PublicArchivePeek`): a header with the archive's name, size, and format, a search
 * box that filters entries client-side, a note when the API truncated the list, and a table of
 * entries grouped by their containing folder within the archive. Entries never link anywhere;
 * an archive's own members are not individually downloadable from either view.
 */
export function ArchiveEntriesView({ name, size, data, actions }: ArchiveEntriesViewProps) {
  const [search, setSearch] = useState("");
  const filtered = filterArchiveEntries(data.entries, search);
  const groups = groupArchiveEntries(filtered);
  const formatLabel = ARCHIVE_FORMAT_LABELS[data.format] ?? data.format;
  const totalLabel = `${data.entries.length.toLocaleString()} ${data.entries.length === 1 ? "entry" : "entries"}`;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{name}</p>
          <p className="text-xs text-muted-foreground">
            {size !== undefined ? `${formatBytes(size)} · ` : ""}
            {formatLabel} · {totalLabel}
          </p>
        </div>

        <div className="relative w-full max-w-56 sm:w-56">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Filter entries"
            className="pl-7"
          />
        </div>

        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>

      {data.truncated && (
        <div className="shrink-0 border-b bg-muted/50 px-4 py-2 text-xs text-muted-foreground">
          Showing the first {data.entries.length.toLocaleString()} entries; this archive has more.
        </div>
      )}

      <ScrollArea className="min-h-0 flex-1">
        {groups.length === 0 ? (
          <p className="p-6 text-center text-sm text-muted-foreground">
            {search.trim().length > 0 ? "No entries match your search." : "This archive is empty."}
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead className="text-right">Size</TableHead>
                <TableHead className="text-right">Modified</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {groups.map((group) => (
                <Fragment key={group.folder.length > 0 ? group.folder : "/"}>
                  {group.folder.length > 0 && (
                    <TableRow className="bg-muted/40 hover:bg-muted/40">
                      <TableCell
                        colSpan={3}
                        className="py-1.5 text-xs font-medium text-muted-foreground"
                      >
                        <span className="inline-flex items-center gap-1.5">
                          <FolderIcon className="size-3.5" />
                          {group.folder}
                        </span>
                      </TableCell>
                    </TableRow>
                  )}
                  {group.entries.map((archiveEntry) => (
                    <TableRow key={archiveEntry.path}>
                      <TableCell className="max-w-0">
                        <span className="block truncate" title={archiveEntry.path}>
                          {archiveEntry.path}
                        </span>
                      </TableCell>
                      <TableCell className="text-right text-muted-foreground tabular-nums">
                        {archiveEntry.kind === "dir" ? "—" : formatBytes(archiveEntry.size)}
                      </TableCell>
                      <TableCell className="text-right text-muted-foreground tabular-nums">
                        {archiveEntry.modifiedAt !== null
                          ? formatDate(new Date(archiveEntry.modifiedAt))
                          : "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </Fragment>
              ))}
            </TableBody>
          </Table>
        )}
      </ScrollArea>
    </div>
  );
}
