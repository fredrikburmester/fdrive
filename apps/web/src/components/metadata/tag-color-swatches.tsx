"use client";

import { Button } from "@/components/ui/button";
import {
  TAG_COLOR_LABELS,
  TAG_COLORS,
  type TagColor,
  tagDotClassName,
} from "@/lib/metadata/colors";
import { cn } from "@/lib/utils";

const CHOICES: readonly TagColor[] = [...TAG_COLORS, "none"];

export interface TagColorSwatchesProps {
  readonly value: TagColor;
  readonly onChange: (color: TagColor) => void;
}

/** A row of the fixed tag color palette, each a plain (shadcn) `Button`
 * tinted with that color; the selected swatch gets a ring. */
export function TagColorSwatches({ value, onChange }: TagColorSwatchesProps) {
  return (
    <div role="radiogroup" aria-label="Tag color" className="flex flex-wrap gap-1.5">
      {CHOICES.map((color) => (
        <Button
          key={color}
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-pressed={value === color}
          aria-label={TAG_COLOR_LABELS[color]}
          onClick={() => onChange(color)}
          className={cn(
            "size-6 rounded-full p-0 hover:opacity-80",
            tagDotClassName(color === "none" ? null : color),
            value === color && "ring-2 ring-ring ring-offset-2 ring-offset-background",
          )}
        />
      ))}
    </div>
  );
}
