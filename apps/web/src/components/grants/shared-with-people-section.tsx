"use client";

import type { OwnedGrant } from "@fdrive/contracts";
import { baseName } from "@fdrive/core";
import { FolderIcon } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import {
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeader,
  DataTableRow,
  PageSection,
} from "@/components/shell/page-layout";
import { PHONE_TARGET, RowsSkeleton, TruncatedCell } from "@/components/shell/page-rows";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import { describeApiError } from "@/lib/api/errors";
import { pathToHref } from "@/lib/files/path-url";
import { useGrants } from "@/lib/grants/queries";
import { AccessSelect } from "./access-select";
import { useOwnedGrant } from "./use-owned-grant";

/** A line of the section that is not a row: the same side padding, in small muted text. */
const NOTE = "px-3 py-2.5 text-muted-foreground text-xs";

/** One folder shared with one person: where it is, who has it, and what they may do. */
function OwnedGrantRow({ grant }: { grant: OwnedGrant }) {
  const name = baseName(grant.path);
  const { busy, changeAccess, stopSharing } = useOwnedGrant(grant, name);

  return (
    <DataTableRow>
      <DataTableCell>
        <div className="flex min-w-0 items-center gap-2">
          <Link
            href={pathToHref(grant.path) as Route}
            className="flex min-w-0 items-center gap-2 hover:underline"
          >
            <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
            <span className="truncate">{name}</span>
          </Link>
          {/* Beside the name where there is room; a narrow page keeps the name whole instead. */}
          <span className="hidden min-w-0 shrink-[2] truncate text-muted-foreground text-xs @xl:block">
            {grant.path}
          </span>
        </div>
        {/* The Person column, folded under the folder where the page is too narrow for it. */}
        <span className="block truncate pl-6 text-muted-foreground text-xs @xl:hidden">
          {grant.username}
        </span>
      </DataTableCell>
      <TruncatedCell className="hidden @xl:table-cell">{grant.username}</TruncatedCell>
      <DataTableCell>
        <AccessSelect
          value={grant.access}
          label={`Access for ${grant.username} to ${name}`}
          className={PHONE_TARGET}
          disabled={busy}
          onChange={changeAccess}
        />
      </DataTableCell>
      <DataTableCell className="text-right">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={PHONE_TARGET}
          aria-label={`Stop sharing ${name} with ${grant.username}`}
          disabled={busy}
          onClick={stopSharing}
        >
          Stop sharing
        </Button>
      </DataTableCell>
    </DataTableRow>
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
    <PageSection
      aria-labelledby="shared-with-people"
      title={<span id="shared-with-people">Shared with people</span>}
      description="Folders you share with other people here. Choose Share with people on a folder in Files to add one."
    >
      {grants.isPending ? (
        <RowsSkeleton label="Loading shared folders…" rows={2} />
      ) : grants.isError ? (
        <FieldError className="px-3 py-2.5">{describeApiError(grants.error)}</FieldError>
      ) : owned.length === 0 ? (
        <p className={NOTE}>You don't share any folders with people yet.</p>
      ) : (
        <DataTable className="table-fixed">
          <DataTableHeader>
            <DataTableRow>
              <DataTableHead>Folder</DataTableHead>
              <DataTableHead className="hidden w-[22%] @xl:table-cell">Person</DataTableHead>
              <DataTableHead className="w-32">Access</DataTableHead>
              <DataTableHead className="w-28 text-right">Actions</DataTableHead>
            </DataTableRow>
          </DataTableHeader>
          <DataTableBody>
            {owned.map((grant) => (
              <OwnedGrantRow key={grant.id} grant={grant} />
            ))}
          </DataTableBody>
        </DataTable>
      )}
    </PageSection>
  );
}
