"use client";

import { PublicUrlUpdateRequest } from "@fdrive/contracts";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { describeApiError } from "@/lib/api/errors";
import { useSystemPublicUrl, useUpdatePublicUrl } from "@/lib/api/public-url-queries";
import { SystemErrorState } from "./system-error-state";

/**
 * The address everyone opens fdrive at. Prefilled from the browser's own
 * address, which is right whenever the owner is onboarding from the address
 * others will use too (an HTTPS edge, or the LAN address).
 */
export function PublicUrlCard({
  onContinue,
  disabled = false,
}: {
  onContinue?: () => void;
  disabled?: boolean;
}) {
  const query = useSystemPublicUrl();
  const update = useUpdatePublicUrl();
  const [draft, setDraft] = useState<string | null>(null);
  const saved = query.data;
  const value = draft ?? saved?.url ?? (saved ? window.location.origin : "");
  const busy = disabled || update.isPending;
  const parsed = saved
    ? PublicUrlUpdateRequest.safeParse({ revision: saved.revision, url: value })
    : null;
  const unchanged =
    saved !== undefined && parsed?.success === true && parsed.data.url === saved.url;
  function save() {
    if (!parsed?.success) return;
    if (unchanged) {
      onContinue?.();
      return;
    }
    update.mutate(parsed.data, {
      onSuccess: () => {
        setDraft(null);
        onContinue?.();
      },
    });
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Server address</CardTitle>
        <CardDescription>
          The address everyone uses to open fdrive, including http:// or https:// and any port.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {query.isError ? (
          <>
            <SystemErrorState error={query.error} onRetry={() => void query.refetch()} />
            {onContinue ? (
              <Button variant="outline" disabled={busy} onClick={onContinue}>
                Continue without changing the address
              </Button>
            ) : null}
          </>
        ) : saved ? (
          <>
            <Field>
              <FieldLabel htmlFor="public-url">fdrive server address</FieldLabel>
              <Input
                id="public-url"
                type="url"
                value={value}
                disabled={busy}
                onChange={(event) => setDraft(event.target.value)}
              />
              <FieldDescription>
                Document editing is told this is where fdrive lives, and links from connected
                assistants point here. Behind an HTTPS reverse proxy this must be the https://
                address.
              </FieldDescription>
            </Field>
            {draft !== null && !parsed?.success ? (
              <p role="alert" className="text-sm text-destructive">
                Enter an address such as https://drive.example.com or http://192.168.1.10:8090,
                without a path.
              </p>
            ) : null}
            {update.isError ? (
              <div role="alert" className="text-sm text-destructive [overflow-wrap:anywhere]">
                {describeApiError(update.error)}
                <Button
                  variant="link"
                  onClick={() => {
                    setDraft(null);
                    update.reset();
                    void query.refetch();
                  }}
                >
                  Reload saved address
                </Button>
              </div>
            ) : null}
            <div className="flex justify-end">
              <Button disabled={busy || !parsed?.success} onClick={save}>
                {update.isPending
                  ? "Saving…"
                  : onContinue
                    ? "Save and continue"
                    : "Save server address"}
              </Button>
            </div>
          </>
        ) : (
          <p role="status">Loading server address…</p>
        )}
      </CardContent>
    </Card>
  );
}

export function PublicUrlReview() {
  const query = useSystemPublicUrl();
  return (
    <div className="flex justify-between gap-3 text-sm">
      <span>Server address</span>
      <span className="[overflow-wrap:anywhere]">
        {query.data
          ? (query.data.url ?? "Not set")
          : query.isError
            ? "Status unavailable"
            : "Loading…"}
      </span>
    </div>
  );
}
