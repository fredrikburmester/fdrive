"use client";

import { LOCAL_PASSWORD_MIN_LENGTH } from "@fdrive/contracts";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { useShellMe } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useChangePassword } from "@/lib/account/queries";
import { describeCredentialError } from "@/lib/api/errors";
import { newPasswordErrors } from "@/lib/auth/local-account";

/**
 * Account page card: the active login changes its own password. Only a
 * login on the local folder has a password fdrive keeps; other storage
 * changes passwords on its own server, so the card stays hidden there.
 */
export function PasswordCard() {
  const { data: me } = useShellMe();
  const active = me?.identities.find((identity) => identity.id === me.activeIdentityId);
  if (active?.providerType !== "local") return null;
  return <PasswordForm key={active.id} username={active.username} />;
}

function PasswordForm({ username }: { username: string }) {
  const change = useChangePassword();
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const errors = newPasswordErrors({ password, confirm });
  const ready = current.length > 0 && errors.valid;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready) return;
    change.mutate(
      { currentPassword: current, newPassword: password },
      {
        onSuccess: () => {
          setCurrent("");
          setPassword("");
          setConfirm("");
          toast.success("Password changed. Your other sessions were signed out.");
        },
      },
    );
  }

  return (
    <Card className="w-full max-w-2xl">
      <CardHeader>
        <CardTitle>Password</CardTitle>
        <CardDescription>
          The password {username} signs in with. Changing it signs out your other sessions.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit}>
          {/* Lets password managers file the new password under the right account. */}
          <input
            type="text"
            name="username"
            autoComplete="username"
            value={username}
            readOnly
            hidden
          />
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="account-current-password">Current password</FieldLabel>
              <Input
                id="account-current-password"
                type="password"
                autoComplete="current-password"
                maxLength={1024}
                value={current}
                disabled={change.isPending}
                onChange={(event) => setCurrent(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="account-new-password">New password</FieldLabel>
              <Input
                id="account-new-password"
                type="password"
                autoComplete="new-password"
                maxLength={1024}
                value={password}
                disabled={change.isPending}
                aria-invalid={errors.password !== null}
                onChange={(event) => setPassword(event.target.value)}
              />
              <FieldDescription>At least {LOCAL_PASSWORD_MIN_LENGTH} characters.</FieldDescription>
              {errors.password !== null ? <FieldError>{errors.password}</FieldError> : null}
            </Field>
            <Field>
              <FieldLabel htmlFor="account-confirm-password">Confirm new password</FieldLabel>
              <Input
                id="account-confirm-password"
                type="password"
                autoComplete="new-password"
                maxLength={1024}
                value={confirm}
                disabled={change.isPending}
                aria-invalid={errors.confirm !== null}
                onChange={(event) => setConfirm(event.target.value)}
              />
              {errors.confirm !== null ? <FieldError>{errors.confirm}</FieldError> : null}
            </Field>
            {change.isError ? (
              <FieldError>{describeCredentialError(change.error)}</FieldError>
            ) : null}
            <div className="flex justify-end">
              <Button type="submit" disabled={!ready || change.isPending}>
                {change.isPending ? "Changing…" : "Change password"}
              </Button>
            </div>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
}
