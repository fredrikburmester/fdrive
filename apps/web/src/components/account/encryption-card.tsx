"use client";

import { ApiClientError, type EncryptionDevice, type EncryptionStatus } from "@fdrive/contracts";
import {
  createAccountKeys,
  keyFingerprint,
  MIN_ENCRYPTION_PASSWORD_LENGTH,
  type NewAccountKeys,
  passwordKeyFor,
} from "@fdrive/crypto";
import { useQuery } from "@tanstack/react-query";
import { CheckIcon, CopyIcon, DownloadIcon } from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";
import { toast } from "sonner";
import {
  describeEncryptionError,
  encryptionPasswordErrors,
  PasswordInput,
  RecoveryKeyField,
  recoveryIdentityFrom,
  UnlockForm,
} from "@/components/encryption/unlock-form";
import { useShellMe } from "@/components/shell/page-header";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FieldError, FieldGroup, FieldSeparator } from "@/components/ui/field";
import { Skeleton } from "@/components/ui/skeleton";
import { formatShortDate } from "@/lib/account/format";
import { describeApiError } from "@/lib/api/errors";
import { keyStore, useKeyState } from "@/lib/encryption/keys";
import {
  useChangeEncryptionPassword,
  useEnableEncryption,
  useEncryptionStatus,
  useRemoveEncryptionDevice,
  useResetEncryption,
} from "@/lib/encryption/queries";

type EnabledStatus = Extract<EncryptionStatus, { enabled: true }>;

const RECOVERY_FILE = "fdrive-encryption-recovery-key.txt";

/**
 * Account page card: turns encrypted folders on, unlocks them on this
 * browser, and manages the encryption password, recovery key and paired
 * Macs. Hidden until the account has loaded, and where the installation
 * has no encrypted folders.
 */
export function EncryptionCard() {
  const { data: me } = useShellMe();
  if (me === undefined || !me.encryptedFolders) return null;
  return <EncryptionPanel key={me.identity.id} username={me.identity.username} />;
}

function EncryptionPanel({ username }: { username: string }) {
  const status = useEncryptionStatus();
  const keyState = useKeyState();
  // Keeps the setup steps on screen while they turn encryption on and unlock.
  const [settingUp, setSettingUp] = useState(false);

  let description: string;
  let body: ReactNode;
  if (status.data === undefined) {
    description = "Folders only your own devices can open.";
    body = status.isError ? (
      <div className="flex items-center justify-between gap-2">
        <p role="alert" className="text-sm text-destructive">
          {describeApiError(status.error)}
        </p>
        <Button type="button" variant="outline" size="sm" onClick={() => void status.refetch()}>
          Try again
        </Button>
      </div>
    ) : (
      <Skeleton className="h-24 w-full" />
    );
  } else if (!status.data.enabled || settingUp) {
    description = "Folders only your own devices can open.";
    body = <SetupFlow username={username} onActive={setSettingUp} />;
  } else if (keyState.status === "unlocked") {
    description = "Encryption is on, and this browser holds your key.";
    body = <UnlockedView status={status.data} username={username} />;
  } else {
    description =
      "Encryption is on. Enter your encryption password to open encrypted folders here.";
    body = (
      <FieldGroup>
        <UnlockForm />
        <FieldSeparator />
        <ResetSection username={username} />
      </FieldGroup>
    );
  }

  return (
    <Card className="w-full max-w-2xl">
      <CardHeader>
        <CardTitle>Encryption</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  );
}

/** A hidden username, so password managers file the sign-in password under the right account. */
function UsernameHint({ username }: { username: string }) {
  return (
    <input type="text" name="username" autoComplete="username" value={username} readOnly hidden />
  );
}

function SetupFlow({
  username,
  onActive,
}: {
  username: string;
  onActive: (active: boolean) => void;
}) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [signInPassword, setSignInPassword] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [keys, setKeys] = useState<NewAccountKeys | null>(null);
  const errors = encryptionPasswordErrors({ password, confirm, signInPassword });

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!errors.valid || creating) return;
    setCreating(true);
    setError(null);
    try {
      setKeys(await createAccountKeys(password));
      onActive(true);
    } catch (failure) {
      setError(describeApiError(failure));
    } finally {
      setCreating(false);
    }
  }

  function startOver() {
    setKeys(null);
    setPassword("");
    setConfirm("");
    setSignInPassword("");
    onActive(false);
  }

  if (keys !== null) {
    return (
      <SaveRecoveryKey
        keys={keys}
        username={username}
        password={password}
        signInPassword={signInPassword}
        onSignInPassword={setSignInPassword}
        onStartOver={startOver}
        onDone={() => onActive(false)}
      />
    );
  }

  return (
    <form onSubmit={(event) => void create(event)}>
      <UsernameHint username={username} />
      <FieldGroup>
        <div className="space-y-2 text-sm text-muted-foreground">
          <p>
            Names and contents in an encrypted folder are encrypted in this browser and on your Mac
            before they upload, so the server and its administrators cannot open them. If you lose
            both your encryption password and your recovery key, those folders are gone for good.
          </p>
          <p>
            A server that has been taken over could change this web app to capture your encryption
            password. The Mac app cannot be changed that way.
          </p>
        </div>
        <PasswordInput
          id="encryption-new-password"
          label="Encryption password"
          description={`At least ${MIN_ENCRYPTION_PASSWORD_LENGTH} characters, and not your sign-in password.`}
          value={password}
          onChange={setPassword}
          disabled={creating}
          error={errors.password}
        />
        <PasswordInput
          id="encryption-confirm-password"
          label="Confirm encryption password"
          value={confirm}
          onChange={setConfirm}
          disabled={creating}
          error={errors.confirm}
        />
        <PasswordInput
          id="encryption-sign-in-password"
          label="Sign-in password"
          description="The password you sign in with, to confirm it is you."
          autoComplete="current-password"
          value={signInPassword}
          onChange={setSignInPassword}
          disabled={creating}
        />
        {error === null ? null : <FieldError>{error}</FieldError>}
        <div className="flex justify-end">
          <Button type="submit" disabled={!errors.valid || creating} aria-busy={creating}>
            {creating ? "Creating keys…" : "Continue"}
          </Button>
        </div>
      </FieldGroup>
    </form>
  );
}

function recoveryFileText(username: string, identity: string): string {
  return [
    "# fdrive encryption recovery key",
    `# For: ${username}`,
    `# Created: ${new Date().toISOString().slice(0, 10)}`,
    "# With it you can set a new encryption password in Account > Encryption.",
    "# Keep it private and away from this computer.",
    identity,
    "",
  ].join("\n");
}

function saveText(text: string, filename: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function SaveRecoveryKey({
  keys,
  username,
  password,
  signInPassword,
  onSignInPassword,
  onStartOver,
  onDone,
}: {
  keys: NewAccountKeys;
  username: string;
  password: string;
  signInPassword: string;
  onSignInPassword: (value: string) => void;
  onStartOver: () => void;
  onDone: () => void;
}) {
  const enable = useEnableEncryption();
  const [pasted, setPasted] = useState("");
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [signInRefused, setSignInRefused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pastedIdentity = recoveryIdentityFrom(pasted);
  const matches = pastedIdentity === keys.recoveryIdentity;
  const pasteError =
    pasted.trim().length === 0 || matches
      ? null
      : pastedIdentity === null
        ? "Paste the line that starts with AGE-SECRET-KEY-1."
        : "That is not the recovery key above.";
  const signInError = encryptionPasswordErrors({
    password,
    confirm: password,
    signInPassword,
  }).password;
  const ready = matches && signInPassword.length > 0 && signInError === null;

  async function copy() {
    try {
      await navigator.clipboard.writeText(keys.recoveryIdentity);
    } catch {
      toast.error("This browser did not copy the key. Download it instead.");
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  async function finish(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      await enable.mutateAsync({
        signInPassword,
        recipient: keys.recipient,
        passwordKey: keys.passwordKey,
        recoveryKey: keys.recoveryKey,
      });
      await keyStore.unlocked(keys.identity);
      toast.success("Encryption is on.");
      onDone();
    } catch (failure) {
      if (failure instanceof ApiClientError && failure.kind === "unauthorized") {
        setSignInRefused(true);
        onSignInPassword("");
      }
      setError(describeEncryptionError(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(event) => void finish(event)}>
      <UsernameHint username={username} />
      <FieldGroup>
        <p className="text-sm text-muted-foreground">
          Save your recovery key somewhere safe. If you forget your encryption password, it is the
          only way back into your encrypted folders.
        </p>
        <div className="space-y-2">
          <p
            className="rounded-lg bg-muted p-3 font-mono text-xs break-all"
            data-slot="recovery-key"
          >
            {keys.recoveryIdentity}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                saveText(recoveryFileText(username, keys.recoveryIdentity), RECOVERY_FILE)
              }
            >
              <DownloadIcon />
              Download
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => void copy()}>
              {copied ? <CheckIcon /> : <CopyIcon />}
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        </div>
        <RecoveryKeyField
          id="encryption-confirm-recovery"
          label="Paste your recovery key"
          description="Shows that you saved it. Paste the key, or choose the downloaded file."
          value={pasted}
          onChange={setPasted}
          disabled={busy}
          error={pasteError}
        />
        {signInRefused ? (
          <PasswordInput
            id="encryption-retry-sign-in-password"
            label="Sign-in password"
            description="The password you sign in with, to confirm it is you."
            autoComplete="current-password"
            value={signInPassword}
            onChange={(value) => {
              onSignInPassword(value);
              setError(null);
            }}
            disabled={busy}
            error={signInPassword.length > 0 ? signInError : null}
          />
        ) : null}
        {error === null ? null : <FieldError>{error}</FieldError>}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button type="button" variant="ghost" disabled={busy} onClick={onStartOver}>
            Start over
          </Button>
          <Button type="submit" disabled={!ready || busy} aria-busy={busy}>
            {busy ? "Turning on…" : "Turn on encryption"}
          </Button>
        </div>
      </FieldGroup>
    </form>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="space-y-1">
        <h3 className="text-sm font-medium">{title}</h3>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      {children}
    </section>
  );
}

function UnlockedView({ status, username }: { status: EnabledStatus; username: string }) {
  const fingerprint = useQuery({
    queryKey: ["encryption", "fingerprint", status.recipient],
    queryFn: () => keyFingerprint(status.recipient),
    staleTime: Number.POSITIVE_INFINITY,
  });
  return (
    <FieldGroup>
      <Section
        title="Key fingerprint"
        description="The Mac app shows the same fingerprint once it holds your key."
      >
        <p className="font-mono text-sm tracking-wider" data-slot="key-fingerprint">
          {fingerprint.data ?? ""}
        </p>
      </Section>
      <FieldSeparator />
      <ChangePasswordSection username={username} />
      <FieldSeparator />
      <DevicesSection devices={status.devices} />
      <FieldSeparator />
      <Section
        title="Lock this browser"
        description="Forgets your key here until you enter your encryption password again."
      >
        <Button type="button" variant="outline" onClick={() => void keyStore.lock()}>
          Lock this browser
        </Button>
      </Section>
      <FieldSeparator />
      <ResetSection username={username} />
    </FieldGroup>
  );
}

function ChangePasswordSection({ username }: { username: string }) {
  const change = useChangeEncryptionPassword();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [signInPassword, setSignInPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errors = encryptionPasswordErrors({ password, confirm, signInPassword });

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const identity = keyStore.identity();
    if (!errors.valid || busy || identity === null) return;
    setBusy(true);
    setError(null);
    try {
      const passwordKey = await passwordKeyFor(identity, password);
      await change.mutateAsync({ signInPassword, passwordKey });
      setPassword("");
      setConfirm("");
      setSignInPassword("");
      toast.success("Encryption password changed.");
    } catch (failure) {
      setError(describeEncryptionError(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section
      title="Change encryption password"
      description="Your encrypted folders and paired Macs keep working as before."
    >
      <form onSubmit={(event) => void submit(event)}>
        <UsernameHint username={username} />
        <FieldGroup>
          <PasswordInput
            id="encryption-change-password"
            label="New encryption password"
            description={`At least ${MIN_ENCRYPTION_PASSWORD_LENGTH} characters, and not your sign-in password.`}
            value={password}
            onChange={setPassword}
            disabled={busy}
            error={errors.password}
          />
          <PasswordInput
            id="encryption-change-confirm"
            label="Confirm new encryption password"
            value={confirm}
            onChange={setConfirm}
            disabled={busy}
            error={errors.confirm}
          />
          <PasswordInput
            id="encryption-change-sign-in"
            label="Sign-in password"
            description="The password you sign in with, to confirm it is you."
            autoComplete="current-password"
            value={signInPassword}
            onChange={setSignInPassword}
            disabled={busy}
          />
          {error === null ? null : <FieldError>{error}</FieldError>}
          <div className="flex justify-end">
            <Button type="submit" disabled={!errors.valid || busy} aria-busy={busy}>
              {busy ? "Changing…" : "Change encryption password"}
            </Button>
          </div>
        </FieldGroup>
      </form>
    </Section>
  );
}

function DevicesSection({ devices }: { devices: readonly EncryptionDevice[] }) {
  const remove = useRemoveEncryptionDevice();
  const [target, setTarget] = useState<EncryptionDevice | null>(null);

  return (
    <Section title="Paired Macs" description="Macs that hold a copy of your key.">
      {devices.length === 0 ? (
        <p className="text-sm text-muted-foreground">No Mac holds your key.</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {devices.map((device) => (
            <li key={device.id} className="flex items-center justify-between gap-3 px-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{device.name}</p>
                <p className="text-xs text-muted-foreground">
                  Paired {formatShortDate(device.createdAt)}
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={`Remove ${device.name}`}
                onClick={() => setTarget(device)}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      <AlertDialog
        open={target !== null}
        onOpenChange={(open) => (open ? undefined : setTarget(null))}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove "{target?.name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              This disconnects the Mac and deletes its copy of your key from the server. It cannot
              erase a key the Mac already holds.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (target !== null) {
                  remove.mutate(target.id, {
                    onError: (failure) => toast.error(describeApiError(failure)),
                  });
                }
                setTarget(null);
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Section>
  );
}

function ResetSection({ username }: { username: string }) {
  const reset = useResetEncryption();
  const [open, setOpen] = useState(false);
  const [signInPassword, setSignInPassword] = useState("");

  function close(next: boolean) {
    if (next || reset.isPending) return;
    setOpen(false);
    setSignInPassword("");
    reset.reset();
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (signInPassword.length === 0 || reset.isPending) return;
    reset.mutate(
      { signInPassword },
      {
        onSuccess: () => {
          setOpen(false);
          setSignInPassword("");
          toast.success("Encryption was reset.");
        },
      },
    );
  }

  return (
    <Section
      title="Reset encryption"
      description="Deletes your keys. Every encrypted folder becomes unreadable for good."
    >
      <div>
        <Button type="button" variant="destructive" onClick={() => setOpen(true)}>
          Reset encryption
        </Button>
      </div>
      <AlertDialog open={open} onOpenChange={close}>
        <AlertDialogContent>
          <form onSubmit={submit} className="contents">
            <UsernameHint username={username} />
            <AlertDialogHeader>
              <AlertDialogTitle>Reset encryption?</AlertDialogTitle>
              <AlertDialogDescription>
                Every encrypted folder becomes unreadable for good, on every device. Nobody can open
                them again, not even with your recovery key.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <PasswordInput
              id="encryption-reset-sign-in"
              label="Sign-in password"
              description="The password you sign in with, to confirm it is you."
              autoComplete="current-password"
              value={signInPassword}
              onChange={setSignInPassword}
              disabled={reset.isPending}
              error={reset.isError ? describeEncryptionError(reset.error) : null}
            />
            <AlertDialogFooter>
              <AlertDialogCancel disabled={reset.isPending}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                type="submit"
                variant="destructive"
                disabled={signInPassword.length === 0 || reset.isPending}
              >
                {reset.isPending ? "Resetting…" : "Reset encryption"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </form>
        </AlertDialogContent>
      </AlertDialog>
    </Section>
  );
}
