"use client";

import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { PageHeader, useShellMe } from "@/components/shell/page-header";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { TriangleAlertIcon } from "lucide-react";
import { accountItemHref, navigateAccountItem } from "@/lib/account/identities";
import { useAccountFavorites } from "@/lib/account/queries";
import { useIdentityActions } from "@/lib/account/use-identities";
import { describeApiError } from "@/lib/api/errors";
import { AccountFavoritesList } from "./account-favorites-list";

export function FavoritesPage() {
  const { data: me } = useShellMe();
  const favorites = useAccountFavorites(me?.account.id);
  const actions = useIdentityActions();
  const router = useRouter();
  const [navigationError, setNavigationError] = useState<string | null>(null);
  return (
    <>
      <PageHeader breadcrumbs={<span className="text-sm font-medium">Favorites</span>} />
      {favorites.error ? (
        <div className="p-4">
          <Alert variant="destructive">
            <TriangleAlertIcon />
            <AlertDescription>{describeApiError(favorites.error)}</AlertDescription>
          </Alert>
        </div>
      ) : null}
      {actions.error || navigationError ? (
        <div className="p-4">
          <Alert variant="destructive">
            <TriangleAlertIcon />
            <AlertDescription>{actions.error ?? navigationError}</AlertDescription>
          </Alert>
        </div>
      ) : null}
      {favorites.isLoading || !me ? (
        <Skeleton className="m-4 h-24" />
      ) : favorites.data ? (
        <AccountFavoritesList
          response={favorites.data}
          me={me}
          pending={actions.pending}
          onNavigate={(identityId, path, kind) => {
            setNavigationError(null);
            void navigateAccountItem(
              me,
              identityId,
              accountItemHref(kind, path),
              actions.switch,
              (href) => router.push(href as Route),
            ).catch((error: unknown) => setNavigationError(describeApiError(error)));
          }}
        />
      ) : null}
    </>
  );
}
