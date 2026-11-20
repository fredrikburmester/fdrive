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
import { type ReactNode, useEffect, useState } from "react";
import { FileActivitySection } from "@/components/activity/file-activity-section";
import { EntryMetadataSection } from "@/components/metadata/entry-metadata-section";
import { Code, FactList } from "@/components/shell/sheet-data";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetClose, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { useFolderSize, usePhotoDetails } from "@/lib/inspector/queries";
import { apiClient } from "@/lib/preview/deps";
import { type DescribeRow, describeEntry, describePhoto } from "@/lib/preview/describe";
import { isHeicExt } from "@/lib/preview/heic";
import { previewKindFor } from "@/lib/preview/kind";
import { isRawExt } from "@/lib/preview/raw";
import { summarizeSelection } from "@/lib/preview/selection";
import { useFormatters } from "@/lib/use-format-preferences";

export interface InspectorProps {
  readonly entries: readonly FsEntry[];
  readonly onClose: () => void;
  /**
   * Whether the files folder is indexed: without it a folder's size reads
   * "Not indexed" without asking the API. Defaults to `true`.
   */
  readonly indexed?: boolean;
}

const NOT_INDEXED = { isPending: false, isError: false } as const;

/** Same breakpoint as `INSPECTOR_SIDE_PANEL_QUERY`, which decides whether the panel starts open. */
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

/**
 * The panel around what is shown: a header like a sheet's (the title in full, so a long name
 * wraps, one quiet line under it, and the close button at the far end), then the content, which
 * scrolls under the header.
 */
function PanelFrame({
  title,
  detail,
  close,
  children,
}: {
  title: string;
  detail: string;
  close: ReactNode;
  children?: ReactNode;
}) {
  return (
    <>
      <header data-slot="inspector-header" className="flex items-start gap-2 px-4 pt-4 pb-3">
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold text-[17px] leading-[22px] tracking-[-0.01em] [overflow-wrap:anywhere]">
            {title}
          </h2>
          <p className="mt-1 text-muted-foreground text-xs">{detail}</p>
        </div>
        {close}
      </header>
      <ScrollArea className="min-h-0 flex-1">{children}</ScrollArea>
    </>
  );
}

/** A block of the panel: a hairline, then a small muted heading over its content. */
function PanelBlock({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 pt-1">
      <Separator />
      <h3 className="font-medium text-muted-foreground text-xs">{title}</h3>
      {children}
    </section>
  );
}

function rowValue(rows: readonly DescribeRow[], label: string): string {
  return rows.find((row) => row.label === label)?.value ?? "";
}

function SingleEntryPanel({
  entry,
  indexed,
  close,
}: {
  entry: FsEntry;
  indexed: boolean;
  close: ReactNode;
}) {
  const { prefs } = useFormatters();
  const isDir = entry.kind === "dir";
  const kind = previewKindFor(entry);
  const folderSizeQuery = useFolderSize(entry.path, { enabled: isDir && indexed });
  const photoQuery = usePhotoDetails(entry.path, { enabled: kind === "image" && indexed });
  const { rows, note } = describeEntry(entry, {
    now: new Date(),
    units: prefs.sizes,
    clock: prefs.clock,
    ...(isDir
      ? {
          folderSize: indexed
            ? {
                isPending: folderSizeQuery.isPending,
                isError: folderSizeQuery.isError,
                ...(folderSizeQuery.data === undefined ? {} : { data: folderSizeQuery.data }),
              }
            : NOT_INDEXED,
        }
      : {}),
  });
  const photoRows =
    photoQuery.data === undefined ? [] : describePhoto(photoQuery.data, { clock: prefs.clock });
  const Icon = iconFor(entry);
  // Browsers other than Safari cannot decode HEIC, and none decodes camera raw,
  // so those show the indexer's thumbnail; any image that fails to load falls
  // back to the kind icon.
  const [imageFailed, setImageFailed] = useState(false);
  const imageSrc =
    isHeicExt(entry.ext) || isRawExt(entry.ext)
      ? apiClient.thumbUrl(entry.path, 256)
      : apiClient.downloadUrl(entry.path, { inline: true });
  // The line under the name: the kind, and the size once it is known. A folder's is known only
  // when the index has counted it, which is when the note shows.
  const kindName = rowValue(rows, "Kind");
  const detail = isDir && note === null ? kindName : `${kindName} · ${rowValue(rows, "Size")}`;

  return (
    <PanelFrame title={entry.name} detail={detail} close={close}>
      <div className="flex flex-col gap-4 px-4 pb-4">
        <div className="flex justify-center py-2">
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
        </div>
        <PanelBlock title="Details">
          <FactList
            className="grid-cols-[minmax(5.5rem,auto)_minmax(0,1fr)] gap-x-3 gap-y-2"
            facts={[...rows, ...photoRows].map((row) => ({
              label: row.label,
              value: row.label === "Location" ? <Code>{row.value}</Code> : row.value,
            }))}
          />
          {note !== null && <p className="text-muted-foreground text-xs">{note}</p>}
        </PanelBlock>
        <EntryMetadataSection entries={[entry]} />
        <FileActivitySection path={entry.path} />
      </div>
    </PanelFrame>
  );
}

function MultiEntryPanel({ entries, close }: { entries: readonly FsEntry[]; close: ReactNode }) {
  const { formatBytes } = useFormatters();
  const summary = summarizeSelection(entries);

  return (
    <PanelFrame
      title={`${summary.count} items selected`}
      detail={`${formatBytes(summary.totalSize)} total`}
      close={close}
    >
      <div className="px-4 pb-4">
        <EntryMetadataSection entries={entries} />
      </div>
    </PanelFrame>
  );
}

/** The panel for whatever is selected: nothing, one entry, or several. */
function InspectorPanel({
  entries,
  indexed,
  close,
}: {
  entries: readonly FsEntry[];
  indexed: boolean;
  close: ReactNode;
}) {
  if (entries.length === 0) {
    return (
      <PanelFrame
        title="No selection"
        detail="Select a file or folder to see its details."
        close={close}
      />
    );
  }

  const single = entries.length === 1 ? entries.at(0) : undefined;
  if (single !== undefined) {
    return <SingleEntryPanel key={single.path} entry={single} indexed={indexed} close={close} />;
  }

  return <MultiEntryPanel entries={entries} close={close} />;
}

/** The close button's look, wide or narrow: a round ghost icon button at the header's end. */
const CLOSE_BUTTON = "-mt-0.5 -mr-1.5 shrink-0 rounded-full text-muted-foreground";

/**
 * The trailing details panel: a fixed 320px aside on wide screens, a
 * shadcn `Sheet` on narrow ones. It takes the detail sheet's look (docs/DESIGN.md) at the file
 * browser's compact size: `panel` ground, a hairline on its left, the name as its title, and
 * blocks divided by hairlines under small muted headings. Shows a single entry's
 * icon/thumbnail and `describeEntry` rows, or a count-and-size summary for several. The file
 * browser passes its selection or, with none, the highlighted row
 * (`inspectedEntries`). Showing a file here records nothing: the panel is open by default, so
 * the file browser records "Viewed info" only when the person opens it on a file.
 */
export function Inspector({ entries, onClose, indexed = true }: InspectorProps) {
  const isWide = useIsWideScreen();

  if (isWide) {
    return (
      <aside
        aria-label="Info"
        className="flex h-full w-80 shrink-0 flex-col border-border border-l bg-panel"
      >
        <InspectorPanel
          entries={entries}
          indexed={indexed}
          close={
            <Button
              variant="ghost"
              size="icon-sm"
              className={CLOSE_BUTTON}
              onClick={onClose}
              aria-label="Close info"
            >
              <X />
            </Button>
          }
        />
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
      <SheetContent side="right" showCloseButton={false} className="flex w-80 flex-col gap-0 p-0">
        {/* The dialog keeps its name; the header under it names what is shown. */}
        <SheetTitle className="sr-only">Info</SheetTitle>
        <InspectorPanel
          entries={entries}
          indexed={indexed}
          close={
            <SheetClose
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className={`${CLOSE_BUTTON} max-md:size-11`}
                />
              }
            >
              <X />
              <span className="sr-only">Close</span>
            </SheetClose>
          }
        />
      </SheetContent>
    </Sheet>
  );
}
