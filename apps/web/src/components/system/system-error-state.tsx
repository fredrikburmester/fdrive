"use client";

import { TriangleAlertIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { describeApiError } from "@/lib/api/errors";
import { useSystemSurface } from "./system-section";

export interface SystemErrorStateProps {
  /** The error thrown by the failed query, passed straight to `describeApiError`. */
  error: unknown;
  /** Re-runs the query, typically the `refetch` returned by the `useQuery` hook. */
  onRetry: () => void;
}

/**
 * Shown in place of a System page's content when its query has failed, so a
 * failed or unparsable response is visibly distinct from the page still
 * loading and from data actually being ready. On a page it is one flat row;
 * in the setup walkthrough it is a card.
 */
export function SystemErrorState({ error, onRetry }: SystemErrorStateProps) {
  const surface = useSystemSurface();
  if (surface === "card") {
    return (
      <Card>
        <CardContent>
          <Alert variant="destructive">
            <TriangleAlertIcon />
            <AlertTitle>Couldn't load this page</AlertTitle>
            <AlertDescription>{describeApiError(error)}</AlertDescription>
          </Alert>
          <div className="mt-4 flex justify-end">
            <Button type="button" variant="outline" onClick={onRetry}>
              Retry
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }
  return (
    <div
      data-slot="system-error"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 border-border/60 border-b px-3 py-2.5 last:border-b-0"
    >
      <TriangleAlertIcon className="size-4 shrink-0 text-destructive" aria-hidden="true" />
      <div role="alert" className="min-w-0 flex-1 basis-48">
        <p className="font-medium text-destructive text-sm">Couldn't load this page</p>
        <p className="text-muted-foreground text-xs [overflow-wrap:anywhere]">
          {describeApiError(error)}
        </p>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="max-md:min-h-11"
        onClick={onRetry}
      >
        Retry
      </Button>
    </div>
  );
}
