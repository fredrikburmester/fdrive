"use client";

import type { Tag } from "@fdrive/contracts";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { tagDotClassName } from "@/lib/metadata/colors";
import { cn } from "@/lib/utils";

const MAX_VISIBLE_DOTS = 3;

export interface TagDotsProps {
  /** Every tag known to the account; `tagIds` is filtered against this list
   * (an id with no matching tag, e.g. one deleted after this listing was
   * cached, is silently skipped). */
  readonly tags: readonly Tag[];
  readonly tagIds: readonly string[];
  readonly className?: string;
}

/**
 * Up to three small colored dots after a row's name, Finder-style, with a
 * tooltip listing every tagged name (not just the visible dots). Renders
 * nothing for an entry with no tags.
 */
export function TagDots({ tags, tagIds, className }: TagDotsProps) {
  const matched = tagIds
    .map((id) => tags.find((tag) => tag.id === id))
    .filter((tag): tag is Tag => tag !== undefined);

  if (matched.length === 0) {
    return null;
  }

  const visible = matched.slice(0, MAX_VISIBLE_DOTS);

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          // biome-ignore lint/a11y/useSemanticElements: this is a tooltip trigger's hit area, not a form's field group; a <fieldset> would be semantically wrong here.
          <span
            role="group"
            className={cn("inline-flex shrink-0 items-center gap-0.5", className)}
            aria-label={`Tags: ${matched.map((tag) => tag.name).join(", ")}`}
          />
        }
      >
        {visible.map((tag) => (
          <span key={tag.id} className={cn("size-1.5 rounded-full", tagDotClassName(tag.color))} />
        ))}
      </TooltipTrigger>
      <TooltipContent>{matched.map((tag) => tag.name).join(", ")}</TooltipContent>
    </Tooltip>
  );
}
