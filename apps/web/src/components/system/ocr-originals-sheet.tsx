"use client";

import { buildRequestUrl, type OcrOriginal, ROUTES } from "@fdrive/contracts";
import { Archive, Download, MoreHorizontal, RotateCcw, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
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

function downloadHref(id: string): string {
  return buildRequestUrl("", ROUTES.system.ocrOriginalDownload, { id });
}

/**
 * The "Manage" button on `System > OCR` and the sheet it opens: the inventory
 * of originals kept before each rewrite, with restore, download and delete.
 * The body only mounts while open, so a closed sheet issues no request.
 */
export function OcrOriginalsSheet({ disabled }: { disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <Button type="button" variant="outline" disabled={disabled} onClick={() => setOpen(true)}>
        <Archive />
        Manage
      </Button>
      <SheetContent side="right" className="gap-0 sm:max-w-2xl">
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
      <SheetHeader className="border-b pr-12">
        <SheetTitle>Kept originals</SheetTitle>
        <SheetDescription>
          The file each OCR rewrite replaced, newest first. Restoring puts one back over the
          searchable PDF.
        </SheetDescription>
      </SheetHeader>
      <div className="border-b px-4 py-2">
        <Input
          aria-label="Search kept originals"
          placeholder="Search by path…"
          value={query}
          onChange={(event) => search(event.target.value)}
        />
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col p-2">
          {originals.isError ? (
            <p className="p-2 text-sm text-destructive">
              Could not load kept originals: {describeApiError(originals.error)}
            </p>
          ) : originals.isPending ? (
            <p className="p-2 text-sm text-muted-foreground">Loading…</p>
          ) : items.length === 0 ? (
            <p className="p-2 text-sm text-muted-foreground">
              {query === ""
                ? "No originals are kept yet. One is kept each time OCR rewrites a PDF."
                : "No kept original matches that search."}
            </p>
          ) : (
            <ul className="flex flex-col gap-1" aria-label="Kept originals">
              {items.map((original) => (
                <OriginalRow
                  key={original.id}
                  original={original}
                  onRestore={() => setPending({ kind: "restore", original })}
                  onDelete={() => setPending({ kind: "delete", original })}
                />
              ))}
            </ul>
          )}
        </div>
      </ScrollArea>
      <SheetFooter className="shrink-0 flex-row items-center justify-between border-t">
        <span className="text-xs text-muted-foreground">
          {pageSummary(total, offset, items.length)}
        </span>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - OCR_ORIGINALS_PAGE_SIZE))}
          >
            Previous
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
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
            <p className="font-mono text-xs break-all text-muted-foreground">
              {originalTitle(pending.original)}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
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
    <li className="flex items-start gap-2 rounded-md px-2 py-2 hover:bg-muted/50">
      <div className="min-w-0 flex-1">
        <p className="font-mono text-xs break-all">{originalTitle(original)}</p>
        <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {original.state !== null ? (
            <Badge variant={ORIGINAL_STATE_TONE[original.state]}>
              {ORIGINAL_STATE_LABEL[original.state]}
            </Badge>
          ) : (
            <Badge variant="secondary">Source unknown</Badge>
          )}
          <span>{formatBytes(original.size)}</span>
          <span>kept {formatRelativeTime(new Date(original.keptAt), new Date())}</span>
          {original.root !== null ? <span>in {original.root}</span> : null}
        </p>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon"
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
    </li>
  );
}
