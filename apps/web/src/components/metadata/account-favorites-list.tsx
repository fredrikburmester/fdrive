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
      ) : (
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
                        onClick={() => onNavigate(item.identityId, item.path, item.kind)}
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
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={pending}
                    onClick={() => onNavigate(item.identityId, item.path, "reveal")}
                  >
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
