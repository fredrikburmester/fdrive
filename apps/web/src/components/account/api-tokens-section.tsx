"use client";

import type { ApiTokenSummary } from "@fdrive/contracts";
import { cn } from "cn";
import { useState } from "react";
import { DetailSheet } from "@/components/shell/list-sheet";
import { useShellMe } from "@/components/shell/page-header";
import {
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeader,
  DataTableRow,
} from "@/components/shell/page-layout";
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
import { Skeleton } from "@/components/ui/skeleton";
import { formatExpires, formatLastUsed, formatShortDate } from "@/lib/account/format";
import { useApiTokens, useRevokeApiToken } from "@/lib/account/queries";
import { CreateTokenDialog, TOKEN_ACCESS_LABELS } from "./create-token-dialog";
import { type CreatedToken, TokenCreatedDialog } from "./token-created-dialog";

/**
 * The table fits the sheet by the sheet's own width, since the sidebar and the section list take
 * theirs from the window first. A narrow sheet (a phone, a small window) shows a token's name
 * over a line with its access and expiry, and Revoke. Wider sheets bring those out as columns
 * along with the folders, then when the token was last used, then when it was created.
 */
const FROM_36REM = "@max-xl:hidden";
const FROM_48REM = "@max-3xl:hidden";
const FROM_64REM = "@max-5xl:hidden";
/** The line under the name, which goes when its columns come. */
const UNTIL_36REM = "@xl:hidden";

/** A token's access and expiry in one line, for the sheet too narrow for their columns. */
function accessAndExpiry(token: ApiTokenSummary): string {
  const expiry =
    token.expiresAt === null ? "Never expires" : `Expires ${formatExpires(token.expiresAt)}`;
  return `${TOKEN_ACCESS_LABELS[token.access.mode]} · ${expiry}`;
}

/** Settings > API tokens: the signed-in account's API tokens (MCP, Raycast). */
export function ApiTokensSection() {
  const { data: me } = useShellMe();
  const { data, isLoading } = useApiTokens();
  const revokeToken = useRevokeApiToken();
  const [createOpen, setCreateOpen] = useState(false);
  const [created, setCreated] = useState<CreatedToken | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<ApiTokenSummary | null>(null);

  const tokens = data?.items ?? [];

  return (
    <>
      <DetailSheet
        title="API tokens"
        lede="Long-lived tokens for Claude (MCP) and Raycast."
        actions={
          <Button type="button" disabled={me === undefined} onClick={() => setCreateOpen(true)}>
            Create token
          </Button>
        }
      >
        {isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : tokens.length === 0 ? (
          <div data-slot="sheet-empty" className="flex max-w-prose flex-col gap-1 text-sm">
            <p className="font-medium">No tokens yet.</p>
            <p className="text-muted-foreground">
              Create one to connect Claude or Raycast to your files.
            </p>
          </div>
        ) : (
          <DataTable className="table-fixed">
            <DataTableHeader>
              <DataTableRow>
                <DataTableHead>Name</DataTableHead>
                <DataTableHead className={cn("w-36", FROM_36REM)}>Access</DataTableHead>
                <DataTableHead className={FROM_36REM}>Folders</DataTableHead>
                <DataTableHead className={cn("w-28", FROM_64REM)}>Created</DataTableHead>
                <DataTableHead className={cn("w-28", FROM_48REM)}>Last used</DataTableHead>
                <DataTableHead className={cn("w-28", FROM_36REM)}>Expires</DataTableHead>
                <DataTableHead className="w-24 text-right">Actions</DataTableHead>
              </DataTableRow>
            </DataTableHeader>
            <DataTableBody>
              {tokens.map((token) => {
                const folders = token.access.paths.join(", ");
                return (
                  <DataTableRow key={token.id}>
                    <DataTableCell>
                      <span data-slot="token-name" className="block truncate" title={token.name}>
                        {token.name}
                      </span>
                      <span
                        data-slot="token-summary"
                        className={cn(
                          "block whitespace-normal font-normal text-muted-foreground text-xs",
                          UNTIL_36REM,
                        )}
                      >
                        {accessAndExpiry(token)}
                      </span>
                    </DataTableCell>
                    <DataTableCell className={cn("truncate", FROM_36REM)}>
                      {TOKEN_ACCESS_LABELS[token.access.mode]}
                    </DataTableCell>
                    <DataTableCell className={cn("text-muted-foreground", FROM_36REM)}>
                      <span className="block truncate" title={folders}>
                        {folders}
                      </span>
                    </DataTableCell>
                    <DataTableCell className={cn("text-muted-foreground tabular-nums", FROM_64REM)}>
                      {formatShortDate(token.createdAt)}
                    </DataTableCell>
                    <DataTableCell className={cn("text-muted-foreground tabular-nums", FROM_48REM)}>
                      {formatLastUsed(token.lastUsedAt)}
                    </DataTableCell>
                    <DataTableCell className={cn("text-muted-foreground tabular-nums", FROM_36REM)}>
                      {formatExpires(token.expiresAt)}
                    </DataTableCell>
                    <DataTableCell className="text-right">
                      <Button
                        type="button"
                        variant="destructive"
                        className="max-md:min-h-11"
                        onClick={() => setRevokeTarget(token)}
                      >
                        Revoke
                      </Button>
                    </DataTableCell>
                  </DataTableRow>
                );
              })}
            </DataTableBody>
          </DataTable>
        )}
      </DetailSheet>

      <CreateTokenDialog
        key={String(createOpen)}
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(result) => {
          setCreateOpen(false);
          setCreated(result);
        }}
      />

      <TokenCreatedDialog created={created} onClose={() => setCreated(null)} />

      <AlertDialog
        open={revokeTarget !== null}
        onOpenChange={(open) => (open ? undefined : setRevokeTarget(null))}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke "{revokeTarget?.name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              Any client using this token (Claude, Raycast) will lose access immediately. This
              cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (revokeTarget) {
                  revokeToken.mutate(revokeTarget.id);
                }
                setRevokeTarget(null);
              }}
            >
              Revoke
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
