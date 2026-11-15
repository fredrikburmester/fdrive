"use client";

import type { FsEntry } from "@fdrive/contracts";
import { ArrowRightIcon } from "lucide-react";
import { type FormEvent, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { type BatchRenameRule, planBatchRename } from "@/lib/files/batch-rename";
import type { RenameVariables } from "@/lib/files/queries";
import { cn } from "@/lib/utils";

type Mode = BatchRenameRule["mode"];

export interface BatchRenameDialogProps {
  /** The entries to rename, in listing order. */
  entries: readonly FsEntry[];
  /** Every entry the listing shows as the dialog opens, to catch names already taken. */
  siblings: readonly FsEntry[];
  onClose: () => void;
  /** Renames one entry; a rejection stops the batch, and the caller reports it. */
  onRename: (vars: RenameVariables) => Promise<unknown>;
}

/**
 * Renames several entries at once, by replacing text in each name or by
 * numbering them, with a live old-to-new preview. Renames run one at a time
 * and stop at the first failure.
 */
export function BatchRenameDialog({
  entries,
  siblings,
  onClose,
  onRename,
}: BatchRenameDialogProps) {
  const [mode, setMode] = useState<Mode>("replace");
  const [find, setFind] = useState("");
  const [replace, setReplace] = useState("");
  const [base, setBase] = useState("");
  const [pending, setPending] = useState(false);
  // Renamed entries show up in the listing as the batch runs; they are not collisions.
  const [taken] = useState(siblings);
  const findRef = useRef<HTMLInputElement>(null);
  const rule: BatchRenameRule = mode === "replace" ? { mode, find, replace } : { mode, base };
  const plan = planBatchRename(entries, rule, taken);
  const collides = plan.rows.some((row) => row.collides);

  async function apply() {
    setPending(true);
    try {
      for (const row of plan.changes) {
        await onRename({ path: row.path, newName: row.newName });
      }
    } catch {
      // Stop at the first failure; the rename mutation has already shown it.
    }
    onClose();
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (plan.ready && !pending) void apply();
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg" initialFocus={findRef}>
        <form onSubmit={handleSubmit} className="flex min-w-0 flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Rename {entries.length} items</DialogTitle>
            <DialogDescription>
              Replace text in each name, or number them in listing order.
            </DialogDescription>
          </DialogHeader>
          <Tabs value={mode} onValueChange={(value) => setMode(value as Mode)}>
            <TabsList>
              <TabsTrigger value="replace">Replace text</TabsTrigger>
              <TabsTrigger value="number">Number</TabsTrigger>
            </TabsList>
          </Tabs>
          {mode === "replace" ? (
            <div className="grid grid-cols-2 gap-2">
              <Input
                ref={findRef}
                value={find}
                onChange={(event) => setFind(event.target.value)}
                placeholder="Find"
                aria-label="Find"
              />
              <Input
                value={replace}
                onChange={(event) => setReplace(event.target.value)}
                placeholder="Replace with"
                aria-label="Replace with"
              />
            </div>
          ) : (
            <Input
              value={base}
              onChange={(event) => setBase(event.target.value)}
              placeholder="Name"
              aria-label="Name"
            />
          )}
          <ul aria-label="Preview" className="max-h-64 overflow-y-auto rounded-lg border">
            {plan.rows.map((row) => (
              <li
                key={row.path}
                className="flex items-center gap-2 border-b px-3 py-1.5 last:border-b-0"
              >
                <span className="min-w-0 flex-1 truncate text-muted-foreground">{row.name}</span>
                <ArrowRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
                <span className={cn("min-w-0 flex-1 truncate", row.collides && "text-destructive")}>
                  {row.newName}
                </span>
              </li>
            ))}
          </ul>
          {collides && <p className="text-destructive">Some new names are already taken.</p>}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!plan.ready || pending}>
              Rename
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
