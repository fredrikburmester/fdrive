"use client";

import type { Route } from "next";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { describeApiError } from "@/lib/api/errors";
import { useSetupComplete, useSetupTest } from "@/lib/api/system-queries";
import { homeTemplatePreview } from "@/lib/system/connection";
import {
  canCompleteAccountStep,
  canLeaveConnectionStep,
  canLeaveTemplateStep,
  canLeaveTokenStep,
  nextSetupStep,
  previousSetupStep,
  SETUP_STEPS,
  type SetupStep,
} from "@/lib/system/setup-flow";

const STEP_LABELS: Record<SetupStep, string> = {
  token: "Token",
  connection: "SFTPGo",
  template: "Home",
  account: "Admin",
};

const DEFAULT_HOME_TEMPLATE = "sftpgo:/{username}";

/** Same escape hatch as `lib/api/auth-queries.ts`: `/files` is not a statically-typed route. */
const FILES_ROUTE = "/files" as unknown as Route;

export function SetupWizard() {
  const router = useRouter();
  const [step, setStep] = useState<SetupStep>("token");
  const [token, setToken] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [testedBaseUrl, setTestedBaseUrl] = useState<string | null>(null);
  const [homeTemplate, setHomeTemplate] = useState(DEFAULT_HOME_TEMPLATE);
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
          homeTemplate,
          username,
          password,
          ...(showOtp && otp.length > 0 ? { otp } : {}),
        },
      },
      { onSuccess: () => router.push(FILES_ROUTE) },
    );
  }

  const testResult = setupTest.data ?? null;
  const canLeaveConnection = canLeaveConnectionStep(baseUrl, testResult, testedBaseUrl);

  return (
    <main className="flex min-h-svh flex-1 items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader className="items-center gap-1 text-center">
          <span className="text-lg font-semibold tracking-tight">fdrive</span>
          <CardTitle>Set up fdrive</CardTitle>
          <CardDescription>Connect fdrive to your SFTPGo server</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
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
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={baseUrl.trim().length === 0 || setupTest.isPending}
                  onClick={handleTest}
                >
                  {setupTest.isPending ? "Testing..." : "Test connection"}
                </Button>
                {testResult && testedBaseUrl === baseUrl ? (
                  <Badge variant={testResult.ok ? "default" : "destructive"}>
                    {testResult.ok ? "Reachable" : testResult.detail}
                  </Badge>
                ) : null}
              </div>
              {setupTest.isError ? (
                <FieldError>{describeApiError(setupTest.error)}</FieldError>
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

          {step === "template" ? (
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="setup-home-template">Home template</FieldLabel>
                <FieldDescription>
                  Maps each SFTPGo username to a path, as "&lt;root&gt;:&lt;path&gt;". The default
                  matches a home directory named after the username.
                </FieldDescription>
                <Input
                  id="setup-home-template"
                  value={homeTemplate}
                  onChange={(event) => setHomeTemplate(event.target.value)}
                />
                <FieldDescription>{homeTemplatePreview(homeTemplate, username)}</FieldDescription>
              </Field>
              <div className="flex justify-between">
                <Button type="button" variant="ghost" onClick={goBack}>
                  Back
                </Button>
                <Button
                  type="button"
                  disabled={!canLeaveTemplateStep(homeTemplate)}
                  onClick={goNext}
                >
                  Continue
                </Button>
              </div>
            </FieldGroup>
          ) : null}

          {step === "account" ? (
            <form onSubmit={handleComplete}>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="setup-username">Admin username</FieldLabel>
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
                  <FieldError>{describeApiError(setupComplete.error)}</FieldError>
                ) : null}
                <div className="flex justify-between">
                  <Button type="button" variant="ghost" onClick={goBack}>
                    Back
                  </Button>
                  <Button
                    type="submit"
                    disabled={
                      !canCompleteAccountStep(username, password) || setupComplete.isPending
                    }
                  >
                    {setupComplete.isPending ? "Completing..." : "Complete setup"}
                  </Button>
                </div>
              </FieldGroup>
            </form>
          ) : null}
        </CardContent>
      </Card>
    </main>
  );
}
