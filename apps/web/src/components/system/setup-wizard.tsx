"use client";

import {
  type AdminProviderType,
  ApiClientError,
  LOCAL_PASSWORD_MIN_LENGTH,
  type ProviderType,
  type SetupStatusResponse,
} from "@fdrive/contracts";
import { type FormEvent, useState } from "react";
import { ProviderFieldInputs } from "@/components/identity/provider-fields";
import { StorageNote } from "@/components/identity/storage-note";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { describeApiError } from "@/lib/api/errors";
import { useSetupComplete, useSetupStatus, useSetupTest } from "@/lib/api/system-queries";
import { localUsernameError, newPasswordErrors } from "@/lib/auth/local-account";
import { buildCredential, credentialComplete } from "@/lib/auth/login-model";
import {
  normalizeProviderConfig,
  providerAddressHint,
  providerConfigDraft,
} from "@/lib/system/connection";
import {
  canLeaveConnectionStep,
  canLeaveTokenStep,
  connectionStepError,
  connectionTestKey,
  nextSetupStep,
  previousSetupStep,
  SETUP_STEPS,
  type SetupStep,
} from "@/lib/system/setup-flow";
import { walkthroughTotal } from "@/lib/system/walkthrough";
import { SetupFeatures } from "./features-page";
import { SetupFrame } from "./setup-frame";

const STEP_LABELS: Record<SetupStep, string> = {
  token: "Claim",
  connection: "Storage",
  account: "Account",
};

function stepDescription(mode: SetupStatusResponse["mode"], step: SetupStep): string {
  if (step === "token") return "Claim this installation with its setup token";
  if (step === "connection") return "Connect the storage people sign in to";
  return mode === "local" ? "Create your account" : "Sign in to your storage";
}

/**
 * `/setup` before the installation is claimed: the setup token, then the
 * owner's account. With a local folder (`FDRIVE_STORAGE_ROOT`) the owner
 * picks a username and password for it; without one they connect WebDAV or
 * S3 first and sign in to it. Either way the account becomes the
 * administrator and the walkthrough continues on the same screen.
 */
export function SetupWizard() {
  const status = useSetupStatus();
  const [claimed, setClaimed] = useState(false);

  if (claimed) return <SetupFeatures />;
  if (status.data === undefined) {
    return (
      <SetupFrame description="Preparing setup">
        {status.isError ? (
          <div className="flex flex-col items-start gap-3">
            <FieldError className="[overflow-wrap:anywhere]">
              {describeApiError(status.error)}
            </FieldError>
            <Button type="button" variant="outline" onClick={() => void status.refetch()}>
              Try again
            </Button>
          </div>
        ) : (
          <p role="status" className="text-sm text-muted-foreground">
            Loading…
          </p>
        )}
      </SetupFrame>
    );
  }
  return <SetupSteps status={status.data} onClaimed={() => setClaimed(true)} />;
}

function SetupSteps({ status, onClaimed }: { status: SetupStatusResponse; onClaimed: () => void }) {
  const mode = status.mode;
  const steps = SETUP_STEPS[mode];
  const [step, setStep] = useState<SetupStep>("token");
  const [token, setToken] = useState("");

  // Provider mode: the storage to connect and the owner's sign-in to it.
  const [type, setType] = useState<string>(status.types[0]?.type ?? "");
  const selected: AdminProviderType | undefined = status.types.find((entry) => entry.type === type);
  const configFields = selected?.configFields ?? [];
  const credentialFields = selected?.credentialFields ?? [];
  const [label, setLabel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [config, setConfig] = useState<Record<string, string>>(() =>
    providerConfigDraft(configFields),
  );
  const [touched, setTouched] = useState(false);
  const [testedKey, setTestedKey] = useState<string | null>(null);
  const [credential, setCredential] = useState<Record<string, string>>({});
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(new Set());

  // Local mode: the owner's new account on the folder.
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");

  const setupTest = useSetupTest();
  const setupComplete = useSetupComplete();

  const draft = { type, label, baseUrl, config };
  const draftKey = connectionTestKey(draft);
  const formError = connectionStepError(configFields, draft);
  const testResult = setupTest.data ?? null;
  const testIsCurrent = testedKey === draftKey;
  const canLeaveConnection = canLeaveConnectionStep(configFields, draft, testResult, testedKey);

  const usernameError = localUsernameError(username);
  const passwordErrors = newPasswordErrors({ password, confirm });
  const canComplete =
    mode === "local"
      ? usernameError === null && passwordErrors.valid
      : credentialComplete(credentialFields, credential);

  function goNext(): void {
    const next = nextSetupStep(mode, step);
    if (next !== null) setStep(next);
  }

  function goBack(): void {
    const previous = previousSetupStep(mode, step);
    if (previous !== null) setStep(previous);
  }

  function changeType(next: string): void {
    const fields = status.types.find((entry) => entry.type === next)?.configFields ?? [];
    setType(next);
    setConfig(providerConfigDraft(fields));
    setCredential({});
    setRevealed(new Set());
    setupTest.reset();
  }

  function handleTest(): void {
    const key = draftKey;
    setupTest.mutate(
      {
        token,
        request: {
          type: type as ProviderType,
          baseUrl: baseUrl.trim(),
          config: normalizeProviderConfig(config),
        },
      },
      { onSuccess: () => setTestedKey(key) },
    );
  }

  function handleComplete(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!canComplete) return;
    const configuration = normalizeProviderConfig(config);
    setupComplete.mutate(
      {
        token,
        request:
          mode === "local"
            ? { kind: "local", username: username.trim(), password }
            : {
                kind: "provider",
                type: type as ProviderType,
                baseUrl: baseUrl.trim(),
                label: label.trim(),
                ...(Object.keys(configuration).length > 0 ? { config: configuration } : {}),
                credential: buildCredential(credentialFields, credential),
              },
      },
      {
        onSuccess: () => {
          setPassword("");
          setConfirm("");
          setCredential({});
          setToken("");
          onClaimed();
        },
      },
    );
  }

  const completeError = setupComplete.isError
    ? setupComplete.error instanceof ApiClientError && setupComplete.error.kind === "unauthorized"
      ? mode === "local"
        ? "The setup token was not accepted. Go back and check it."
        : "Sign-in failed. Check the setup token and your sign-in details."
      : describeApiError(setupComplete.error)
    : null;

  return (
    <SetupFrame description={stepDescription(mode, step)}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          Step {steps.indexOf(step) + 1} of {walkthroughTotal(mode)}
        </p>
        <Tabs value={step}>
          <TabsList className="w-full">
            {steps.map((s) => (
              <TabsTrigger key={s} value={s} disabled className="data-active:font-semibold">
                {STEP_LABELS[s]}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        {step === "token" ? (
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="setup-token">Setup token</FieldLabel>
              <FieldDescription>
                Printed to the API's log at startup: "setup token: &lt;token&gt;".
              </FieldDescription>
              <Input
                id="setup-token"
                type="password"
                autoFocus
                value={token}
                onChange={(event) => setToken(event.target.value)}
              />
            </Field>
            <Field>
              <Button type="button" disabled={!canLeaveTokenStep(token)} onClick={goNext}>
                Continue
              </Button>
            </Field>
          </FieldGroup>
        ) : null}

        {step === "connection" ? (
          <FieldGroup>
            {status.types.length === 0 ? (
              <FieldError>This installation offers no storage types to connect.</FieldError>
            ) : null}
            <Field>
              <FieldLabel htmlFor="setup-provider-type">Storage type</FieldLabel>
              <Select
                items={status.types.map((entry) => ({ value: entry.type, label: entry.label }))}
                value={type}
                onValueChange={(value) => changeType(value ?? type)}
              >
                <SelectTrigger id="setup-provider-type" className="w-full">
                  <SelectValue placeholder="Choose a type" />
                </SelectTrigger>
                <SelectContent>
                  {status.types.map((entry) => (
                    <SelectItem key={entry.type} value={entry.type}>
                      {entry.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <StorageNote capabilities={selected?.capabilities} />
            </Field>
            <Field>
              <FieldLabel htmlFor="setup-provider-name">Storage name</FieldLabel>
              <Input
                id="setup-provider-name"
                placeholder="Home storage"
                value={label}
                maxLength={120}
                required
                onChange={(event) => {
                  setLabel(event.target.value);
                  setTouched(true);
                }}
              />
              <FieldDescription>Shown when choosing storage and in Finder.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="setup-base-url">Address</FieldLabel>
              <Input
                id="setup-base-url"
                placeholder={providerAddressHint(type).example}
                value={baseUrl}
                required
                onChange={(event) => {
                  setBaseUrl(event.target.value);
                  setTouched(true);
                }}
              />
              <FieldDescription>{providerAddressHint(type).description}</FieldDescription>
            </Field>
            <ProviderFieldInputs
              fields={configFields}
              values={config}
              idPrefix="setup-config"
              onChange={(name, value) => {
                setConfig({ ...config, [name]: value });
                setTouched(true);
              }}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={formError !== null || setupTest.isPending}
                onClick={handleTest}
              >
                {setupTest.isPending ? "Testing…" : "Test connection"}
              </Button>
              {testResult?.ok && testIsCurrent ? <Badge>Reachable</Badge> : null}
            </div>
            {touched && formError !== null ? <FieldError>{formError}</FieldError> : null}
            {testResult && !testResult.ok && testIsCurrent ? (
              <FieldError className="min-w-0 [overflow-wrap:anywhere]">
                {testResult.detail}
              </FieldError>
            ) : null}
            {setupTest.isError ? (
              <FieldError className="min-w-0 [overflow-wrap:anywhere]">
                {describeApiError(setupTest.error)}
              </FieldError>
            ) : null}
            <div className="flex justify-between">
              <Button type="button" variant="ghost" onClick={goBack}>
                Back
              </Button>
              <Button type="button" disabled={!canLeaveConnection} onClick={goNext}>
                Continue
              </Button>
            </div>
          </FieldGroup>
        ) : null}

        {step === "account" ? (
          <form onSubmit={handleComplete}>
            <FieldGroup>
              {mode === "local" ? (
                <>
                  <FieldDescription>
                    This account manages fdrive. Add everyone else under System &gt; Users.
                  </FieldDescription>
                  <Field>
                    <FieldLabel htmlFor="setup-username">Username</FieldLabel>
                    <Input
                      id="setup-username"
                      autoComplete="username"
                      autoFocus
                      maxLength={255}
                      value={username}
                      aria-invalid={username.length > 0 && usernameError !== null}
                      onChange={(event) => setUsername(event.target.value)}
                    />
                    <FieldDescription>
                      Also the name of your folder on this server.
                    </FieldDescription>
                    {username.length > 0 && usernameError !== null ? (
                      <FieldError>{usernameError}</FieldError>
                    ) : null}
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="setup-password">Password</FieldLabel>
                    <Input
                      id="setup-password"
                      type="password"
                      autoComplete="new-password"
                      maxLength={1024}
                      value={password}
                      aria-invalid={passwordErrors.password !== null}
                      onChange={(event) => setPassword(event.target.value)}
                    />
                    <FieldDescription>
                      At least {LOCAL_PASSWORD_MIN_LENGTH} characters.
                    </FieldDescription>
                    {passwordErrors.password !== null ? (
                      <FieldError>{passwordErrors.password}</FieldError>
                    ) : null}
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="setup-confirm">Confirm password</FieldLabel>
                    <Input
                      id="setup-confirm"
                      type="password"
                      autoComplete="new-password"
                      maxLength={1024}
                      value={confirm}
                      aria-invalid={passwordErrors.confirm !== null}
                      onChange={(event) => setConfirm(event.target.value)}
                    />
                    {passwordErrors.confirm !== null ? (
                      <FieldError>{passwordErrors.confirm}</FieldError>
                    ) : null}
                  </Field>
                </>
              ) : (
                <>
                  <FieldDescription>
                    Sign in with your account on {label.trim()}. It becomes fdrive's administrator;
                    everyone else signs in with their own account.
                  </FieldDescription>
                  <ProviderFieldInputs
                    fields={credentialFields}
                    values={credential}
                    idPrefix="setup-credential"
                    autoFocus
                    revealOptionalCode
                    revealed={revealed}
                    onReveal={(name) => setRevealed(new Set([...revealed, name]))}
                    onChange={(name, value) => setCredential({ ...credential, [name]: value })}
                  />
                </>
              )}
              {completeError !== null ? <FieldError>{completeError}</FieldError> : null}
              <div className="flex justify-between">
                <Button type="button" variant="ghost" onClick={goBack}>
                  Back
                </Button>
                <Button type="submit" disabled={!canComplete || setupComplete.isPending}>
                  {setupComplete.isPending
                    ? mode === "local"
                      ? "Creating…"
                      : "Verifying…"
                    : mode === "local"
                      ? "Create account"
                      : "Continue setup"}
                </Button>
              </div>
            </FieldGroup>
          </form>
        ) : null}
      </div>
    </SetupFrame>
  );
}
