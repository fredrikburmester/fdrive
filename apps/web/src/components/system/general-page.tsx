"use client";

import type { AdminProvider } from "@fdrive/contracts";
import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { useShellMe } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { describeApiError } from "@/lib/api/errors";
import {
  useAdminProviders,
  useAdminTestProvider,
  useAdminUpdateProvider,
} from "@/lib/api/system-queries";
import {
  connectionSourceLabel,
  hasHomeTemplateChanged,
  homeTemplatePreview,
  isPlausibleHomeTemplate,
} from "@/lib/system/connection";
import { PublicUrlCard } from "./public-url-card";
import { SystemPage } from "./system-page";
import { SystemSection } from "./system-section";
import { TrashSettingsCard } from "./trash-settings-card";

const DEFAULT_HOME_TEMPLATE = "sftpgo:/{username}";

/** The SFTPGo provider this page edits: the oldest one, which setup created. */
export function primarySftpgoProvider(
  providers: readonly AdminProvider[] | undefined,
): AdminProvider | null {
  return providers?.find((provider) => provider.type === "sftpgo") ?? null;
}

/**
 * Admin page: `System > General`. The settings that are neither a feature
 * nor a sidecar: the address fdrive is reached at, the SFTPGo server it
 * talks to, how each account's home directory is derived, and Trash.
 */
export function GeneralPage() {
  const { data: me } = useShellMe();
  const { data, isLoading, dataUpdatedAt } = useAdminProviders();
  const provider = primarySftpgoProvider(data?.providers);
  const testProvider = useAdminTestProvider();
  const updateProvider = useAdminUpdateProvider();
  const [urlDraft, setUrlDraft] = useState("");
  const [homeTemplateDraft, setHomeTemplateDraft] = useState("");

  const savedHomeTemplate = provider?.config.homeTemplate ?? DEFAULT_HOME_TEMPLATE;
  useEffect(() => {
    if (provider) {
      setHomeTemplateDraft(provider.config.homeTemplate ?? DEFAULT_HOME_TEMPLATE);
      setUrlDraft(provider.baseUrl);
    }
  }, [provider]);

  const username = me?.identities.find((identity) => identity.id === me.activeIdentityId)?.username;
  const changed = provider ? hasHomeTemplateChanged(savedHomeTemplate, homeTemplateDraft) : false;
  const testedCandidate =
    typeof testProvider.variables === "object" ? testProvider.variables.baseUrl : null;

  return (
    <SystemPage
      title="General"
      description="Server address, SFTPGo connection, home template, and Trash."
      lastUpdated={dataUpdatedAt > 0 ? new Date(dataUpdatedAt) : null}
    >
      <PublicUrlCard />

      <SystemSection
        title="SFTPGo connection"
        description="Where fdrive reaches your SFTPGo server."
        contentClassName="gap-4"
      >
        {isLoading || !provider ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Host</span>
              <span className="font-medium">{provider.label}</span>
            </div>
            <Field>
              <FieldLabel htmlFor="connection-url">SFTPGo address</FieldLabel>
              <Input
                id="connection-url"
                value={urlDraft}
                disabled={provider.managedByEnv || updateProvider.isPending}
                onChange={(event) => {
                  setUrlDraft(event.target.value);
                  testProvider.reset();
                }}
              />
              <FieldDescription>
                {provider.managedByEnv
                  ? "Set by the deployment. Remove SFTPGO_URL to manage the connection here."
                  : "Changing servers requires users to sign in to the new server. Existing logins stay bound to the server they were created on."}
              </FieldDescription>
            </Field>
            {!provider.managedByEnv && urlDraft !== provider.baseUrl ? (
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  disabled={testProvider.isPending}
                  onClick={() => testProvider.mutate({ type: "sftpgo", baseUrl: urlDraft })}
                >
                  Test new URL
                </Button>
                <Button
                  disabled={
                    !testProvider.data?.ok ||
                    testedCandidate !== urlDraft ||
                    updateProvider.isPending
                  }
                  onClick={() =>
                    updateProvider.mutate({ id: provider.id, patch: { baseUrl: urlDraft } })
                  }
                >
                  Save connection
                </Button>
              </div>
            ) : null}
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Source</span>
              <Badge variant={provider.managedByEnv ? "outline" : "secondary"}>
                {connectionSourceLabel(provider.managedByEnv)}
              </Badge>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Reachability</span>
              <div className="flex items-center gap-2">
                <Badge
                  variant={
                    (testProvider.data?.ok ?? provider.reachable) ? "default" : "destructive"
                  }
                >
                  {(testProvider.data?.ok ?? provider.reachable) ? "Reachable" : "Unreachable"}
                </Badge>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={testProvider.isPending}
                  onClick={() =>
                    testProvider.mutate(
                      urlDraft && urlDraft !== provider.baseUrl
                        ? { type: "sftpgo", baseUrl: urlDraft }
                        : provider.id,
                    )
                  }
                >
                  <RefreshCw className={testProvider.isPending ? "animate-spin" : ""} />
                  Test
                </Button>
              </div>
            </div>
            {testProvider.data ? (
              <p className="text-sm text-muted-foreground">{testProvider.data.detail}</p>
            ) : null}
          </>
        )}
      </SystemSection>

      <SystemSection
        title="Home template"
        description="Maps each SFTPGo username to a home directory."
      >
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="home-template">Template</FieldLabel>
            <FieldDescription>
              Written as "&lt;root&gt;:&lt;path&gt;", where "{"{username}"}" is replaced by each
              person's SFTPGo username.
            </FieldDescription>
            <Input
              id="home-template"
              value={homeTemplateDraft}
              onChange={(event) => setHomeTemplateDraft(event.target.value)}
              disabled={isLoading || !provider}
            />
            <FieldDescription>
              {homeTemplatePreview(homeTemplateDraft, username ?? "")}
            </FieldDescription>
            <FieldDescription>
              Every account's home directory is computed from this template each time it is needed,
              not stored per account, so saving a change immediately moves everyone's home
              directory.
            </FieldDescription>
          </Field>
          {updateProvider.isError ? (
            <FieldError>{describeApiError(updateProvider.error)}</FieldError>
          ) : null}
          <div className="flex justify-end">
            <Button
              type="button"
              disabled={
                !provider ||
                !changed ||
                !isPlausibleHomeTemplate(homeTemplateDraft) ||
                updateProvider.isPending
              }
              onClick={() =>
                provider &&
                updateProvider.mutate({
                  id: provider.id,
                  patch: { config: { ...provider.config, homeTemplate: homeTemplateDraft } },
                })
              }
            >
              {updateProvider.isPending ? "Saving..." : "Save"}
            </Button>
          </div>
        </FieldGroup>
      </SystemSection>

      <TrashSettingsCard />
    </SystemPage>
  );
}
