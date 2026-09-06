"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";

const MAX_LISTED_NAMES = 10;

export interface ConflictDialogProps {
  readonly open: boolean;
  /** Top-level names that already exist at the destination. */
  readonly conflicts: readonly string[];
  readonly onReplace: () => void;
  readonly onSkip: () => void;
  readonly onCancel: () => void;
}

/**
 * Asked once per batch when `planUploads` reports name collisions: replace
 * the existing items, skip the colliding ones and upload the rest, or
 * cancel the whole batch. Lists up to 10 names and a count for the rest.
 */
export function ConflictDialog({
  open,
  conflicts,
  onReplace,
  onSkip,
  onCancel,
}: ConflictDialogProps) {
  const shown = conflicts.slice(0, MAX_LISTED_NAMES);
  const hiddenCount = conflicts.length - shown.length;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          onCancel();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {conflicts.length} item{conflicts.length === 1 ? "" : "s"} already exist
            {conflicts.length === 1 ? "s" : ""}
          </DialogTitle>
          <DialogDescription>
            Choose whether to replace the existing items or skip them and upload the rest.
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-48">
          <ul className="space-y-1 text-sm">
            {shown.map((name) => (
              <li key={name} className="truncate rounded-md bg-muted px-2 py-1 text-foreground">
                {name}
              </li>
            ))}
          </ul>
        </ScrollArea>
        {hiddenCount > 0 && <p className="text-xs text-muted-foreground">and {hiddenCount} more</p>}

        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="outline" onClick={onSkip}>
            Skip
          </Button>
          <Button onClick={onReplace}>Replace</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
