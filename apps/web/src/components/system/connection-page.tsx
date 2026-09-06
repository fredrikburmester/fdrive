"use client";

import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { PageHeader, useShellMe } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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

/** Admin page: `System > Connection`. Shows the active SFTPGo connection and lets an admin edit the home template. */
export function ConnectionPage() {
  const { data: me } = useShellMe();
  const { data: connection, isLoading } = useAdminConnection();
  const testConnection = useAdminTestConnection();
  const updateConnection = useAdminUpdateConnection();
  const [homeTemplateDraft, setHomeTemplateDraft] = useState("");

  useEffect(() => {
    if (connection) {
      setHomeTemplateDraft(connection.homeTemplate);
    }
  }, [connection]);

  const username = me?.identities.find((identity) => identity.id === me.activeIdentityId)?.username;
  const changed = connection
    ? hasHomeTemplateChanged(connection.homeTemplate, homeTemplateDraft)
    : false;

  return (
    <>
      <PageHeader breadcrumbs={<span className="text-sm font-medium">System / Connection</span>} />
      <div className="flex flex-1 flex-col items-center gap-4 p-6">
        <Card className="w-full max-w-lg">
          <CardHeader>
            <CardTitle>SFTPGo connection</CardTitle>
            <CardDescription>Where fdrive reaches your SFTPGo server.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {isLoading || !connection ? (
              <Skeleton className="h-24 w-full" />
            ) : (
              <>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Host</span>
                  <span className="font-medium">{connection.host}</span>
                </div>
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
                      onClick={() => testConnection.mutate(undefined)}
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
          </CardContent>
        </Card>

        <Card className="w-full max-w-lg">
          <CardHeader>
            <CardTitle>Home template</CardTitle>
            <CardDescription>Maps each SFTPGo username to a home directory.</CardDescription>
          </CardHeader>
          <CardContent>
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
                  Every account's home directory is computed from this template each time it is
                  needed, not stored per account, so saving a change immediately moves everyone's
                  home directory.
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
          </CardContent>
        </Card>
      </div>
    </>
  );
}
