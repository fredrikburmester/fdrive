"use client";

import { useShellMe } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/** Account page card: every SFTPGo login linked to the signed-in account. */
export function IdentitiesCard() {
  const { data: me, isLoading } = useShellMe();

  return (
    <Card className="w-full max-w-2xl">
      <CardHeader>
        <CardTitle>Identities</CardTitle>
        <CardDescription>SFTPGo logins linked to this account.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {isLoading || !me ? (
          <Skeleton className="h-16 w-full" />
        ) : (
          me.identities.map((identity) => (
            <div
              key={identity.id}
              className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-sm"
            >
              <div className="flex flex-col">
                <span className="font-medium">{identity.username}</span>
                <span className="text-xs text-muted-foreground">{identity.providerLabel}</span>
              </div>
              {identity.id === me.activeIdentityId ? (
                <Badge variant="secondary">Active</Badge>
              ) : null}
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
