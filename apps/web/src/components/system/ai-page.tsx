"use client";

import {
  type AiProvider,
  AiProvider as AiProviderSchema,
  aiProviderHasBaseUrl,
  DEFAULT_AI_MODEL,
} from "@fdrive/contracts";
import { useState } from "react";
import { toast } from "sonner";
import { SettingActions, SettingRow } from "@/components/shell/page-layout";
import { ChoiceRow } from "@/components/shell/setting-controls";
import { StatusBadge, type StatusTone } from "@/components/shell/status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { providerLabel } from "@/lib/ai/organize";
import { useSystemAi, useTestSystemAi, useUpdateSystemAi } from "@/lib/ai/queries";
import {
  AI_PROVIDER_LABELS,
  type AiDraft,
  type AiStatusTone,
  aiStatus,
  draftFrom,
  isDirty,
  keyWillBeDropped,
  requestFrom,
  withProvider,
} from "@/lib/ai/settings-draft";
import { describeApiError } from "@/lib/api/errors";
import { SettingsFormActions } from "./settings-form";
import { SystemErrorState } from "./system-error-state";
import { SystemPage } from "./system-page";
import { SystemLine, SystemNote, SystemSection } from "./system-section";

/** The providers as the segments name them; the header badge spells the saved one out. */
const PROVIDER_SEGMENTS: Record<AiProvider, string> = {
  anthropic: "Anthropic",
  mistral: "Mistral",
  openai_compatible: "OpenAI-compatible",
};

const STATUS_TONES: Record<AiStatusTone, StatusTone> = {
  on: "success",
  off: "off",
  incomplete: "warning",
};

/** How the model and key fields read for each provider. */
const PROVIDER_FIELDS: Record<
  AiProvider,
  { modelPlaceholder: string; modelDescription: string; keyPlaceholder: string }
> = {
  anthropic: {
    modelPlaceholder: DEFAULT_AI_MODEL.anthropic,
    modelDescription: "A Claude model ID; claude-opus-5 plans large reorganizations best.",
    keyPlaceholder: "sk-ant-…",
  },
  mistral: {
    modelPlaceholder: DEFAULT_AI_MODEL.mistral,
    modelDescription: "A Mistral model ID that supports tool calling.",
    keyPlaceholder: "Required",
  },
  openai_compatible: {
    modelPlaceholder: "qwen3:32b",
    modelDescription: "A model your server lists that supports tool calling.",
    keyPlaceholder: "Optional",
  },
};

/** Inputs and buttons in a row are 44px tall on a phone. */
const TOUCH = "max-md:min-h-11";

/**
 * Admin page: `System > AI`, where the provider behind Organize and Chat is chosen. The
 * settings are the sheet's own rows and stay on screen while both are off, since this is where
 * they are turned on. Everything saves together: Organize and Chat need the key beside them.
 */
export function AiSystemPage() {
  const query = useSystemAi();
  const update = useUpdateSystemAi();
  const test = useTestSystemAi();
  const [draft, setDraft] = useState<AiDraft | null>(null);
  const saved = query.data?.configuration;
  const values = draft ?? (saved ? draftFrom(saved) : null);
  const result = values && saved ? requestFrom(values, saved) : null;
  const status = saved ? aiStatus(saved) : null;
  const dirty = values !== null && saved !== undefined && isDirty(values, saved);

  function change(patch: Partial<AiDraft>) {
    if (values) setDraft({ ...values, ...patch });
  }

  function handleSave() {
    if (result === null || !result.ok) return;
    update.mutate(result.request, {
      onSuccess: () => {
        setDraft(null);
        test.reset();
        toast.success("AI settings saved.");
      },
      onError: (error) => toast.error(describeApiError(error)),
    });
  }

  return (
    <SystemPage
      title="AI"
      description="Organizes files and chats about them, using Claude, Mistral or a model you host."
      lastUpdated={query.dataUpdatedAt > 0 ? new Date(query.dataUpdatedAt) : null}
      badges={
        saved !== undefined && status !== null ? (
          <>
            <StatusBadge tone={STATUS_TONES[status.tone]}>{status.label}</StatusBadge>
            <StatusBadge>{AI_PROVIDER_LABELS[saved.provider]}</StatusBadge>
          </>
        ) : null
      }
    >
      {query.isError ? (
        <SystemErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : saved === undefined || values === null || status === null ? (
        <SystemLine role="status">Loading AI settings…</SystemLine>
      ) : (
        <>
          <div data-slot="ai-settings">
            <SettingRow
              label="Organize"
              htmlFor="ai-organize"
              description="Suggests where selected files belong, for everyone signed in. Nothing moves until the person approves."
              align="end"
            >
              <Switch
                id="ai-organize"
                checked={values.organize}
                disabled={update.isPending}
                onCheckedChange={(organize) => change({ organize })}
              />
            </SettingRow>
            <SettingRow
              label="Chat"
              htmlFor="ai-chat"
              description="Lets people chat about their files in a panel and approve the changes it proposes."
              align="end"
            >
              <Switch
                id="ai-chat"
                checked={values.chat}
                disabled={update.isPending}
                onCheckedChange={(chat) => change({ chat })}
              />
            </SettingRow>
            <ChoiceRow
              label="Provider"
              hint="Claude gives the best suggestions; a server like Ollama keeps everything on your network."
              value={values.provider}
              options={AiProviderSchema.options}
              labels={PROVIDER_SEGMENTS}
              onChange={(provider) => setDraft(withProvider(values, provider))}
            />
            {aiProviderHasBaseUrl(values.provider) ? (
              <SettingRow
                label="Base URL"
                htmlFor="ai-base-url"
                description="The server's API root, reachable from the fdrive API container."
              >
                <Input
                  id="ai-base-url"
                  className={TOUCH}
                  value={values.baseUrl}
                  disabled={update.isPending}
                  placeholder="http://ollama:11434/v1"
                  onChange={(event) => change({ baseUrl: event.target.value })}
                />
              </SettingRow>
            ) : null}
            <SettingRow
              label="Model"
              htmlFor="ai-model"
              description={PROVIDER_FIELDS[values.provider].modelDescription}
            >
              <Input
                id="ai-model"
                className={TOUCH}
                value={values.model}
                disabled={update.isPending}
                placeholder={PROVIDER_FIELDS[values.provider].modelPlaceholder}
                onChange={(event) => change({ model: event.target.value })}
              />
            </SettingRow>
            <ApiKeyRow
              values={values}
              hasSavedKey={saved.hasApiKey}
              keyDropped={keyWillBeDropped(values, saved)}
              needed={status.tone === "incomplete"}
              disabled={update.isPending}
              onChange={change}
            />
            <SettingActions>
              {result !== null && !result.ok ? (
                <ul className="mr-auto min-w-0 flex-[1_1_16rem] text-destructive text-sm">
                  {result.errors.map((message) => (
                    <li key={message}>{message}</li>
                  ))}
                </ul>
              ) : null}
              <div className="flex flex-none items-center gap-2">
                <SettingsFormActions
                  dirty={dirty}
                  invalid={result === null || !result.ok}
                  pending={update.isPending}
                  onSave={handleSave}
                  onReset={() => setDraft(null)}
                />
              </div>
            </SettingActions>
          </div>

          <div data-slot="ai-connection">
            <SettingRow
              label="Connection"
              description={
                test.data !== undefined ? (
                  <span
                    role={test.data.ok ? "status" : "alert"}
                    className={
                      test.data.ok
                        ? "[overflow-wrap:anywhere]"
                        : "text-destructive [overflow-wrap:anywhere]"
                    }
                  >
                    {test.data.message}
                  </span>
                ) : test.isError ? (
                  <span role="alert" className="text-destructive [overflow-wrap:anywhere]">
                    {describeApiError(test.error)}
                  </span>
                ) : dirty ? (
                  "Save your changes to test them."
                ) : !aiProviderHasBaseUrl(saved.provider) && !saved.hasApiKey ? (
                  "Save an API key to test the connection."
                ) : (
                  `Sends one short request to ${providerLabel(saved.provider)} with the saved settings.`
                )
              }
              align="end"
            >
              <div className="flex flex-wrap items-center gap-2.5">
                {test.data !== undefined ? (
                  <StatusBadge tone={test.data.ok ? "success" : "danger"}>
                    {test.data.ok ? "Reachable" : "Failed"}
                  </StatusBadge>
                ) : test.isError ? (
                  <StatusBadge tone="danger">Failed</StatusBadge>
                ) : null}
                <Button
                  variant="outline"
                  className={TOUCH}
                  disabled={
                    test.isPending ||
                    dirty ||
                    (!aiProviderHasBaseUrl(saved.provider) && !saved.hasApiKey)
                  }
                  onClick={() => test.mutate()}
                >
                  {test.isPending ? "Testing…" : "Test connection"}
                </Button>
              </div>
            </SettingRow>
          </div>

          <SystemSection
            title="What is sent"
            description={`When someone organizes files, fdrive sends ${providerLabel(saved.provider)} only what it needs to suggest places.`}
          >
            <SystemNote>
              <ul className="list-disc space-y-1 pl-5">
                <li>Paths, sizes and dates of the selected items.</li>
                <li>
                  Names of folders and files anywhere in the drive that the assistant browses or
                  finds by search, with sizes and dates for the folders it opens.
                </li>
                <li>
                  Up to 1,500 characters of already-extracted text for each selected file, unless
                  the person turns off file contents for that run.
                </li>
                <li>
                  Each person chooses in the Organize sheet whether file contents and the names of
                  other files are shared. Files themselves are never uploaded, and nothing moves
                  until the person approves.
                </li>
              </ul>
            </SystemNote>
          </SystemSection>
        </>
      )}
    </SystemPage>
  );
}

/**
 * The API key is never shown again once saved, so its row says whether one is saved, takes a
 * new one, and offers to remove the saved one.
 */
function ApiKeyRow({
  values,
  hasSavedKey,
  keyDropped,
  needed,
  disabled,
  onChange,
}: {
  values: AiDraft;
  hasSavedKey: boolean;
  /** Saving would drop the saved key: the provider or its address changed. */
  keyDropped: boolean;
  /** Organize or Chat is on with no key saved, so neither is offered to anyone. */
  needed: boolean;
  disabled: boolean;
  onChange: (patch: Partial<AiDraft>) => void;
}) {
  const kept = hasSavedKey && !values.clearKey && !keyDropped;
  return (
    <SettingRow
      label="API key"
      htmlFor="ai-api-key"
      description={
        keyDropped
          ? "Changing the provider or base URL removes the saved key."
          : values.clearKey
            ? "The saved key is removed when you save."
            : needed
              ? "Organize and Chat stay hidden until an API key is saved."
              : "Stored encrypted and never shown again."
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        {kept ? <StatusBadge>Saved</StatusBadge> : null}
        <Input
          id="ai-api-key"
          type="password"
          autoComplete="off"
          className={`min-w-0 flex-1 basis-56 ${TOUCH}`}
          value={values.apiKey}
          disabled={disabled}
          placeholder={
            kept ? "Enter a new key to replace it" : PROVIDER_FIELDS[values.provider].keyPlaceholder
          }
          onChange={(event) => onChange({ apiKey: event.target.value, clearKey: false })}
        />
        {hasSavedKey && !keyDropped && values.apiKey === "" ? (
          <Button
            type="button"
            variant="outline"
            className={TOUCH}
            disabled={disabled}
            onClick={() => onChange({ clearKey: !values.clearKey })}
          >
            {values.clearKey ? "Keep key" : "Remove key"}
          </Button>
        ) : null}
      </div>
    </SettingRow>
  );
}
