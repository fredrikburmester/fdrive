"use client";

import {
  FEATURE_IDS,
  type FeatureConfiguration,
  type FeatureId,
  type FeatureValues,
  type SystemFeaturesResponse,
} from "@fdrive/contracts";
import { useQuery } from "@tanstack/react-query";
import type { Route } from "next";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useMe } from "@/lib/api/auth-queries";
import { apiClient } from "@/lib/api/client";
import { describeApiError } from "@/lib/api/errors";
import { useSystemFeatures, useUpdateFeatures } from "@/lib/api/system-queries";
import { changeFeature, FEATURE_DESCRIPTIONS } from "@/lib/system/features";
import { SetupFrame } from "./setup-frame";
import { SystemErrorState } from "./system-error-state";
import { SystemPage } from "./system-page";

function StorageCheck({
  roots,
  values,
}: Pick<SystemFeaturesResponse, "roots"> & { values: FeatureValues }) {
  const { data: me } = useMe();
  const indexNeeded = FEATURE_IDS.some((id) => id !== "pdfOcr" && values[id]);
  const identityId = me?.activeIdentityId;
  const [mapping, setMapping] = useState<{ rootName: string; fsPrefix: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [mappingError, setMappingError] = useState<string | null>(null);
  const scope = useQuery({
    queryKey: ["setup", "storage", identityId],
    queryFn: () => apiClient.identityScope(identityId ?? ""),
    enabled: !!identityId && indexNeeded,
    refetchInterval: 5000,
  });
  const home = scope.data?.isAdmin
    ? scope.data.mappings.find((item) => item.virtualPrefix === "/")
    : undefined;
  const draft = mapping ?? {
    rootName: home?.rootName ?? roots[0]?.name ?? "",
    fsPrefix: home?.fsPrefix ?? "/",
  };
  async function saveMapping() {
    if (!identityId || !scope.data?.isAdmin) return;
    setSaving(true);
    setMappingError(null);
    try {
      await apiClient.setIdentityScope(identityId, {
        scopes: [
          { ...draft, virtualPrefix: "/" },
          ...scope.data.mappings.filter((item) => item.virtualPrefix !== "/"),
        ],
      });
      setMapping(null);
      await scope.refetch();
    } catch (error) {
      setMappingError(describeApiError(error));
    } finally {
      setSaving(false);
    }
  }
  const mountProblem =
    roots.length === 0 ||
    roots.some(
      (root) =>
        (indexNeeded && root.processing?.indexReadable !== true) ||
        (values.pdfOcr &&
          (root.processing?.pdfReadable !== true || root.processing?.pdfWritable !== true)),
    );
  const scopeProblem =
    indexNeeded && (scope.isError || (scope.data && scope.data.status !== "available"));
  const checking = indexNeeded && !scope.data;
  if (!mountProblem && !scopeProblem)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {checking
          ? "Checking storage access automatically… You can continue while features prepare."
          : "Storage access checked. Features are preparing or ready."}
      </p>
    );
  return (
    <Card>
      <CardHeader>
        <CardTitle>Processing needs storage access</CardTitle>
        <CardDescription>
          Your selected features need access to the files behind SFTPGo. You can finish setup and
          browse files while this is resolved.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <details>
          <summary className="cursor-pointer text-sm">Advanced storage settings</summary>
          <div className="mt-3 space-y-4">
            {roots.length === 0 ? (
              <p className="text-sm">
                No processing roots are configured. You can finish setup and browse files; indexing
                needs a storage mount.
              </p>
            ) : (
              roots.map((root) => (
                <div key={root.name} className="rounded-md border p-3 text-sm break-all">
                  <strong>{root.name}</strong>
                  <p className="text-muted-foreground">SFTPGo: {root.sftpgoPath}</p>
                  <p className="text-muted-foreground">Worker: {root.indexerPath}</p>
                  <p>
                    Indexing:{" "}
                    {root.processing?.indexReadable === true
                      ? "readable"
                      : root.processing?.indexReadable === false
                        ? "not readable — check mount permissions"
                        : "worker check unavailable"}
                    .
                  </p>
                  <p>
                    PDF conversion:{" "}
                    {root.processing?.pdfReadable === true && root.processing.pdfWritable === true
                      ? "readable and writable"
                      : root.processing?.pdfReadable === false ||
                          root.processing?.pdfWritable === false
                        ? "needs readable and writable storage"
                        : "worker check unavailable"}
                    .
                  </p>
                </div>
              ))
            )}
            {indexNeeded ? (
              <div role="status" className="text-sm">
                {scope.data
                  ? scope.data.status === "available"
                    ? "Storage mapping verified for your account."
                    : `Storage mapping needs attention: ${scope.data.reason.replaceAll("_", " ")}.`
                  : scope.isError
                    ? describeApiError(scope.error)
                    : "Checking storage mapping…"}
              </div>
            ) : null}
            <p className="text-sm text-muted-foreground">
              Folder mappings must stay within storage mounted during deployment. A remote SFTPGo
              connection supports browsing even without a local mount.
            </p>
            {indexNeeded && scope.data?.isAdmin && roots.length > 0 ? (
              <div className="space-y-3 rounded-md border p-3">
                <p className="text-sm font-medium">Map your account's home folder</p>
                <Field>
                  <FieldLabel htmlFor="setup-root">Mounted root</FieldLabel>
                  <Select
                    value={draft.rootName}
                    onValueChange={(value) => {
                      if (value) setMapping({ ...draft, rootName: value });
                    }}
                  >
                    <SelectTrigger id="setup-root">
                      <SelectValue>{draft.rootName}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {roots.map((root) => (
                        <SelectItem key={root.name} value={root.name}>
                          {root.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field>
                  <FieldLabel htmlFor="setup-root-folder">Home folder inside this root</FieldLabel>
                  <Input
                    id="setup-root-folder"
                    value={draft.fsPrefix}
                    onChange={(event) => setMapping({ ...draft, fsPrefix: event.target.value })}
                  />
                  <FieldDescription>
                    For example, /alice. Choose the folder that corresponds to this user's SFTPGo
                    home; fdrive checks its directory listing.
                  </FieldDescription>
                </Field>
                {mappingError ? (
                  <p role="alert" className="text-sm text-destructive">
                    {mappingError}
                  </p>
                ) : null}
                <Button
                  variant="outline"
                  disabled={mapping === null || saving}
                  onClick={() => void saveMapping()}
                >
                  {saving ? "Checking…" : "Save and verify mapping"}
                </Button>
              </div>
            ) : null}
            <p className="text-sm text-muted-foreground">
              Connection defaults and per-account mappings remain editable in System and Account
              settings after setup. Each user's file permissions still apply.
            </p>
          </div>
        </details>
      </CardContent>
    </Card>
  );
}

function FeatureCard({
  id,
  values,
  disabled,
  onChange,
  status,
}: {
  id: FeatureId;
  values: FeatureValues;
  disabled: boolean;
  onChange: (id: FeatureId, enabled: boolean) => void;
  status: SystemFeaturesResponse["statuses"][number] | undefined;
}) {
  const info = FEATURE_DESCRIPTIONS[id];
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle>{info.title}</CardTitle>
          {status ? <Badge variant="secondary">{status.state}</Badge> : null}
        </div>
        <CardDescription>{info.description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Field orientation="horizontal">
          <FieldLabel htmlFor={`feature-${id}`}>Enable {info.title.toLowerCase()}</FieldLabel>
          <Switch
            id={`feature-${id}`}
            checked={values[id]}
            disabled={disabled}
            onCheckedChange={(checked) => onChange(id, checked)}
          />
        </Field>
        <FieldDescription>{info.cost}</FieldDescription>
        <FieldDescription>{info.dependency}</FieldDescription>
        {status ? (
          <p className="text-xs text-muted-foreground" role="status">
            {status.detail}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function FeatureEditor({ data }: { data: SystemFeaturesResponse }) {
  const router = useRouter();
  const update = useUpdateFeatures();
  const [draft, setDraft] = useState<{ values: FeatureValues; revision: number } | null>(null);
  const [localStep, setLocalStep] = useState<number | null>(null);
  const configuration = data.configuration;
  const values = draft?.values ?? configuration.values;
  const step = localStep ?? configuration.walkthroughStep ?? 0;
  const walkthrough = !configuration.walkthroughComplete;
  const id = FEATURE_IDS[step];
  function change(id: FeatureId, enabled: boolean) {
    setDraft({
      values: changeFeature(values, id, enabled),
      revision: draft?.revision ?? configuration.revision,
    });
  }
  function save(
    patch: Partial<Pick<FeatureConfiguration, "walkthroughComplete" | "walkthroughStep">> = {},
    nextValues = values,
  ) {
    update.mutate(
      {
        revision: draft?.revision ?? configuration.revision,
        values: nextValues,
        walkthroughComplete: configuration.walkthroughComplete,
        walkthroughStep: step,
        ...patch,
      },
      {
        onSuccess: () => {
          setDraft(null);
          setLocalStep(null);
          if (patch.walkthroughComplete === true) router.replace("/files" as Route);
          else if (patch.walkthroughComplete === false) router.replace("/setup" as Route);
        },
      },
    );
  }
  const cards = walkthrough ? (id === undefined ? [] : [id]) : FEATURE_IDS;
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      {walkthrough ? (
        <div>
          <h2 className="font-medium">fdrive setup walkthrough</h2>
          <p className="text-sm text-muted-foreground">
            Step {step + 4} of 10 ·{" "}
            {step === 6 ? "Review" : id ? FEATURE_DESCRIPTIONS[id].title : "Features"}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            Choose each optional feature. Your progress is saved when you continue.
          </p>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          Changes apply without restarting the stack. Disabled features retain their existing index
          and cache data.
        </p>
      )}
      {cards.map((featureId) => (
        <FeatureCard
          key={featureId}
          id={featureId}
          values={values}
          onChange={change}
          disabled={update.isPending}
          status={data.statuses.find((status) => status.id === featureId)}
        />
      ))}
      {Object.values(configuration.values).some(Boolean) ? (
        <StorageCheck roots={data.roots} values={configuration.values} />
      ) : null}
      {walkthrough && step === 6 ? (
        <Card>
          <CardHeader>
            <CardTitle>Ready to use fdrive</CardTitle>
            <CardDescription>
              You can finish while optional features prepare. You can change your choices later in
              System → Features.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {FEATURE_IDS.map((featureId) => (
              <div key={featureId} className="flex justify-between gap-3 text-sm">
                <span>{FEATURE_DESCRIPTIONS[featureId].title}</span>
                <span>
                  {values[featureId]
                    ? (data.statuses.find((status) => status.id === featureId)?.state ?? "Enabled")
                    : "Off"}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}
      {update.isError ? (
        <div role="alert" className="text-sm text-destructive">
          {describeApiError(update.error)}
          <Button
            variant="link"
            onClick={() => {
              setDraft(null);
              update.reset();
            }}
          >
            Reload saved choices
          </Button>
        </div>
      ) : null}
      {data.statuses.some((status) => status.state === "failed") ? (
        <Button
          className="self-start"
          variant="outline"
          disabled={update.isPending}
          onClick={() => save()}
        >
          Retry preparation
        </Button>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-3">
        {walkthrough ? (
          <>
            <Button
              variant="ghost"
              disabled={step === 0 || update.isPending}
              onClick={() => setLocalStep(step - 1)}
            >
              Back
            </Button>
            <div className="flex gap-2">
              {id ? (
                <Button
                  variant="outline"
                  disabled={update.isPending}
                  onClick={() =>
                    save({ walkthroughStep: step + 1 }, changeFeature(values, id, false))
                  }
                >
                  Skip this feature
                </Button>
              ) : null}
              <Button
                disabled={update.isPending}
                onClick={() =>
                  save(step === 6 ? { walkthroughComplete: true } : { walkthroughStep: step + 1 })
                }
              >
                {update.isPending ? "Saving…" : step === 6 ? "Finish setup" : "Save and continue"}
              </Button>
            </div>
          </>
        ) : (
          <>
            <Button
              variant="outline"
              disabled={update.isPending}
              onClick={() => save({ walkthroughComplete: false, walkthroughStep: 0 })}
            >
              Run walkthrough
            </Button>
            <div className="flex items-center gap-3">
              <Link href={"/files" as Route} className="text-sm underline">
                Open files
              </Link>
              <Button disabled={draft === null || update.isPending} onClick={() => save()}>
                {update.isPending ? "Saving…" : "Save features"}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function FeaturesPage() {
  const query = useSystemFeatures();
  return (
    <SystemPage
      title="Features"
      description="Set up optional processing and monitor its readiness."
      lastUpdated={query.dataUpdatedAt ? new Date(query.dataUpdatedAt) : null}
    >
      {query.isError ? (
        <SystemErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : query.data ? (
        <FeatureEditor data={query.data} />
      ) : (
        <p role="status">Loading features…</p>
      )}
    </SystemPage>
  );
}

/** Keeps feature selection in the same shell-free screen as server claiming. */
export function SetupFeatures() {
  const query = useSystemFeatures();
  return (
    <SetupFrame description="Choose optional features">
      {query.isError ? (
        <SystemErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : query.data?.configuration.walkthroughComplete ? (
        <p role="status">Opening your files…</p>
      ) : query.data ? (
        <FeatureEditor data={query.data} />
      ) : (
        <p role="status">Loading your setup…</p>
      )}
    </SetupFrame>
  );
}
