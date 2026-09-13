"use client";

import type { SystemLogEntry, SystemLogLevel, SystemLogSubsystem } from "@fdrive/contracts";
import { ChevronRight, ScrollText } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useSystemLogs } from "@/lib/api/system-logs-queries";
import { adaptDocument, createAnchorDownloader, downloadObjectUrl } from "@/lib/files/download";
import {
  formatLogLines,
  formatLogTime,
  LOG_LEVEL_FILTERS,
  logFileName,
  toNdjson,
} from "@/lib/system/logs";

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
      <Button type="button" variant="outline" onClick={() => setOpen(true)}>
        <ScrollText />
        Logs
      </Button>
      <SheetContent side="right" className="gap-0 sm:max-w-xl">
        {open ? <LogSheetBody subsystem={subsystem} title={title ?? `${subsystem} log`} /> : null}
      </SheetContent>
    </Sheet>
  );
}

const LEVEL_BADGE: Record<SystemLogLevel, "outline" | "secondary" | "destructive"> = {
  info: "outline",
  warn: "secondary",
  error: "destructive",
};

function LogSheetBody({ subsystem, title }: { subsystem: SystemLogSubsystem; title: string }) {
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
      <SheetHeader className="border-b pr-12">
        <SheetTitle className="capitalize">{title}</SheetTitle>
        <SheetDescription>Newest first. Refreshes every 5 seconds while open.</SheetDescription>
        {["thumbnails", "indexer", "search", "image-search"].includes(subsystem) ? (
          <SheetClose render={<a href="#processing-failures" className="text-sm underline" />}>
            View per-file failure history
          </SheetClose>
        ) : null}
      </SheetHeader>
      <div className="flex items-center justify-between gap-3 border-b px-4 py-2">
        <ToggleGroup
          aria-label="Minimum level"
          size="sm"
          variant="outline"
          value={[level]}
          onValueChange={(next: unknown[]) => {
            const chosen = next[0];
            if (typeof chosen === "string") setLevel(chosen as SystemLogLevel);
          }}
        >
          {LOG_LEVEL_FILTERS.map((filter) => (
            <ToggleGroupItem key={filter.value} value={filter.value}>
              {filter.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <span className="text-xs text-muted-foreground">
          {logs.isFetching && !logs.isFetchingNextPage
            ? "Refreshing…"
            : `${entries.length} entries`}
        </span>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col p-2">
          {logs.isError ? (
            <p className="p-2 text-sm text-destructive">
              Could not load the log: {logs.error.message}
            </p>
          ) : logs.isPending ? (
            <p className="p-2 text-sm text-muted-foreground">Loading…</p>
          ) : entries.length === 0 ? (
            <p className="p-2 text-sm text-muted-foreground">No entries at this level yet.</p>
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
              variant="ghost"
              size="sm"
              className="mt-2 self-center"
              disabled={logs.isFetchingNextPage}
              onClick={() => void logs.fetchNextPage()}
            >
              {logs.isFetchingNextPage ? "Loading…" : "Load older"}
            </Button>
          ) : null}
        </div>
      </ScrollArea>
      <SheetFooter className="flex-row justify-end gap-2 border-t">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={entries.length === 0}
          onClick={() => void copy()}
        >
          Copy
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={entries.length === 0}
          onClick={() => download("txt")}
        >
          Download .txt
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={entries.length === 0}
          onClick={() => download("ndjson")}
        >
          Download .ndjson
        </Button>
      </SheetFooter>
    </>
  );
}

function LogRow({ entry }: { entry: SystemLogEntry }) {
  const line = (
    <>
      <span className="shrink-0 text-muted-foreground">{formatLogTime(entry.at)}</span>
      <Badge variant={LEVEL_BADGE[entry.level]} className="w-14 shrink-0 justify-center font-mono">
        {entry.level}
      </Badge>
      <span className="min-w-0 break-words">{entry.message}</span>
    </>
  );
  if (entry.data === undefined) {
    return <li className="flex items-start gap-2 px-2 py-1">{line}</li>;
  }
  return (
    <li className="px-2 py-1">
      <Collapsible>
        <CollapsibleTrigger className="group flex w-full items-start gap-2 text-left">
          <ChevronRight className="mt-0.5 size-3 shrink-0 transition group-data-panel-open:rotate-90" />
          {line}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <pre className="mt-1 ml-5 overflow-x-auto rounded bg-muted p-2 text-[11px] whitespace-pre-wrap">
            {JSON.stringify(entry.data, null, 2)}
          </pre>
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}
