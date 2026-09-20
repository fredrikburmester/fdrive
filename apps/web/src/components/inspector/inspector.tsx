"use client";

import type { FsEntry, ProviderCapabilities } from "@fdrive/contracts";
import {
  File,
  FileArchive,
  FileAudio,
  FileCode2,
  FileImage,
  FileText,
  FileVideo,
  Folder,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { FileJourneyButton } from "@/components/activity/file-journey-button";
import { EntryMetadataSection } from "@/components/metadata/entry-metadata-section";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useActivityGesture } from "@/lib/activity/gestures";
import { DEFAULT_CAPABILITIES } from "@/lib/identity/capabilities";
import { useFolderSize } from "@/lib/inspector/queries";
import { apiClient } from "@/lib/preview/deps";
import { describeEntry } from "@/lib/preview/describe";
import { isHeicExt } from "@/lib/preview/heic";
import { previewKindFor } from "@/lib/preview/kind";
import { isRawExt } from "@/lib/preview/raw";
import { summarizeSelection } from "@/lib/preview/selection";
import { useFormatters } from "@/lib/use-format-preferences";

export interface InspectorProps {
  readonly entries: readonly FsEntry[];
  readonly onClose: () => void;
  /**
   * What the active login's storage can do: without `index` a folder's
   * size reads "Not indexed" without asking the API, and without
   * `setModifiedAt` a note explains that Modified is the upload time.
   * Defaults to `DEFAULT_CAPABILITIES`.
   */
  readonly capabilities?: ProviderCapabilities;
}

const NOT_INDEXED = { isPending: false, isError: false } as const;
const UPLOAD_TIME_NOTE =
  "Modified is when the file reached this server; uploads do not keep the original time.";

const WIDE_MEDIA_QUERY = "(min-width: 1024px)";

/** True on viewports at or above Tailwind's `lg` breakpoint. */
function useIsWideScreen(): boolean {
  const [isWide, setIsWide] = useState<boolean>(() =>
    typeof window === "undefined" ? true : window.matchMedia(WIDE_MEDIA_QUERY).matches,
  );

  useEffect(() => {
    const mediaQueryList = window.matchMedia(WIDE_MEDIA_QUERY);
    const handleChange = (event: MediaQueryListEvent) => setIsWide(event.matches);
    setIsWide(mediaQueryList.matches);
    mediaQueryList.addEventListener("change", handleChange);
    return () => mediaQueryList.removeEventListener("change", handleChange);
  }, []);

  return isWide;
}

const ICON_BY_PREVIEW_KIND = {
  image: FileImage,
  video: FileVideo,
  audio: FileAudio,
  pdf: FileText,
  markdown: FileText,
  code: FileCode2,
  text: FileText,
  office: FileText,
  archive: FileArchive,
  none: File,
} as const;

function iconFor(entry: FsEntry) {
  if (entry.kind === "dir") {
    return Folder;
  }
  return ICON_BY_PREVIEW_KIND[previewKindFor(entry)];
}

function SingleEntryBody({
  entry,
  capabilities,
}: {
  entry: FsEntry;
  capabilities: ProviderCapabilities;
}) {
  const { prefs } = useFormatters();
  const isDir = entry.kind === "dir";
  const folderSizeQuery = useFolderSize(entry.path, { enabled: isDir && capabilities.index });
  const { rows, note } = describeEntry(entry, {
    now: new Date(),
    units: prefs.sizes,
    clock: prefs.clock,
    ...(isDir
      ? {
          folderSize: capabilities.index
            ? {
                isPending: folderSizeQuery.isPending,
                isError: folderSizeQuery.isError,
                ...(folderSizeQuery.data === undefined ? {} : { data: folderSizeQuery.data }),
              }
            : NOT_INDEXED,
        }
      : {}),
  });
  const kind = previewKindFor(entry);
  const Icon = iconFor(entry);
  // Browsers other than Safari cannot decode HEIC, and none decodes camera raw,
  // so those show the indexer's thumbnail; any image that fails to load falls
  // back to the kind icon.
  const [imageFailed, setImageFailed] = useState(false);
  const imageSrc =
    isHeicExt(entry.ext) || isRawExt(entry.ext)
      ? apiClient.thumbUrl(entry.path, 256)
      : apiClient.downloadUrl(entry.path, { inline: true });

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-col items-center gap-3 py-2">
        {kind === "image" && !imageFailed ? (
          // biome-ignore lint/performance/noImgElement: thumbnail loads arbitrary API-served bytes, not a static asset next/image can optimize
          <img
            src={imageSrc}
            alt={entry.name}
            onError={() => setImageFailed(true)}
            className="max-h-40 max-w-full rounded-lg object-contain ring-1 ring-border"
          />
        ) : (
          <Icon className="size-16 text-muted-foreground" strokeWidth={1.25} />
        )}
        <p className="max-w-full break-all text-center text-sm font-medium">{entry.name}</p>
        <FileJourneyButton path={entry.path} />
      </div>
      <Separator />
      <dl className="flex flex-col gap-2 text-sm">
        {rows.map((row) => (
          <div key={row.label} className="flex items-baseline justify-between gap-4">
            <dt className="shrink-0 text-muted-foreground">{row.label}</dt>
            <dd className="truncate text-right">{row.value}</dd>
          </div>
        ))}
      </dl>
      {note !== null && <p className="text-xs text-muted-foreground">{note}</p>}
      {!capabilities.setModifiedAt && (
        <p className="text-xs text-muted-foreground">{UPLOAD_TIME_NOTE}</p>
      )}
      <EntryMetadataSection entries={[entry]} />
    </div>
  );
}

function MultiEntryBody({ entries }: { entries: readonly FsEntry[] }) {
  const { formatBytes } = useFormatters();
  const summary = summarizeSelection(entries);

  return (
    <div className="flex flex-col">
      <div className="flex flex-col items-center gap-3 p-4 py-10">
        <Badge variant="secondary" className="text-sm">
          {summary.count} items selected
        </Badge>
        <p className="text-sm text-muted-foreground">{formatBytes(summary.totalSize)} total</p>
      </div>
      <div className="px-4 pb-4">
        <EntryMetadataSection entries={entries} />
      </div>
    </div>
  );
}

function InspectorBody({
  entries,
  capabilities,
}: {
  entries: readonly FsEntry[];
  capabilities: ProviderCapabilities;
}) {
  if (entries.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
        No selection
      </div>
    );
  }

  const single = entries.length === 1 ? entries.at(0) : undefined;
  if (single !== undefined) {
    return <SingleEntryBody key={single.path} entry={single} capabilities={capabilities} />;
  }

  return <MultiEntryBody entries={entries} />;
}

/**
 * The trailing details panel: a fixed 320px aside on wide screens, a
 * shadcn `Sheet` on narrow ones. Shows a single entry's icon/thumbnail and
 * `describeEntry` rows, or a count-and-size summary for a multi-selection.
 */
export function Inspector({
  entries,
  onClose,
  capabilities = DEFAULT_CAPABILITIES,
}: InspectorProps) {
  useActivityGesture("file.inspect", entries.length === 1 ? entries[0]?.path : undefined);
  const isWide = useIsWideScreen();

  if (isWide) {
    return (
      <aside className="flex h-full w-80 shrink-0 flex-col border-l bg-card">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <span className="text-sm font-medium">Info</span>
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close info">
            <X />
          </Button>
        </div>
        <ScrollArea className="flex-1">
          <InspectorBody entries={entries} capabilities={capabilities} />
        </ScrollArea>
      </aside>
    );
  }

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <SheetContent side="right" className="flex w-80 flex-col gap-0 p-0">
        <SheetHeader className="border-b p-4">
          <SheetTitle>Info</SheetTitle>
        </SheetHeader>
        <ScrollArea className="flex-1">
          <InspectorBody entries={entries} capabilities={capabilities} />
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
