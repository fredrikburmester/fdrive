"use client";

import { describeScopeError, mountMappingsWithout } from "@/components/account/scope-model";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useMountMappings, useSetMountMappings } from "@/lib/api/scope-queries";

/**
 * `System > Connection` card listing the folder-level virtual folder
 * mappings. New mappings are created from a login's unmapped mount on the
 * account page, where the suggestions live; this card is where they are
 * reviewed and removed.
 */
export function SharedFoldersCard() {
  const { data, isLoading, error } = useMountMappings();
  const save = useSetMountMappings();

  return (
    <Card className="w-full max-w-lg">
      <CardHeader>
        <CardTitle>Shared folders</CardTitle>
        <CardDescription>
          Where SFTPGo virtual folders live on disk. Every login that mounts one of these paths uses
          its mapping for search and other index-backed features.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        {isLoading ? <Skeleton className="h-8 w-full" /> : null}
        {error !== null ? (
          <p className="text-destructive">{describeScopeError(error).message}</p>
        ) : null}
        {data !== undefined && data.mappings.length === 0 ? (
          <p className="text-muted-foreground">
            No shared folder mappings yet. Map a folder from a login's index status on the Account
            page, and choose to apply it to every login.
          </p>
        ) : null}
        {data !== undefined && data.mappings.length > 0 ? (
          <ul className="flex flex-col gap-2" aria-label="Shared folder mappings">
            {data.mappings.map((mapping) => (
              <li key={mapping.virtualPath} className="flex flex-wrap items-center gap-2">
                <code className="rounded bg-muted px-1">{mapping.virtualPath}</code>
                <span className="text-muted-foreground">
                  {mapping.rootName}:{mapping.fsPrefix}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={save.isPending}
                  onClick={() =>
                    save.mutate(mountMappingsWithout(data.mappings, mapping.virtualPath))
                  }
                  aria-label={`Remove shared folder ${mapping.virtualPath}`}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
        {save.isError ? (
          <p className="text-destructive">{describeScopeError(save.error).message}</p>
        ) : null}
        <p className="text-xs text-muted-foreground">
          A mapping is an authorization boundary set by an administrator. Each login still only sees
          what its own SFTPGo permissions allow.
        </p>
      </CardContent>
    </Card>
  );
}
