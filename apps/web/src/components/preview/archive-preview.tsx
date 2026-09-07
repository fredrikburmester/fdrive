"use client";

import type { CompressRequest, ExtractRequest, FsEntry } from "@fdrive/contracts";
import { parentPath } from "@fdrive/core";
import {
  DownloadIcon,
  FolderIcon,
  FolderInputIcon,
  PackageOpenIcon,
  SearchIcon,
} from "lucide-react";
import { Fragment, useState } from "react";
import { toast } from "sonner";
import { DestinationPicker } from "@/components/files/destination-picker";
import { Button } from "@/components/ui/button";
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
import { useArchiveEntries } from "@/lib/archive/queries";
import { extractDestinationUnder } from "@/lib/files/archive";
import { formatBytes, formatDate } from "@/lib/format";
import { type RunJobRequestDeps, runJobRequest } from "@/lib/jobs/actions";
import { useJobsStore } from "@/lib/jobs/store";
import type { JobRequest } from "@/lib/jobs/types";
import { apiClient } from "@/lib/preview/deps";
import { Unsupported } from "./unsupported";

export interface ArchivePreviewProps {
  readonly entry: FsEntry;
  readonly downloadUrl: string;
}

const FORMAT_LABELS: Readonly<Record<string, string>> = {
  zip: "ZIP archive",
  tar: "TAR archive",
  "tar.gz": "gzip-compressed TAR archive",
  "tar.zst": "zstd-compressed TAR archive",
};

/** Placeholder row widths, cycled so the skeleton reads as a real table
 * instead of one uniform block. */
const SKELETON_ROW_WIDTHS = [92, 80, 88, 65, 95, 72, 84, 60];

function ArchivePreviewSkeleton() {
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

/**
 * Preview kind `archive`: a header with the archive's name, size, and
 * format, a search box that filters entries client-side, a table of
 * entries (grouped by their containing folder within the archive) with a
 * name, size, and modified date, a note when the API truncated the list,
 * and the same Download, "Extract here", and "Extract to" actions the file
 * browser itself offers for an archive. Never extracts anything itself;
 * reading the archive's own bytes only happens server-side, through
 * `GET /fs/archive-entries`.
 */
export function ArchivePreview({ entry, downloadUrl }: ArchivePreviewProps) {
  const query = useArchiveEntries(entry.path);
  const [search, setSearch] = useState("");
  const [destinationPickerOpen, setDestinationPickerOpen] = useState(false);

  function buildJobRequestDeps(): RunJobRequestDeps {
    return {
      compress: (req: CompressRequest) => apiClient.compress(req),
      extract: (req: ExtractRequest) => apiClient.extract(req),
      seedJob: (job, request) => useJobsStore.getState().seed(job, request),
      notifySuccess: (message) => toast.success(message),
      notifyError: (message) => toast.error(message),
    };
  }

  function submitJobRequest(request: JobRequest): void {
    void runJobRequest(buildJobRequestDeps(), request);
  }

  function handleExtractHere(): void {
    submitJobRequest({ kind: "extract", req: { path: entry.path } });
  }

  function handleExtractToConfirm(destinationDir: string): void {
    setDestinationPickerOpen(false);
    submitJobRequest({
      kind: "extract",
      req: { path: entry.path, destination: extractDestinationUnder(entry.path, destinationDir) },
    });
  }

  if (query.status === "pending") {
    return <ArchivePreviewSkeleton />;
  }

  if (query.status === "error") {
    return (
      <Unsupported
        name={entry.name}
        size={entry.size}
        kind="archive"
        reason="This archive cannot be read."
        downloadUrl={downloadUrl}
      />
    );
  }

  const data = query.data;
  const filtered = filterArchiveEntries(data.entries, search);
  const groups = groupArchiveEntries(filtered);
  const formatLabel = FORMAT_LABELS[data.format] ?? data.format;
  const totalLabel = `${data.entries.length.toLocaleString()} ${data.entries.length === 1 ? "entry" : "entries"}`;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{entry.name}</p>
          <p className="text-xs text-muted-foreground">
            {formatBytes(entry.size)} · {formatLabel} · {totalLabel}
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

        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={handleExtractHere}>
            <PackageOpenIcon data-icon="inline-start" />
            Extract here
          </Button>
          <Button variant="outline" size="sm" onClick={() => setDestinationPickerOpen(true)}>
            <FolderInputIcon data-icon="inline-start" />
            Extract to
          </Button>
          <Button
            size="sm"
            nativeButton={false}
            render={<a href={downloadUrl} download={entry.name} />}
          >
            <DownloadIcon data-icon="inline-start" />
            Download
          </Button>
        </div>
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

      <DestinationPicker
        open={destinationPickerOpen}
        mode="extractTo"
        initialPath={parentPath(entry.path)}
        onOpenChange={setDestinationPickerOpen}
        onConfirm={handleExtractToConfirm}
      />
    </div>
  );
}
