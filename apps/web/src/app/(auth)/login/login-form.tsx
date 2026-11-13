"use client";

import type { PublicProvider } from "@fdrive/contracts";
import type { Route } from "next";
import { type FormEvent, useState } from "react";
import { ProviderFieldInputs } from "@/components/identity/provider-fields";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldError, FieldGroup } from "@/components/ui/field";
import { useLogin } from "@/lib/api/auth-queries";
import { describeCredentialError } from "@/lib/api/errors";
import {
  buildCredential,
  credentialComplete,
  credentialFieldsFor,
  loginSubtitle,
} from "@/lib/auth/login-model";

export interface LoginFormProps {
  readonly destination?: Route;
  /** The enabled storage, resolved server-side by the page; empty when the API was unreachable. */
  readonly providers: readonly PublicProvider[];
}

const EMPTY_VALUES: Readonly<Record<string, string>> = {};
const NONE_REVEALED: ReadonlySet<string> = new Set();

/**
 * The login form: the storage's credential fields, rendered from the API's
 * own field list, under a subtitle that names the storage. Without the list
 * (the API could not be reached while rendering the page) the default
 * username and password fields render and the server picks its storage.
 */
export function LoginForm({ providers, destination }: LoginFormProps) {
  const [values, setValues] = useState(EMPTY_VALUES);
  const [revealed, setRevealed] = useState(NONE_REVEALED);
  const login = useLogin(destination);
  const [provider] = providers;
  const fields = credentialFieldsFor(provider);

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!credentialComplete(fields, values)) return;
    login.mutate({
      ...(provider === undefined ? {} : { providerId: provider.id }),
      credential: buildCredential(fields, values),
    });
  }

  return (
    <main className="flex min-h-svh flex-1 items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader className="items-center gap-1 text-center">
          <span className="text-lg font-semibold tracking-tight">fdrive</span>
          <CardTitle>Sign in</CardTitle>
          <CardDescription>{loginSubtitle(provider)}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit}>
            <FieldGroup>
              <ProviderFieldInputs
                fields={fields}
                values={values}
                onChange={(name, value) => setValues((prev) => ({ ...prev, [name]: value }))}
                idPrefix="login"
                autoFocus
                revealOptionalCode
                revealed={revealed}
                onReveal={(name) => setRevealed((prev) => new Set(prev).add(name))}
                disabled={login.isPending}
              />
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
