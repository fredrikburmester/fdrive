"use client";
import { ApiClientError, type BackupSchedule, type BackupsResponse } from "@fdrive/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { Decrypter, generateIdentity, identityToRecipient } from "age-encryption";
import { Download, LoaderCircle, Plus, ShieldCheck } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { toast } from "sonner";
import { SettingActions, SettingRow } from "@/components/shell/page-layout";
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
import { formatBytes, type SizeUnits } from "@/lib/format";
import { useFormatters } from "@/lib/use-format-preferences";
import { BackupHealth } from "./backup-health";
import { SystemPage } from "./system-page";
import { SystemAlert, SystemLine, SystemNote, SystemSection } from "./system-section";

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
  const [password, setPassword] = useState("");
  const id = useId();
  return (
    <SettingRow label="Current password" htmlFor={id} description="The password you sign in with.">
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void act(async () => {
            await backupClient.unlock(password);
            setPassword("");
            onUnlocked();
          });
        }}
      >
        {/* Lets password managers fill the signed-in user's own password. */}
        <input
          type="text"
          name="username"
          autoComplete="username"
          value={me?.identity.username ?? ""}
          readOnly
          hidden
        />
        <Input
          id={id}
          className="min-w-0 max-w-sm flex-1 basis-56"
          type="password"
          autoComplete="current-password"
          maxLength={1024}
          value={password}
          disabled={busy}
          onChange={(event) => setPassword(event.target.value)}
        />
        <Button type="submit" disabled={busy || password.length === 0}>
          Unlock backups
        </Button>
      </form>
    </SettingRow>
  );
}
/** One field of a form as a row: its label on the left, the control given its id beside it. */
function FieldRow({
  label,
  description,
  children,
}: {
  label: string;
  description?: ReactNode;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <SettingRow label={label} htmlFor={id} description={description}>
      {children(id)}
    </SettingRow>
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
/** Text fields stop at a readable width instead of stretching across the window. */
const FIELD_WIDTH = "max-w-sm";
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
    <>
      <SettingRow label="How often to back up" htmlFor={`${id}-frequency`}>
        <Select
          value={value.frequency}
          onValueChange={(frequency) => {
            if (frequency)
              onChange({ ...value, frequency: frequency as BackupSchedule["frequency"] });
          }}
        >
          <SelectTrigger id={`${id}-frequency`} className="w-full max-w-sm">
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
      </SettingRow>
      <SettingRow
        label="Timezone"
        htmlFor={`${id}-timezone`}
        description="An IANA name, such as Europe/Stockholm. Also decides where days and months begin."
      >
        <Input
          id={`${id}-timezone`}
          className="max-w-sm"
          value={value.timezone}
          onChange={(event) => onChange({ ...value, timezone: event.target.value })}
        />
      </SettingRow>
      {timed && (
        <SettingRow
          label="Hour of day (0–23)"
          htmlFor={`${id}-hour`}
          description="Pick a quiet hour; uploads wait while a backup is captured."
        >
          <Input
            id={`${id}-hour`}
            className="w-28"
            type="number"
            min={0}
            max={23}
            value={value.hour}
            onChange={(event) => onChange({ ...value, hour: Number(event.target.value) })}
          />
        </SettingRow>
      )}
      <SystemNote>
        <p className="font-medium text-foreground text-sm">How many backups to keep</p>
        <p>
          This thins out old backups; it doesn't add backups. fdrive keeps the newest backup from
          each of the most recent days, weeks and months that have one, plus the latest and any
          pinned backup, and deletes the rest. There is no monthly schedule because a daily or
          weekly backup already serves as its month's copy.
        </p>
        {note && <p>{note}</p>}
        {retentionNote && <p>{retentionNote}</p>}
      </SystemNote>
      {retentionPeriods.map(([period, label, unit, min, max]) => (
        <SettingRow
          key={period}
          label={label}
          htmlFor={`${id}-${period}`}
          description={`One from each of the last ${value[period]} ${unit}.`}
        >
          <Input
            id={`${id}-${period}`}
            className="w-28"
            type="number"
            min={min}
            max={max}
            value={value[period]}
            onChange={(event) => onChange({ ...value, [period]: Number(event.target.value) })}
          />
        </SettingRow>
      ))}
    </>
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
      className="border-border/60 border-t bg-muted/20"
      onSubmit={(event) => {
        event.preventDefault();
        void onSave(inherit ? null : policy);
      }}
    >
      <SystemNote>
        <p className="font-medium text-foreground text-sm">Schedule for {name}</p>
        <p>When fdrive sends a new backup here, and how many old backups to keep here.</p>
      </SystemNote>
      <div className="border-border/60 border-b px-3 py-2.5">
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
      </div>
      {!inherit && (
        <ScheduleFields
          value={policy}
          onChange={setPolicy}
          retentionNote="A backup shared with another destination stays until neither needs it."
        />
      )}
      <SettingActions>
        <Button type="submit" disabled={busy}>
          Save destination schedule
        </Button>
        <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </SettingActions>
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
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [pathStyle, setPathStyle] = useState(false);
  const [name, setName] = useState("");
  const [endpoint, setEndpoint] = useState("https://s3.amazonaws.com");
  const [region, setRegion] = useState("us-east-1");
  const [bucket, setBucket] = useState("");
  const [prefix, setPrefix] = useState("fdrive-backups");
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secret, setSecret] = useState("");
  return (
    <SystemSection
      title="Destinations"
      description="Copy each backup to an S3-compatible bucket, such as AWS S3 or Backblaze B2."
      actions={
        <Button
          variant="outline"
          size="sm"
          disabled={!unlocked || busy}
          onClick={() => setAdding(!adding)}
        >
          <Plus />
          Add destination
        </Button>
      }
    >
      {data.destinations.length === 0 && (
        <SystemLine className="border-border/60 border-b last:border-b-0">
          No remote destinations. You can still download a local backup.
        </SystemLine>
      )}
      {data.destinations.map((item) => (
        <div
          key={item.id}
          data-slot="backup-destination"
          className="border-border/60 border-b last:border-b-0"
        >
          <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-6 gap-y-2 px-3 py-2.5">
            <div className="min-w-0">
              <p className="flex flex-wrap items-center gap-2 font-medium text-sm">
                <span className="break-words">{item.name}</span>
                <Badge variant="secondary">{item.enabled ? "Enabled" : "Paused"}</Badge>
              </p>
              <p className="break-all text-muted-foreground text-xs">{item.location}</p>
              {item.retainedProbe && (
                <p className="break-all text-muted-foreground text-xs">
                  Bucket retention keeps the test object {item.retainedProbe.name} until{" "}
                  {new Date(item.retainedProbe.retentionUntil).toLocaleString()}.
                </p>
              )}
              <p className="text-muted-foreground text-xs">
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
              <p className="text-muted-foreground text-xs">
                {item.testedAt
                  ? `Last tested: ${new Date(item.testedAt).toLocaleString()}`
                  : "Not tested yet"}
              </p>
              <p className="break-words text-muted-foreground text-xs">
                {item.schedule
                  ? `Own schedule: ${describeSchedule(item.schedule)}`
                  : `Installation schedule: ${describeSchedule(data.schedule)}`}
                {(item.schedule ? item.nextRunAt : data.nextRunAt) &&
                  ` · next ${new Date((item.schedule ? item.nextRunAt : data.nextRunAt) as string).toLocaleString()}`}
              </p>
            </div>
            <div className="flex flex-wrap gap-1.5">
              <Button
                variant="outline"
                size="sm"
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
                size="sm"
                disabled={busy || !unlocked || !data.keyConfirmed}
                aria-expanded={editing === item.id}
                onClick={() => setEditing(editing === item.id ? null : item.id)}
              >
                Edit schedule
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy || !unlocked}
                onClick={() => void act(() => backupClient.removeDestination(item.id))}
              >
                Remove destination
              </Button>
            </div>
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
          aria-label="New destination"
          onSubmit={(event) => {
            event.preventDefault();
            void act(async () => {
              await backupClient.destination({
                type: "s3",
                name,
                endpoint,
                region,
                bucket,
                prefix,
                pathStyle,
                accessKeyId,
                secretAccessKey: secret,
              });
              setSecret("");
              setAdding(false);
            });
          }}
        >
          <SettingRow label="Preset" description="Fills in the endpoint and region of a provider.">
            <div className="flex flex-wrap gap-2">
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
          </SettingRow>
          <FieldRow label="Name">
            {(id) => (
              <Input
                id={id}
                className={FIELD_WIDTH}
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            )}
          </FieldRow>
          <FieldRow label="S3 endpoint">
            {(id) => (
              <Input
                id={id}
                className={FIELD_WIDTH}
                type="url"
                value={endpoint}
                onChange={(e) => setEndpoint(e.target.value)}
                required
              />
            )}
          </FieldRow>
          <FieldRow label="Region">
            {(id) => (
              <Input
                id={id}
                className={FIELD_WIDTH}
                value={region}
                onChange={(e) => setRegion(e.target.value)}
                required
              />
            )}
          </FieldRow>
          <FieldRow label="Bucket">
            {(id) => (
              <Input
                id={id}
                className={FIELD_WIDTH}
                value={bucket}
                onChange={(e) => setBucket(e.target.value)}
                required
              />
            )}
          </FieldRow>
          <FieldRow
            label="Use path-style addressing"
            description="For servers that take the bucket in the path, such as MinIO."
          >
            {(id) => (
              <input
                id={id}
                type="checkbox"
                // Stays a square where the page gives every other input a 44px tap target.
                className="size-4 max-md:size-5 max-md:min-h-5!"
                checked={pathStyle}
                onChange={(event) => setPathStyle(event.target.checked)}
              />
            )}
          </FieldRow>
          <FieldRow label="Access key ID">
            {(id) => (
              <Input
                id={id}
                className={FIELD_WIDTH}
                value={accessKeyId}
                onChange={(e) => setAccessKeyId(e.target.value)}
                autoComplete="off"
                required
              />
            )}
          </FieldRow>
          <FieldRow label="Key prefix">
            {(id) => (
              <Input
                id={id}
                className={FIELD_WIDTH}
                value={prefix}
                onChange={(e) => setPrefix(e.target.value)}
                required
              />
            )}
          </FieldRow>
          <FieldRow label="Secret access key">
            {(id) => (
              <Input
                id={id}
                className={FIELD_WIDTH}
                type="password"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                autoComplete="new-password"
                required
              />
            )}
          </FieldRow>
          <SystemNote>
            <p>
              Use a private bucket with dedicated credentials; scheduled backups run unattended.
              Keep a copy of those credentials outside fdrive for disaster recovery.
            </p>
          </SystemNote>
          <SettingActions>
            <Button disabled={busy} type="submit">
              Test and save
            </Button>
          </SettingActions>
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
            size="sm"
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
      <div className="contents max-md:[&_button]:min-h-11 max-md:[&_input]:min-h-11 max-md:[&_a[data-slot=button]]:min-h-11">
        {(error || query.error) && (
          <SystemAlert row className="break-words border-destructive/40 bg-destructive/5">
            {error || query.error?.message}
          </SystemAlert>
        )}
        {query.isPending && <SystemLine role="status">Loading backups…</SystemLine>}
        {data && (
          <>
            <SystemSection
              title="Owner access"
              description="Confirm your password to manage sensitive backups for the next ten minutes."
            >
              {unlocked ? (
                <SystemLine className="text-foreground">Backup controls unlocked.</SystemLine>
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
                <SettingRow
                  label={<Badge variant="secondary">Recovery key confirmed</Badge>}
                  description={<span className="break-all font-mono">{data.recipient}</span>}
                >
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
                </SettingRow>
              ) : (
                <>
                  <SettingRow
                    label="New recovery key"
                    description="Made in this browser and saved as a file. fdrive never holds the private key."
                  >
                    <Button
                      variant="outline"
                      disabled={!unlocked || busy}
                      onClick={() =>
                        void act(async () => {
                          const identity = await generateIdentity();
                          const recipient = await identityToRecipient(identity);
                          const result = await backupClient.key(recipient);
                          saveText(
                            `# fdrive recovery key\n# Installation: ${data.installationId}\n# Recipient: ${recipient}\n# Store destination access credentials separately.\n# Destinations: ${data.destinations.map((item) => `${item.name}: ${item.location}`).join("; ") || "Browser download only"}\n# Restore: use the same fdrive release, a new empty database and a new master key.\n# Inspect offline: node dist/main.js backup inspect --file BACKUP.fdrive.age --key-file THIS_FILE\n# Set private key file permissions to 600. Use /restore with a host recovery token, or the backup restore CLI.\n# Restore starts paused. Review the files folder binding and reauthenticate before resuming.\n${identity}\n`,
                            "fdrive-recovery-key.txt",
                          );
                          setChallenge(result.challenge);
                        })
                      }
                    >
                      <Download />
                      Create and download recovery key
                    </Button>
                  </SettingRow>
                  {challenge && (
                    <FieldRow label="Paste the saved recovery key to confirm">
                      {(id) => (
                        <div className="flex max-w-xl flex-col items-start gap-2">
                          <Textarea
                            id={id}
                            value={key}
                            onChange={(event) => setKey(event.target.value)}
                            autoComplete="off"
                          />
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
                        </div>
                      )}
                    </FieldRow>
                  )}
                </>
              )}
            </SystemSection>
            <SystemSection
              title="Download options"
              description="Local downloads expire after 24 hours unless kept. File changes wait only while a backup takes its database snapshot."
              actions={
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy || !unlocked || !data.keyConfirmed}
                    onClick={() =>
                      void act(() =>
                        backupClient.create({ destinationIds: [], metadataOnly: false }),
                      )
                    }
                  >
                    Prepare local download
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy || !unlocked || !data.keyConfirmed}
                    onClick={() =>
                      setConfirmation({
                        description:
                          "Create a partial backup of database records only? Recovery files are excluded and this backup will show incomplete coverage.",
                        action: () =>
                          backupClient.create({ destinationIds: [], metadataOnly: true }),
                      })
                    }
                  >
                    Database only
                  </Button>
                </>
              }
            />
            <Destinations data={data} act={act} busy={busy} unlocked={unlocked} />
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
                  onSubmit={(event) => {
                    event.preventDefault();
                    void act(() => backupClient.schedule(selected));
                  }}
                >
                  <ScheduleFields value={selected} onChange={setSchedule} />
                  <SettingActions>
                    <Button type="submit" disabled={busy || !unlocked || !data.keyConfirmed}>
                      Save schedule
                    </Button>
                  </SettingActions>
                </form>
              </SystemSection>
            )}
            <SystemSection
              title="Backup history"
              description="A complete backup includes all declared sources. Partial backups list missing coverage."
            >
              {data.runs.length === 0 && <SystemLine>No backups yet.</SystemLine>}
              {data.runs.map((run) => (
                <div
                  key={run.id}
                  data-slot="backup-run"
                  className="flex min-w-0 flex-wrap items-start justify-between gap-x-6 gap-y-2 border-border/60 border-b px-3 py-2.5 last:border-b-0"
                >
                  <div className="min-w-0 space-y-1">
                    <p className="flex flex-wrap items-center gap-2 font-medium text-sm">
                      {new Date(run.createdAt).toLocaleString()}
                      <Badge variant="secondary">
                        {run.state}
                        {run.pinned ? " · pinned" : ""}
                      </Badge>
                    </p>
                    <p className="text-muted-foreground text-xs">
                      {size(run.bytes, prefs.sizes)}
                      {run.verifiedAt
                        ? ` · Bytes verified ${new Date(run.verifiedAt).toLocaleString()}`
                        : ""}
                    </p>
                    {run.verificationError && (
                      <p className="text-destructive text-sm">{run.verificationError}</p>
                    )}
                    {run.error && <p className="text-destructive text-sm">{run.error}</p>}
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
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {run.downloadable && (
                      <Button
                        variant="outline"
                        size="sm"
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
                      size="sm"
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
                      size="sm"
                      disabled={busy || !unlocked}
                      onClick={() => void act(() => backupClient.pin(run.id, !run.pinned))}
                    >
                      {run.pinned ? "Unpin" : "Keep"}
                    </Button>
                    {["queued", "capturing", "transferring"].includes(run.state) ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy || !unlocked}
                        onClick={() => void act(() => backupClient.cancel(run.id))}
                      >
                        Cancel
                      </Button>
                    ) : (
                      <>
                        <Button
                          variant="ghost"
                          size="sm"
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
                            size="sm"
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
              actions={
                <Button
                  variant="outline"
                  size="sm"
                  nativeButton={false}
                  render={<a href="/restore" />}
                >
                  Open restore
                </Button>
              }
            >
              <SystemNote>
                <p>
                  Have your recovery key and destination credentials ready. The files folder needs
                  its own backup.
                </p>
              </SystemNote>
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
