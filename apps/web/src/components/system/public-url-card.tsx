"use client";

import { PublicUrlUpdateRequest } from "@fdrive/contracts";
import { useState } from "react";
import { SettingRow } from "@/components/shell/page-layout";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { describeApiError } from "@/lib/api/errors";
import { useSystemPublicUrl, useUpdatePublicUrl } from "@/lib/api/public-url-queries";
import { SystemErrorState } from "./system-error-state";
import { SystemAlert, SystemLine, SystemSection, useSystemSurface } from "./system-section";

const ADDRESS_SUMMARY =
  "The address everyone uses to open fdrive, including http:// or https:// and any port.";
const PROXY_NOTE = "Behind an HTTPS reverse proxy this must be the https:// address.";
/** What the walkthrough says under the field, where there is room to say why it matters. */
const ADDRESS_NOTE = `Document editing is told this is where fdrive lives, and links from connected assistants point here. ${PROXY_NOTE}`;

/**
 * The address everyone opens fdrive at. Prefilled from the browser's own
 * address, which is right whenever the owner is onboarding from the address
 * others will use too (an HTTPS edge, or the LAN address). On System > General
 * it is one setting row with its own Save; in the setup walkthrough it is a
 * card that saves and moves on.
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
  const card = useSystemSurface() === "card";
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
  const input = (
    <Input
      id="public-url"
      type="url"
      className={card ? undefined : "min-w-0 flex-1 max-md:min-h-11"}
      value={value}
      disabled={busy}
      onChange={(event) => setDraft(event.target.value)}
    />
  );
  const problems = (
    <>
      {draft !== null && !parsed?.success ? (
        <SystemAlert className={card ? undefined : "mt-1.5"}>
          Enter an address such as https://drive.example.com or http://192.168.1.10:8090, without a
          path.
        </SystemAlert>
      ) : null}
      {update.isError ? (
        <SystemAlert className={card ? undefined : "mt-1.5"}>
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
        </SystemAlert>
      ) : null}
    </>
  );

  if (!card) {
    if (query.isError) {
      return (
        <SystemErrorState
          row
          title="Couldn't load the server address"
          error={query.error}
          onRetry={() => void query.refetch()}
        />
      );
    }
    if (saved === undefined) {
      return (
        <SystemLine role="status" className="border-border border-t py-4.5">
          Loading server address…
        </SystemLine>
      );
    }
    return (
      <SettingRow
        label="Server address"
        htmlFor="public-url"
        description={`${ADDRESS_SUMMARY} ${PROXY_NOTE}`}
      >
        <div className="flex items-center gap-2">
          {input}
          {/* One of several Saves on the sheet, so it says which one to assistive technology. */}
          <Button
            variant="outline"
            className="max-md:min-h-11"
            aria-label={update.isPending ? undefined : "Save server address"}
            // Nothing to save while the field holds the saved address.
            disabled={busy || !parsed?.success || unchanged}
            onClick={save}
          >
            {update.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
        {problems}
      </SettingRow>
    );
  }

  return (
    <SystemSection title="Server address" description={ADDRESS_SUMMARY} contentClassName="gap-4">
      {query.isError ? (
        <>
          <SystemErrorState
            title="Couldn't load the server address"
            error={query.error}
            onRetry={() => void query.refetch()}
          />
          {onContinue ? (
            <Button variant="outline" disabled={busy} onClick={onContinue}>
              Continue without changing the address
            </Button>
          ) : null}
        </>
      ) : saved ? (
        <>
          <Field>
            <FieldLabel htmlFor="public-url">Server address</FieldLabel>
            {input}
            <FieldDescription>{ADDRESS_NOTE}</FieldDescription>
          </Field>
          {problems}
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
    </SystemSection>
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
