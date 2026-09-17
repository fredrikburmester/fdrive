"use client";

import { cn } from "cn";
import type { ComponentProps } from "react";
import { Button } from "@/components/ui/button";

/**
 * The compact form of a live activity: a rounded pill with an icon and a
 * short label, sitting in the `LiveActivityDock` at the bottom right.
 * Pressing it opens whatever the activity is about (the activity panel, the
 * Organize sheet).
 */
export function ActivityPill({ className, ...props }: ComponentProps<typeof Button>) {
  return (
    <Button
      variant="outline"
      className={cn(
        "h-auto rounded-full bg-popover px-4 py-2 text-popover-foreground shadow-sm ring-1 ring-foreground/10",
        className,
      )}
      {...props}
    />
  );
}
