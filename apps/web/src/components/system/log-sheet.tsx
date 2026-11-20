"use client";

import type { SystemLogEntry, SystemLogLevel, SystemLogSubsystem } from "@fdrive/contracts";
import { cn } from "cn";
import { useState } from "react";
import { toast } from "sonner";
import { SegmentedControl } from "@/components/shell/setting-controls";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sheet, SheetContent, SheetFooter } from "@/components/ui/sheet";
import { useSystemLogs } from "@/lib/api/system-logs-queries";
import { adaptDocument, createAnchorDownloader, downloadObjectUrl } from "@/lib/files/download";
import {
  formatLogLines,
  formatLogTime,
  LOG_LEVEL_FILTERS,
  logFileName,
  toNdjson,
} from "@/lib/system/logs";
import { SYSTEM_SHEET, SystemSheetHeader } from "./settings-sheet";

export interface LogSheetProps {
  subsystem: SystemLogSubsystem;
  /** Sheet heading; defaults to "{subsystem} log". */
  title?: string;
}

/**
 * The "Logs" header button on a System page and the sheet it opens. The
 * sheet body is its own component and is only mounted while open, so a
 * closed sheet neither polls nor needs a query client to render.
 */
export function LogSheet({ subsystem, title }: LogSheetProps) {
  const [open, setOpen] = useState(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <Button type="button" variant="outline" size="lg" onClick={() => setOpen(true)}>
        Logs
      </Button>
      <SheetContent
        side="right"
        showCloseButton={false}
        className={cn(SYSTEM_SHEET, "data-[side=right]:sm:max-w-xl")}
      >
        {open ? (
          <LogSheetBody
            subsystem={subsystem}
            title={title ?? `${subsystem} log`}
            onClose={() => setOpen(false)}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

/** The subsystems whose System area also keeps a per-file failure history. */
const WITH_FAILURE_HISTORY: readonly SystemLogSubsystem[] = [
  "thumbnails",
  "indexer",
  "search",
  "image-search",
];

const LEVELS = LOG_LEVEL_FILTERS.map((filter) => filter.value);
const LEVEL_LABELS = Object.fromEntries(
  LOG_LEVEL_FILTERS.map((filter) => [filter.value, filter.label]),
) as Record<SystemLogLevel, string>;

/** A level is its word; the color only repeats what a warning or an error already says. */
const LEVEL_TONES: Record<SystemLogLevel, string> = {
  info: "text-muted-foreground",
  warn: "text-warning",
  error: "text-destructive",
};

function LogSheetBody({
  subsystem,
  title,
  onClose,
}: {
  subsystem: SystemLogSubsystem;
  title: string;
  onClose: () => void;
}) {
  const [level, setLevel] = useState<SystemLogLevel>("info");
  const logs = useSystemLogs(subsystem, { level, enabled: true });
  const entries = logs.data?.pages.flatMap((page) => page.entries) ?? [];

  async function copy() {
    try {
      await navigator.clipboard.writeText(formatLogLines(entries).join("\n"));
      toast.success(`Copied ${entries.length} log lines`);
    } catch {
      toast.error("Could not copy to the clipboard");
    }
  }

  /**
   * Hands the rendered log to the browser as a file through the shared
   * anchor downloader, which attaches the anchor before clicking it and
   * releases the object URL only after the browser has had the click.
   */
  function download(format: "txt" | "ndjson") {
    const text = format === "txt" ? formatLogLines(entries).join("\n") : toNdjson(entries);
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    downloadObjectUrl(url, logFileName(subsystem, format, new Date()), {
      anchor: createAnchorDownloader(adaptDocument(document)),
      revokeObjectUrl: (objectUrl) => {
        URL.revokeObjectURL(objectUrl);
      },
    });
  }

  return (
    <>
      <SystemSheetHeader
        title={title}
        titleClassName="first-letter:uppercase"
        description="Newest first. Refreshes every 5 seconds while open."
      >
        {WITH_FAILURE_HISTORY.includes(subsystem) ? (
          // The failure line is on the sheet under this one: close, and bring it into view.
          <button
            type="button"
            className="w-fit rounded-sm text-left text-muted-foreground text-sm underline underline-offset-4 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring max-md:-my-2 max-md:py-3"
            onClick={() => {
              onClose();
              document.getElementById("processing-failures")?.scrollIntoView({ block: "nearest" });
            }}
          >
            View per-file failure history
          </button>
        ) : null}
      </SystemSheetHeader>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-border border-b px-5 py-3">
        <SegmentedControl
          label="Minimum level"
          value={level}
          options={LEVELS}
          labels={LEVEL_LABELS}
          onChange={setLevel}
        />
        <span className="text-muted-foreground text-xs tabular-nums">
          {logs.isFetching && !logs.isFetchingNextPage
            ? "Refreshing…"
            : `${entries.length} entries`}
        </span>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col px-5 py-3">
          {logs.isError ? (
            <p role="alert" className="py-1 text-destructive text-sm">
              Could not load the log: {logs.error.message}
            </p>
          ) : logs.isPending ? (
            <p className="py-1 text-muted-foreground text-sm">Loading…</p>
          ) : entries.length === 0 ? (
            <p className="py-1 text-muted-foreground text-sm">No entries at this level yet.</p>
          ) : (
            <ul className="flex flex-col font-mono text-xs" aria-label="Log entries">
              {entries.map((entry) => (
                <LogRow key={entry.id} entry={entry} />
              ))}
            </ul>
          )}
          {logs.hasNextPage ? (
            <Button
              type="button"
              variant="secondary"
              className="mt-3 h-10 self-center px-3.5 max-md:h-11"
              disabled={logs.isFetchingNextPage}
              onClick={() => void logs.fetchNextPage()}
            >
              {logs.isFetchingNextPage ? "Loading…" : "Load older"}
            </Button>
          ) : null}
        </div>
      </ScrollArea>
      <SheetFooter className="shrink-0 flex-row flex-wrap justify-end gap-2 border-border border-t px-5 py-4">
        <Button
          type="button"
          variant="secondary"
          className="h-11 px-4.5"
          disabled={entries.length === 0}
          onClick={() => void copy()}
        >
          Copy
        </Button>
        <Button
          type="button"
          variant="secondary"
          className="h-11 px-4.5"
          disabled={entries.length === 0}
          onClick={() => download("txt")}
        >
          Download .txt
        </Button>
        <Button
          type="button"
          variant="secondary"
          className="h-11 px-4.5"
          disabled={entries.length === 0}
          onClick={() => download("ndjson")}
        >
          Download .ndjson
        </Button>
      </SheetFooter>
    </>
  );
}

/**
 * One entry: when, its level, and what happened. Data attached to the entry sits under the
 * message as one line of JSON, the same text the `.txt` download carries.
 */
function LogRow({ entry }: { entry: SystemLogEntry }) {
  return (
    <li className="grid grid-cols-[auto_2.75rem_minmax(0,1fr)] items-baseline gap-x-3 py-1.5">
      <span className="text-muted-foreground tabular-nums">{formatLogTime(entry.at)}</span>
      <span className={cn("font-medium", LEVEL_TONES[entry.level])}>{entry.level}</span>
      <span className="min-w-0 [overflow-wrap:anywhere]">{entry.message}</span>
      {entry.data !== undefined ? (
        <span className="col-start-3 mt-0.5 min-w-0 text-muted-foreground [overflow-wrap:anywhere]">
          {JSON.stringify(entry.data)}
        </span>
      ) : null}
    </li>
  );
}
