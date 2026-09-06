"use client";

import { ChevronDown, RotateCcw, UploadCloud, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { estimateSpeed, formatEta, formatSpeed, type ThroughputSample } from "@/lib/upload/format";
import { summarize } from "@/lib/upload/queue";
import { useUploadStore } from "@/lib/upload/store";
import type { UploadItem, UploadStatus } from "@/lib/upload/types";

const SAMPLE_HISTORY_LIMIT = 50;

function statusLabel(status: UploadStatus): string {
  switch (status) {
    case "queued":
      return "Queued";
    case "uploading":
      return "Uploading";
    case "done":
      return "Done";
    case "error":
      return "Failed";
    case "skipped":
      return "Skipped";
    case "cancelled":
      return "Cancelled";
  }
}

function statusVariant(status: UploadStatus): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "done":
      return "secondary";
    case "error":
      return "destructive";
    case "uploading":
      return "default";
    default:
      return "outline";
  }
}

interface UploadRowProps {
  readonly item: UploadItem;
  readonly onRetry: () => void;
  readonly onCancel: () => void;
}

function UploadRow({ item, onRetry, onCancel }: UploadRowProps) {
  const isActive = item.status === "queued" || item.status === "uploading";

  return (
    <li className="flex flex-col gap-1 py-2 first:pt-0 last:pb-0">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-sm text-foreground" title={item.relativePath}>
          {item.relativePath}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          <Badge variant={statusVariant(item.status)}>{statusLabel(item.status)}</Badge>
          {item.status === "error" && (
            <Button variant="ghost" size="icon-xs" onClick={onRetry} aria-label="Retry upload">
              <RotateCcw />
            </Button>
          )}
          {isActive && (
            <Button variant="ghost" size="icon-xs" onClick={onCancel} aria-label="Cancel upload">
              <X />
            </Button>
          )}
        </div>
      </div>
      {item.status === "uploading" && <Progress value={item.progress * 100} />}
      {item.status === "error" && item.error !== undefined && (
        <p className="truncate text-xs text-destructive">{item.error}</p>
      )}
    </li>
  );
}

/**
 * Bottom-right floating panel listing every upload in the queue, with
 * per-file and overall progress, speed, ETA, retry and cancel, and a
 * "Clear" action once everything has finished. Collapses to a compact pill
 * once nothing is left in flight, and renders nothing while the queue is
 * empty. Meant to be mounted once by the shell.
 */
export function UploadPanel() {
  const state = useUploadStore((s) => s.state);
  const retry = useUploadStore((s) => s.retry);
  const cancel = useUploadStore((s) => s.cancel);
  const clearFinished = useUploadStore((s) => s.clearFinished);
  const [collapsed, setCollapsed] = useState(false);

  const summary = summarize(state);
  const items: UploadItem[] = [];
  for (const id of state.order) {
    const item = state.items[id];
    if (item !== undefined) {
      items.push(item);
    }
  }
  const activeCount = items.filter(
    (item) => item.status === "queued" || item.status === "uploading",
  ).length;
  const finished = summary.total > 0 && activeCount === 0;

  const samplesRef = useRef<ThroughputSample[]>([]);
  const wasActiveRef = useRef(false);

  useEffect(() => {
    samplesRef.current = [
      ...samplesRef.current,
      { timestampMs: Date.now(), bytesDone: summary.bytesDone },
    ].slice(-SAMPLE_HISTORY_LIMIT);
  }, [summary.bytesDone]);

  useEffect(() => {
    if (wasActiveRef.current && finished) {
      setCollapsed(true);
    }
    wasActiveRef.current = activeCount > 0;
  }, [finished, activeCount]);

  if (summary.total === 0) {
    return null;
  }

  const speed = estimateSpeed(samplesRef.current);
  const bytesRemaining = Math.max(0, summary.bytesTotal - summary.bytesDone);

  if (collapsed) {
    return (
      <Button
        variant="outline"
        onClick={() => setCollapsed(false)}
        className="fixed right-4 bottom-4 z-50 h-auto rounded-full bg-popover px-4 py-2 text-popover-foreground shadow-sm ring-1 ring-foreground/10"
      >
        <UploadCloud />
        {summary.done} uploaded{summary.failed > 0 ? `, ${summary.failed} failed` : ""}
      </Button>
    );
  }

  return (
    <Card className="fixed right-4 bottom-4 z-50 w-80 gap-3 shadow-lg">
      <CardHeader className="flex-row items-center justify-between gap-2">
        <CardTitle>
          {finished
            ? `Uploaded ${summary.done}${summary.failed > 0 ? `, ${summary.failed} failed` : ""}`
            : `Uploading ${activeCount} item${activeCount === 1 ? "" : "s"}`}
        </CardTitle>
        <div className="flex shrink-0 items-center gap-1">
          {finished && (
            <Button variant="ghost" size="sm" onClick={clearFinished}>
              Clear
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => setCollapsed(true)}
            aria-label="Collapse upload panel"
          >
            <ChevronDown />
          </Button>
        </div>
      </CardHeader>
      <Separator />
      <CardContent className="flex flex-col gap-3">
        {!finished && (
          <div className="flex flex-col gap-1">
            <Progress value={summary.overallProgress * 100} />
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{formatSpeed(speed)}</span>
              <span>{formatEta(bytesRemaining, speed)} left</span>
            </div>
          </div>
        )}
        <ScrollArea className="max-h-64">
          <ul className="divide-y divide-border">
            {items.map((item) => (
              <UploadRow
                key={item.id}
                item={item}
                onRetry={() => retry(item.id)}
                onCancel={() => cancel(item.id)}
              />
            ))}
          </ul>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
