"use client";

import {
  buildRequestUrl,
  type OcrOriginal,
  type OcrOriginalState,
  ROUTES,
} from "@fdrive/contracts";
import { cn } from "cn";
import { Download, MoreHorizontal, RotateCcw, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Code } from "@/components/shell/sheet-data";
import { StatusBadge, type StatusTone } from "@/components/shell/status";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sheet, SheetContent, SheetFooter } from "@/components/ui/sheet";
import { describeApiError } from "@/lib/api/errors";
import {
  OCR_ORIGINALS_PAGE_SIZE,
  useDeleteOcrOriginal,
  useOcrOriginals,
  useRestoreOcrOriginal,
} from "@/lib/api/system-queries";
import { formatRelativeTime } from "@/lib/system/format";
import {
  isRestorable,
  ORIGINAL_STATE_LABEL,
  ORIGINAL_STATE_TONE,
  originalTitle,
  pageSummary,
  restoreConfirmation,
  restoreOptIns,
} from "@/lib/system/ocr-originals";
import { useFormatters } from "@/lib/use-format-preferences";
import { SYSTEM_SHEET, SystemSheetHeader } from "./settings-sheet";

function downloadHref(id: string): string {
  return buildRequestUrl("", ROUTES.system.ocrOriginalDownload, { id });
}

/**
 * `ORIGINAL_STATE_TONE` names its tones as badge variants. A status badge takes these instead:
 * the ordinary states are plain facts, and the two where a restore destroys something ask for
 * attention.
 */
const STATE_TONES: Record<(typeof ORIGINAL_STATE_TONE)[OcrOriginalState], StatusTone> = {
  outline: "neutral",
  secondary: "neutral",
  destructive: "warning",
};

/**
 * The columns of a row where the sheet has room for them: the file, its state, its size, when
 * it was kept, and the row's menu. On a phone a row is the path over one line of those details.
 */
const COLUMNS = "sm:grid-cols-[minmax(0,1fr)_9.5rem_4.5rem_4.5rem_2.5rem]";

/**
 * The "Manage" button on `System > Searchable PDFs` and the sheet it opens: the inventory
 * of originals kept before each rewrite, with restore, download and delete.
 * The body only mounts while open, so a closed sheet issues no request.
 */
export function OcrOriginalsSheet({ disabled }: { disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <Button
        type="button"
        variant="outline"
        className="max-md:min-h-11"
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        Manage
      </Button>
      <SheetContent
        side="right"
        showCloseButton={false}
        className={cn(SYSTEM_SHEET, "data-[side=right]:sm:max-w-2xl")}
      >
        {open ? <OcrOriginalsSheetBody /> : null}
      </SheetContent>
    </Sheet>
  );
}

type Pending =
  | { readonly kind: "restore"; readonly original: OcrOriginal }
  | { readonly kind: "delete"; readonly original: OcrOriginal };

function OcrOriginalsSheetBody() {
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [pending, setPending] = useState<Pending | null>(null);
  const originals = useOcrOriginals(query, offset, true);
  const restore = useRestoreOcrOriginal();
  const remove = useDeleteOcrOriginal();

  const items = originals.data?.items ?? [];
  const total = originals.data?.total ?? 0;

  function search(next: string) {
    setQuery(next);
    setOffset(0);
  }

  function confirm() {
    if (pending === null) {
      return;
    }
    const { original } = pending;
    if (pending.kind === "delete") {
      remove.mutate(original.id, {
        onSuccess: () => {
          toast.success("Kept original deleted.");
          setPending(null);
        },
        onError: (error) => toast.error(describeApiError(error)),
      });
      return;
    }
    restore.mutate(
      { id: original.id, ...restoreOptIns(original.state) },
      {
        onSuccess: () => {
          toast.success(`Restored ${originalTitle(original)}.`);
          setPending(null);
        },
        onError: (error) => toast.error(describeApiError(error)),
      },
    );
  }

  const confirmation =
    pending?.kind === "restore" ? restoreConfirmation(pending.original.state) : null;

  return (
    <>
      <SystemSheetHeader
        title="Kept originals"
        description="The file each OCR rewrite replaced, newest first. Restoring puts one back over the searchable PDF."
      />
      <div className="border-border border-b px-5 py-3">
        <Input
          aria-label="Search kept originals"
          placeholder="Search by path"
          className="h-10 bg-background px-3 max-md:h-11"
          value={query}
          onChange={(event) => search(event.target.value)}
        />
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="px-5 py-2">
          {originals.isError ? (
            <p role="alert" className="py-2 text-destructive text-sm">
              Could not load kept originals: {describeApiError(originals.error)}
            </p>
          ) : originals.isPending ? (
            <p className="py-2 text-muted-foreground text-sm">Loading…</p>
          ) : items.length === 0 ? (
            <p className="py-2 text-muted-foreground text-sm">
              {query === ""
                ? "No originals are kept yet. One is kept each time OCR rewrites a PDF."
                : "No kept original matches that search."}
            </p>
          ) : (
            <>
              {/* Column heads for the eye. Each row says the same in words to a screen reader. */}
              <div
                aria-hidden="true"
                className={cn(
                  "hidden h-10 items-center gap-x-4 border-border border-b font-medium text-muted-foreground text-xs sm:grid",
                  COLUMNS,
                )}
              >
                <span>File</span>
                <span>State</span>
                <span className="text-right">Size</span>
                <span>Kept</span>
              </div>
              <ul aria-label="Kept originals" className="flex flex-col">
                {items.map((original) => (
                  <OriginalRow
                    key={original.id}
                    original={original}
                    onRestore={() => setPending({ kind: "restore", original })}
                    onDelete={() => setPending({ kind: "delete", original })}
                  />
                ))}
              </ul>
            </>
          )}
        </div>
      </ScrollArea>
      <SheetFooter className="shrink-0 flex-row flex-wrap items-center justify-between gap-2 border-border border-t px-5 py-4">
        <span className="text-muted-foreground text-xs tabular-nums">
          {pageSummary(total, offset, items.length)}
        </span>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="secondary"
            className="h-11 px-4.5"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - OCR_ORIGINALS_PAGE_SIZE))}
          >
            Previous
          </Button>
          <Button
            type="button"
            variant="secondary"
            className="h-11 px-4.5"
            disabled={offset + items.length >= total}
            onClick={() => setOffset(offset + OCR_ORIGINALS_PAGE_SIZE)}
          >
            Next
          </Button>
        </div>
      </SheetFooter>

      <AlertDialog
        open={pending !== null}
        onOpenChange={(next) => {
          if (!next) setPending(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pending?.kind === "delete" ? "Delete this kept original?" : confirmation?.title}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pending?.kind === "delete"
                ? "The kept copy is deleted permanently. The searchable PDF stays as it is, and this OCR rewrite can no longer be undone."
                : confirmation?.description}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {pending !== null ? (
            <Code className="break-all text-muted-foreground text-xs">
              {originalTitle(pending.original)}
            </Code>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel className="max-md:min-h-11">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="max-md:min-h-11"
              variant={
                pending?.kind === "delete" || confirmation?.destructive ? "destructive" : "default"
              }
              disabled={restore.isPending || remove.isPending}
              onClick={(event) => {
                event.preventDefault();
                confirm();
              }}
            >
              {pending?.kind === "delete" ? "Delete" : "Restore"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** One kept original: its source path, what is at that path now, and what can be done with it. */
function OriginalRow({
  original,
  onRestore,
  onDelete,
}: {
  original: OcrOriginal;
  onRestore: () => void;
  onDelete: () => void;
}) {
  const { formatBytes } = useFormatters();
  return (
    <li
      className={cn(
        "grid min-h-13 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 border-border border-b py-2.5 last:border-b-0",
        COLUMNS,
      )}
    >
      <div className="min-w-0">
        <Code className="block break-all">{originalTitle(original)}</Code>
        {original.root !== null ? (
          <p className="mt-0.5 text-muted-foreground text-xs">in {original.root}</p>
        ) : null}
      </div>
      {/* One line under the path on a phone; from `sm` up its parts are the row's columns. */}
      <div className="col-start-1 row-start-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground text-xs sm:contents sm:text-sm">
        <span>
          {original.state !== null ? (
            <StatusBadge tone={STATE_TONES[ORIGINAL_STATE_TONE[original.state]]}>
              {ORIGINAL_STATE_LABEL[original.state]}
            </StatusBadge>
          ) : (
            <StatusBadge tone="off">Source unknown</StatusBadge>
          )}
        </span>
        <span className="tabular-nums sm:text-right">{formatBytes(original.size)}</span>
        <span>
          <span className="sm:sr-only">kept </span>
          {formatRelativeTime(new Date(original.keptAt), new Date())}
        </span>
      </div>
      <div className="col-start-2 row-span-2 row-start-1 sm:col-start-auto sm:row-span-1 sm:row-start-auto">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="text-muted-foreground max-md:size-11"
                aria-label={`Actions for ${originalTitle(original)}`}
              />
            }
          >
            <MoreHorizontal />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem disabled={!isRestorable(original)} onClick={onRestore}>
              <RotateCcw />
              Restore
            </DropdownMenuItem>
            <DropdownMenuItem render={<a href={downloadHref(original.id)} download />}>
              <Download />
              Download
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onClick={onDelete}>
              <Trash2 />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  );
}
