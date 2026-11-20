"use client";

import type { TrashEntry } from "@fdrive/contracts";
import { cn } from "cn";
import { Loader2 } from "lucide-react";
import { DetailSheet } from "@/components/shell/list-sheet";
import { PHONE_TARGET } from "@/components/shell/page-rows";
import { Code, type Fact, FactList } from "@/components/shell/sheet-data";
import type { RowSheetProps } from "@/components/shell/use-sheet-row";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/format";
import { useFormatters } from "@/lib/use-format-preferences";
import { type TrashLabel, TrashName } from "./trash-name";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Where the item was, as a path. An item whose name this browser cannot read shows as far as
 * its folder reads.
 */
function originalLocation(label: TrashLabel): string {
  const folder = label.folder === "Home" ? "" : label.folder;
  if (label.name === null) return folder === "" ? "/" : folder;
  return `${folder}/${label.name}`;
}

/** What Restore does, in one line. A folder this browser cannot read in full is not named. */
function restoreLede(label: TrashLabel): string {
  return label.folder.endsWith("…")
    ? "Restoring puts it back where it was."
    : `Restoring puts it back in ${label.folder}.`;
}

export interface TrashSheetProps extends RowSheetProps {
  entry: TrashEntry;
  /** How the item reads: an encrypted name is decrypted in this browser, or stays unread. */
  label: TrashLabel;
  /** How long Trash keeps an item, once that setting has loaded. */
  retentionDays: number | undefined;
  /** This sheet's own restore is running. */
  restoring: boolean;
  /** Some restore is running, here or elsewhere on the page. */
  busy: boolean;
  onRestore: () => void;
  onRestoreTo: () => void;
  /** Asks before deleting: the page owns the confirmation. */
  onPurge: () => void;
}

/**
 * A trashed item's sheet: where it was, when it was deleted and how long Trash keeps it, with
 * Restore as its one primary action and permanent deletion apart in the footer.
 */
export function TrashSheet({
  entry,
  label,
  retentionDays,
  restoring,
  busy,
  onRestore,
  onRestoreTo,
  onPurge,
  ...sheet
}: TrashSheetProps) {
  const { prefs, formatBytes } = useFormatters();
  const deletedAt = new Date(entry.deletedAt);
  const when = (date: Date) => formatDate(date, { style: "absolute", clock: prefs.clock });
  const facts: Fact[] = [
    { label: "Original location", value: <Code>{originalLocation(label)}</Code> },
    { label: "Deleted", value: when(deletedAt) },
    { label: "Size", value: formatBytes(entry.size) },
    ...(retentionDays === undefined
      ? []
      : [
          {
            label: "Kept until",
            value: when(new Date(deletedAt.getTime() + retentionDays * DAY_MS)),
          },
        ]),
  ];
  return (
    <DetailSheet
      width="docked"
      titleAs="h2"
      title={<TrashName label={label} />}
      lede={restoreLede(label)}
      actions={
        <>
          <Button variant="outline" disabled={busy} onClick={onRestoreTo}>
            Restore to
          </Button>
          <Button disabled={busy} aria-busy={restoring} onClick={onRestore}>
            {restoring ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
            {restoring ? "Restoring…" : "Restore"}
          </Button>
        </>
      }
      footer={
        <>
          <p className="min-w-0 flex-[1_1_12rem] text-muted-foreground">
            Deleting permanently cannot be undone.
          </p>
          <Button variant="destructive" className={cn("ml-auto", PHONE_TARGET)} onClick={onPurge}>
            Delete permanently
          </Button>
        </>
      }
      className="outline-hidden"
      {...sheet}
    >
      <FactList facts={facts} />
    </DetailSheet>
  );
}
