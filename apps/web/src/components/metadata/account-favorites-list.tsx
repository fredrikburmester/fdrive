"use client";

import type { AccountFavoritesResponse, MeResponse } from "@fdrive/contracts";
import { baseName } from "@fdrive/core";
import { FileIcon, FolderIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { accountItemKey, identityLabel } from "@/lib/account/identities";
import { useDefaultView } from "@/lib/files/use-default-view";

export function AccountFavoritesList({
  response,
  me,
  pending,
  onNavigate,
}: {
  response: AccountFavoritesResponse;
  me: MeResponse;
  pending: boolean;
  onNavigate: (identityId: string, path: string, kind: "file" | "dir" | "reveal") => void;
}) {
  const [viewMode] = useDefaultView();

  function open(item: AccountFavoritesResponse["items"][number]) {
    onNavigate(item.identityId, item.path, item.kind);
  }

  function reveal(item: AccountFavoritesResponse["items"][number]) {
    onNavigate(item.identityId, item.path, "reveal");
  }

  return (
    <>
      {response.unavailableIdentityIds.length > 0 ? (
        <p role="status" className="px-4 py-3 text-sm text-muted-foreground">
          Could not load favorites for{" "}
          {response.unavailableIdentityIds.map((id) => identityLabel(me.identities, id)).join(", ")}
          . Other favorites remain available.
        </p>
      ) : null}
      {response.items.length === 0 ? (
        <p className="p-6 text-sm text-muted-foreground">No favorites available.</p>
      ) : viewMode === "grid" ? (
        <div
          className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3"
          data-slot="account-favorites-grid"
        >
          {response.items.map((item) => (
            <div
              key={accountItemKey(item.identityId, item.path)}
              className="min-w-0 rounded-lg border p-3"
            >
              <div className="flex items-start gap-2">
                {item.kind === "dir" ? (
                  <FolderIcon className="mt-0.5 size-4 shrink-0" />
                ) : (
                  <FileIcon className="mt-0.5 size-4 shrink-0" />
                )}
                <div className="min-w-0 flex-1">
                  <Button
                    variant="link"
                    className="h-auto max-w-full p-0 text-foreground"
                    disabled={pending}
                    onClick={() => open(item)}
                  >
                    <span className="truncate">{baseName(item.path) || "Home"}</span>
                  </Button>
                  <p className="truncate text-xs text-muted-foreground">{item.path}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {identityLabel(me.identities, item.identityId)}
                  </p>
                </div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="mt-2"
                disabled={pending}
                onClick={() => reveal(item)}
              >
                Reveal in folder
              </Button>
            </div>
          ))}
        </div>
      ) : (
        // Cross-identity favorite folders cannot be expanded until the identity switch succeeds.
        // Tree therefore uses the same safe flat rows as list.
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Login</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {response.items.map((item) => (
              <TableRow key={accountItemKey(item.identityId, item.path)}>
                <TableCell>
                  <div className="flex items-center gap-2">
                    {item.kind === "dir" ? (
                      <FolderIcon className="size-4 shrink-0" />
                    ) : (
                      <FileIcon className="size-4 shrink-0" />
                    )}
                    <div>
                      <Button
                        variant="link"
                        className="h-auto p-0 text-foreground"
                        disabled={pending}
                        onClick={() => open(item)}
                      >
                        {baseName(item.path) || "Home"}
                      </Button>
                      <p className="text-xs text-muted-foreground">{item.path}</p>
                    </div>
                  </div>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {identityLabel(me.identities, item.identityId)}
                </TableCell>
                <TableCell className="text-right">
                  <Button variant="ghost" size="sm" disabled={pending} onClick={() => reveal(item)}>
                    Reveal in folder
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </>
  );
}
