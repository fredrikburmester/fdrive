"use client";

import type { ApiTokenSummary } from "@fdrive/contracts";
import { PlusIcon } from "lucide-react";
import { useState } from "react";
import { useShellMe } from "@/components/shell/page-header";
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
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatExpires, formatLastUsed, formatShortDate } from "@/lib/account/format";
import { useApiTokens, useRevokeApiToken } from "@/lib/account/queries";
import { CreateTokenDialog } from "./create-token-dialog";
import { type CreatedToken, TokenCreatedDialog } from "./token-created-dialog";

/** Looks up an identity's username by id, "-" when the identity was unlinked. */
function identityLabel(
  identities: { id: string; username: string }[],
  identityId: string | null,
): string {
  if (identityId === null) {
    return "-";
  }
  return identities.find((identity) => identity.id === identityId)?.username ?? "(unlinked)";
}

/** Account page card: the signed-in account's API tokens (MCP, Raycast). */
export function ApiTokensCard() {
  const { data: me } = useShellMe();
  const { data, isLoading } = useApiTokens();
  const revokeToken = useRevokeApiToken();
  const [createOpen, setCreateOpen] = useState(false);
  const [created, setCreated] = useState<CreatedToken | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<ApiTokenSummary | null>(null);

  const identities = me?.identities ?? [];
  const tokens = data?.items ?? [];

  return (
    <>
      <Card className="w-full max-w-2xl">
        <CardHeader>
          <CardTitle>API tokens</CardTitle>
          <CardDescription>Long-lived tokens for Claude (MCP) and Raycast.</CardDescription>
          <CardAction>
            <Button type="button" size="sm" onClick={() => setCreateOpen(true)}>
              <PlusIcon />
              Create token
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : tokens.length === 0 ? (
            <p className="text-sm text-muted-foreground">No tokens yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Identity</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Last used</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tokens.map((token) => (
                  <TableRow key={token.id}>
                    <TableCell className="font-medium">{token.name}</TableCell>
                    <TableCell>{identityLabel(identities, token.identityId)}</TableCell>
                    <TableCell>{formatShortDate(token.createdAt)}</TableCell>
                    <TableCell>{formatLastUsed(token.lastUsedAt)}</TableCell>
                    <TableCell>{formatExpires(token.expiresAt)}</TableCell>
                    <TableCell className="text-right">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setRevokeTarget(token)}
                      >
                        Revoke
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <CreateTokenDialog
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
