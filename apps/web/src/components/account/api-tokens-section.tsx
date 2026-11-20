"use client";

import type { ApiTokenSummary } from "@fdrive/contracts";
import { cn } from "cn";
import { KeyRound, PlusIcon } from "lucide-react";
import { useState } from "react";
import { useShellMe } from "@/components/shell/page-header";
import {
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeader,
  DataTableRow,
  PageEmpty,
  PageSection,
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

/** Columns a phone leaves out, so a token's name, access, expiry and Revoke fit its width. */
const WIDE_ONLY = "max-sm:hidden";

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
      <PageSection
        title="API tokens"
        description="Long-lived tokens for Claude (MCP) and Raycast."
        actions={
          <Button
            type="button"
            size="sm"
            disabled={me === undefined}
            onClick={() => setCreateOpen(true)}
          >
            <PlusIcon />
            Create token
          </Button>
        }
      >
        {isLoading ? (
          <div className="p-3">
            <Skeleton className="h-24 w-full" />
          </div>
        ) : tokens.length === 0 ? (
          <PageEmpty
            icon={KeyRound}
            title="No tokens yet."
            description="Create one to connect Claude or Raycast to your files."
          />
        ) : (
          <DataTable>
            <DataTableHeader>
              <DataTableRow>
                <DataTableHead>Name</DataTableHead>
                <DataTableHead>Access</DataTableHead>
                <DataTableHead className={WIDE_ONLY}>Folders</DataTableHead>
                <DataTableHead className={WIDE_ONLY}>Created</DataTableHead>
                <DataTableHead className={WIDE_ONLY}>Last used</DataTableHead>
                <DataTableHead>Expires</DataTableHead>
                <DataTableHead className="text-right">Actions</DataTableHead>
              </DataTableRow>
            </DataTableHeader>
            <DataTableBody>
              {tokens.map((token) => (
                <DataTableRow key={token.id}>
                  <DataTableCell className="max-w-40 truncate font-medium sm:max-w-64">
                    {token.name}
                  </DataTableCell>
                  <DataTableCell>{TOKEN_ACCESS_LABELS[token.access.mode]}</DataTableCell>
                  <DataTableCell className={cn("max-w-64 text-muted-foreground", WIDE_ONLY)}>
                    <span className="block truncate" title={token.access.paths.join(", ")}>
                      {token.access.paths.join(", ")}
                    </span>
                  </DataTableCell>
                  <DataTableCell className={cn("text-muted-foreground tabular-nums", WIDE_ONLY)}>
                    {formatShortDate(token.createdAt)}
                  </DataTableCell>
                  <DataTableCell className={cn("text-muted-foreground tabular-nums", WIDE_ONLY)}>
                    {formatLastUsed(token.lastUsedAt)}
                  </DataTableCell>
                  <DataTableCell className="text-muted-foreground tabular-nums">
                    {formatExpires(token.expiresAt)}
                  </DataTableCell>
                  <DataTableCell className="text-right">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setRevokeTarget(token)}
                    >
                      Revoke
                    </Button>
                  </DataTableCell>
                </DataTableRow>
              ))}
            </DataTableBody>
          </DataTable>
        )}
      </PageSection>

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
