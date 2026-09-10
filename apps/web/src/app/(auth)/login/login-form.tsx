"use client";

import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useLogin } from "@/lib/api/auth-queries";
import { describeApiError } from "@/lib/api/errors";

export interface LoginFormProps {
  /** Subtitle shown under the "Sign in" title, naming the SFTPGo host. */
  subtitle: string;
}

/**
 * The login form: username, password, and an optional one-time code field
 * revealed on demand. `subtitle` is resolved server-side (by the page) from
 * the `/about` endpoint's provider label, since this client component has
 * no server-side access.
 */
export function LoginForm({ subtitle }: LoginFormProps) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [otp, setOtp] = useState("");
  const [showOtp, setShowOtp] = useState(false);
  const login = useLogin();

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    login.mutate({
      credential: {
        username,
        password,
        ...(showOtp && otp.length > 0 ? { otp } : {}),
      },
    });
  }

  return (
    <main className="flex min-h-svh flex-1 items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader className="items-center gap-1 text-center">
          <span className="text-lg font-semibold tracking-tight">fdrive</span>
          <CardTitle>Sign in</CardTitle>
          <CardDescription>{subtitle}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="username">Username</FieldLabel>
                <Input
                  id="username"
                  name="username"
                  autoComplete="username"
                  autoFocus
                  required
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="password">Password</FieldLabel>
                <Input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </Field>
              {showOtp ? (
                <Field>
                  <FieldLabel htmlFor="otp">One-time code</FieldLabel>
                  <Input
                    id="otp"
                    name="otp"
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
              {login.isError ? <FieldError>{describeApiError(login.error)}</FieldError> : null}
              <Field>
                <Button type="submit" className="w-full" disabled={login.isPending}>
                  {login.isPending ? "Signing in..." : "Sign in"}
                </Button>
              </Field>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
