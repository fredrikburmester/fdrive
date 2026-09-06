import { TriangleAlertIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

export interface ErrorStateProps {
  message: string;
  onRetry?: () => void;
}

/** Shown in place of the listing when it failed to load. */
export function ErrorState({ message, onRetry }: ErrorStateProps) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      <TriangleAlertIcon className="size-10 text-destructive/70" aria-hidden="true" />
      <div className="space-y-1">
        <p className="font-medium text-sm">Could not load this folder</p>
        <p className="text-muted-foreground text-sm">{message}</p>
      </div>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}
