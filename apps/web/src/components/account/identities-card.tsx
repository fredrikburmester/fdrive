"use client";

import { useState } from "react";
import { ProviderIcon } from "@/components/identity/provider-icon";
import { useShellMe } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { AccountIdentity } from "@/lib/account/identities";
import { useAccountTransition } from "@/lib/account/transition";
import { storageNote } from "@/lib/identity/capabilities";
import { loginDisplay } from "@/lib/identity/login-display";
import { IdentityScope } from "./identity-scope";
import { LinkLoginDialog } from "./link-login-dialog";
import { UnlinkLoginDialog } from "./unlink-login-dialog";

/** Account page card: every login linked to the signed-in account, each with its index status where its provider is indexed. */
export function IdentitiesCard() {
  const { data: me, isLoading } = useShellMe();
  const [linkOpen, setLinkOpen] = useState(false);
  const [unlink, setUnlink] = useState<AccountIdentity | null>(null);
  const { pending } = useAccountTransition();

  return (
    <Card className="w-full max-w-2xl">
      <CardHeader>
        <CardTitle>Logins</CardTitle>
        <CardDescription>Every login you can use from this account.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {isLoading || !me ? (
          <Skeleton className="h-16 w-full" />
        ) : (
          me.identities.map((identity) => {
            const display = loginDisplay(identity);
            const note = storageNote(identity.capabilities);
            return (
              <div
                key={identity.id}
                className="flex flex-col gap-2 rounded-lg border border-border px-3 py-2 text-sm"
              >
                <div className="flex items-center justify-between">
                  <div className="flex flex-col">
                    <span className="font-medium">{display.title}</span>
                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                      <ProviderIcon type={identity.providerType} />
                      {display.detail}
                    </span>
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
                      aria-label={`Remove ${display.title}`}
                    >
                      Remove
                    </Button>
                  </div>
                </div>
                {note !== null && <p className="text-xs text-muted-foreground">{note}</p>}
                {identity.capabilities.scopeMapping && (
                  <IdentityScope identityId={identity.id} username={identity.username} />
                )}
              </div>
            );
          })
        )}
        <p className="text-xs text-muted-foreground">Keep at least one login on this account.</p>
        <Button
          variant="outline"
          className="self-start"
          disabled={!me || pending}
          onClick={() => setLinkOpen(true)}
        >
          Add login
        </Button>
        <LinkLoginDialog open={linkOpen} onOpenChange={setLinkOpen} />
        <UnlinkLoginDialog identity={unlink} onClose={() => setUnlink(null)} />
      </CardContent>
    </Card>
  );
}
