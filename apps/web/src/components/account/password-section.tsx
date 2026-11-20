"use client";

import { LOCAL_PASSWORD_MIN_LENGTH } from "@fdrive/contracts";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { DetailSheet } from "@/components/shell/list-sheet";
import { useShellMe } from "@/components/shell/page-header";
import { SettingActions, SettingRow } from "@/components/shell/page-layout";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useChangePassword } from "@/lib/account/queries";
import { describeCredentialError } from "@/lib/api/errors";
import { newPasswordErrors } from "@/lib/auth/local-account";

/**
 * Settings > Password: the signed-in login changes its own password, which
 * fdrive keeps for every user of its files folder. Hidden until the account
 * has loaded.
 */
export function PasswordSection() {
  const { data: me } = useShellMe();
  if (me === undefined) return null;
  return <PasswordForm key={me.identity.id} username={me.identity.username} />;
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
    <DetailSheet
      title="Password"
      lede={`The password ${username} signs in with. Changing it signs out your other sessions.`}
    >
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
        <SettingRow
          label="Current password"
          description="The one you sign in with now, to confirm it is you."
          htmlFor="account-current-password"
        >
          <Input
            id="account-current-password"
            type="password"
            autoComplete="current-password"
            maxLength={1024}
            className="max-md:min-h-11"
            value={current}
            disabled={change.isPending}
            onChange={(event) => setCurrent(event.target.value)}
          />
        </SettingRow>
        <SettingRow
          label="New password"
          description={`At least ${LOCAL_PASSWORD_MIN_LENGTH} characters.`}
          htmlFor="account-new-password"
        >
          <Input
            id="account-new-password"
            type="password"
            autoComplete="new-password"
            maxLength={1024}
            className="max-md:min-h-11"
            value={password}
            disabled={change.isPending}
            aria-invalid={errors.password !== null}
            onChange={(event) => setPassword(event.target.value)}
          />
          {errors.password !== null ? (
            <FieldError className="mt-1.5">{errors.password}</FieldError>
          ) : null}
        </SettingRow>
        <SettingRow
          label="Confirm new password"
          description="The new password once more, to catch a typo."
          htmlFor="account-confirm-password"
        >
          <Input
            id="account-confirm-password"
            type="password"
            autoComplete="new-password"
            maxLength={1024}
            className="max-md:min-h-11"
            value={confirm}
            disabled={change.isPending}
            aria-invalid={errors.confirm !== null}
            onChange={(event) => setConfirm(event.target.value)}
          />
          {errors.confirm !== null ? (
            <FieldError className="mt-1.5">{errors.confirm}</FieldError>
          ) : null}
        </SettingRow>
        <SettingActions>
          {change.isError ? <FieldError>{describeCredentialError(change.error)}</FieldError> : null}
          <Button type="submit" className="max-md:min-h-11" disabled={!ready || change.isPending}>
            {change.isPending ? "Changing…" : "Change password"}
          </Button>
        </SettingActions>
      </form>
    </DetailSheet>
  );
}
