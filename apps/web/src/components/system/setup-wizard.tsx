"use client";

import { ApiClientError, LOCAL_PASSWORD_MIN_LENGTH } from "@fdrive/contracts";
import { type FormEvent, type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { describeApiError } from "@/lib/api/errors";
import { useSetupComplete, useSetupStatus } from "@/lib/api/system-queries";
import { localUsernameError, newPasswordErrors } from "@/lib/auth/local-account";
import {
  canLeaveTokenStep,
  nextSetupStep,
  previousSetupStep,
  SETUP_STEPS,
  type SetupStep,
} from "@/lib/system/setup-flow";
import { WALKTHROUGH_TOTAL } from "@/lib/system/walkthrough";
import { SetupFeatures } from "./features-page";
import { SetupFrame } from "./setup-frame";

const STEP_LABELS: Record<SetupStep, string> = {
  token: "Claim",
  account: "Account",
};

const STEP_DESCRIPTIONS: Record<SetupStep, string> = {
  token: "Claim this installation with its setup token",
  account: "Create your account",
};

/**
 * `/setup` before the installation is claimed: the setup token, then the
 * owner's account on the deployment's files folder (`FDRIVE_STORAGE_ROOT`).
 * The account becomes the administrator and the walkthrough continues on
 * the same screen. A deployment without the folder cannot be set up, so
 * the page says what to configure instead of showing the form.
 */
export function SetupWizard() {
  const status = useSetupStatus();
  const [claimed, setClaimed] = useState(false);

  if (claimed) return <SetupFeatures />;
  if (status.data === undefined) {
    return (
      <SetupFrame description="Preparing setup">
        {status.isError ? (
          <SetupRetry onRetry={() => void status.refetch()}>
            <FieldError className="[overflow-wrap:anywhere]">
              {describeApiError(status.error)}
            </FieldError>
          </SetupRetry>
        ) : (
          <p role="status" className="text-sm text-muted-foreground">
            Loading…
          </p>
        )}
      </SetupFrame>
    );
  }
  if (!status.data.storageConfigured) {
    return (
      <SetupFrame description="Choose where fdrive keeps files">
        <SetupRetry onRetry={() => void status.refetch()}>
          <p className="text-sm text-muted-foreground">
            fdrive keeps everyone's files in a folder on this server. Set{" "}
            <code className="font-mono text-foreground">FDRIVE_STORAGE_ROOT</code> to that folder in
            the deployment, restart fdrive, then check again.
          </p>
        </SetupRetry>
      </SetupFrame>
    );
  }
  return <SetupSteps onClaimed={() => setClaimed(true)} />;
}

/** A message with a button that asks for the setup status again. */
function SetupRetry({ children, onRetry }: { children: ReactNode; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-start gap-3">
      {children}
      <Button type="button" variant="outline" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

function SetupSteps({ onClaimed }: { onClaimed: () => void }) {
  const [step, setStep] = useState<SetupStep>("token");
  const [token, setToken] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const setupComplete = useSetupComplete();

  const usernameError = localUsernameError(username);
  const passwordErrors = newPasswordErrors({ password, confirm });
  const canComplete = usernameError === null && passwordErrors.valid;

  function goNext(): void {
    const next = nextSetupStep(step);
    if (next !== null) setStep(next);
  }

  function goBack(): void {
    const previous = previousSetupStep(step);
    if (previous !== null) setStep(previous);
  }

  function handleComplete(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!canComplete) return;
    setupComplete.mutate(
      { token, request: { username: username.trim(), password } },
      {
        onSuccess: () => {
          setPassword("");
          setConfirm("");
          setToken("");
          onClaimed();
        },
      },
    );
  }

  const completeError = setupComplete.isError
    ? setupComplete.error instanceof ApiClientError && setupComplete.error.kind === "unauthorized"
      ? "The setup token was not accepted. Go back and check it."
      : describeApiError(setupComplete.error)
    : null;

  return (
    <SetupFrame description={STEP_DESCRIPTIONS[step]}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          Step {SETUP_STEPS.indexOf(step) + 1} of {WALKTHROUGH_TOTAL}
        </p>
        <Tabs value={step}>
          <TabsList className="w-full">
            {SETUP_STEPS.map((s) => (
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

        {step === "account" ? (
          <form onSubmit={handleComplete}>
            <FieldGroup>
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
                <FieldDescription>Also the name of your folder on this server.</FieldDescription>
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
              {completeError !== null ? <FieldError>{completeError}</FieldError> : null}
              <div className="flex justify-between">
                <Button type="button" variant="ghost" onClick={goBack}>
                  Back
                </Button>
                <Button type="submit" disabled={!canComplete || setupComplete.isPending}>
                  {setupComplete.isPending ? "Creating…" : "Create account"}
                </Button>
              </div>
            </FieldGroup>
          </form>
        ) : null}
      </div>
    </SetupFrame>
  );
}
