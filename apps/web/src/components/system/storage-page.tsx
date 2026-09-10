"use client";

import type { AdminProvider, AdminProviderType } from "@fdrive/contracts";
import { Plus, RefreshCw } from "lucide-react";
import { useState } from "react";
import { ProviderIcon } from "@/components/identity/provider-icon";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { describeApiError } from "@/lib/api/errors";
import {
  useAdminDeleteProvider,
  useAdminProviders,
  useAdminTestProvider,
  useAdminUpdateProvider,
} from "@/lib/api/system-queries";
import { CAPABILITY_LABELS } from "@/lib/identity/capabilities";
import { providerTypeLabel } from "@/lib/identity/provider-type";
import {
  connectionSourceLabel,
  enabledCapabilities,
  providerRemoveBlock,
} from "@/lib/system/connection";
import { ProviderDialog } from "./provider-dialog";
import { SystemPage } from "./system-page";
import { SystemSection } from "./system-section";

/** A destructive action waiting for the administrator to confirm it. */
type Confirmation =
  | { readonly kind: "remove"; readonly provider: AdminProvider }
  | { readonly kind: "disable-last"; readonly provider: AdminProvider };

interface ProviderRowProps {
  readonly provider: AdminProvider;
  /** The matching entry of `types`, `undefined` for a type this build does not know. */
  readonly type: AdminProviderType | undefined;
  /** True when turning this row off would leave no enabled provider at all. */
  readonly lastEnabled: boolean;
  readonly onEdit: (provider: AdminProvider) => void;
  readonly onConfirm: (confirmation: Confirmation) => void;
}

/** One configured provider: what it is, whether fdrive can reach it, and what it can do. */
function ProviderRow({ provider, type, lastEnabled, onEdit, onConfirm }: ProviderRowProps) {
  const test = useAdminTestProvider();
  const update = useAdminUpdateProvider();
  const reachable = test.data?.ok ?? provider.reachable;
  const removeBlock = providerRemoveBlock(provider);
  const capabilities = type === undefined ? [] : enabledCapabilities(type.capabilities);

  return (
    <SystemSection
      title={provider.label}
      description={
        <span className="flex flex-wrap items-center gap-1.5">
          <ProviderIcon type={provider.type} />
          {providerTypeLabel(provider.type)}
          <span aria-hidden="true">·</span>
          <span className="font-mono text-xs">{provider.baseUrl}</span>
        </span>
      }
      actions={
        <>
          <Switch
            aria-label={`Enable ${provider.label}`}
            checked={provider.enabled}
            disabled={update.isPending}
            onCheckedChange={(enabled) => {
              if (!enabled && lastEnabled) {
                onConfirm({ kind: "disable-last", provider });
                return;
              }
              update.mutate({ id: provider.id, patch: { enabled } });
            }}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label={`Edit ${provider.label}`}
            onClick={() => onEdit(provider)}
          >
            Edit
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={`Remove ${provider.label}`}
            disabled={removeBlock !== null}
            onClick={() => onConfirm({ kind: "remove", provider })}
          >
            Remove
          </Button>
        </>
      }
      contentClassName="gap-3"
    >
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">Reachability</span>
        <div className="flex items-center gap-2">
          <Badge variant={reachable ? "default" : "destructive"}>
            {reachable ? "Reachable" : "Unreachable"}
          </Badge>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label={`Test ${provider.label}`}
            disabled={test.isPending}
            onClick={() => test.mutate(provider.id)}
          >
            <RefreshCw className={test.isPending ? "animate-spin" : ""} />
            Test
          </Button>
        </div>
      </div>
      {test.data ? <p className="text-sm text-muted-foreground">{test.data.detail}</p> : null}
      {test.isError ? (
        <p className="text-sm text-destructive">{describeApiError(test.error)}</p>
      ) : null}
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">Source</span>
        <Badge variant={provider.managedByEnv ? "outline" : "secondary"}>
          {connectionSourceLabel(provider.managedByEnv)}
        </Badge>
      </div>
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">Logins</span>
        <span className="font-medium">{provider.identityCount}</span>
      </div>
      {capabilities.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5 text-sm">
          <span className="text-muted-foreground">Supports</span>
          {capabilities.map((key) => (
            <Badge key={key} variant="secondary">
              {CAPABILITY_LABELS[key]}
            </Badge>
          ))}
        </div>
      ) : null}
      {removeBlock === null ? null : <p className="text-xs text-muted-foreground">{removeBlock}</p>}
      {update.isError ? (
        <p className="text-sm text-destructive">{describeApiError(update.error)}</p>
      ) : null}
    </SystemSection>
  );
}

/**
 * Admin page: `System > Storage`. Every storage server people can sign in
 * to, with the reachability probe, the capabilities its type brings, and the
 * add, test, edit, enable and remove actions. The API refuses to move a
 * server's address once logins are bound to it and to remove a server that
 * still has any, so those controls are locked here with the reason.
 */
export function StoragePage() {
  const { data, isLoading, dataUpdatedAt } = useAdminProviders();
  const remove = useAdminDeleteProvider();
  const update = useAdminUpdateProvider();
  const [dialog, setDialog] = useState<{ readonly provider: AdminProvider | null } | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const providers = data?.providers ?? [];
  const types = data?.types ?? [];
  const enabledCount = providers.filter((provider) => provider.enabled).length;

  function confirm() {
    if (confirmation === null) {
      return;
    }
    if (confirmation.kind === "remove") {
      remove.mutate(confirmation.provider.id);
    } else {
      update.mutate({ id: confirmation.provider.id, patch: { enabled: false } });
    }
    setConfirmation(null);
  }

  return (
    <SystemPage
      title="Storage"
      description="The storage servers people sign in to."
      lastUpdated={dataUpdatedAt > 0 ? new Date(dataUpdatedAt) : null}
      actions={
        <Button
          type="button"
          size="sm"
          disabled={types.length === 0}
          onClick={() => setDialog({ provider: null })}
        >
          <Plus />
          Add provider
        </Button>
      }
    >
      {isLoading ? <Skeleton className="h-40 w-full" /> : null}
      {remove.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {describeApiError(remove.error)}
        </p>
      ) : null}
      {!isLoading && providers.length === 0 ? (
        <SystemSection
          title="No storage servers"
          description="Add a server so people have somewhere to sign in to."
        />
      ) : null}
      {providers.map((provider) => (
        <ProviderRow
          key={provider.id}
          provider={provider}
          type={types.find((entry) => entry.type === provider.type)}
          lastEnabled={provider.enabled && enabledCount === 1}
          onEdit={(target) => setDialog({ provider: target })}
          onConfirm={setConfirmation}
        />
      ))}

      {dialog === null ? null : (
        <ProviderDialog
          key={dialog.provider?.id ?? "new"}
          provider={dialog.provider}
          types={types}
          onClose={() => setDialog(null)}
        />
      )}

      <AlertDialog
        open={confirmation !== null}
        onOpenChange={(open) => (open ? undefined : setConfirmation(null))}
      >
        {/* Mounted only while a confirmation is pending: an exiting dialog
            would otherwise briefly render the other action's copy. */}
        {confirmation === null ? null : (
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {confirmation.kind === "remove"
                  ? `Remove "${confirmation.provider.label}"?`
                  : `Disable "${confirmation.provider.label}"?`}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {confirmation.kind === "remove"
                  ? "fdrive stops offering this server on the login page and forgets how to reach it. Nothing on the server itself changes."
                  : "This is the only enabled storage server. Nobody can sign in until one is enabled again."}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={confirm}>
                {confirmation.kind === "remove" ? "Remove" : "Disable"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        )}
      </AlertDialog>
    </SystemPage>
  );
}
