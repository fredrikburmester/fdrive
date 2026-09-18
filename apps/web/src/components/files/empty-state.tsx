import { FolderOpenIcon, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export interface EmptyStateProps {
  title?: string;
  description?: string;
  action?: ReactNode;
  /** The pictogram above the title; a folder unless the page has nothing to do with folders. */
  icon?: LucideIcon;
}

/** Shown in place of the listing when a folder has no entries. */
export function EmptyState({
  title = "This folder is empty",
  description = "Drop files here, or use Upload to add some.",
  action,
  icon: Icon = FolderOpenIcon,
}: EmptyStateProps) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      <Icon className="size-10 text-muted-foreground/60" aria-hidden="true" />
      <div className="space-y-1">
        <p className="font-medium text-sm">{title}</p>
        <p className="text-muted-foreground text-sm">{description}</p>
      </div>
      {action}
    </div>
  );
}
