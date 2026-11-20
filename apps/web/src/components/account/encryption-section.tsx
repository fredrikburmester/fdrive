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
import { cn } from "cn";
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
import { DetailSheet } from "@/components/shell/list-sheet";
import { useShellMe } from "@/components/shell/page-header";
import {
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeader,
  DataTableRow,
  PageSection,
  SettingActions,
  SettingRow,
} from "@/components/shell/page-layout";
import { SegmentedControl } from "@/components/shell/setting-controls";
import { Code } from "@/components/shell/sheet-data";
import { StatusBadge } from "@/components/shell/status";
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
import { FieldError, FieldGroup } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
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

const INTRO = "Folders only your own devices can open.";
const SIGN_IN_HINT = "The password you sign in with, to confirm it is you.";
const NEW_PASSWORD_HINT = `At least ${MIN_ENCRYPTION_PASSWORD_LENGTH} characters, and not your sign-in password.`;
const CONFIRM_HINT = "The same password once more, to catch a typo.";

/** A phone's 44px tap target for the fields and buttons of a form this file does not own. */
const PHONE_TARGETS = "max-md:[&_button]:min-h-11 max-md:[&_input]:min-h-11";

/**
 * Settings > Encryption: turns encrypted folders on, unlocks them on this
 * browser, and manages the encryption password, recovery key and paired
 * Macs. Hidden until the account has loaded; says so where the installation
 * has no encrypted folders.
 */
export function EncryptionSection() {
  const { data: me } = useShellMe();
  if (me === undefined) return null;
  if (!me.encryptedFolders) {
    return (
      <EncryptionSheet>
        <div data-slot="sheet-empty" className="flex max-w-prose flex-col gap-1 text-sm">
          <p className="font-medium">Encrypted folders are not available</p>
          <p className="text-muted-foreground">This fdrive server does not offer them.</p>
        </div>
      </EncryptionSheet>
    );
  }
  return <EncryptionPanel key={me.identity.id} username={me.identity.username} />;
}

interface EncryptionSheetProps {
  /** Whether encryption is on, and whether this browser holds the key. */
  badges?: ReactNode;
  /** The reset, once encryption is on. */
  footer?: ReactNode;
  children: ReactNode;
}

/** The section's sheet, which every state of it shares. */
function EncryptionSheet({ badges, footer, children }: EncryptionSheetProps) {
  return (
    <DetailSheet title="Encryption" lede={INTRO} badges={badges} footer={footer}>
      {children}
    </DetailSheet>
  );
}

function EncryptionPanel({ username }: { username: string }) {
  const status = useEncryptionStatus();
  const keyState = useKeyState();
  // Keeps the setup steps on screen while they turn encryption on and unlock.
  const [settingUp, setSettingUp] = useState(false);

  if (status.data === undefined) {
    return (
      <EncryptionSheet>
        {status.isError ? (
          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
            <p role="alert" className="text-destructive text-sm">
              {describeApiError(status.error)}
            </p>
            <Button
              type="button"
              variant="outline"
              className="max-md:min-h-11"
              onClick={() => void status.refetch()}
            >
              Try again
            </Button>
          </div>
        ) : (
          <Skeleton className="h-24 w-full max-w-xl" />
        )}
      </EncryptionSheet>
    );
  }
  const on = <StatusBadge tone="success">On</StatusBadge>;
  if (!status.data.enabled || settingUp) {
    return (
      <EncryptionSheet
        badges={status.data.enabled ? on : <StatusBadge tone="off">Off</StatusBadge>}
      >
        <SetupFlow username={username} onActive={setSettingUp} />
      </EncryptionSheet>
    );
  }
  const reset = <ResetEncryption username={username} />;
  if (keyState.status === "unlocked") {
    return (
      <EncryptionSheet
        badges={
          <>
            {on}
            <StatusBadge>Unlocked in this browser</StatusBadge>
          </>
        }
        footer={reset}
      >
        <UnlockedView status={status.data} username={username} />
      </EncryptionSheet>
    );
  }
  return (
    <EncryptionSheet
      badges={
        <>
          {on}
          <StatusBadge>Locked in this browser</StatusBadge>
        </>
      }
      footer={reset}
    >
      <PageSection
        title="Unlock this browser"
        description="Enter your encryption password to open encrypted folders here."
      >
        <UnlockForm className={cn("max-w-md", PHONE_TARGETS)} />
      </PageSection>
    </EncryptionSheet>
  );
}

/** A hidden username, so password managers file the sign-in password under the right account. */
function UsernameHint({ username }: { username: string }) {
  return (
    <input type="text" name="username" autoComplete="username" value={username} readOnly hidden />
  );
}

interface PasswordRowProps {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly disabled: boolean;
  readonly error?: string | null;
  readonly autoComplete?: string;
}

/** One password as a settings row: its label and one-line description beside the field. */
function PasswordRow({
  id,
  label,
  description,
  value,
  onChange,
  disabled,
  error = null,
  autoComplete = "off",
}: PasswordRowProps) {
  return (
    <SettingRow label={label} description={description} htmlFor={id}>
      <Input
        id={id}
        type="password"
        autoComplete={autoComplete}
        maxLength={1024}
        className="max-md:min-h-11"
        value={value}
        disabled={disabled}
        aria-invalid={error !== null}
        onChange={(event) => onChange(event.target.value)}
      />
      {error === null ? null : <FieldError className="mt-1.5">{error}</FieldError>}
    </SettingRow>
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
    <form onSubmit={(event) => void create(event)} className="flex flex-col gap-6">
      <UsernameHint username={username} />
      <div className="flex max-w-prose flex-col gap-2 text-muted-foreground text-sm">
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
      <div data-slot="setting-rows">
        <PasswordRow
          id="encryption-new-password"
          label="Encryption password"
          description={NEW_PASSWORD_HINT}
          value={password}
          onChange={setPassword}
          disabled={creating}
          error={errors.password}
        />
        <PasswordRow
          id="encryption-confirm-password"
          label="Confirm encryption password"
          description={CONFIRM_HINT}
          value={confirm}
          onChange={setConfirm}
          disabled={creating}
          error={errors.confirm}
        />
        <PasswordRow
          id="encryption-sign-in-password"
          label="Sign-in password"
          description={SIGN_IN_HINT}
          autoComplete="current-password"
          value={signInPassword}
          onChange={setSignInPassword}
          disabled={creating}
        />
        <SettingActions>
          {error === null ? null : <FieldError>{error}</FieldError>}
          <Button
            type="submit"
            className="max-md:min-h-11"
            disabled={!errors.valid || creating}
            aria-busy={creating}
          >
            {creating ? "Creating keys…" : "Continue"}
          </Button>
        </SettingActions>
      </div>
    </form>
  );
}

function recoveryFileText(username: string, identity: string): string {
  return [
    "# fdrive encryption recovery key",
    `# For: ${username}`,
    `# Created: ${new Date().toISOString().slice(0, 10)}`,
    "# With it you can set a new encryption password in Settings > Encryption.",
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
      <PageSection
        title="Recovery key"
        description="Save it somewhere safe. If you forget your encryption password, it is the only way back into your encrypted folders."
      >
        <FieldGroup className={cn("max-w-2xl pb-4.5", PHONE_TARGETS)}>
          <div className="flex flex-col gap-3">
            <Code data-slot="recovery-key" className="break-all">
              {keys.recoveryIdentity}
            </Code>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() =>
                  saveText(recoveryFileText(username, keys.recoveryIdentity), RECOVERY_FILE)
                }
              >
                <DownloadIcon />
                Download
              </Button>
              <Button type="button" variant="outline" onClick={() => void copy()}>
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
              description={SIGN_IN_HINT}
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
        </FieldGroup>
        <SettingActions>
          {error === null ? null : <FieldError>{error}</FieldError>}
          <Button
            type="button"
            variant="outline"
            className="max-md:min-h-11"
            disabled={busy}
            onClick={onStartOver}
          >
            Start over
          </Button>
          <Button
            type="submit"
            className="max-md:min-h-11"
            disabled={!ready || busy}
            aria-busy={busy}
          >
            {busy ? "Turning on…" : "Turn on encryption"}
          </Button>
        </SettingActions>
      </PageSection>
    </form>
  );
}

type UnlockedTab = "key" | "password" | "macs";

const UNLOCKED_TABS: readonly UnlockedTab[] = ["key", "password", "macs"];
const UNLOCKED_TAB_LABELS: Record<UnlockedTab, string> = {
  key: "Key",
  password: "Password",
  macs: "Macs",
};

/**
 * Encryption while it is on and this browser holds the key. That is more than one screen, so the
 * sheet shows one part at a time: the key here, the encryption password, or the paired Macs.
 */
function UnlockedView({ status, username }: { status: EnabledStatus; username: string }) {
  const [tab, setTab] = useState<UnlockedTab>("key");
  return (
    <>
      <SegmentedControl
        label="Section"
        value={tab}
        options={UNLOCKED_TABS}
        labels={UNLOCKED_TAB_LABELS}
        onChange={setTab}
        className="self-start"
      />
      {tab === "key" ? (
        <KeySection recipient={status.recipient} />
      ) : tab === "password" ? (
        <ChangePasswordSection username={username} />
      ) : (
        <DevicesSection devices={status.devices} />
      )}
    </>
  );
}

function KeySection({ recipient }: { recipient: string }) {
  const fingerprint = useQuery({
    queryKey: ["encryption", "fingerprint", recipient],
    queryFn: () => keyFingerprint(recipient),
    staleTime: Number.POSITIVE_INFINITY,
  });
  return (
    <PageSection
      title="Your key"
      description="This browser holds your key until you lock it or sign out."
    >
      <SettingRow
        label="Key fingerprint"
        description="The Mac app shows the same fingerprint once it holds your key."
        align="end"
      >
        <Code className="tracking-wider" data-slot="key-fingerprint">
          {fingerprint.data ?? ""}
        </Code>
      </SettingRow>
      <SettingRow
        label="Lock this browser"
        description="Forgets your key here until you enter your encryption password again."
        align="end"
      >
        <Button
          type="button"
          variant="outline"
          className="max-md:min-h-11"
          onClick={() => void keyStore.lock()}
        >
          Lock this browser
        </Button>
      </SettingRow>
    </PageSection>
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
    <PageSection
      title="Change encryption password"
      description="Your encrypted folders and paired Macs keep working as before."
    >
      <form onSubmit={(event) => void submit(event)}>
        <UsernameHint username={username} />
        <PasswordRow
          id="encryption-change-password"
          label="New encryption password"
          description={NEW_PASSWORD_HINT}
          value={password}
          onChange={setPassword}
          disabled={busy}
          error={errors.password}
        />
        <PasswordRow
          id="encryption-change-confirm"
          label="Confirm new encryption password"
          description={CONFIRM_HINT}
          value={confirm}
          onChange={setConfirm}
          disabled={busy}
          error={errors.confirm}
        />
        <PasswordRow
          id="encryption-change-sign-in"
          label="Sign-in password"
          description={SIGN_IN_HINT}
          autoComplete="current-password"
          value={signInPassword}
          onChange={setSignInPassword}
          disabled={busy}
        />
        <SettingActions>
          {error === null ? null : <FieldError>{error}</FieldError>}
          <Button
            type="submit"
            className="max-md:min-h-11"
            disabled={!errors.valid || busy}
            aria-busy={busy}
          >
            {busy ? "Changing…" : "Change encryption password"}
          </Button>
        </SettingActions>
      </form>
    </PageSection>
  );
}

function DevicesSection({ devices }: { devices: readonly EncryptionDevice[] }) {
  const remove = useRemoveEncryptionDevice();
  const [target, setTarget] = useState<EncryptionDevice | null>(null);

  return (
    <PageSection title="Paired Macs" description="Macs that hold a copy of your key.">
      {devices.length === 0 ? (
        <p className="text-muted-foreground text-sm">No Mac holds your key.</p>
      ) : (
        <DataTable>
          <DataTableHeader>
            <DataTableRow>
              <DataTableHead>Name</DataTableHead>
              <DataTableHead>Paired</DataTableHead>
              <DataTableHead className="text-right">Actions</DataTableHead>
            </DataTableRow>
          </DataTableHeader>
          <DataTableBody>
            {devices.map((device) => (
              <DataTableRow key={device.id}>
                <DataTableCell>{device.name}</DataTableCell>
                <DataTableCell className="text-muted-foreground tabular-nums">
                  {formatShortDate(device.createdAt)}
                </DataTableCell>
                <DataTableCell className="text-right">
                  <Button
                    type="button"
                    variant="destructive"
                    className="max-md:min-h-11"
                    aria-label={`Remove ${device.name}`}
                    onClick={() => setTarget(device)}
                  >
                    Remove
                  </Button>
                </DataTableCell>
              </DataTableRow>
            ))}
          </DataTableBody>
        </DataTable>
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
    </PageSection>
  );
}

/**
 * The sheet's footer once encryption is on: what a reset destroys and what it leaves alone, and
 * the reset itself, which asks for the sign-in password before it runs.
 */
function ResetEncryption({ username }: { username: string }) {
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
    <>
      <p className="min-w-0 max-w-prose flex-[1_1_16rem] text-muted-foreground">
        Resetting deletes your keys, and every encrypted folder becomes unreadable for good. Your
        other files are not touched.
      </p>
      <Button
        type="button"
        variant="destructive"
        className="ml-auto max-md:min-h-11"
        onClick={() => setOpen(true)}
      >
        Reset encryption
      </Button>
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
              description={SIGN_IN_HINT}
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
    </>
  );
}
