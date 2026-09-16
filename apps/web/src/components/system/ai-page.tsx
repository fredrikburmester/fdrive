"use client";

import { type AiProvider, AiProvider as AiProviderSchema } from "@fdrive/contracts";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { providerLabel } from "@/lib/ai/organize";
import { useSystemAi, useTestSystemAi, useUpdateSystemAi } from "@/lib/ai/queries";
import {
  AI_PROVIDER_LABELS,
  type AiDraft,
  aiStatus,
  draftFrom,
  isDirty,
  keyWillBeDropped,
  requestFrom,
  withProvider,
} from "@/lib/ai/settings-draft";
import { describeApiError } from "@/lib/api/errors";
import { SettingsSheet, SystemSettingsButton } from "./settings-sheet";
import { StatGrid } from "./stat-grid";
import { SystemErrorState } from "./system-error-state";
import { SystemPage } from "./system-page";
import { SystemSection } from "./system-section";

const PROVIDER_ITEMS = AiProviderSchema.options.map((value) => ({
  value,
  label: AI_PROVIDER_LABELS[value],
}));

const TONE_VARIANT = { on: "default", off: "outline", incomplete: "destructive" } as const;

/** Admin page: `System > AI`, where the provider behind Organize is chosen. */
export function AiSystemPage() {
  const query = useSystemAi();
  const update = useUpdateSystemAi();
  const test = useTestSystemAi();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draft, setDraft] = useState<AiDraft | null>(null);
  const saved = query.data?.configuration;
  const values = draft ?? (saved ? draftFrom(saved) : null);
  const result = values && saved ? requestFrom(values, saved) : null;
  const status = saved ? aiStatus(saved) : null;

  function change(patch: Partial<AiDraft>) {
    if (values) setDraft({ ...values, ...patch });
  }

  function handleSave() {
    if (result === null || !result.ok) return;
    update.mutate(result.request, {
      onSuccess: () => {
        setDraft(null);
        test.reset();
        setSettingsOpen(false);
        toast.success("AI settings saved.");
      },
      onError: (error) => toast.error(describeApiError(error)),
    });
  }

  return (
    <SystemPage
      title="AI"
      description="Suggests where files belong, using Claude or a model you host."
      lastUpdated={query.dataUpdatedAt > 0 ? new Date(query.dataUpdatedAt) : null}
      actions={
        <SystemSettingsButton
          onClick={() => setSettingsOpen(true)}
          disabled={saved === undefined}
        />
      }
    >
      {query.isError ? (
        <SystemErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : saved === undefined || status === null ? (
        <p role="status">Loading AI settings…</p>
      ) : (
        <>
          <SystemSection
            title="Status"
            description={
              status.tone === "on"
                ? "Organize is available to everyone signed in."
                : status.tone === "off"
                  ? "Organize is hidden. Turn AI on in Settings."
                  : "Organize stays hidden until an API key is saved."
            }
            actions={
              <Button
                variant="outline"
                size="sm"
                disabled={test.isPending || (saved.provider === "anthropic" && !saved.hasApiKey)}
                onClick={() => test.mutate()}
              >
                {test.isPending ? "Checking…" : "Check connection"}
              </Button>
            }
          >
            <Badge variant={TONE_VARIANT[status.tone]} className="self-start">
              {status.label}
            </Badge>
            {test.data ? (
              <p
                role={test.data.ok ? "status" : "alert"}
                className={test.data.ok ? "text-sm" : "text-sm text-destructive"}
              >
                {test.data.message}
              </p>
            ) : null}
            {test.isError ? (
              <p role="alert" className="text-sm text-destructive">
                {describeApiError(test.error)}
              </p>
            ) : null}
          </SystemSection>

          <StatGrid
            stats={[
              { label: "Provider", value: AI_PROVIDER_LABELS[saved.provider] },
              { label: "Model", value: saved.model },
              { label: "API key", value: saved.hasApiKey ? "Saved" : "None" },
            ]}
          />

          <SystemSection
            title="What is sent"
            description={`When someone organizes files, fdrive sends ${providerLabel(saved.provider)} only what it needs to suggest places.`}
          >
            <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
              <li>Paths, sizes and dates of the selected items.</li>
              <li>
                Names of folders and files anywhere in the drive that the assistant browses or finds
                by search, with sizes and dates for the folders it opens.
              </li>
              <li>
                Up to 1,500 characters of already-extracted text for each selected file, unless the
                person turns off file contents for that run.
              </li>
              <li>
                Each person chooses in the Organize sheet whether file contents and the names of
                other files are shared. Files themselves are never uploaded, and nothing moves until
                the person approves.
              </li>
            </ul>
          </SystemSection>
        </>
      )}

      <SettingsSheet
        title="AI settings"
        description="The provider, model and key Organize uses."
        open={settingsOpen}
        onOpenChange={(open) => {
          setSettingsOpen(open);
          if (!open) setDraft(null);
        }}
        dirty={values !== null && saved !== undefined && isDirty(values, saved)}
        invalid={result === null || !result.ok}
        pending={update.isPending}
        onSave={handleSave}
        onReset={() => setDraft(null)}
        validationMessages={result !== null && !result.ok ? result.errors : []}
      >
        {values !== null && saved !== undefined ? (
          <AiSettingsFields
            values={values}
            hasSavedKey={saved.hasApiKey}
            keyDropped={keyWillBeDropped(values, saved)}
            disabled={update.isPending}
            onChange={change}
            onProviderChange={(provider) => setDraft(withProvider(values, provider))}
          />
        ) : null}
      </SettingsSheet>
    </SystemPage>
  );
}

function AiSettingsFields({
  values,
  hasSavedKey,
  keyDropped,
  disabled,
  onChange,
  onProviderChange,
}: {
  values: AiDraft;
  hasSavedKey: boolean;
  keyDropped: boolean;
  disabled: boolean;
  onChange: (patch: Partial<AiDraft>) => void;
  onProviderChange: (provider: AiProvider) => void;
}) {
  const anthropic = values.provider === "anthropic";
  const keyPlaceholder =
    hasSavedKey && !values.clearKey && !keyDropped
      ? "Saved. Enter a new key to replace it"
      : anthropic
        ? "sk-ant-…"
        : "Optional";
  return (
    <>
      <Field orientation="horizontal">
        <FieldLabel htmlFor="ai-enabled">Turn on AI</FieldLabel>
        <Switch
          id="ai-enabled"
          checked={values.enabled}
          disabled={disabled}
          onCheckedChange={(enabled) => onChange({ enabled })}
        />
      </Field>
      <FieldDescription>Shows Organize to everyone signed in to fdrive.</FieldDescription>
      <Field>
        <FieldLabel htmlFor="ai-provider">Provider</FieldLabel>
        <Select
          items={PROVIDER_ITEMS}
          value={values.provider}
          onValueChange={(value) => {
            if (value !== null) onProviderChange(value);
          }}
        >
          <SelectTrigger id="ai-provider" disabled={disabled}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PROVIDER_ITEMS.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FieldDescription>
          Claude gives the best suggestions; a server like Ollama keeps everything on your network.
        </FieldDescription>
      </Field>
      {anthropic ? null : (
        <Field>
          <FieldLabel htmlFor="ai-base-url">Base URL</FieldLabel>
          <Input
            id="ai-base-url"
            value={values.baseUrl}
            disabled={disabled}
            placeholder="http://ollama:11434/v1"
            onChange={(event) => onChange({ baseUrl: event.target.value })}
          />
          <FieldDescription>
            The server's API root, reachable from the fdrive API container.
          </FieldDescription>
        </Field>
      )}
      <Field>
        <FieldLabel htmlFor="ai-model">Model</FieldLabel>
        <Input
          id="ai-model"
          value={values.model}
          disabled={disabled}
          placeholder={anthropic ? "claude-opus-5" : "qwen3:32b"}
          onChange={(event) => onChange({ model: event.target.value })}
        />
        <FieldDescription>
          {anthropic
            ? "A Claude model ID; claude-opus-5 plans large reorganizations best."
            : "A model your server lists that supports tool calling."}
        </FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor="ai-api-key">API key</FieldLabel>
        <Input
          id="ai-api-key"
          type="password"
          autoComplete="off"
          value={values.apiKey}
          disabled={disabled}
          placeholder={keyPlaceholder}
          onChange={(event) => onChange({ apiKey: event.target.value, clearKey: false })}
        />
        <FieldDescription>
          {keyDropped
            ? "Changing the provider or base URL removes the saved key."
            : "Stored encrypted and never shown again."}
        </FieldDescription>
        {hasSavedKey && !keyDropped && values.apiKey === "" ? (
          <Button
            type="button"
            variant="link"
            size="sm"
            className="self-start px-0"
            disabled={disabled}
            onClick={() => onChange({ clearKey: !values.clearKey })}
          >
            {values.clearKey ? "Keep the saved key" : "Remove the saved key"}
          </Button>
        ) : null}
      </Field>
    </>
  );
}
