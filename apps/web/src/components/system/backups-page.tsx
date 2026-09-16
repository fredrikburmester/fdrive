"use client";
import { ApiClientError, type BackupSchedule, type BackupsResponse } from "@fdrive/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { Decrypter, generateIdentity, identityToRecipient } from "age-encryption";
import { Download, LoaderCircle, Plus, ShieldCheck } from "lucide-react";
import { type ReactNode, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { ProviderFieldInputs } from "@/components/identity/provider-fields";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  FieldContent,
  FieldDescription,
  FieldLabel,
  Field as FormField,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useMe } from "@/lib/api/auth-queries";
import { backupClient, backupQueryKey, useBackups } from "@/lib/api/backup-queries";
import { useProviders } from "@/lib/api/provider-queries";
import { useAdminProviders } from "@/lib/api/system-queries";
import {
  buildCredential,
  confirmationFieldsFor,
  credentialComplete,
  credentialFieldsFor,
} from "@/lib/auth/login-model";
import { formatBytes, type SizeUnits } from "@/lib/format";
import { useFormatters } from "@/lib/use-format-preferences";
import { BackupHealth } from "./backup-health";
import { SystemPage } from "./system-page";
import { SystemSection } from "./system-section";

function OwnerUnlock({
  act,
  busy,
  onUnlocked,
}: {
  act: Act;
  busy: boolean;
  onUnlocked: () => void;
}) {
  const { data: me } = useMe();
  const { data: providers } = useProviders();
  const [current, setCurrent] = useState<Record<string, string>>({});
  const id = useId();
  const identity = me?.identities.find((item) => item.id === me.activeIdentityId);
  const provider = providers?.providers.find((item) => item.id === identity?.providerId);
  const fields = confirmationFieldsFor(credentialFieldsFor(provider));
  return (
    <form
      className="grid max-w-lg gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        void act(async () => {
          await backupClient.unlock(buildCredential(fields, current));
          setCurrent({});
          onUnlocked();
        });
      }}
    >
      <ProviderFieldInputs
        fields={fields}
        values={current}
        onChange={(name, value) => setCurrent({ ...current, [name]: value })}
        idPrefix={id}
        disabled={busy}
      />
      <Button type="submit" disabled={busy || !credentialComplete(fields, current)}>
        Unlock backups
      </Button>
    </form>
  );
}
function Field({ label, children }: { label: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="min-w-0 space-y-2">
      <Label htmlFor={id}>{label}</Label>
      {children(id)}
    </div>
  );
}
function saveText(text: string, filename: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function size(value: string, units: SizeUnits) {
  return formatBytes(Number(value), { units });
}
type Act = (work: () => Promise<unknown>) => Promise<void>;
const frequencyLabels: Record<BackupSchedule["frequency"], string> = {
  manual: "Only when I click Back up now",
  hourly: "Every hour",
  daily: "Every day",
  weekly: "Every week, on Sunday",
};
function describeSchedule(schedule: BackupSchedule): string {
  const hour = `${String(schedule.hour).padStart(2, "0")}:00`;
  switch (schedule.frequency) {
    case "manual":
      return "Manual only";
    case "hourly":
      return "Every hour";
    case "daily":
      return `Daily at ${hour} (${schedule.timezone})`;
    case "weekly":
      return `Sundays at ${hour} (${schedule.timezone})`;
  }
}
function describeRetention(schedule: BackupSchedule): string {
  return `keeps ${schedule.daily} daily, ${schedule.weekly} weekly and ${schedule.monthly} monthly backups`;
}
const retentionPeriods = [
  ["daily", "Daily backups", "days", 1, 365],
  ["weekly", "Weekly backups", "weeks", 0, 104],
  ["monthly", "Monthly backups", "months", 0, 120],
] as const;
/** How often backups run is separate from which of them retention keeps, so the form says so. */
function frequencyNote(frequency: BackupSchedule["frequency"]): string | null {
  if (frequency === "hourly")
    return "Hourly backups protect today. Older days are thinned to their newest backup.";
  if (frequency === "weekly")
    return "With one backup a week, each backup is also its day's newest, so the daily count keeps that many weekly backups too.";
  if (frequency === "manual") return "These limits also apply to backups you start yourself.";
  return null;
}
function ScheduleFields({
  value,
  onChange,
  retentionNote,
}: {
  value: BackupSchedule;
  onChange: (value: BackupSchedule) => void;
  retentionNote?: string;
}) {
  const id = useId();
  const timed = value.frequency === "daily" || value.frequency === "weekly";
  const note = frequencyNote(value.frequency);
  return (
    <div className="grid gap-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField>
          <FieldLabel htmlFor={`${id}-frequency`}>How often to back up</FieldLabel>
          <Select
            value={value.frequency}
            onValueChange={(frequency) => {
              if (frequency)
                onChange({ ...value, frequency: frequency as BackupSchedule["frequency"] });
            }}
          >
            <SelectTrigger id={`${id}-frequency`}>
              <SelectValue>{frequencyLabels[value.frequency]}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {(["manual", "hourly", "daily", "weekly"] as const).map((frequency) => (
                <SelectItem key={frequency} value={frequency}>
                  {frequencyLabels[frequency]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
        <FormField>
          <FieldLabel htmlFor={`${id}-timezone`}>Timezone</FieldLabel>
          <Input
            id={`${id}-timezone`}
            value={value.timezone}
            onChange={(event) => onChange({ ...value, timezone: event.target.value })}
          />
          <FieldDescription>
            An IANA name, such as Europe/Stockholm. Also decides where days and months begin.
          </FieldDescription>
        </FormField>
        {timed && (
          <FormField>
            <FieldLabel htmlFor={`${id}-hour`}>Hour of day (0–23)</FieldLabel>
            <Input
              id={`${id}-hour`}
              type="number"
              min={0}
              max={23}
              value={value.hour}
              onChange={(event) => onChange({ ...value, hour: Number(event.target.value) })}
            />
            <FieldDescription>
              Pick a quiet hour; uploads wait while a backup is captured.
            </FieldDescription>
          </FormField>
        )}
      </div>
      <div className="grid gap-4">
        <div className="space-y-1">
          <p className="text-sm font-medium">How many backups to keep</p>
          <p className="text-sm text-muted-foreground">
            This thins out old backups; it doesn't add backups. fdrive keeps the newest backup from
            each of the most recent days, weeks and months that have one, plus the latest and any
            pinned backup, and deletes the rest. There is no monthly schedule because a daily or
            weekly backup already serves as its month's copy.
          </p>
          {note && <p className="text-sm text-muted-foreground">{note}</p>}
          {retentionNote && <p className="text-sm text-muted-foreground">{retentionNote}</p>}
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          {retentionPeriods.map(([period, label, unit, min, max]) => (
            <FormField key={period}>
              <FieldLabel htmlFor={`${id}-${period}`}>{label}</FieldLabel>
              <Input
                id={`${id}-${period}`}
                type="number"
                min={min}
                max={max}
                value={value[period]}
                onChange={(event) => onChange({ ...value, [period]: Number(event.target.value) })}
              />
              <FieldDescription>
                One from each of the last {value[period]} {unit}.
              </FieldDescription>
            </FormField>
          ))}
        </div>
      </div>
    </div>
  );
}
function DestinationPolicy({
  name,
  value,
  installation,
  onSave,
  onCancel,
  busy,
}: {
  name: string;
  value: BackupSchedule | null;
  installation: BackupSchedule;
  onSave: (value: BackupSchedule | null) => Promise<void>;
  onCancel: () => void;
  busy: boolean;
}) {
  const id = useId();
  const [inherit, setInherit] = useState(value === null);
  const [policy, setPolicy] = useState<BackupSchedule>(value ?? installation);
  return (
    <form
      aria-label={`Schedule for ${name}`}
      className="grid basis-full gap-4 border-t pt-4"
      onSubmit={(event) => {
        event.preventDefault();
        void onSave(inherit ? null : policy);
      }}
    >
      <div className="space-y-1">
        <p className="text-sm font-medium">Schedule for {name}</p>
        <p className="text-sm text-muted-foreground">
          When fdrive sends a new backup here, and how many old backups to keep here.
        </p>
      </div>
      <RadioGroup
        value={inherit ? "installation" : "custom"}
        onValueChange={(choice) => setInherit(choice === "installation")}
      >
        <FormField orientation="horizontal">
          <RadioGroupItem id={`${id}-installation`} value="installation" />
          <FieldContent>
            <FieldLabel htmlFor={`${id}-installation`}>
              Same as the installation schedule
            </FieldLabel>
            <FieldDescription>
              {describeSchedule(installation)}, {describeRetention(installation)}. Follows any
              change you make under Schedule and retention.
            </FieldDescription>
          </FieldContent>
        </FormField>
        <FormField orientation="horizontal">
          <RadioGroupItem id={`${id}-custom`} value="custom" />
          <FieldContent>
            <FieldLabel htmlFor={`${id}-custom`}>
              A separate schedule for this destination
            </FieldLabel>
            <FieldDescription>
              For destinations that need different timing, such as hourly to a nearby server and
              weekly to cloud storage.
            </FieldDescription>
          </FieldContent>
        </FormField>
      </RadioGroup>
      {!inherit && (
        <ScheduleFields
          value={policy}
          onChange={setPolicy}
          retentionNote="A backup shared with another destination stays until neither needs it."
        />
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy}>
          Save destination schedule
        </Button>
      </div>
    </form>
  );
}
function Destinations({
  data,
  act,
  busy,
  unlocked,
}: {
  data: BackupsResponse;
  act: Act;
  busy: boolean;
  unlocked: boolean;
}) {
  const providers = useAdminProviders();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [pathStyle, setPathStyle] = useState(false);
  const [type, setType] = useState("s3");
  const [name, setName] = useState("");
  const [endpoint, setEndpoint] = useState("https://s3.amazonaws.com");
  const [region, setRegion] = useState("us-east-1");
  const [bucket, setBucket] = useState("");
  const [prefix, setPrefix] = useState("fdrive-backups");
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secret, setSecret] = useState("");
  const [providerId, setProviderId] = useState("");
  const [username, setUsername] = useState("");
  return (
    <SystemSection
      title="Destinations"
      description="Store a copy independently of this fdrive server."
      actions={
        <Button variant="outline" disabled={!unlocked || busy} onClick={() => setAdding(!adding)}>
          <Plus />
          Add destination
        </Button>
      }
    >
      {data.destinations.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No remote destinations. You can still download a local backup.
        </p>
      )}
      {data.destinations.map((item) => (
        <div
          key={item.id}
          className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
        >
          <div className="min-w-0">
            <p className="font-medium break-words">{item.name}</p>
            <p className="break-all text-xs text-muted-foreground">{item.location}</p>
            {item.retainedProbe && (
              <p className="break-all text-xs text-muted-foreground">
                Bucket retention keeps the test object {item.retainedProbe.name} until{" "}
                {new Date(item.retainedProbe.retentionUntil).toLocaleString()}.
              </p>
            )}
            <Badge variant="secondary">{item.enabled ? "Enabled" : "Paused"}</Badge>
            <p className="text-xs text-muted-foreground">
              {(() => {
                const latest = data.runs.find(
                  (run) =>
                    !run.coverage.length &&
                    run.deliveries.some(
                      (delivery) =>
                        delivery.destinationId === item.id && delivery.state === "complete",
                    ),
                );
                return latest
                  ? `Last complete copy: ${new Date(latest.createdAt).toLocaleString()}`
                  : "No complete copy yet";
              })()}
            </p>
            <p className="text-xs text-muted-foreground">
              {item.testedAt
                ? `Last tested: ${new Date(item.testedAt).toLocaleString()}`
                : "Not tested yet"}
            </p>
            <p className="break-words text-xs text-muted-foreground">
              {item.schedule
                ? `Own schedule: ${describeSchedule(item.schedule)}`
                : `Installation schedule: ${describeSchedule(data.schedule)}`}
              {(item.schedule ? item.nextRunAt : data.nextRunAt) &&
                ` · next ${new Date((item.schedule ? item.nextRunAt : data.nextRunAt) as string).toLocaleString()}`}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={busy || !unlocked}
              onClick={() =>
                void act(async () => {
                  setTesting(item.id);
                  try {
                    await backupClient.testDestination(item.id);
                    toast.success(`${item.name} passed the test`, {
                      description: "fdrive wrote, read back and removed a test object.",
                    });
                  } catch (reason) {
                    toast.error(`${item.name} failed the test`, {
                      description: reason instanceof Error ? reason.message : undefined,
                    });
                    throw reason;
                  } finally {
                    setTesting(null);
                  }
                })
              }
            >
              {testing === item.id && <LoaderCircle className="animate-spin" />}
              Test
            </Button>
            <Button
              variant="outline"
              disabled={busy || !unlocked || !data.keyConfirmed}
              aria-expanded={editing === item.id}
              onClick={() => setEditing(editing === item.id ? null : item.id)}
            >
              Edit schedule
            </Button>
            <Button
              variant="ghost"
              disabled={busy || !unlocked}
              onClick={() => void act(() => backupClient.removeDestination(item.id))}
            >
              Remove destination
            </Button>
          </div>
          {editing === item.id && (
            <DestinationPolicy
              name={item.name}
              value={item.schedule}
              installation={data.schedule}
              busy={busy}
              onCancel={() => setEditing(null)}
              onSave={async (value) => {
                await act(async () => {
                  await backupClient.destinationSchedule(item.id, value);
                  setEditing(null);
                });
              }}
            />
          )}
        </div>
      ))}
      {adding && (
        <form
          className="grid gap-4 rounded-lg border p-4 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            void act(async () => {
              await backupClient.destination(
                type === "s3"
                  ? {
                      type: "s3",
                      name,
                      endpoint,
                      region,
                      bucket,
                      prefix,
                      pathStyle,
                      accessKeyId,
                      secretAccessKey: secret,
                    }
                  : {
                      type: "provider",
                      name,
                      providerId,
                      prefix,
                      credential: { username, password: secret },
                    },
              );
              setSecret("");
              setAdding(false);
            });
          }}
        >
          <Field label="Name">
            {(id) => (
              <Input id={id} value={name} onChange={(e) => setName(e.target.value)} required />
            )}
          </Field>
          <Field label="Destination type">
            {(id) => (
              <Select
                value={type}
                onValueChange={(value) => {
                  if (value) {
                    setType(value);
                    setPrefix(value === "s3" ? "fdrive-backups" : "/");
                  }
                }}
              >
                <SelectTrigger id={id}>
                  <SelectValue>
                    {type === "s3" ? "S3 or Backblaze B2" : "Connected fileserver"}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="s3">S3 or Backblaze B2</SelectItem>
                  <SelectItem value="provider">Connected fileserver</SelectItem>
                </SelectContent>
              </Select>
            )}
          </Field>
          {type === "s3" ? (
            <>
              <div className="flex flex-wrap gap-2 sm:col-span-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setEndpoint("https://s3.amazonaws.com");
                    setRegion("us-east-1");
                  }}
                >
                  AWS S3
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setEndpoint("https://s3.us-west-004.backblazeb2.com");
                    setRegion("us-west-004");
                  }}
                >
                  Backblaze B2
                </Button>
              </div>
              <Field label="S3 endpoint">
                {(id) => (
                  <Input
                    id={id}
                    type="url"
                    value={endpoint}
                    onChange={(e) => setEndpoint(e.target.value)}
                    required
                  />
                )}
              </Field>
              <Field label="Region">
                {(id) => (
                  <Input
                    id={id}
                    value={region}
                    onChange={(e) => setRegion(e.target.value)}
                    required
                  />
                )}
              </Field>
              <Field label="Bucket">
                {(id) => (
                  <Input
                    id={id}
                    value={bucket}
                    onChange={(e) => setBucket(e.target.value)}
                    required
                  />
                )}
              </Field>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={pathStyle}
                  onChange={(event) => setPathStyle(event.target.checked)}
                />
                Use path-style addressing
              </label>
              <Field label="Access key ID">
                {(id) => (
                  <Input
                    id={id}
                    value={accessKeyId}
                    onChange={(e) => setAccessKeyId(e.target.value)}
                    autoComplete="off"
                    required
                  />
                )}
              </Field>
            </>
          ) : (
            <>
              <Field label="Fileserver">
                {(id) => (
                  <Select value={providerId} onValueChange={(value) => setProviderId(value ?? "")}>
                    <SelectTrigger id={id}>
                      <SelectValue placeholder="Choose storage" />
                    </SelectTrigger>
                    <SelectContent>
                      {providers.data?.providers.map((provider) => (
                        <SelectItem key={provider.id} value={provider.id}>
                          {provider.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </Field>
              <Field label="Backup username">
                {(id) => (
                  <Input
                    id={id}
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    autoComplete="off"
                    required
                  />
                )}
              </Field>
            </>
          )}
          <Field label={type === "s3" ? "Key prefix" : "Private backup directory"}>
            {(id) => (
              <Input id={id} value={prefix} onChange={(e) => setPrefix(e.target.value)} required />
            )}
          </Field>
          <Field label={type === "s3" ? "Secret access key" : "Backup password"}>
            {(id) => (
              <Input
                id={id}
                type="password"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                autoComplete="new-password"
                required
              />
            )}
          </Field>
          <p className="text-sm text-muted-foreground sm:col-span-2">
            Use private storage with a dedicated password that signs in without one-time codes;
            scheduled backups run unattended. Keep a copy of those credentials outside fdrive for
            disaster recovery.
          </p>
          <Button disabled={busy} type="submit">
            Test and save
          </Button>
        </form>
      )}
    </SystemSection>
  );
}
export function BackupsPage() {
  const { prefs } = useFormatters();
  const query = useBackups();
  const cache = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [unlocked, setUnlocked] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [challenge, setChallenge] = useState("");
  const [key, setKey] = useState("");
  const [label, setLabel] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [notes, setNotes] = useState("");
  const [sourceDate, setSourceDate] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const [replace, setReplace] = useState<string | undefined>();
  const [schedule, setSchedule] = useState<BackupSchedule | null>(null);
  const [confirmation, setConfirmation] = useState<{
    description: string;
    action: () => Promise<unknown>;
  } | null>(null);
  const act: Act = async (work) => {
    setBusy(true);
    setError("");
    try {
      await work();
      await cache.invalidateQueries({ queryKey: backupQueryKey });
    } catch (reason) {
      if (reason instanceof ApiClientError && reason.kind === "reauth_required") setUnlocked(false);
      setError(reason instanceof Error ? reason.message : "Backup request failed");
    } finally {
      setBusy(false);
    }
  };
  const data = query.data;
  const selected = schedule ?? data?.schedule;
  return (
    <SystemPage
      title="Backups"
      description="Protect configuration, activity and recovery files. Indexes and thumbnails can be rebuilt."
      lastUpdated={query.dataUpdatedAt ? new Date(query.dataUpdatedAt) : null}
      actions={
        <>
          {data && (!unlocked || !data.keyConfirmed) && (
            <span className="text-xs text-muted-foreground">
              {!unlocked
                ? "Unlock owner access below to back up now"
                : "Confirm your recovery key below to back up now"}
            </span>
          )}
          <Button
            disabled={busy || !unlocked || !data?.keyConfirmed}
            onClick={() =>
              void act(() =>
                backupClient.create({
                  destinationIds:
                    data?.destinations.filter((d) => d.enabled).map((d) => d.id) ?? [],
                  metadataOnly: false,
                }),
              )
            }
          >
            {busy ? <LoaderCircle className="animate-spin" /> : <ShieldCheck />}Back up now
          </Button>
        </>
      }
    >
      <div className="contents max-sm:[&_button]:min-h-11 max-sm:[&_input]:min-h-11 max-sm:[&_a[data-slot=button]]:min-h-11">
        {(error || query.error) && (
          <p
            role="alert"
            className="break-words rounded-lg border border-destructive/40 p-4 text-sm text-destructive"
          >
            {error || query.error?.message}
          </p>
        )}
        {query.isPending && <p role="status">Loading backups…</p>}
        {data && (
          <>
            <SystemSection
              title="Owner access"
              description="Confirm your storage password to manage sensitive backups for the next ten minutes."
            >
              {unlocked ? (
                <p className="text-sm">Backup controls unlocked.</p>
              ) : (
                <OwnerUnlock act={act} busy={busy} onUnlocked={() => setUnlocked(true)} />
              )}
            </SystemSection>
            <BackupHealth data={data} act={act} busy={busy} unlocked={unlocked} />
            <SystemSection
              title="Recovery key"
              description="Keep this key somewhere independent of fdrive. It is required to decrypt your backups."
            >
              {data.keyConfirmed && !rotating ? (
                <>
                  <Badge variant="secondary">Recovery key confirmed</Badge>
                  <p className="break-all font-mono text-xs text-muted-foreground">
                    {data.recipient}
                  </p>
                  <Button
                    variant="outline"
                    disabled={busy || !unlocked}
                    onClick={() =>
                      setConfirmation({
                        description:
                          "Create a new key for future backups. Keep every old recovery key until all backups using it have expired.",
                        action: async () => setRotating(true),
                      })
                    }
                  >
                    Rotate recovery key
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    variant="outline"
                    disabled={!unlocked || busy}
                    onClick={() =>
                      void act(async () => {
                        const identity = await generateIdentity();
                        const recipient = await identityToRecipient(identity);
                        const result = await backupClient.key(recipient);
                        saveText(
                          `# fdrive recovery key\n# Installation: ${data.installationId}\n# Recipient: ${recipient}\n# Store destination access credentials separately.\n# Destinations: ${data.destinations.map((item) => `${item.name}: ${item.location}`).join("; ") || "Browser download only"}\n# Restore: use the same fdrive release, a new empty database and a new master key.\n# Inspect offline: node dist/main.js backup inspect --file BACKUP.fdrive.age --key-file THIS_FILE\n# Set private key file permissions to 600. Use /restore with a host recovery token, or the backup restore CLI.\n# Restore starts paused. Review fileserver bindings and reauthenticate before resuming.\n# External configuration ZIPs are extracted for manual recovery with their original tools.\n${identity}\n`,
                          "fdrive-recovery-key.txt",
                        );
                        setChallenge(result.challenge);
                      })
                    }
                  >
                    <Download />
                    Create and download recovery key
                  </Button>
                  {challenge && (
                    <>
                      <Field label="Paste the saved recovery key to confirm">
                        {(id) => (
                          <Textarea
                            id={id}
                            value={key}
                            onChange={(event) => setKey(event.target.value)}
                            autoComplete="off"
                          />
                        )}
                      </Field>
                      <Button
                        disabled={busy || !key}
                        onClick={() =>
                          void act(async () => {
                            const identity = key
                              .split(/\r?\n/)
                              .map((line) => line.trim())
                              .find((line) => line.startsWith("AGE-SECRET-KEY-"));
                            if (!identity)
                              throw Error("Paste the private key from the downloaded file");
                            const decrypt = new Decrypter();
                            decrypt.addIdentity(identity);
                            const proof = await decrypt.decrypt(
                              Uint8Array.from(atob(challenge), (c) => c.charCodeAt(0)),
                              "text",
                            );
                            await backupClient.confirm(proof);
                            setKey("");
                            setChallenge("");
                            setRotating(false);
                          })
                        }
                      >
                        Confirm saved key
                      </Button>
                    </>
                  )}
                </>
              )}
            </SystemSection>
            <SystemSection
              title="Download options"
              description="Local downloads expire after 24 hours unless kept. Capturing the archive pauses file changes; remote transfer starts after that pause."
            >
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  disabled={busy || !unlocked || !data.keyConfirmed}
                  onClick={() =>
                    void act(() => backupClient.create({ destinationIds: [], metadataOnly: false }))
                  }
                >
                  Prepare local download
                </Button>
                <Button
                  variant="ghost"
                  disabled={busy || !unlocked || !data.keyConfirmed}
                  onClick={() =>
                    setConfirmation({
                      description:
                        "Create a partial backup of database records and available configuration ZIPs? Other recovery files are excluded and this backup will show incomplete coverage.",
                      action: () => backupClient.create({ destinationIds: [], metadataOnly: true }),
                    })
                  }
                >
                  Database and ZIPs only
                </Button>
              </div>
            </SystemSection>
            <Destinations data={data} act={act} busy={busy} unlocked={unlocked} />
            <SystemSection
              title="Additional configuration files"
              description="Upload a ZIP containing configuration files from outside fdrive. We'll include it in future backups. Upload a new copy whenever those files change."
            >
              {data.attachments.map((item) => (
                <div
                  key={item.id}
                  className="flex min-w-0 flex-wrap justify-between gap-3 border-b pb-3"
                >
                  <div className="min-w-0">
                    <p className="break-words font-medium">{item.label}</p>
                    <p className="break-all text-xs text-muted-foreground">
                      {item.filename} · {size(item.bytes, prefs.sizes)} · Uploaded{" "}
                      {new Date(item.uploadedAt).toLocaleDateString()}
                      {item.sourceDate
                        ? ` · Source ${new Date(item.sourceDate).toLocaleDateString()}`
                        : ""}
                    </p>
                    <p className="break-words text-xs text-muted-foreground">
                      {item.lastCapturedAt
                        ? `This version included in a complete backup on ${new Date(item.lastCapturedAt).toLocaleString()}`
                        : "This version has not been included in a complete backup yet."}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      disabled={!unlocked}
                      nativeButton={false}
                      render={<a href={backupClient.attachmentUrl(item.id)} />}
                    >
                      Download ZIP
                    </Button>
                    <Button
                      variant="outline"
                      disabled={busy || !unlocked}
                      onClick={() => {
                        setReplace(item.id);
                        setLabel(item.label);
                        setNotes(item.notes);
                        setSourceDate(item.sourceDate?.slice(0, 10) ?? "");
                      }}
                    >
                      Replace
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={busy || !unlocked}
                      onClick={() =>
                        setConfirmation({
                          description:
                            "Remove this ZIP from future backups? Existing backups keep their captured copies.",
                          action: () => backupClient.removeAttachment(item.id),
                        })
                      }
                    >
                      Remove
                    </Button>
                  </div>
                </div>
              ))}
              <form
                className="grid gap-4 sm:grid-cols-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void act(async () => {
                    if (!file) throw Error("Choose a configuration ZIP");
                    await backupClient.upload(
                      {
                        label,
                        filename: file.name,
                        notes,
                        sourceDate: sourceDate ? new Date(sourceDate).toISOString() : null,
                      },
                      file,
                      replace,
                    );
                    setFile(null);
                    if (fileInput.current) fileInput.current.value = "";
                    setSourceDate("");
                    setLabel("");
                    setNotes("");
                    setReplace(undefined);
                  });
                }}
              >
                <Field label="Bundle name">
                  {(id) => (
                    <Input
                      id={id}
                      value={label}
                      onChange={(e) => setLabel(e.target.value)}
                      placeholder="Fileserver configuration"
                      required
                      disabled={!unlocked}
                    />
                  )}
                </Field>
                <Field label="Configuration ZIP">
                  {(id) => (
                    <Input
                      id={id}
                      ref={fileInput}
                      type="file"
                      accept=".zip,application/zip"
                      onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                      required
                      disabled={!unlocked}
                    />
                  )}
                </Field>
                <Field label="Configuration source date (optional)">
                  {(id) => (
                    <Input
                      id={id}
                      type="date"
                      value={sourceDate}
                      onChange={(event) => setSourceDate(event.target.value)}
                      disabled={!unlocked}
                    />
                  )}
                </Field>
                <div className="sm:col-span-2">
                  <Field label="Restore notes (optional)">
                    {(id) => (
                      <Textarea
                        id={id}
                        value={notes}
                        onChange={(e) => setNotes(e.target.value)}
                        disabled={!unlocked}
                      />
                    )}
                  </Field>
                </div>
                <Button type="submit" disabled={!unlocked || busy || !file}>
                  {replace ? "Replace configuration ZIP" : "Upload configuration ZIP"}
                </Button>
              </form>
            </SystemSection>
            {selected && (
              <SystemSection
                title="Schedule and retention"
                description={
                  data.nextRunAt
                    ? `The default for every destination unless you give it its own schedule. Next backup: ${new Date(data.nextRunAt).toLocaleString()}.`
                    : "The default for every destination unless you give it its own schedule. Automatic backups are off."
                }
              >
                <form
                  className="grid gap-6"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void act(() => backupClient.schedule(selected));
                  }}
                >
                  <ScheduleFields value={selected} onChange={setSchedule} />
                  <div className="flex justify-end">
                    <Button type="submit" disabled={busy || !unlocked || !data.keyConfirmed}>
                      Save schedule
                    </Button>
                  </div>
                </form>
              </SystemSection>
            )}
            <SystemSection
              title="Backup history"
              description="A complete backup includes all declared sources. Partial backups list missing coverage."
            >
              {data.runs.length === 0 && (
                <p className="text-sm text-muted-foreground">No backups yet.</p>
              )}
              {data.runs.map((run) => (
                <div key={run.id} className="min-w-0 space-y-3 rounded-lg border p-4">
                  <div className="flex flex-wrap justify-between gap-2">
                    <p className="font-medium">{new Date(run.createdAt).toLocaleString()}</p>
                    <Badge variant="secondary">
                      {run.state}
                      {run.pinned ? " · pinned" : ""}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {size(run.bytes, prefs.sizes)}
                    {run.verifiedAt
                      ? ` · Bytes verified ${new Date(run.verifiedAt).toLocaleString()}`
                      : ""}
                  </p>
                  {run.verificationError && (
                    <p className="text-sm text-destructive">{run.verificationError}</p>
                  )}
                  {run.error && <p className="text-sm text-destructive">{run.error}</p>}
                  {[...new Set(run.coverage)].map((item) => (
                    <p key={item} className="break-words text-sm">
                      {item}
                    </p>
                  ))}
                  {run.deliveries.map((delivery) => (
                    <p key={delivery.destinationId} className="break-words text-sm">
                      {delivery.name}: {delivery.state}
                      {delivery.error ? ` — ${delivery.error}` : ""}
                      {delivery.retentionUntil
                        ? ` · Locked until ${new Date(delivery.retentionUntil).toLocaleString()}`
                        : ""}
                    </p>
                  ))}
                  <div className="flex flex-wrap gap-2">
                    {run.downloadable && (
                      <Button
                        variant="outline"
                        disabled={!unlocked}
                        nativeButton={false}
                        render={<a href={backupClient.downloadUrl(run.id)} />}
                      >
                        <Download />
                        Download backup
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      disabled={
                        busy ||
                        !unlocked ||
                        run.verificationRequested ||
                        !["complete", "partial"].includes(run.state)
                      }
                      onClick={() => void act(() => backupClient.verify(run.id))}
                    >
                      {run.verificationRequested ? "Verifying…" : "Verify bytes"}
                    </Button>
                    <Button
                      variant="outline"
                      disabled={busy || !unlocked}
                      onClick={() => void act(() => backupClient.pin(run.id, !run.pinned))}
                    >
                      {run.pinned ? "Unpin" : "Keep"}
                    </Button>
                    {["queued", "capturing", "transferring"].includes(run.state) ? (
                      <Button
                        variant="ghost"
                        disabled={busy || !unlocked}
                        onClick={() => void act(() => backupClient.cancel(run.id))}
                      >
                        Cancel
                      </Button>
                    ) : (
                      <>
                        <Button
                          variant="ghost"
                          disabled={busy || !unlocked || run.pinned}
                          onClick={() =>
                            setConfirmation({
                              description:
                                "Delete this backup from its destinations? Locked remote objects may prevent deletion.",
                              action: () => backupClient.remove(run.id),
                            })
                          }
                        >
                          Delete backup
                        </Button>
                        {run.state === "partial" && run.downloadable && (
                          <Button
                            variant="outline"
                            disabled={busy || !unlocked}
                            onClick={() => void act(() => backupClient.retry(run.id))}
                          >
                            Retry destinations
                          </Button>
                        )}
                      </>
                    )}
                  </div>
                </div>
              ))}
            </SystemSection>
            <SystemSection
              title="Restore an installation"
              description="Use a fresh fdrive installation or the backup restore command to inspect an archive before replacing any data."
            >
              <p className="text-sm text-muted-foreground">
                Have your recovery key and destination credentials ready. Original files and the
                fileserver itself need their own backups. Uploaded configuration ZIPs are returned
                intact for manual recovery.
              </p>
              <Button variant="outline" nativeButton={false} render={<a href="/restore" />}>
                Open restore
              </Button>
            </SystemSection>
          </>
        )}
        <AlertDialog
          open={confirmation !== null}
          onOpenChange={(open) => {
            if (!open) setConfirmation(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Confirm action</AlertDialogTitle>
              <AlertDialogDescription>{confirmation?.description}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  const action = confirmation?.action;
                  setConfirmation(null);
                  if (action) void act(action);
                }}
              >
                Confirm
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </SystemPage>
  );
}
