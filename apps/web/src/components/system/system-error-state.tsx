import { TriangleAlertIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { describeApiError } from "@/lib/api/errors";

export interface SystemErrorStateProps {
  /** The error thrown by the failed query, passed straight to `describeApiError`. */
  error: unknown;
  /** Re-runs the query, typically the `refetch` returned by the `useQuery` hook. */
  onRetry: () => void;
}

/**
 * Shown in place of a System page's content when its query has failed, so a
 * failed or unparsable response is visibly distinct from the page still
 * loading and from data actually being ready.
 */
export function SystemErrorState({ error, onRetry }: SystemErrorStateProps) {
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
