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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { describeApiError } from "@/lib/api/errors";
import { useSystemFeatures, useUpdateFeatures } from "@/lib/api/system-queries";
import { changeFeature, FEATURE_DESCRIPTIONS } from "@/lib/system/features";
import { SetupFrame } from "./setup-frame";
import { SystemErrorState } from "./system-error-state";
import { SystemPage } from "./system-page";

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
