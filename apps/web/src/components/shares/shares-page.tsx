"use client";

import type { FsEntry, ManagedShare } from "@fdrive/contracts";
import { Check, Copy, LinkIcon, LockIcon, Pencil, Trash2, TriangleAlertIcon } from "lucide-react";
import { useState } from "react";
import { SharedWithPeopleSection } from "@/components/grants/shared-with-people-section";
import { PageHeader } from "@/components/shell/page-header";
import {
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeader,
  DataTableRow,
  PageBar,
  PageBody,
  PageEmpty,
} from "@/components/shell/page-layout";
import { RowsSkeleton, RowText, TruncatedCell } from "@/components/shell/page-rows";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import { useIsMobile } from "@/hooks/use-mobile";
import { activityGesture } from "@/lib/activity/gestures";
import { describeApiError } from "@/lib/api/errors";
import { formatDate } from "@/lib/format";
import { useShareManagement } from "@/lib/shares/management";
import { publicShareHref } from "@/lib/shares/paths";
import { PRESENTATION_LABEL } from "@/lib/shares/presentation-label";
import { shareAccessLabel, shareItemLabel, shareUsage } from "@/lib/shares/status";
import { useFormatters } from "@/lib/use-format-preferences";
import { ShareDialog } from "./share-dialog";

/** "1 link" or "N links". */
function linkCountLabel(count: number): string {
  return `${count} ${count === 1 ? "link" : "links"}`;
}

/**
 * A link's name, with a lock beside it when it asks for a password. The name gives way first:
 * the lock always shows, and says "Password protected" where the page has the room.
 */
function ShareName({ share }: { share: ManagedShare }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="truncate">{share.name}</span>
      {share.hasPassword && (
        <span
          title="Password protected"
          className="flex shrink-0 items-center gap-1 text-muted-foreground text-xs"
        >
          <LockIcon className="size-3" aria-hidden="true" />
          <span className="sr-only @3xl:not-sr-only">Password protected</span>
        </span>
      )}
    </div>
  );
}

export function SharesPage() {
  const management = useShareManagement();
  const mobile = useIsMobile();
  const { prefs } = useFormatters();
  const [editing, setEditing] = useState<{ share: ManagedShare; entries: FsEntry[] } | null>(null);
  const [revoking, setRevoking] = useState<ManagedShare | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  async function edit(share: ManagedShare) {
    setError(null);
    try {
      setEditing({ share, entries: await management.entries(share.paths) });
    } catch {
      setError("Could not load the shared files. Refresh and try again.");
    }
  }
  async function copy(share: ManagedShare) {
    const report = activityGesture("share.copy_link", share.paths[0] ?? "/", share.id);
    try {
      await navigator.clipboard.writeText(
        new URL(publicShareHref(share.id), window.location.origin).href,
      );
      setCopied(share.id);
      void report().catch(() => undefined);
    } catch {
      setError("Could not copy the link.");
    }
  }
  async function revoke() {
    if (!revoking) return;
    setPending(true);
    setError(null);
    try {
      await management.revoke(revoking.id);
      setRevoking(null);
    } catch {
      setError("Could not revoke the link. Try again.");
    } finally {
      setPending(false);
    }
  }
  /** When a link stops working: a short date and time, with the full one as the cell's title. */
  function expiry(share: ManagedShare): { label: string; title: string | undefined } {
    if (!share.expiresAt) return { label: "Never", title: undefined };
    const date = new Date(share.expiresAt);
    return {
      label: formatDate(date, { style: "absolute", clock: prefs.clock }),
      title: date.toLocaleString(),
    };
  }
  const items = management.query.data?.items;
  /** A row's three actions; on a phone each is a larger tap target. */
  function actions(share: ManagedShare) {
    const size = mobile ? "icon-lg" : "icon-sm";
    return (
      <div className="flex items-center justify-end gap-0.5">
        <Button
          size={size}
          variant="ghost"
          aria-label={`Copy link for ${share.name}`}
          onClick={() => void copy(share)}
        >
          {copied === share.id ? <Check /> : <Copy />}
        </Button>
        {copied === share.id && (
          <span role="status" className="sr-only">
            Link copied
          </span>
        )}
        <Button
          size={size}
          variant="ghost"
          aria-label={`Edit ${share.name}`}
          onClick={() => void edit(share)}
        >
          <Pencil />
        </Button>
        <Button
          size={size}
          variant="ghost"
          aria-label={`Revoke ${share.name}`}
          onClick={() => {
            setError(null);
            setRevoking(share);
          }}
        >
          <Trash2 />
        </Button>
      </div>
    );
  }
  return (
    <>
      <PageHeader breadcrumbs={<h1 className="truncate font-medium text-sm">Shares</h1>} />
      {/* `PageBody` is a size container: the table drops its least important columns when narrow. */}
      <PageBody>
        <PageBar>
          {items !== undefined && (
            <span className="text-foreground">{linkCountLabel(items.length)}</span>
          )}
          <span>Select files or a folder in Files and choose Share to create a link.</span>
        </PageBar>
        {(error || management.query.isError) && (
          <div className="border-border/60 border-b p-3">
            <Alert variant="destructive">
              <TriangleAlertIcon />
              {error ? (
                <AlertTitle>{error}</AlertTitle>
              ) : (
                <>
                  <AlertTitle>Could not load share links</AlertTitle>
                  <AlertDescription>{describeApiError(management.query.error)}</AlertDescription>
                </>
              )}
            </Alert>
          </div>
        )}
        {management.query.isPending ? (
          <RowsSkeleton label="Loading links…" rows={3} />
        ) : management.query.isError ? null : items === undefined || items.length === 0 ? (
          // Not a flex container: the people section follows, so the empty state stays compact.
          <div>
            <PageEmpty
              icon={LinkIcon}
              title="No share links yet"
              description="Select files or a folder in Files and choose Share to create one."
            />
          </div>
        ) : (
          <DataTable className="table-fixed">
            <DataTableHeader>
              <DataTableRow>
                <DataTableHead>Name</DataTableHead>
                {!mobile && (
                  <>
                    <DataTableHead className="hidden w-[20%] @2xl:table-cell">Item</DataTableHead>
                    <DataTableHead className="w-24">Access</DataTableHead>
                    <DataTableHead className="hidden w-28 @4xl:table-cell">Shown as</DataTableHead>
                    <DataTableHead className="hidden w-40 @3xl:table-cell">Usage</DataTableHead>
                    <DataTableHead className="w-32">Expires</DataTableHead>
                  </>
                )}
                <DataTableHead
                  className={mobile ? "w-[8.5rem] text-right" : "w-[6.5rem] text-right"}
                >
                  Actions
                </DataTableHead>
              </DataTableRow>
            </DataTableHeader>
            <DataTableBody>
              {items.map((share) => {
                const expires = expiry(share);
                return (
                  <DataTableRow key={share.id} className={mobile ? "h-14" : undefined}>
                    {mobile ? (
                      <DataTableCell>
                        <RowText
                          name={share.name}
                          detail={[
                            shareAccessLabel(share.scope),
                            share.hasPassword ? "Password protected" : null,
                            shareItemLabel(share.paths),
                            share.expiresAt ? `Expires ${expires.label}` : "No expiry",
                            shareUsage(share),
                          ]
                            .filter((part) => part !== null)
                            .join(" · ")}
                        />
                      </DataTableCell>
                    ) : (
                      <>
                        <DataTableCell title={share.name}>
                          <ShareName share={share} />
                        </DataTableCell>
                        <TruncatedCell
                          title={shareItemLabel(share.paths)}
                          className="hidden text-muted-foreground text-xs @2xl:table-cell"
                        >
                          {shareItemLabel(share.paths)}
                        </TruncatedCell>
                        <DataTableCell>
                          <Badge variant="secondary">{shareAccessLabel(share.scope)}</Badge>
                        </DataTableCell>
                        <TruncatedCell className="hidden text-muted-foreground text-xs @4xl:table-cell">
                          {PRESENTATION_LABEL[share.presentation]}
                        </TruncatedCell>
                        <TruncatedCell className="hidden text-muted-foreground text-xs @3xl:table-cell">
                          {shareUsage(share)}
                        </TruncatedCell>
                        <TruncatedCell
                          title={expires.title}
                          className="text-muted-foreground text-xs"
                        >
                          {expires.label}
                        </TruncatedCell>
                      </>
                    )}
                    <DataTableCell>{actions(share)}</DataTableCell>
                  </DataTableRow>
                );
              })}
            </DataTableBody>
          </DataTable>
        )}
        {/*
         * The people section brings its own heading and table. Padded while it is a plain
         * block; flush once it is built from `PageSection`, which pads and borders itself.
         */}
        <div className="border-border border-t px-3 py-4 has-[>[data-slot=page-section]]:p-0">
          <SharedWithPeopleSection />
        </div>
      </PageBody>
      {editing && (
        <ShareDialog
          entries={editing.entries}
          share={editing.share}
          onClose={() => setEditing(null)}
        />
      )}
      <AlertDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open && !pending) setRevoking(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke {revoking?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This link will stop working. The original files remain in your storage.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error && <FieldError>{error}</FieldError>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending}
              onClick={(event) => {
                event.preventDefault();
                void revoke();
              }}
            >
              {pending ? "Revoking…" : "Revoke link"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
