"use client";

import { useState } from "react";
import { useShellMe } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { AccountIdentity } from "@/lib/account/identities";
import { useAccountTransition } from "@/lib/account/transition";
import { LinkLoginDialog } from "./link-login-dialog";
import { UnlinkLoginDialog } from "./unlink-login-dialog";

/** Account page card: every SFTPGo login linked to the signed-in account. */
export function IdentitiesCard() {
  const { data: me, isLoading } = useShellMe();
  const [linkOpen, setLinkOpen] = useState(false);
  const [unlink, setUnlink] = useState<AccountIdentity | null>(null);
  const { pending } = useAccountTransition();

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
              <div className="flex items-center gap-2">
                {identity.id === me.activeIdentityId ? (
                  <Badge variant="secondary">Active</Badge>
                ) : null}
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={pending || me.identities.length < 2}
                  onClick={() => setUnlink(identity)}
                  aria-label={`Unlink ${identity.username}`}
                >
                  Unlink
                </Button>
              </div>
            </div>
          ))
        )}
        <p className="text-xs text-muted-foreground">
          Keep at least one login linked to this account.
        </p>
        <Button
          variant="outline"
          className="self-start"
          disabled={!me || pending}
          onClick={() => setLinkOpen(true)}
        >
          Link login
        </Button>
        <LinkLoginDialog open={linkOpen} onOpenChange={setLinkOpen} />
        <UnlinkLoginDialog identity={unlink} onClose={() => setUnlink(null)} />
      </CardContent>
    </Card>
  );
}
