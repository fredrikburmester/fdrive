"use client";

import {
  FEATURE_IDS,
  type FeatureConfiguration,
  type FeatureId,
  type FeatureValues,
  type SystemFeaturesResponse,
} from "@fdrive/contracts";
import type { Route } from "next";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { SettingActions, SettingRow } from "@/components/shell/page-layout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { describeApiError } from "@/lib/api/errors";
import { useSystemFeatures, useUpdateFeatures } from "@/lib/api/system-queries";
import { changeFeature, FEATURE_DESCRIPTIONS } from "@/lib/system/features";
import { FEATURE_PAGES } from "@/lib/system/pages";
import { WALKTHROUGH_STEPS, walkthroughLabel } from "@/lib/system/walkthrough";
import { OfficeFeatureCard } from "./office-feature-card";
import { OfficeReview, OfficeSettingsCard } from "./office-settings-card";
import { PublicUrlCard, PublicUrlReview } from "./public-url-card";
import { SetupFrame } from "./setup-frame";
import { SystemErrorState } from "./system-error-state";
import { SystemPage } from "./system-page";
import { SystemAlert, SystemCardSurface, SystemLine, SystemSection } from "./system-section";

interface FeatureControlProps {
  id: FeatureId;
  values: FeatureValues;
  disabled: boolean;
  onChange: (id: FeatureId, enabled: boolean) => void;
  status: SystemFeaturesResponse["statuses"][number] | undefined;
}

/** What turning the feature on costs, and what it switches on or off with it. */
function featureNote(id: FeatureId): string {
  const info = FEATURE_DESCRIPTIONS[id];
  return [info.cost, info.dependency].filter(Boolean).join(" ");
}

/** One feature on the Features page: a row with its toggle, state and a link to its own page. */
function FeatureRow({ id, values, disabled, onChange, status }: FeatureControlProps) {
  const info = FEATURE_DESCRIPTIONS[id];
  return (
    <SettingRow
      data-feature={id}
      label={info.title}
      description={info.description}
      className="@2xl:items-start"
    >
      <div className="flex min-h-6 flex-wrap items-center gap-x-3 gap-y-1.5">
        <Switch
          id={`feature-${id}`}
          aria-label={`Enable ${info.title.toLowerCase()}`}
          checked={values[id]}
          disabled={disabled}
          onCheckedChange={(checked) => onChange(id, checked)}
        />
        {status ? <Badge variant="secondary">{status.state}</Badge> : null}
        <Link href={FEATURE_PAGES[id].href} className="text-sm underline underline-offset-4">
          Open {FEATURE_PAGES[id].label}
        </Link>
      </div>
      <p className="mt-1.5 max-w-3xl text-muted-foreground text-xs">{featureNote(id)}</p>
      {status ? (
        <p className="max-w-3xl text-muted-foreground text-xs" role="status">
          {status.detail}
        </p>
      ) : null}
    </SettingRow>
  );
}

/** One feature as a walkthrough step: a card, with no link out of the setup screen. */
function FeatureCard({ id, values, disabled, onChange, status }: FeatureControlProps) {
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
        <FieldDescription>{featureNote(id)}</FieldDescription>
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
  const current = WALKTHROUGH_STEPS[step];
  const id = current?.kind === "feature" ? current.id : undefined;
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
  const problem = update.isError ? (
    <>
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
    </>
  ) : null;
  const retryPreparation = data.statuses.some((status) => status.state === "failed") ? (
    <Button
      className="self-start"
      variant="outline"
      disabled={update.isPending}
      onClick={() => save()}
    >
      Retry preparation
    </Button>
  ) : null;
  if (!walkthrough) {
    return (
      <SystemSection
        title="Optional features"
        description="Changes apply without restarting the stack. Disabled features retain their existing index and cache data."
      >
        {FEATURE_IDS.map((featureId) => (
          <FeatureRow
            key={featureId}
            id={featureId}
            values={values}
            onChange={change}
            disabled={update.isPending}
            status={data.statuses.find((status) => status.id === featureId)}
          />
        ))}
        <OfficeFeatureCard disabled={update.isPending} />
        {problem ? <SystemAlert row>{problem}</SystemAlert> : null}
        <SettingActions className="max-md:[&_button]:min-h-11">
          <Button disabled={draft === null || update.isPending} onClick={() => save()}>
            {update.isPending ? "Saving…" : "Save features"}
          </Button>
          <Button
            variant="outline"
            disabled={update.isPending}
            onClick={() => save({ walkthroughComplete: false, walkthroughStep: 0 })}
          >
            Run walkthrough
          </Button>
          {retryPreparation}
          <Link href={"/files" as Route} className="text-sm underline underline-offset-4">
            Open files
          </Link>
        </SettingActions>
      </SystemSection>
    );
  }
  return (
    <SystemCardSurface>
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
        <div>
          <h2 className="font-medium">fdrive setup walkthrough</h2>
          <p className="text-sm text-muted-foreground">{walkthroughLabel(step)}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Choose each optional feature. Your progress is saved when you continue.
          </p>
        </div>
        {id === undefined ? null : (
          <FeatureCard
            id={id}
            values={values}
            onChange={change}
            disabled={update.isPending}
            status={data.statuses.find((status) => status.id === id)}
          />
        )}
        {current?.kind === "publicUrl" ? (
          <PublicUrlCard
            disabled={update.isPending}
            onContinue={() => save({ walkthroughStep: step + 1 })}
          />
        ) : null}
        {current?.kind === "office" ? (
          <OfficeSettingsCard
            disabled={update.isPending}
            onContinue={() => save({ walkthroughStep: step + 1 })}
          />
        ) : null}
        {current?.kind === "review" ? (
          <Card>
            <CardHeader>
              <CardTitle>Ready to use fdrive</CardTitle>
              <CardDescription>
                You can finish while optional features prepare. You can change your choices later
                under System: Features and General.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {FEATURE_IDS.map((featureId) => (
                <div key={featureId} className="flex justify-between gap-3 text-sm">
                  <span>{FEATURE_DESCRIPTIONS[featureId].title}</span>
                  <span>
                    {values[featureId]
                      ? (data.statuses.find((status) => status.id === featureId)?.state ??
                        "Enabled")
                      : "Off"}
                  </span>
                </div>
              ))}
              <PublicUrlReview />
              <OfficeReview />
            </CardContent>
          </Card>
        ) : null}
        {problem ? (
          <div role="alert" className="text-sm text-destructive">
            {problem}
          </div>
        ) : null}
        {retryPreparation}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Button
            variant="ghost"
            disabled={step === 0 || update.isPending}
            onClick={() => setLocalStep(step - 1)}
          >
            Back
          </Button>
          {current?.kind === "feature" || current?.kind === "review" ? (
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
                  save(
                    current?.kind === "review"
                      ? { walkthroughComplete: true }
                      : { walkthroughStep: step + 1 },
                  )
                }
              >
                {update.isPending
                  ? "Saving…"
                  : current?.kind === "review"
                    ? "Finish setup"
                    : "Save and continue"}
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    </SystemCardSurface>
  );
}

export function FeaturesPage() {
  const query = useSystemFeatures();
  return (
    <SystemPage
      title="Features"
      description="Turn optional features on or off. Each feature's settings live on its own page."
      lastUpdated={query.dataUpdatedAt ? new Date(query.dataUpdatedAt) : null}
    >
      {query.isError ? (
        <SystemErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : query.data === undefined ? (
        <SystemLine role="status">Loading features…</SystemLine>
      ) : query.data.configuration.walkthroughComplete ? (
        <FeatureEditor data={query.data} />
      ) : (
        // Only until "Run walkthrough" lands on /setup: the cards need room the page no longer adds.
        <div className="p-3 sm:p-6">
          <FeatureEditor data={query.data} />
        </div>
      )}
    </SystemPage>
  );
}

/** Keeps feature selection in the same shell-free screen as server claiming. */
export function SetupFeatures() {
  const query = useSystemFeatures();
  return (
    <SetupFrame description="Choose optional features">
      <SystemCardSurface>
        {query.isError ? (
          <SystemErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : query.data?.configuration.walkthroughComplete ? (
          <p role="status">Opening your files…</p>
        ) : query.data ? (
          <FeatureEditor data={query.data} />
        ) : (
          <p role="status">Loading your setup…</p>
        )}
      </SystemCardSurface>
    </SetupFrame>
  );
}
