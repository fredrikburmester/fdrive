"use client";

import { ApiClientError, type EncryptionStatus } from "@fdrive/contracts";
import {
  DecryptError,
  isIdentity,
  MIN_ENCRYPTION_PASSWORD_LENGTH,
  passwordKeyFor,
  unlockWithRecovery,
} from "@fdrive/crypto";
import { cn } from "cn";
import { UploadIcon } from "lucide-react";
import { type ChangeEvent, type FormEvent, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { describeApiError } from "@/lib/api/errors";
import { keyStore } from "@/lib/encryption/keys";
import { useChangeEncryptionPassword, useEncryptionStatus } from "@/lib/encryption/queries";

type EnabledStatus = Extract<EncryptionStatus, { enabled: true }>;

/** What a wrong encryption password reads as. */
export const WRONG_ENCRYPTION_PASSWORD = "That encryption password does not open your key.";

/** The largest file read as a recovery key: the downloaded one is a few hundred bytes. */
const MAX_RECOVERY_FILE_BYTES = 16_384;

/**
 * The recovery key in pasted or uploaded text: the line that starts with
 * `AGE-SECRET-KEY-1`, so the whole downloaded file can be pasted. Null when
 * there is none.
 */
export function recoveryIdentityFrom(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const candidate = line.trim().toUpperCase();
    if (candidate.startsWith("AGE-SECRET-KEY-1") && isIdentity(candidate)) return candidate;
  }
  return null;
}

/** A new encryption password typed twice, with the sign-in password it must differ from. */
export interface EncryptionPasswordDraft {
  readonly password: string;
  readonly confirm: string;
  readonly signInPassword: string;
}

/**
 * The errors to show under a new encryption password, each once its field
 * holds something. The server sees the sign-in password at every sign-in,
 * so the two must differ. `valid` also needs the sign-in password.
 */
export function encryptionPasswordErrors(draft: EncryptionPasswordDraft): {
  readonly password: string | null;
  readonly confirm: string | null;
  readonly valid: boolean;
} {
  const password =
    draft.password.length < MIN_ENCRYPTION_PASSWORD_LENGTH
      ? `Use at least ${MIN_ENCRYPTION_PASSWORD_LENGTH} characters.`
      : draft.password === draft.signInPassword
        ? "Use a different password from the one you sign in with."
        : null;
  const confirm = draft.password === draft.confirm ? null : "The passwords don't match.";
  return {
    password: draft.password.length > 0 ? password : null,
    confirm: draft.confirm.length > 0 ? confirm : null,
    valid: password === null && confirm === null && draft.signInPassword.length > 0,
  };
}

/** The message for an encryption request that sent the sign-in password. */
export function describeEncryptionError(error: unknown): string {
  if (error instanceof ApiClientError && error.kind === "unauthorized") {
    return "That sign-in password is not right.";
  }
  return describeApiError(error);
}

interface PasswordInputProps {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly disabled: boolean;
  readonly description?: string;
  readonly error?: string | null;
  readonly autoComplete?: string;
}

/** One password field with its label, a one-line description and its error. */
export function PasswordInput({
  id,
  label,
  value,
  onChange,
  disabled,
  description,
  error = null,
  autoComplete = "off",
}: PasswordInputProps) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        type="password"
        autoComplete={autoComplete}
        maxLength={1024}
        value={value}
        disabled={disabled}
        aria-invalid={error !== null}
        onChange={(event) => onChange(event.target.value)}
      />
      {description === undefined ? null : <FieldDescription>{description}</FieldDescription>}
      {error === null ? null : <FieldError>{error}</FieldError>}
    </Field>
  );
}

interface RecoveryKeyFieldProps {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly disabled: boolean;
  readonly error?: string | null;
}

/** A recovery key pasted as text, or read from the file it was downloaded as. */
export function RecoveryKeyField({
  id,
  label,
  description,
  value,
  onChange,
  disabled,
  error = null,
}: RecoveryKeyFieldProps) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [fileError, setFileError] = useState<string | null>(null);

  async function choose(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file === undefined) return;
    const identity =
      file.size > MAX_RECOVERY_FILE_BYTES ? null : recoveryIdentityFrom(await file.text());
    setFileError(identity === null ? "That file holds no recovery key." : null);
    if (identity !== null) onChange(identity);
  }

  const shown = fileError ?? error;
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Textarea
        id={id}
        value={value}
        rows={2}
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        placeholder="AGE-SECRET-KEY-1"
        className="font-mono text-xs"
        disabled={disabled}
        aria-invalid={shown !== null}
        onChange={(event) => {
          setFileError(null);
          onChange(event.target.value);
        }}
      />
      <div className="flex items-start justify-between gap-3">
        <FieldDescription>{description}</FieldDescription>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => fileInput.current?.click()}
        >
          <UploadIcon />
          Choose file
        </Button>
      </div>
      <input
        ref={fileInput}
        type="file"
        accept=".txt,text/plain"
        hidden
        aria-label={`${label} file`}
        onChange={(event) => void choose(event)}
      />
      {shown === null ? null : <FieldError>{shown}</FieldError>}
    </Field>
  );
}

export interface UnlockFormProps {
  readonly className?: string;
  /** Called once this browser holds the account key. */
  readonly onUnlocked?: () => void;
}

/**
 * Unlocks encrypted folders on this browser with the encryption password,
 * or, for a forgotten one, with the recovery key and a new encryption
 * password. Renders nothing once encryption turns out to be off.
 */
export function UnlockForm({ className, onUnlocked }: UnlockFormProps) {
  const status = useEncryptionStatus();
  const [forgot, setForgot] = useState(false);

  if (status.data === undefined) {
    return status.isError ? (
      <p role="alert" className={cn("text-sm text-destructive", className)}>
        {describeApiError(status.error)}
      </p>
    ) : (
      <Skeleton className={cn("h-24 w-full", className)} />
    );
  }
  if (!status.data.enabled) return null;
  return (
    <div className={className}>
      {forgot ? (
        <RecoveryUnlock
          status={status.data}
          onBack={() => setForgot(false)}
          onUnlocked={onUnlocked}
        />
      ) : (
        <PasswordUnlock
          status={status.data}
          onForgot={() => setForgot(true)}
          onUnlocked={onUnlocked}
        />
      )}
    </div>
  );
}

function PasswordUnlock({
  status,
  onForgot,
  onUnlocked,
}: {
  status: EnabledStatus;
  onForgot: () => void;
  onUnlocked: (() => void) | undefined;
}) {
  const id = useId();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (password.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      await keyStore.unlock(status.passwordKey, password, status.recipient);
      setPassword("");
      onUnlocked?.();
    } catch (failure) {
      setError(
        failure instanceof DecryptError ? WRONG_ENCRYPTION_PASSWORD : describeApiError(failure),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)}>
      <FieldGroup>
        <PasswordInput
          id={`${id}-password`}
          label="Encryption password"
          description="Opens your encrypted folders on this browser until you sign out."
          value={password}
          onChange={(value) => {
            setPassword(value);
            setError(null);
          }}
          disabled={busy}
          error={error}
        />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button type="button" variant="link" className="px-0" disabled={busy} onClick={onForgot}>
            Forgot encryption password
          </Button>
          <Button type="submit" disabled={password.length === 0 || busy} aria-busy={busy}>
            {busy ? "Unlocking…" : "Unlock"}
          </Button>
        </div>
      </FieldGroup>
    </form>
  );
}

function RecoveryUnlock({
  status,
  onBack,
  onUnlocked,
}: {
  status: EnabledStatus;
  onBack: () => void;
  onUnlocked: (() => void) | undefined;
}) {
  const id = useId();
  const change = useChangeEncryptionPassword();
  const [recovery, setRecovery] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [signInPassword, setSignInPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const errors = encryptionPasswordErrors({ password, confirm, signInPassword });
  const ready = recovery.trim().length > 0 && errors.valid;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready || busy) return;
    const recoveryIdentity = recoveryIdentityFrom(recovery);
    if (recoveryIdentity === null) {
      setRecoveryError("Paste the line that starts with AGE-SECRET-KEY-1.");
      return;
    }
    setBusy(true);
    setRecoveryError(null);
    setError(null);
    let identity: string;
    try {
      identity = await unlockWithRecovery(status.recoveryKey, recoveryIdentity, status.recipient);
    } catch (failure) {
      setBusy(false);
      if (failure instanceof DecryptError) {
        setRecoveryError("That recovery key does not open your key.");
      } else {
        setError(describeApiError(failure));
      }
      return;
    }
    try {
      const passwordKey = await passwordKeyFor(identity, password);
      await change.mutateAsync({ signInPassword, passwordKey });
      await keyStore.unlocked(identity);
      toast.success("Encryption password changed.");
      onUnlocked?.();
    } catch (failure) {
      setError(describeEncryptionError(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)}>
      <FieldGroup>
        <p className="text-sm text-muted-foreground">
          Your recovery key opens your key once more, so you can set a new encryption password.
        </p>
        <RecoveryKeyField
          id={`${id}-recovery`}
          label="Recovery key"
          description="Paste the key, or choose the file you downloaded."
          value={recovery}
          onChange={(value) => {
            setRecovery(value);
            setRecoveryError(null);
          }}
          disabled={busy}
          error={recoveryError}
        />
        <PasswordInput
          id={`${id}-new`}
          label="New encryption password"
          description={`At least ${MIN_ENCRYPTION_PASSWORD_LENGTH} characters, and not your sign-in password.`}
          value={password}
          onChange={setPassword}
          disabled={busy}
          error={errors.password}
        />
        <PasswordInput
          id={`${id}-confirm`}
          label="Confirm new encryption password"
          value={confirm}
          onChange={setConfirm}
          disabled={busy}
          error={errors.confirm}
        />
        <PasswordInput
          id={`${id}-sign-in`}
          label="Sign-in password"
          description="The password you sign in with, to confirm it is you."
          autoComplete="current-password"
          value={signInPassword}
          onChange={setSignInPassword}
          disabled={busy}
        />
        {error === null ? null : <FieldError>{error}</FieldError>}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button type="button" variant="link" className="px-0" disabled={busy} onClick={onBack}>
            Use encryption password
          </Button>
          <Button type="submit" disabled={!ready || busy} aria-busy={busy}>
            {busy ? "Unlocking…" : "Set password and unlock"}
          </Button>
        </div>
      </FieldGroup>
    </form>
  );
}
