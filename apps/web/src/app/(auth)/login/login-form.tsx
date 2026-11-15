"use client";

import type { Route } from "next";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useLogin } from "@/lib/api/auth-queries";
import { describeCredentialError } from "@/lib/api/errors";

export interface LoginFormProps {
  readonly destination?: Route;
}

/** The login form: an fdrive account's username and password. */
export function LoginForm({ destination }: LoginFormProps) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const login = useLogin(destination);

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (username.length === 0 || password.length === 0) return;
    login.mutate({ username, password });
  }

  return (
    <main className="flex min-h-svh flex-1 items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader className="items-center gap-1 text-center">
          <span className="text-lg font-semibold tracking-tight">fdrive</span>
          <CardTitle>Sign in</CardTitle>
          <CardDescription>Sign in with your fdrive account</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="login-username">Username</FieldLabel>
                <Input
                  id="login-username"
                  name="username"
                  autoComplete="username"
                  autoFocus
                  required
                  maxLength={255}
                  value={username}
                  disabled={login.isPending}
                  onChange={(event) => setUsername(event.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="login-password">Password</FieldLabel>
                <Input
                  id="login-password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  maxLength={1024}
                  value={password}
                  disabled={login.isPending}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </Field>
              {login.isError ? (
                <FieldError>{describeCredentialError(login.error)}</FieldError>
              ) : null}
              <Field>
                <Button type="submit" className="w-full" disabled={login.isPending}>
                  {login.isPending ? "Signing in…" : "Sign in"}
                </Button>
              </Field>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
