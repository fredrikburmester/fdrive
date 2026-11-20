"use client";

import type { FsEntry, ManagedShare } from "@fdrive/contracts";
import { useQuery } from "@tanstack/react-query";
import { cn } from "cn";
import { Check, Copy } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { useState } from "react";
import { DetailSheet } from "@/components/shell/list-sheet";
import { PageSection, SettingActions } from "@/components/shell/page-layout";
import { PHONE_TARGET } from "@/components/shell/page-rows";
import { Code, type Fact, FactList } from "@/components/shell/sheet-data";
import { StatusBadge } from "@/components/shell/status";
import type { RowSheetProps } from "@/components/shell/use-sheet-row";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { pathToHref, returnHref } from "@/lib/files/path-url";
import { formatDate } from "@/lib/format";
import { useShareManagement } from "@/lib/shares/management";
import { shareItemLabel, shareUsage } from "@/lib/shares/status";
import { useFormatters } from "@/lib/use-format-preferences";
import { ShareFormFields, useShareForm } from "./share-form";
import {
  copyShareLink,
  type ShareState,
  sharedPathInTrash,
  shareLinkUrl,
  shareState,
} from "./share-link";

/** How many shared items the sheet names before it only counts the rest. */
const SHOWN_ITEMS = 20;

/** One line saying who can do what with the link, or why it no longer works. */
function shareLede(share: ManagedShare, state: ShareState): string {
  if (state.label === "In Trash")
    return "This link does not work while what it shares is in Trash.";
  if (state.label === "Expired") return "This link stopped working when it expired.";
  if (state.label === "Limit reached")
    return "This link stopped working when it reached its limit.";
  const who = share.hasPassword ? "Anyone with the link and its password" : "Anyone with the link";
  return share.scope === "write"
    ? `${who} can upload files, without seeing what is there.`
    : `${who} can view and download.`;
}

/** Where a shared item is in Files: inside a folder, or in its own folder with the item selected. */
function filesHref(path: string, entry: FsEntry | undefined): Route {
  return (
    path === "/" || entry?.kind === "dir" ? pathToHref(path) : returnHref(path, null)
  ) as Route;
}

/** The link's settings, as the form the file browser's dialog also uses. */
function ShareSettings({ share, entries }: { share: ManagedShare; entries: readonly FsEntry[] }) {
  const form = useShareForm({ entries, share, onSaved: () => undefined });
  return (
    <form onSubmit={(event) => void form.submit(event)}>
      <ShareFormFields form={form} layout="sheet" />
      <SettingActions>
        {form.error ? <FieldError className="mr-auto">{form.error}</FieldError> : null}
        {form.saved ? (
          <span role="status" className="mr-auto text-muted-foreground text-sm">
            Changes saved
          </span>
        ) : null}
        <Button type="submit" className={PHONE_TARGET} disabled={form.pending || !form.dirty}>
          {form.pending ? "Saving…" : "Save changes"}
        </Button>
      </SettingActions>
    </form>
  );
}

export interface ShareSheetProps extends RowSheetProps {
  share: ManagedShare;
  /** Asks before revoking: the page owns the confirmation. */
  onRevoke: () => void;
}

/**
 * A link's sheet on the Shares page: its address, what it shares, how it has been used and its
 * settings, with revoking apart in the footer. Give it the link's id as `key`, so another row's
 * sheet starts from that row.
 */
export function ShareSheet({ share, onRevoke, ...sheet }: ShareSheetProps) {
  const { prefs } = useFormatters();
  const management = useShareManagement();
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  const state = shareState(share);
  // A link whose files are in Trash cannot be changed until they are restored.
  const trashed = state.label === "In Trash";
  // The settings need to know what the shared paths are now: only a folder can take uploads.
  const entries = useQuery({
    queryKey: ["shares", "entries", share.id, share.paths],
    queryFn: () => management.entries(share.paths),
    enabled: !trashed,
    retry: false,
    staleTime: 0,
  });
  const when = (iso: string) =>
    formatDate(new Date(iso), { style: "absolute", clock: prefs.clock });
  const facts: Fact[] = [
    { label: "Created", value: when(share.createdAt) },
    ...(share.updatedAt === share.createdAt
      ? []
      : [{ label: "Changed", value: when(share.updatedAt) }]),
    { label: "Expires", value: share.expiresAt === null ? "Never" : when(share.expiresAt) },
    { label: "Usage", value: shareUsage(share) },
  ];

  async function copyLink() {
    try {
      await copyShareLink(share);
      setCopy("copied");
    } catch {
      setCopy("failed");
    }
  }

  return (
    <DetailSheet
      width="docked"
      titleAs="h2"
      title={share.name}
      lede={shareLede(share, state)}
      badges={
        <>
          <StatusBadge tone={state.tone}>{state.label}</StatusBadge>
          {share.hasPassword ? <StatusBadge>Password protected</StatusBadge> : null}
        </>
      }
      footer={
        <>
          <p className="min-w-0 flex-[1_1_12rem] text-muted-foreground">
            Revoking stops the link. The original files remain in your storage.
          </p>
          <Button variant="destructive" className={cn("ml-auto", PHONE_TARGET)} onClick={onRevoke}>
            Revoke link
          </Button>
        </>
      }
      className="outline-hidden"
      {...sheet}
    >
      <PageSection title="Link">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            aria-label="Share link"
            className={cn("min-w-40 flex-1", PHONE_TARGET)}
            readOnly
            value={shareLinkUrl(share.id)}
          />
          <Button variant="outline" className={PHONE_TARGET} onClick={() => void copyLink()}>
            {copy === "copied" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
            Copy link
          </Button>
        </div>
        {copy === "copied" ? (
          <span role="status" className="sr-only">
            Link copied
          </span>
        ) : null}
        {copy === "failed" ? (
          <FieldError className="mt-2">
            Could not copy the link. Select and copy it above.
          </FieldError>
        ) : null}
      </PageSection>

      <PageSection title={share.paths.length === 1 ? "Shared item" : "Shared items"}>
        <ul className="flex flex-col gap-3">
          {share.paths.slice(0, SHOWN_ITEMS).map((path, index) => {
            const name = shareItemLabel([path]);
            // Where an item lies inside Trash is fdrive's own bookkeeping, not a place to show.
            const inTrash = sharedPathInTrash(path);
            return (
              <li key={path} className="flex items-start justify-between gap-4 text-sm">
                <div className="min-w-0">
                  <p className="font-medium [overflow-wrap:anywhere]">{name}</p>
                  {inTrash ? (
                    <p className="text-muted-foreground">In Trash</p>
                  ) : (
                    <Code className="text-muted-foreground [overflow-wrap:anywhere]">{path}</Code>
                  )}
                </div>
                <Link
                  href={inTrash ? ("/trash" as Route) : filesHref(path, entries.data?.[index])}
                  aria-label={inTrash ? `Find ${name} in Trash` : `Open ${name} in Files`}
                  className="shrink-0 underline underline-offset-4"
                >
                  {inTrash ? "Open Trash" : "Open in Files"}
                </Link>
              </li>
            );
          })}
        </ul>
        {share.paths.length > SHOWN_ITEMS ? (
          <p className="mt-3 text-muted-foreground text-sm">
            And {share.paths.length - SHOWN_ITEMS} more.
          </p>
        ) : null}
      </PageSection>

      <PageSection title="Details">
        <FactList facts={facts} />
      </PageSection>

      <PageSection title="Settings">
        {trashed ? (
          <p className="border-border border-t pt-4.5 text-muted-foreground text-sm">
            Restore what this link shares from Trash to change its settings.
          </p>
        ) : entries.isPending ? (
          <div role="status" className="flex flex-col gap-3 border-border border-t pt-4.5">
            <span className="sr-only">Loading settings…</span>
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-4 w-1/4" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : entries.isError ? (
          <FieldError className="border-border border-t pt-4.5">
            Could not load the shared files. Refresh and try again.
          </FieldError>
        ) : (
          <ShareSettings share={share} entries={entries.data} />
        )}
      </PageSection>
    </DetailSheet>
  );
}
