"use client";

import { StarIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface FavoriteToggleRowProps {
  readonly favorite: boolean;
  readonly onToggle: (next: boolean) => void;
  readonly pending?: boolean;
}

/** The Inspector's "Favorite" row: a label and a star toggle button. */
export function FavoriteToggleRow({ favorite, onToggle, pending = false }: FavoriteToggleRowProps) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm font-medium">Favorite</span>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-pressed={favorite}
        aria-label={favorite ? "Remove from Favorites" : "Add to Favorites"}
        disabled={pending}
        onClick={() => onToggle(!favorite)}
      >
        <StarIcon
          className={cn(
            "size-4",
            favorite ? "fill-current text-tag-yellow" : "text-muted-foreground",
          )}
        />
      </Button>
    </div>
  );
}
