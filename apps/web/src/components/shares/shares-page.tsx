"use client";

import type { FsEntry, ManagedShare } from "@fdrive/contracts";
import { Copy, Link2, Pencil, Trash2 } from "lucide-react";
import { useState } from "react";
import { PageHeader } from "@/components/shell/page-header";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useShareManagement } from "@/lib/shares/management";
import { publicShareHref } from "@/lib/shares/paths";
import { PRESENTATION_LABEL } from "@/lib/shares/presentation-label";
import { shareAccessLabel, shareItemLabel, shareUsage } from "@/lib/shares/status";
import { ShareDialog } from "./share-dialog";

export function SharesPage() {
  const management = useShareManagement();
  const [editing, setEditing] = useState<{ share: ManagedShare; entries: FsEntry[] } | null>(null);
  const [revoking, setRevoking] = useState<ManagedShare | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  async function edit(share: ManagedShare) {
    setError(null);
    try {
      const entries = await management.entries(share.paths);
      if (entries) setEditing({ share, entries });
    } catch {
      setError("Could not load the shared files. Refresh and try again.");
    }
  }
  async function copy(share: ManagedShare) {
    try {
      await navigator.clipboard.writeText(
        new URL(publicShareHref(share.id), window.location.origin).href,
      );
      setCopied(share.id);
    } catch {
      setError("Could not copy the link.");
    }
  }
  async function revoke() {
    if (!revoking) return;
    setPending(true);
    setError(null);
    try {
      if (await management.revoke(revoking.id)) setRevoking(null);
    } catch {
      setError("Could not revoke the link. Try again.");
    } finally {
      setPending(false);
    }
  }
  return (
    <>
      <PageHeader breadcrumbs={<span className="font-medium">Shares</span>} />
      <main className="mx-auto w-full max-w-6xl space-y-5 p-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Shares</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Links created by this login. Select files or a folder in Files and choose Share to
            create one.
          </p>
        </div>
        {(error || management.query.isError) && (
          <FieldError>{error ?? "Could not load share links."}</FieldError>
        )}
        {management.query.isPending ? (
          <p role="status" className="text-sm text-muted-foreground">
            Loading links…
          </p>
        ) : management.query.data?.items.length === 0 ? (
          <div className="rounded-xl border border-dashed p-10 text-center text-muted-foreground">
            <Link2 className="mx-auto mb-3 size-5" />
            <p>No share links yet.</p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Item</TableHead>
                <TableHead>Access</TableHead>
                <TableHead>Shown as</TableHead>
                <TableHead>Usage</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {management.query.data?.items.map((share) => (
                <TableRow key={share.id}>
                  <TableCell>
                    <div className="font-medium">{share.name}</div>
                    {share.hasPassword && (
                      <span className="text-xs text-muted-foreground">Password protected</span>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {shareItemLabel(share.paths)}
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary">{shareAccessLabel(share.scope)}</Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {PRESENTATION_LABEL[share.presentation]}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{shareUsage(share)}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {share.expiresAt ? new Date(share.expiresAt).toLocaleString() : "Never"}
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Copy link for ${share.name}`}
                        onClick={() => void copy(share)}
                      >
                        <Copy />
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Edit ${share.name}`}
                        onClick={() => void edit(share)}
                      >
                        <Pencil />
                      </Button>
                      <Button
                        size="icon-sm"
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
                    {copied === share.id && (
                      <span
                        role="status"
                        className="block text-right text-xs text-muted-foreground"
                      >
                        Link copied
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </main>
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
