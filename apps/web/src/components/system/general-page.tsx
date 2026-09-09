"use client";

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
  useAdminConnection,
  useAdminTestConnection,
  useAdminUpdateConnection,
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

/**
 * Admin page: `System > General`. The settings that are neither a feature
 * nor a sidecar: the address fdrive is reached at, the SFTPGo server it
 * talks to, how each account's home directory is derived, and Trash.
 */
export function GeneralPage() {
  const { data: me } = useShellMe();
  const { data: connection, isLoading, dataUpdatedAt } = useAdminConnection();
  const testConnection = useAdminTestConnection();
  const updateConnection = useAdminUpdateConnection();
  const [urlDraft, setUrlDraft] = useState("");
  const [homeTemplateDraft, setHomeTemplateDraft] = useState("");

  useEffect(() => {
    if (connection) {
      setHomeTemplateDraft(connection.homeTemplate);
      setUrlDraft(connection.baseUrl);
    }
  }, [connection]);

  const username = me?.identities.find((identity) => identity.id === me.activeIdentityId)?.username;
  const changed = connection
    ? hasHomeTemplateChanged(connection.homeTemplate, homeTemplateDraft)
    : false;

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
        {isLoading || !connection ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Host</span>
              <span className="font-medium">{connection.host}</span>
            </div>
            <Field>
              <FieldLabel htmlFor="connection-url">SFTPGo address</FieldLabel>
              <Input
                id="connection-url"
                value={urlDraft}
                disabled={connection.source === "env" || updateConnection.isPending}
                onChange={(event) => {
                  setUrlDraft(event.target.value);
                  testConnection.reset();
                }}
              />
              <FieldDescription>
                {connection.source === "env"
                  ? "Set by the deployment. Remove SFTPGO_URL to manage the connection here."
                  : "Changing servers requires users to sign in to the new server. Existing identities remain bound to their original server."}
              </FieldDescription>
            </Field>
            {connection.source === "settings" && urlDraft !== connection.baseUrl ? (
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  disabled={testConnection.isPending}
                  onClick={() => testConnection.mutate(urlDraft)}
                >
                  Test new URL
                </Button>
                <Button
                  disabled={
                    !testConnection.data?.ok ||
                    testConnection.variables !== urlDraft ||
                    updateConnection.isPending
                  }
                  onClick={() => updateConnection.mutate({ baseUrl: urlDraft })}
                >
                  Save connection
                </Button>
              </div>
            ) : null}
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Source</span>
              <Badge variant={connection.source === "env" ? "outline" : "secondary"}>
                {connectionSourceLabel(connection.source)}
              </Badge>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Reachability</span>
              <div className="flex items-center gap-2">
                <Badge variant={connection.reachable ? "default" : "destructive"}>
                  {connection.reachable ? "Reachable" : "Unreachable"}
                </Badge>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={testConnection.isPending}
                  onClick={() => testConnection.mutate(urlDraft || undefined)}
                >
                  <RefreshCw className={testConnection.isPending ? "animate-spin" : ""} />
                  Test
                </Button>
              </div>
            </div>
            {testConnection.data ? (
              <p className="text-sm text-muted-foreground">{testConnection.data.detail}</p>
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
              disabled={isLoading}
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
          {updateConnection.isError ? (
            <FieldError>{describeApiError(updateConnection.error)}</FieldError>
          ) : null}
          <div className="flex justify-end">
            <Button
              type="button"
              disabled={
                !changed ||
                !isPlausibleHomeTemplate(homeTemplateDraft) ||
                updateConnection.isPending
              }
              onClick={() => updateConnection.mutate({ homeTemplate: homeTemplateDraft })}
            >
              {updateConnection.isPending ? "Saving..." : "Save"}
            </Button>
          </div>
        </FieldGroup>
      </SystemSection>

      <TrashSettingsCard />
    </SystemPage>
  );
}
