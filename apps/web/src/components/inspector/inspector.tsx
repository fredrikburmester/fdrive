"use client";

import type { FsEntry } from "@fdrive/contracts";
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
import { EntryMetadataSection } from "@/components/metadata/entry-metadata-section";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { formatBytes } from "@/lib/format";
import { apiClient } from "@/lib/preview/deps";
import { describeEntry } from "@/lib/preview/describe";
import { previewKindFor } from "@/lib/preview/kind";
import { summarizeSelection } from "@/lib/preview/selection";

export interface InspectorProps {
  readonly entries: readonly FsEntry[];
  readonly onClose: () => void;
}

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

function SingleEntryBody({ entry }: { entry: FsEntry }) {
  const { rows } = describeEntry(entry, { now: new Date() });
  const kind = previewKindFor(entry);
  const Icon = iconFor(entry);

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-col items-center gap-3 py-2">
        {kind === "image" ? (
          // biome-ignore lint/performance/noImgElement: thumbnail loads arbitrary API-served bytes, not a static asset next/image can optimize
          <img
            src={apiClient.downloadUrl(entry.path, { inline: true })}
            alt={entry.name}
            className="max-h-40 max-w-full rounded-lg object-contain ring-1 ring-border"
          />
        ) : (
          <Icon className="size-16 text-muted-foreground" strokeWidth={1.25} />
        )}
        <p className="max-w-full break-all text-center text-sm font-medium">{entry.name}</p>
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
      <EntryMetadataSection entries={[entry]} />
    </div>
  );
}

function MultiEntryBody({ entries }: { entries: readonly FsEntry[] }) {
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

function InspectorBody({ entries }: { entries: readonly FsEntry[] }) {
  if (entries.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
        No selection
      </div>
    );
  }

  const single = entries.length === 1 ? entries.at(0) : undefined;
  if (single !== undefined) {
    return <SingleEntryBody entry={single} />;
  }

  return <MultiEntryBody entries={entries} />;
}

/**
 * The trailing details panel: a fixed 320px aside on wide screens, a
 * shadcn `Sheet` on narrow ones. Shows a single entry's icon/thumbnail and
 * `describeEntry` rows, or a count-and-size summary for a multi-selection.
 */
export function Inspector({ entries, onClose }: InspectorProps) {
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
          <InspectorBody entries={entries} />
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
          <InspectorBody entries={entries} />
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
