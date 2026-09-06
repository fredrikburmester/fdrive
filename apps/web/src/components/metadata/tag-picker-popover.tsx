"use client";

import type { Tag } from "@fdrive/contracts";
import { PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { TagColor } from "@/lib/metadata/colors";
import type { TagCheckState } from "@/lib/metadata/tag-set";
import { TagPickerContent } from "./tag-picker-content";

export interface TagPickerPopoverProps {
  readonly tags: readonly Tag[];
  readonly checkState: (tagId: string) => TagCheckState;
  readonly onToggle: (tagId: string, checked: boolean) => void;
  readonly onCreate: (name: string, color: TagColor) => void;
  readonly creating?: boolean;
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
}

/** The Inspector's "Add tag" trigger: a small button opening `TagPickerContent` in a popover. */
export function TagPickerPopover({
  tags,
  checkState,
  onToggle,
  onCreate,
  creating,
  open,
  onOpenChange,
}: TagPickerPopoverProps) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        render={
          <Button variant="outline" size="sm" className="h-7 gap-1 px-2 text-xs">
            <PlusIcon className="size-3.5" />
            Add tag
          </Button>
        }
      />
      <PopoverContent align="start" className="w-64 p-0">
        <TagPickerContent
          tags={tags}
          checkState={checkState}
          onToggle={onToggle}
          onCreate={onCreate}
          creating={creating}
        />
      </PopoverContent>
    </Popover>
  );
}
