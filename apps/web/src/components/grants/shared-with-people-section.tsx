"use client";

import type { OwnedGrant } from "@fdrive/contracts";
import { baseName } from "@fdrive/core";
import { FolderIcon } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { describeApiError } from "@/lib/api/errors";
import { pathToHref } from "@/lib/files/path-url";
import { useGrants } from "@/lib/grants/queries";
import { AccessSelect } from "./access-select";
import { useOwnedGrant } from "./use-owned-grant";

/** One folder shared with one person: where it is, who has it, and what they may do. */
function OwnedGrantRow({ grant }: { grant: OwnedGrant }) {
  const name = baseName(grant.path);
  const { busy, changeAccess, stopSharing } = useOwnedGrant(grant, name);

  return (
    <TableRow>
      <TableCell>
        <Link
          href={pathToHref(grant.path) as Route}
          className="flex min-w-0 items-center gap-2 font-medium hover:underline"
        >
          <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{name}</span>
        </Link>
        <span className="block truncate text-xs text-muted-foreground">{grant.path}</span>
      </TableCell>
      <TableCell>{grant.username}</TableCell>
      <TableCell>
        <AccessSelect
          value={grant.access}
          label={`Access for ${grant.username} to ${name}`}
          disabled={busy}
          onChange={changeAccess}
        />
      </TableCell>
      <TableCell className="text-right">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={`Stop sharing ${name} with ${grant.username}`}
          disabled={busy}
          onClick={stopSharing}
        >
          Stop sharing
        </Button>
      </TableCell>
    </TableRow>
  );
}

/**
 * The Shares page's "Shared with people": every folder of the active login
 * shared with someone else on the same storage, with their access and a
 * way to stop. Public links are listed separately above.
 */
export function SharedWithPeopleSection() {
  const grants = useGrants();
  const owned = [...(grants.data?.owned ?? [])].sort(
    (a, b) => a.path.localeCompare(b.path) || a.username.localeCompare(b.username),
  );

  return (
    <section aria-labelledby="shared-with-people" className="space-y-3">
      <div>
        <h2 id="shared-with-people" className="text-lg font-semibold tracking-tight">
          Shared with people
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Folders you share with other people here. Choose Share with people on a folder in Files to
          add one.
        </p>
      </div>
      {grants.isPending ? (
        <Skeleton className="h-16 w-full" />
      ) : grants.isError ? (
        <FieldError>{describeApiError(grants.error)}</FieldError>
      ) : owned.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          You don't share any folders with people yet.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Folder</TableHead>
              <TableHead>Person</TableHead>
              <TableHead>Access</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {owned.map((grant) => (
              <OwnedGrantRow key={grant.id} grant={grant} />
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}
