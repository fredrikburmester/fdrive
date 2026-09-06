"use client";

import type { Tag } from "@fdrive/contracts";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { TagColor } from "@/lib/metadata/colors";
import type { TagCheckState } from "@/lib/metadata/tag-set";
import { TagPickerContent } from "./tag-picker-content";

export interface TagsEditDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly count: number;
  readonly tags: readonly Tag[];
  readonly checkState: (tagId: string) => TagCheckState;
  readonly onToggle: (tagId: string, checked: boolean) => void;
  readonly onCreate: (name: string, color: TagColor) => void;
  readonly creating?: boolean;
}

/** "Edit tags…" from the row context menu: the same `TagPickerContent`
 * list, in a dialog instead of a popover so it survives the context menu
 * closing when it was opened. */
export function TagsEditDialog({
  open,
  onOpenChange,
  count,
  tags,
  checkState,
  onToggle,
  onCreate,
  creating,
}: TagsEditDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="p-0 sm:max-w-xs">
        <DialogHeader className="p-4 pb-0">
          <DialogTitle>Edit tags</DialogTitle>
          <DialogDescription>
            {count === 1 ? "Choose tags for this item." : `Choose tags for ${count} items.`}
          </DialogDescription>
        </DialogHeader>
        <div className="p-2 pt-0">
          <TagPickerContent
            tags={tags}
            checkState={checkState}
            onToggle={onToggle}
            onCreate={onCreate}
            creating={creating}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
