"use client";

import type { PublicProvider } from "@fdrive/contracts";
import type { Route } from "next";
import { type FormEvent, useState } from "react";
import { ProviderFieldInputs } from "@/components/identity/provider-fields";
import { ProviderPicker } from "@/components/identity/provider-picker";
import { StorageNote } from "@/components/identity/storage-note";
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
  selectProvider,
} from "@/lib/auth/login-model";

export interface LoginFormProps {
  readonly destination?: Route;
  /** The enabled providers, resolved server-side by the page; empty when the API was unreachable. */
  readonly providers: readonly PublicProvider[];
}

const EMPTY_VALUES: Readonly<Record<string, string>> = {};
const NONE_REVEALED: ReadonlySet<string> = new Set();

/**
 * The login form: the chosen provider's credential fields, rendered from
 * the API's own field list. With several enabled providers a picker sits
 * above the fields; with one, the subtitle names it. Without any (the API
 * could not be reached while rendering the page) the SFTPGo-shaped
 * defaults render and the server picks its only enabled provider.
 */
export function LoginForm({ providers, destination }: LoginFormProps) {
  const [providerId, setProviderId] = useState<string | null>(null);
  const [values, setValues] = useState(EMPTY_VALUES);
  const [revealed, setRevealed] = useState(NONE_REVEALED);
  const login = useLogin(destination);
  const provider = selectProvider(providers, providerId);
  const fields = credentialFieldsFor(provider);

  function choose(id: string) {
    setProviderId(id);
    setValues(EMPTY_VALUES);
    setRevealed(NONE_REVEALED);
    login.reset();
  }

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
          <CardDescription>{loginSubtitle(providers)}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit}>
            <FieldGroup>
              {providers.length > 1 && provider !== undefined && (
                <ProviderPicker
                  id="login-provider"
                  providers={providers}
                  value={provider.id}
                  onChange={choose}
                  disabled={login.isPending}
                />
              )}
              {providers.length > 1 ? null : <StorageNote capabilities={provider?.capabilities} />}
              <ProviderFieldInputs
                key={provider?.id ?? "default"}
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
