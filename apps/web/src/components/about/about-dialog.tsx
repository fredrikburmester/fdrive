"use client";

import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { apiClient } from "@/lib/api/client";
import { describeApiError } from "@/lib/api/errors";
import { AboutSheet } from "./about-sheet";

/** `GET /about` as the account menu's sheet reads it. Nothing else in the browser asks for it. */
const ABOUT_QUERY_KEY = ["about"] as const;

export interface AboutDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * About fdrive as a narrow sheet over whatever page is open, for everyone who has no System to
 * find it in. It asks the API only while it is open, and again each time it opens, so the uptime
 * it shows is the uptime now.
 */
export function AboutDialog({ open, onOpenChange }: AboutDialogProps) {
  const query = useQuery({
    queryKey: ABOUT_QUERY_KEY,
    queryFn: () => apiClient.about(),
    enabled: open,
    staleTime: 0,
  });
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        aria-label="About fdrive"
        // The sheet inside brings its own heading, close button and padding.
        showCloseButton={false}
        className="gap-0 overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-[460px]"
      >
        <AboutSheet
          about={query.data}
          titleAs="h2"
          onClose={() => onOpenChange(false)}
          // The popup already draws the hairline on its left, and is as narrow as a docked sheet.
          className="md:border-l-0 md:px-6"
        >
          {query.isError ? (
            <div className="flex flex-col items-start gap-3">
              <p role="alert" className="text-destructive text-sm [overflow-wrap:anywhere]">
                {describeApiError(query.error)}
              </p>
              <Button
                variant="outline"
                className="max-md:min-h-11"
                onClick={() => void query.refetch()}
              >
                Retry
              </Button>
            </div>
          ) : (
            <p role="status" className="text-muted-foreground text-sm">
              Loading…
            </p>
          )}
        </AboutSheet>
      </SheetContent>
    </Sheet>
  );
}
