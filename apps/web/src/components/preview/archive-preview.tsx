"use client";

import type { CompressRequest, ExtractRequest, FsEntry } from "@fdrive/contracts";
import { parentPath } from "@fdrive/core";
import { DownloadIcon, FolderInputIcon, PackageOpenIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { DestinationPicker } from "@/components/files/destination-picker";
import { Button } from "@/components/ui/button";
import { useArchiveEntries } from "@/lib/archive/queries";
import { extractDestinationUnder } from "@/lib/files/archive";
import { type RunJobRequestDeps, runJobRequest } from "@/lib/jobs/actions";
import { useJobsStore } from "@/lib/jobs/store";
import type { JobRequest } from "@/lib/jobs/types";
import { apiClient } from "@/lib/preview/deps";
import { ArchiveEntriesSkeleton, ArchiveEntriesView } from "./archive-entries-view";
import { Unsupported } from "./unsupported";

export interface ArchivePreviewProps {
  readonly entry: FsEntry;
  readonly downloadUrl: string;
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
    return <ArchiveEntriesSkeleton />;
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

  return (
    <>
      <ArchiveEntriesView
        name={entry.name}
        size={entry.size}
        data={query.data}
        actions={
          <>
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
          </>
        }
      />

      <DestinationPicker
        open={destinationPickerOpen}
        mode="extractTo"
        initialPath={parentPath(entry.path)}
        onOpenChange={setDestinationPickerOpen}
        onConfirm={handleExtractToConfirm}
      />
    </>
  );
}
