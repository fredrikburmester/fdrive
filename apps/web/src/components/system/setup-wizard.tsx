"use client";

import { ApiClientError } from "@fdrive/contracts";
import { type FormEvent, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { describeApiError } from "@/lib/api/errors";
import { useSetupComplete, useSetupTest } from "@/lib/api/system-queries";
import {
  canCompleteAccountStep,
  canLeaveConnectionStep,
  canLeaveTokenStep,
  nextSetupStep,
  previousSetupStep,
  SETUP_STEPS,
  type SetupStep,
} from "@/lib/system/setup-flow";
import { SetupFeatures } from "./features-page";
import { SetupFrame } from "./setup-frame";

const STEP_LABELS: Record<SetupStep, string> = {
  token: "Claim",
  connection: "SFTPGo",
  account: "Administrator",
};

const DEFAULT_HOME_TEMPLATE = "sftpgo:/{username}";

export function SetupWizard() {
  const [claimed, setClaimed] = useState(false);
  const [step, setStep] = useState<SetupStep>("token");
  const [token, setToken] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [testedBaseUrl, setTestedBaseUrl] = useState<string | null>(null);

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [otp, setOtp] = useState("");
  const [showOtp, setShowOtp] = useState(false);

  const setupTest = useSetupTest();
  const setupComplete = useSetupComplete();

  function goNext(): void {
    const next = nextSetupStep(step);
    if (next !== null) {
      setStep(next);
    }
  }

  function goBack(): void {
    const previous = previousSetupStep(step);
    if (previous !== null) {
      setStep(previous);
    }
  }

  function handleTest(): void {
    setupTest.mutate({ token, baseUrl }, { onSuccess: () => setTestedBaseUrl(baseUrl) });
  }

  function handleComplete(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setupComplete.mutate(
      {
        token,
        request: {
          baseUrl,
          homeTemplate: DEFAULT_HOME_TEMPLATE,
          username,
          password,
          ...(showOtp && otp.length > 0 ? { otp } : {}),
        },
      },
      {
        onSuccess: () => {
          setPassword("");
          setOtp("");
          setToken("");
          setClaimed(true);
        },
      },
    );
  }

  const testResult = setupTest.data ?? null;
  const canLeaveConnection = canLeaveConnectionStep(baseUrl, testResult, testedBaseUrl);

  if (claimed) return <SetupFeatures />;

  return (
    <SetupFrame
      description={
        step === "account"
          ? "Choose your fdrive administrator"
          : "Connect fdrive to your SFTPGo server"
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">Step {SETUP_STEPS.indexOf(step) + 1} of 10</p>
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

        {step === "connection" ? (
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="setup-base-url">SFTPGo URL</FieldLabel>
              <Input
                id="setup-base-url"
                placeholder="http://sftpgo:8080"
                value={baseUrl}
                onChange={(event) => {
                  setBaseUrl(event.target.value);
                  setTestedBaseUrl(null);
                }}
              />
            </Field>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={baseUrl.trim().length === 0 || setupTest.isPending}
                onClick={handleTest}
              >
                {setupTest.isPending ? "Testing..." : "Test connection"}
              </Button>
              {testResult?.ok && testedBaseUrl === baseUrl ? <Badge>Reachable</Badge> : null}
            </div>
            {testResult && !testResult.ok && testedBaseUrl === baseUrl ? (
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
              <Field>
                <FieldLabel htmlFor="setup-username">SFTPGo file-user username</FieldLabel>
                <FieldDescription>
                  Use the account you use in SFTPGo WebClient to browse files, not a SFTPGo WebAdmin
                  account.
                </FieldDescription>
                <FieldDescription>
                  This account will manage settings in fdrive. Its SFTPGo permissions stay
                  unchanged; other users sign in with their own file accounts.
                </FieldDescription>
                <Input
                  id="setup-username"
                  autoComplete="username"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="setup-password">Password</FieldLabel>
                <Input
                  id="setup-password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </Field>
              {showOtp ? (
                <Field>
                  <FieldLabel htmlFor="setup-otp">One-time code</FieldLabel>
                  <Input
                    id="setup-otp"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    value={otp}
                    onChange={(event) => setOtp(event.target.value)}
                  />
                </Field>
              ) : (
                <Button
                  type="button"
                  variant="link"
                  className="h-auto w-fit justify-start p-0 text-muted-foreground"
                  onClick={() => setShowOtp(true)}
                >
                  Use a one-time code
                </Button>
              )}
              {setupComplete.isError ? (
                <FieldError>
                  {setupComplete.error instanceof ApiClientError &&
                  setupComplete.error.kind === "unauthorized"
                    ? "Sign-in failed. Check the setup token, file-user credentials, and any one-time code."
                    : describeApiError(setupComplete.error)}
                </FieldError>
              ) : null}
              <div className="flex justify-between">
                <Button type="button" variant="ghost" onClick={goBack}>
                  Back
                </Button>
                <Button
                  type="submit"
                  disabled={!canCompleteAccountStep(username, password) || setupComplete.isPending}
                >
                  {setupComplete.isPending ? "Verifying…" : "Continue setup"}
                </Button>
              </div>
            </FieldGroup>
          </form>
        ) : null}
      </div>
    </SetupFrame>
  );
}
