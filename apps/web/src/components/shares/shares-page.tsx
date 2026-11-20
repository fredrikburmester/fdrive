"use client";

import type { ManagedShare } from "@fdrive/contracts";
import { cn } from "cn";
import { Check, Copy, LinkIcon, LockIcon, Trash2, TriangleAlertIcon } from "lucide-react";
import { useState } from "react";
import { SharedWithPeopleSection } from "@/components/grants/shared-with-people-section";
import { SheetDock } from "@/components/shell/list-sheet";
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
import { StatusBadge } from "@/components/shell/status";
import { CHOSEN_NAME, SHEET_ROW, useSheetRow } from "@/components/shell/use-sheet-row";
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
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import { useIsMobile } from "@/hooks/use-mobile";
import { describeApiError } from "@/lib/api/errors";
import { formatDate } from "@/lib/format";
import { useShareManagement } from "@/lib/shares/management";
import { PRESENTATION_LABEL } from "@/lib/shares/presentation-label";
import { shareAccessLabel, shareItemLabel, shareUsage } from "@/lib/shares/status";
import { useFormatters } from "@/lib/use-format-preferences";
import { copyShareLink, shareExpired } from "./share-link";
import { ShareSheet } from "./share-sheet";

const NO_SHARES: readonly ManagedShare[] = [];

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
          className="flex shrink-0 items-center gap-1 font-normal text-muted-foreground text-xs"
        >
          <LockIcon className="size-3" aria-hidden="true" />
          <span className="sr-only @3xl:not-sr-only">Password protected</span>
        </span>
      )}
    </div>
  );
}

/**
 * The login's public links as rows, and under them the folders it shares with people. Choosing
 * a link opens its sheet beside the rows: its address, what it shares and its settings.
 */
export function SharesPage() {
  const management = useShareManagement();
  const mobile = useIsMobile();
  const { prefs } = useFormatters();
  const [revoking, setRevoking] = useState<ManagedShare | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const items = management.query.data?.items;
  // A listing that failed shows no rows, so it has no row to keep a sheet open for.
  const sheet = useSheetRow(management.query.isError ? NO_SHARES : (items ?? NO_SHARES));
  async function copy(share: ManagedShare) {
    try {
      await copyShareLink(share);
      setCopied(share.id);
    } catch {
      setError("Could not copy the link.");
    }
  }
  function askToRevoke(share: ManagedShare) {
    setError(null);
    setRevoking(share);
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
  /** A row's own actions, beside choosing it; on a phone each is a larger tap target. */
  function actions(share: ManagedShare) {
    const size = mobile ? "icon-lg" : "icon-sm";
    return (
      <div className="flex items-center justify-end gap-0.5">
        <Button
          size={size}
          variant="ghost"
          className="max-md:size-11"
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
          className="max-md:size-11"
          aria-label={`Revoke ${share.name}`}
          onClick={() => askToRevoke(share)}
        >
          <Trash2 />
        </Button>
      </div>
    );
  }
  const chosen = sheet.chosen;
  return (
    <>
      <PageHeader breadcrumbs={<h1 className="truncate font-medium text-sm">Shares</h1>} />
      <SheetDock
        sheet={
          chosen !== null ? (
            <ShareSheet
              key={chosen.id}
              share={chosen}
              onRevoke={() => askToRevoke(chosen)}
              {...sheet.sheetProps}
            />
          ) : null
        }
      >
        {/*
         * `PageBody` is a size container: the table drops its least important columns when narrow,
         * as it is beside an open sheet, which shows them all.
         */}
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
                      <DataTableHead className="hidden w-24 @md:table-cell">Access</DataTableHead>
                      <DataTableHead className="hidden w-28 @4xl:table-cell">
                        Shown as
                      </DataTableHead>
                      <DataTableHead className="hidden w-40 @3xl:table-cell">Usage</DataTableHead>
                      <DataTableHead className="hidden w-32 @sm:table-cell">Expires</DataTableHead>
                    </>
                  )}
                  <DataTableHead className={mobile ? "w-[6.75rem] text-right" : "w-20 text-right"}>
                    Actions
                  </DataTableHead>
                </DataTableRow>
              </DataTableHeader>
              <DataTableBody>
                {items.map((share) => {
                  const expires = expiry(share);
                  const expired = shareExpired(share);
                  return (
                    <DataTableRow
                      key={share.id}
                      {...sheet.rowProps(share.id)}
                      className={cn(SHEET_ROW, mobile && "h-14")}
                    >
                      {mobile ? (
                        <DataTableCell>
                          <RowText
                            name={<span className={CHOSEN_NAME}>{share.name}</span>}
                            detail={[
                              shareAccessLabel(share.scope),
                              share.hasPassword ? "Password protected" : null,
                              shareItemLabel(share.paths),
                              expired
                                ? "Expired"
                                : share.expiresAt
                                  ? `Expires ${expires.label}`
                                  : "No expiry",
                              shareUsage(share),
                            ]
                              .filter((part) => part !== null)
                              .join(" · ")}
                          />
                        </DataTableCell>
                      ) : (
                        <>
                          <DataTableCell title={share.name} className={CHOSEN_NAME}>
                            <ShareName share={share} />
                          </DataTableCell>
                          <TruncatedCell
                            title={shareItemLabel(share.paths)}
                            className="hidden text-muted-foreground text-xs @2xl:table-cell"
                          >
                            {shareItemLabel(share.paths)}
                          </TruncatedCell>
                          <DataTableCell className="hidden @md:table-cell">
                            <StatusBadge>{shareAccessLabel(share.scope)}</StatusBadge>
                          </DataTableCell>
                          <TruncatedCell className="hidden text-muted-foreground text-xs @4xl:table-cell">
                            {PRESENTATION_LABEL[share.presentation]}
                          </TruncatedCell>
                          <TruncatedCell className="hidden text-muted-foreground text-xs @3xl:table-cell">
                            {shareUsage(share)}
                          </TruncatedCell>
                          <TruncatedCell
                            title={expires.title}
                            className="hidden text-muted-foreground text-xs @sm:table-cell"
                          >
                            {expired ? (
                              <StatusBadge tone="warning">Expired</StatusBadge>
                            ) : (
                              expires.label
                            )}
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
          {/* The people section brings its own heading and table, and pads and borders itself. */}
          <div className="border-border border-t">
            <SharedWithPeopleSection />
          </div>
        </PageBody>
      </SheetDock>
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
