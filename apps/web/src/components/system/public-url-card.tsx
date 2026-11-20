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

const ADDRESS_NOTE =
  "Document editing is told this is where fdrive lives, and links from connected assistants point here. Behind an HTTPS reverse proxy this must be the https:// address.";

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
      className={card ? undefined : "min-w-0 max-w-sm flex-1 basis-56 max-md:min-h-11"}
      value={value}
      disabled={busy}
      onChange={(event) => setDraft(event.target.value)}
    />
  );
  const saveButton = (
    <Button
      className={card ? undefined : "max-md:min-h-11"}
      disabled={busy || !parsed?.success}
      onClick={save}
    >
      {update.isPending ? "Saving…" : onContinue ? "Save and continue" : "Save server address"}
    </Button>
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
  return (
    <SystemSection
      title="Server address"
      description="The address everyone uses to open fdrive, including http:// or https:// and any port."
      contentClassName="gap-4"
    >
      {query.isError ? (
        <>
          <SystemErrorState error={query.error} onRetry={() => void query.refetch()} />
          {onContinue ? (
            <div className={card ? "contents" : "px-3 py-2.5"}>
              <Button variant="outline" disabled={busy} onClick={onContinue}>
                Continue without changing the address
              </Button>
            </div>
          ) : null}
        </>
      ) : saved ? (
        card ? (
          <>
            <Field>
              <FieldLabel htmlFor="public-url">Server address</FieldLabel>
              {input}
              <FieldDescription>{ADDRESS_NOTE}</FieldDescription>
            </Field>
            {problems}
            <div className="flex justify-end">{saveButton}</div>
          </>
        ) : (
          <SettingRow label="Server address" htmlFor="public-url" description={ADDRESS_NOTE}>
            <div className="flex flex-wrap items-center gap-2">
              {input}
              {saveButton}
            </div>
            {problems}
          </SettingRow>
        )
      ) : card ? (
        <p role="status">Loading server address…</p>
      ) : (
        <SystemLine role="status">Loading server address…</SystemLine>
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
