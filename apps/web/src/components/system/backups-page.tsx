"use client";
import { ApiClientError, type BackupSchedule, type BackupsResponse } from "@fdrive/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { Decrypter, generateIdentity, identityToRecipient } from "age-encryption";
import { cn } from "cn";
import { LoaderCircle, MoreHorizontal } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { toast } from "sonner";
import {
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeader,
  DataTableRow,
  SettingActions,
  SettingRow,
} from "@/components/shell/page-layout";
import { ChoiceRow, SegmentedControl } from "@/components/shell/setting-controls";
import { Code } from "@/components/shell/sheet-data";
import { StatusBadge, type StatusTone } from "@/components/shell/status";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useMe } from "@/lib/api/auth-queries";
import { backupClient, backupQueryKey, useBackups } from "@/lib/api/backup-queries";
import { useFormatters } from "@/lib/use-format-preferences";
import {
  BackupStatus,
  backupHealth,
  destinationStatus,
  RestoreRehearsal,
  StorageEstimate,
  useBackupTime,
} from "./backup-health";
import { SystemPage } from "./system-page";
import { SystemAlert, SystemLine, SystemNote, SystemSection } from "./system-section";

type Act = (work: () => Promise<unknown>) => Promise<void>;
type Destination = BackupsResponse["destinations"][number];
type Run = BackupsResponse["runs"][number];

/** What a row's action asks before it runs. A destructive one is confirmed in red. */
interface Confirmation {
  title: string;
  description: string;
  confirm: string;
  destructive?: boolean;
  action: () => Promise<unknown>;
}
type Confirm = (confirmation: Confirmation) => void;

/** The sheet's tabs: it holds more than one screen, so it is split instead of scrolled. */
const TABS = ["overview", "destinations", "history", "recovery"] as const;
type Tab = (typeof TABS)[number];
const TAB_LABELS: Record<Tab, string> = {
  overview: "Overview",
  destinations: "Destinations",
  history: "History",
  recovery: "Recovery",
};

/** The round More button at the end of a table row. */
const ROW_MENU = "rounded-full text-muted-foreground max-md:size-11";
/** A second line under a row's name: smaller, and free to wrap. */
const ROW_DETAIL = "font-normal text-xs [overflow-wrap:anywhere]";

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
    <SystemSection
      title="Owner access"
      description="Confirm your password to back up now and manage backups for the next ten minutes."
    >
      <SettingRow
        label="Current password"
        htmlFor={id}
        description="The password you sign in with."
      >
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
            className="min-w-0 flex-1 basis-56"
            type="password"
            autoComplete="current-password"
            maxLength={1024}
            value={password}
            disabled={busy}
            onChange={(event) => setPassword(event.target.value)}
          />
          <Button type="submit" variant="outline" disabled={busy || password.length === 0}>
            Unlock backups
          </Button>
        </form>
      </SettingRow>
    </SystemSection>
  );
}
/** One field of a form as a row: its label on the left, the control given its id beside it. */
function FieldRow({
  label,
  description,
  children,
  ...row
}: {
  label: string;
  description: ReactNode;
  align?: "end";
  className?: string;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <SettingRow label={label} htmlFor={id} description={description} {...row}>
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
/** A count: right-aligned in a narrow field, with figures that line up. */
const NUMBER_FIELD = "w-24 text-right tabular-nums";
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
      <SettingRow
        label="How often to back up"
        htmlFor={`${id}-frequency`}
        description="A backup runs on this schedule and is copied to each destination."
        align="end"
      >
        <Select
          value={value.frequency}
          onValueChange={(frequency) => {
            if (frequency)
              onChange({ ...value, frequency: frequency as BackupSchedule["frequency"] });
          }}
        >
          <SelectTrigger id={`${id}-frequency`} className="w-64 max-w-full">
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
        align="end"
      >
        <Input
          id={`${id}-timezone`}
          className="w-64 max-w-full"
          value={value.timezone}
          onChange={(event) => onChange({ ...value, timezone: event.target.value })}
        />
      </SettingRow>
      {timed && (
        <SettingRow
          label="Hour of day (0–23)"
          htmlFor={`${id}-hour`}
          description="Pick a quiet hour; uploads wait while a backup is captured."
          align="end"
        >
          <Input
            id={`${id}-hour`}
            className={NUMBER_FIELD}
            type="number"
            min={0}
            max={23}
            value={value.hour}
            onChange={(event) => onChange({ ...value, hour: Number(event.target.value) })}
          />
        </SettingRow>
      )}
      <SystemNote className="border-border border-t py-4.5">
        <p className="font-medium text-foreground">How many backups to keep</p>
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
          align="end"
        >
          <Input
            id={`${id}-${period}`}
            className={NUMBER_FIELD}
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
/** One destination's own schedule, shown in place of the list while it is edited. */
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
  const [inherit, setInherit] = useState(value === null);
  const [policy, setPolicy] = useState<BackupSchedule>(value ?? installation);
  return (
    <SystemSection
      title={`Schedule for ${name}`}
      description="When fdrive sends a new backup here, and how many old backups to keep here."
    >
      <form
        aria-label={`Schedule for ${name}`}
        onSubmit={(event) => {
          event.preventDefault();
          void onSave(inherit ? null : policy);
        }}
      >
        <ChoiceRow
          label="Schedule"
          hint={
            inherit
              ? `${describeSchedule(installation)}, ${describeRetention(installation)}. Follows any change you make to the installation schedule.`
              : "For destinations that need different timing, such as hourly to a nearby server and weekly to cloud storage."
          }
          value={inherit ? "installation" : "own"}
          options={["installation", "own"] as const}
          labels={{ installation: "Installation schedule", own: "Own schedule" }}
          onChange={(choice) => setInherit(choice === "installation")}
        />
        {!inherit && (
          <ScheduleFields
            value={policy}
            onChange={setPolicy}
            retentionNote="A backup shared with another destination stays until neither needs it."
          />
        )}
        <SettingActions>
          <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" variant="outline" disabled={busy}>
            Save destination schedule
          </Button>
        </SettingActions>
      </form>
    </SystemSection>
  );
}
/** A new bucket, shown in place of the list while it is filled in. Saving tests it first. */
function NewDestination({ act, busy, onDone }: { act: Act; busy: boolean; onDone: () => void }) {
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
      title="New destination"
      description="Copy each backup to an S3-compatible bucket, such as AWS S3 or Backblaze B2."
    >
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
            onDone();
          });
        }}
      >
        <SettingRow
          label="Preset"
          description="Fills in the endpoint and region of a provider."
          align="end"
        >
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
        <FieldRow label="Name" description="What fdrive calls this destination.">
          {(id) => (
            <Input id={id} value={name} onChange={(e) => setName(e.target.value)} required />
          )}
        </FieldRow>
        <FieldRow label="S3 endpoint" description="The address of the provider's S3 API.">
          {(id) => (
            <Input
              id={id}
              type="url"
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              required
            />
          )}
        </FieldRow>
        <FieldRow label="Region" description="The region the bucket belongs to.">
          {(id) => (
            <Input id={id} value={region} onChange={(e) => setRegion(e.target.value)} required />
          )}
        </FieldRow>
        <FieldRow label="Bucket" description="The bucket backups are copied to.">
          {(id) => (
            <Input id={id} value={bucket} onChange={(e) => setBucket(e.target.value)} required />
          )}
        </FieldRow>
        <FieldRow
          label="Use path-style addressing"
          description="For servers that take the bucket in the path, such as MinIO."
          align="end"
          // The switch's tap area reaches past the row's end; keep it from widening the section.
          className="overflow-x-clip"
        >
          {(id) => <Switch id={id} checked={pathStyle} onCheckedChange={setPathStyle} />}
        </FieldRow>
        <FieldRow label="Key prefix" description="The folder inside the bucket that holds them.">
          {(id) => (
            <Input id={id} value={prefix} onChange={(e) => setPrefix(e.target.value)} required />
          )}
        </FieldRow>
        <FieldRow label="Access key ID" description="The ID of a key made for fdrive alone.">
          {(id) => (
            <Input
              id={id}
              value={accessKeyId}
              onChange={(e) => setAccessKeyId(e.target.value)}
              autoComplete="off"
              required
            />
          )}
        </FieldRow>
        <FieldRow label="Secret access key" description="The secret that belongs to that key.">
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
        </FieldRow>
        <SystemNote className="border-border border-t py-4.5">
          <p>
            Use a private bucket with dedicated credentials; scheduled backups run unattended. Keep
            a copy of those credentials outside fdrive for disaster recovery.
          </p>
        </SystemNote>
        <SettingActions>
          <Button type="button" variant="ghost" disabled={busy} onClick={onDone}>
            Cancel
          </Button>
          <Button type="submit" variant="outline" disabled={busy}>
            Test and save
          </Button>
        </SettingActions>
      </form>
    </SystemSection>
  );
}
interface OwnerProps {
  data: BackupsResponse;
  act: Act;
  busy: boolean;
  unlocked: boolean;
}
function DestinationRow({
  data,
  item,
  act,
  busy,
  unlocked,
  confirm,
  onEdit,
}: OwnerProps & { item: Destination; confirm: Confirm; onEdit: () => void }) {
  const time = useBackupTime();
  const [testing, setTesting] = useState(false);
  const status = destinationStatus(data, item, Date.now());
  const next = item.schedule ? item.nextRunAt : data.nextRunAt;
  return (
    <DataTableRow data-slot="backup-destination">
      <DataTableCell className="whitespace-normal py-2.5">
        <span className="[overflow-wrap:anywhere]">{item.name}</span>
        <p className={cn(ROW_DETAIL, "text-muted-foreground")}>{item.location}</p>
        <p className={cn(ROW_DETAIL, "text-muted-foreground")}>
          {item.testedAt ? `Last tested: ${time(item.testedAt)}` : "Not tested yet"}
        </p>
        {item.retainedProbe && (
          <p className={cn(ROW_DETAIL, "text-muted-foreground")}>
            Bucket retention keeps the test object {item.retainedProbe.name} until{" "}
            {time(item.retainedProbe.retentionUntil)}.
          </p>
        )}
        {status.overdue && (
          <p className={cn(ROW_DETAIL, "text-warning")}>
            Delivery overdue by more than 15 minutes.
          </p>
        )}
        {status.error && <p className={cn(ROW_DETAIL, "text-destructive")}>{status.error}</p>}
      </DataTableCell>
      <DataTableCell className="whitespace-normal text-muted-foreground @max-xl:hidden">
        <span>
          {item.schedule
            ? `Own schedule: ${describeSchedule(item.schedule)}`
            : `Installation schedule: ${describeSchedule(data.schedule)}`}
        </span>
        {next && <p className="text-xs">Next {time(next)}</p>}
      </DataTableCell>
      <DataTableCell className="text-muted-foreground @max-3xl:hidden">
        {status.delivered ? time(status.delivered.createdAt) : "None yet"}
      </DataTableCell>
      <DataTableCell>
        {testing ? (
          <StatusBadge>Testing</StatusBadge>
        ) : (
          <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
        )}
      </DataTableCell>
      <DataTableCell className="w-11 text-right">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={ROW_MENU}
                aria-label={`Actions for ${item.name}`}
                disabled={busy || !unlocked}
              />
            }
          >
            <MoreHorizontal />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-auto min-w-48">
            <DropdownMenuItem
              onClick={() =>
                void act(async () => {
                  setTesting(true);
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
                    setTesting(false);
                  }
                })
              }
            >
              Test
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!data.keyConfirmed} onClick={onEdit}>
              Edit schedule
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onClick={() =>
                confirm({
                  title: `Remove ${item.name}?`,
                  description:
                    "fdrive stops copying backups to it. A destination that still holds backups can't be removed until those backups are deleted.",
                  confirm: "Remove destination",
                  destructive: true,
                  action: () => backupClient.removeDestination(item.id),
                })
              }
            >
              Remove destination
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </DataTableCell>
    </DataTableRow>
  );
}
/**
 * Where backups are copied to: the buckets as a table, each with its state judged on its own,
 * then how much room they need. Adding a bucket or editing one's schedule takes the tab over
 * until it is saved or cancelled.
 */
function Destinations({ data, act, busy, unlocked, confirm }: OwnerProps & { confirm: Confirm }) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const edited = data.destinations.find((item) => item.id === editing);
  if (adding) return <NewDestination act={act} busy={busy} onDone={() => setAdding(false)} />;
  if (edited)
    return (
      <DestinationPolicy
        name={edited.name}
        value={edited.schedule}
        installation={data.schedule}
        busy={busy}
        onCancel={() => setEditing(null)}
        onSave={async (value) => {
          await act(async () => {
            await backupClient.destinationSchedule(edited.id, value);
            setEditing(null);
          });
        }}
      />
    );
  return (
    <>
      <SystemSection
        title="Destinations"
        description="Copy each backup to an S3-compatible bucket, such as AWS S3 or Backblaze B2."
        actions={
          <Button variant="outline" disabled={!unlocked || busy} onClick={() => setAdding(true)}>
            Add destination
          </Button>
        }
      >
        {data.destinations.length === 0 ? (
          <SystemLine>No remote destinations. You can still download a local backup.</SystemLine>
        ) : (
          <DataTable>
            <DataTableHeader>
              <DataTableRow>
                <DataTableHead>Destination</DataTableHead>
                <DataTableHead className="@max-xl:hidden">Schedule</DataTableHead>
                <DataTableHead className="@max-3xl:hidden">Last complete copy</DataTableHead>
                <DataTableHead>State</DataTableHead>
                <DataTableHead className="w-11">
                  <span className="sr-only">Actions</span>
                </DataTableHead>
              </DataTableRow>
            </DataTableHeader>
            <DataTableBody>
              {data.destinations.map((item) => (
                <DestinationRow
                  key={item.id}
                  data={data}
                  item={item}
                  act={act}
                  busy={busy}
                  unlocked={unlocked}
                  confirm={confirm}
                  onEdit={() => setEditing(item.id)}
                />
              ))}
            </DataTableBody>
          </DataTable>
        )}
      </SystemSection>
      <StorageEstimate data={data} act={act} busy={busy} unlocked={unlocked} />
    </>
  );
}
const RUN_STATES: Record<Run["state"], { tone: StatusTone; label: string }> = {
  queued: { tone: "neutral", label: "Queued" },
  capturing: { tone: "neutral", label: "Capturing" },
  transferring: { tone: "neutral", label: "Transferring" },
  complete: { tone: "success", label: "Complete" },
  partial: { tone: "warning", label: "Partial" },
  failed: { tone: "danger", label: "Failed" },
  cancelled: { tone: "off", label: "Cancelled" },
};
function RunRow({
  run,
  act,
  busy,
  unlocked,
  confirm,
}: Omit<OwnerProps, "data"> & { run: Run; confirm: Confirm }) {
  const { formatBytes } = useFormatters();
  const time = useBackupTime();
  const when = time(run.createdAt);
  const state = RUN_STATES[run.state];
  const running = ["queued", "capturing", "transferring"].includes(run.state);
  return (
    <DataTableRow data-slot="backup-run">
      <DataTableCell className="whitespace-normal py-2.5">
        <span className="@xl:whitespace-nowrap">{when}</span>
        {run.verifiedAt && (
          <p className={cn(ROW_DETAIL, "text-muted-foreground")}>
            Bytes verified {time(run.verifiedAt)}
          </p>
        )}
        {run.verificationError && (
          <p className={cn(ROW_DETAIL, "text-destructive")}>{run.verificationError}</p>
        )}
        {run.error && <p className={cn(ROW_DETAIL, "text-destructive")}>{run.error}</p>}
        {[...new Set(run.coverage)].map((item) => (
          <p key={item} className={cn(ROW_DETAIL, "text-warning")}>
            {item}
          </p>
        ))}
      </DataTableCell>
      <DataTableCell className="text-muted-foreground tabular-nums @max-xl:hidden">
        {formatBytes(Number(run.bytes))}
      </DataTableCell>
      <DataTableCell className="whitespace-normal text-muted-foreground @max-xl:hidden">
        {run.deliveries.length === 0 && "Download only"}
        {run.deliveries.map((delivery) => (
          <p
            key={delivery.destinationId}
            className={cn("[overflow-wrap:anywhere]", delivery.error && "text-destructive")}
          >
            {delivery.name}: {delivery.state}
            {delivery.error ? ` — ${delivery.error}` : ""}
            {delivery.retentionUntil ? ` · Locked until ${time(delivery.retentionUntil)}` : ""}
          </p>
        ))}
      </DataTableCell>
      <DataTableCell>
        <span className="flex flex-wrap items-center gap-1.5">
          <StatusBadge tone={state.tone}>{state.label}</StatusBadge>
          {run.pinned && <StatusBadge>Pinned</StatusBadge>}
          {run.verificationRequested && <StatusBadge>Verifying</StatusBadge>}
        </span>
      </DataTableCell>
      <DataTableCell className="w-11 text-right">
        <span className="flex items-center justify-end gap-1">
          {run.downloadable && (
            <Button
              variant="link"
              className="px-1"
              aria-label="Download backup"
              disabled={!unlocked}
              nativeButton={false}
              render={<a href={backupClient.downloadUrl(run.id)} />}
            >
              Download
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className={ROW_MENU}
                  aria-label={`Actions for the backup from ${when}`}
                  disabled={busy || !unlocked}
                />
              }
            >
              <MoreHorizontal />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-auto min-w-48">
              <DropdownMenuItem
                disabled={run.verificationRequested || !["complete", "partial"].includes(run.state)}
                onClick={() => void act(() => backupClient.verify(run.id))}
              >
                {run.verificationRequested ? "Verifying…" : "Verify bytes"}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => void act(() => backupClient.pin(run.id, !run.pinned))}
              >
                {run.pinned ? "Unpin" : "Keep"}
              </DropdownMenuItem>
              {run.state === "partial" && run.downloadable && (
                <DropdownMenuItem onClick={() => void act(() => backupClient.retry(run.id))}>
                  Retry destinations
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              {running ? (
                <DropdownMenuItem onClick={() => void act(() => backupClient.cancel(run.id))}>
                  Cancel
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem
                  variant="destructive"
                  disabled={run.pinned}
                  onClick={() =>
                    confirm({
                      title: "Delete this backup?",
                      description:
                        "This removes every copy its destinations allow. A copy locked at a destination stays until its lock ends.",
                      confirm: "Delete backup",
                      destructive: true,
                      action: () => backupClient.remove(run.id),
                    })
                  }
                >
                  Delete backup
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      </DataTableCell>
    </DataTableRow>
  );
}
/** Every backup fdrive still keeps, and the two ways to make one for download alone. */
function History({ data, act, busy, unlocked, confirm }: OwnerProps & { confirm: Confirm }) {
  const ready = !busy && unlocked && data.keyConfirmed;
  return (
    <>
      <SystemSection
        title="Local download"
        description="File changes wait only while a backup takes its database snapshot."
      >
        <SettingRow
          label="Full backup"
          description="Prepares a backup to download here. It expires after 24 hours unless kept."
          align="end"
        >
          <Button
            variant="outline"
            disabled={!ready}
            onClick={() =>
              void act(() => backupClient.create({ destinationIds: [], metadataOnly: false }))
            }
          >
            Prepare local download
          </Button>
        </SettingRow>
        <SettingRow
          label="Database records only"
          description="A partial backup without recovery files. It shows incomplete coverage."
          align="end"
        >
          <Button
            variant="outline"
            disabled={!ready}
            onClick={() =>
              confirm({
                title: "Create a database-only backup?",
                description:
                  "A partial backup of database records only. Recovery files are excluded, and this backup will show incomplete coverage.",
                confirm: "Create backup",
                action: () => backupClient.create({ destinationIds: [], metadataOnly: true }),
              })
            }
          >
            Prepare database-only download
          </Button>
        </SettingRow>
      </SystemSection>
      <SystemSection
        title="Backup history"
        description="A complete backup includes all declared sources. Partial backups list missing coverage."
      >
        {data.runs.length === 0 ? (
          <SystemLine>No backups yet.</SystemLine>
        ) : (
          <DataTable>
            <DataTableHeader>
              <DataTableRow>
                <DataTableHead>When</DataTableHead>
                <DataTableHead className="@max-xl:hidden">Size</DataTableHead>
                <DataTableHead className="@max-xl:hidden">Copied to</DataTableHead>
                <DataTableHead>Result</DataTableHead>
                <DataTableHead className="w-11">
                  <span className="sr-only">Actions</span>
                </DataTableHead>
              </DataTableRow>
            </DataTableHeader>
            <DataTableBody>
              {data.runs.map((run) => (
                <RunRow
                  key={run.id}
                  run={run}
                  act={act}
                  busy={busy}
                  unlocked={unlocked}
                  confirm={confirm}
                />
              ))}
            </DataTableBody>
          </DataTable>
        )}
        <SystemNote className="mt-4.5">
          <p>
            Downloaded archives are only protected after you save them independently. History here
            does not confirm possession or override a bucket's own lifecycle rules.
          </p>
        </SystemNote>
      </SystemSection>
    </>
  );
}
/** The text of the recovery key file: the private key under what a restore will need. */
function recoveryKit(data: BackupsResponse, recipient: string, identity: string): string {
  const destinations =
    data.destinations.map((item) => `${item.name}: ${item.location}`).join("; ") ||
    "Browser download only";
  return `# fdrive recovery key\n# Installation: ${data.installationId}\n# Recipient: ${recipient}\n# Store destination access credentials separately.\n# Destinations: ${destinations}\n# Restore: use the same fdrive release, a new empty database and a new master key.\n# Inspect offline: node dist/main.js backup inspect --file BACKUP.fdrive.age --key-file THIS_FILE\n# Set private key file permissions to 600. Use /restore with a host recovery token, or the backup restore CLI.\n# Restore starts paused. Review the files folder binding and reauthenticate before resuming.\n${identity}\n`;
}
/** Why the page has nothing to show: a refusal the server explains, or a failed request. */
function Unavailable({ error }: { error: Error }) {
  const expected =
    error instanceof ApiClientError && ["forbidden", "unsupported"].includes(error.kind);
  if (!expected) return <SystemAlert className="break-words">{error.message}</SystemAlert>;
  return (
    <div data-slot="backups-unavailable" className="flex max-w-prose flex-col gap-2 text-sm">
      <p className="font-medium">Backups are not available here</p>
      <p className="text-muted-foreground">{error.message.replace(/\.?$/, ".")}</p>
    </div>
  );
}
/**
 * Owner page: `System > Backups`. The sheet's header carries the one health verdict and Back up
 * now; its tabs hold the schedule, the destinations, the kept backups and what a restore needs.
 * Every change asks for the owner's password first, for ten minutes at a time.
 */
export function BackupsPage() {
  const query = useBackups();
  const cache = useQueryClient();
  const [tab, setTab] = useState<Tab>("overview");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [unlocked, setUnlocked] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [challenge, setChallenge] = useState("");
  const [key, setKey] = useState("");
  const [schedule, setSchedule] = useState<BackupSchedule | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
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
  const health = data ? backupHealth(data, Date.now()) : null;
  const owner = { act, busy, unlocked };
  return (
    <SystemPage
      title="Backups"
      description="Protect configuration, activity and recovery files. Indexes and thumbnails can be rebuilt."
      lastUpdated={query.dataUpdatedAt ? new Date(query.dataUpdatedAt) : null}
      badges={
        health ? (
          <>
            <StatusBadge tone={health.tone}>{health.label}</StatusBadge>
            {unlocked ? (
              <StatusBadge>Unlocked</StatusBadge>
            ) : (
              <StatusBadge tone="off">Locked</StatusBadge>
            )}
            {health.rehearsed && <StatusBadge>Last rehearsal passed</StatusBadge>}
          </>
        ) : query.error ? (
          <StatusBadge tone="off">Unavailable</StatusBadge>
        ) : null
      }
      actions={
        data ? (
          <Button
            size="lg"
            disabled={busy || !unlocked || !data.keyConfirmed}
            onClick={() =>
              void act(() =>
                backupClient.create({
                  destinationIds: data.destinations.filter((d) => d.enabled).map((d) => d.id),
                  metadataOnly: false,
                }),
              )
            }
          >
            {busy && <LoaderCircle className="animate-spin" />}
            Back up now
          </Button>
        ) : null
      }
      footer={
        data ? (
          <>
            <p className="min-w-0 max-w-prose flex-[1_1_16rem] text-muted-foreground">
              A restore runs on a fresh fdrive installation and needs your recovery key and
              destination credentials. The files folder needs its own backup.
            </p>
            <Button variant="outline" size="lg" nativeButton={false} render={<a href="/restore" />}>
              Open restore
            </Button>
          </>
        ) : undefined
      }
    >
      <div className="contents max-md:[&_a[data-slot=button]]:min-h-11 max-md:[&_button]:min-h-11 max-md:[&_input:not([aria-hidden=true])]:min-h-11">
        {/* A failed action, or a failed refresh of a page that is already showing. */}
        {(error || (data && query.error)) && (
          <SystemAlert className="break-words">{error || query.error?.message}</SystemAlert>
        )}
        {query.isPending && <SystemLine role="status">Loading backups…</SystemLine>}
        {!data && query.error && <Unavailable error={query.error} />}
        {data && (
          <>
            {!unlocked && (
              <OwnerUnlock act={act} busy={busy} onUnlocked={() => setUnlocked(true)} />
            )}
            <SegmentedControl
              label="Backup sections"
              value={tab}
              options={TABS}
              labels={TAB_LABELS}
              onChange={setTab}
              // Four tabs fit one row on a phone once their side padding is tightened.
              className="max-md:[&>button]:px-2"
            />
            {tab === "overview" && (
              <>
                <BackupStatus data={data} />
                {selected && (
                  <SystemSection
                    title="Schedule and retention"
                    description="The default for every destination unless you give it its own schedule."
                  >
                    <form
                      onSubmit={(event) => {
                        event.preventDefault();
                        void act(() => backupClient.schedule(selected));
                      }}
                    >
                      <ScheduleFields value={selected} onChange={setSchedule} />
                      <SettingActions>
                        <Button
                          type="submit"
                          variant="outline"
                          disabled={busy || !unlocked || !data.keyConfirmed}
                        >
                          Save schedule
                        </Button>
                      </SettingActions>
                    </form>
                  </SystemSection>
                )}
              </>
            )}
            {tab === "destinations" && (
              <Destinations data={data} {...owner} confirm={setConfirmation} />
            )}
            {tab === "history" && <History data={data} {...owner} confirm={setConfirmation} />}
            {tab === "recovery" && (
              <>
                <SystemSection
                  title="Recovery key"
                  description="Keep this key somewhere independent of fdrive. It is required to decrypt your backups."
                >
                  {data.keyConfirmed && !rotating ? (
                    <SettingRow
                      label={
                        <span className="flex flex-wrap items-center gap-2">
                          Recovery key
                          <StatusBadge tone="success">Confirmed</StatusBadge>
                        </span>
                      }
                      description={<Code className="break-all text-xs">{data.recipient}</Code>}
                      align="end"
                    >
                      <Button
                        variant="outline"
                        disabled={busy || !unlocked}
                        onClick={() =>
                          setConfirmation({
                            title: "Rotate the recovery key?",
                            description:
                              "Create a new key for future backups. Keep every old recovery key until all backups using it have expired.",
                            confirm: "Rotate recovery key",
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
                        align="end"
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
                                recoveryKit(data, recipient, identity),
                                "fdrive-recovery-key.txt",
                              );
                              setChallenge(result.challenge);
                            })
                          }
                        >
                          Create and download recovery key
                        </Button>
                      </SettingRow>
                      {challenge && (
                        <FieldRow
                          label="Paste the saved recovery key to confirm"
                          description="Proves that the file you saved can decrypt your backups."
                        >
                          {(id) => (
                            <div className="flex flex-col items-end gap-2">
                              <Textarea
                                id={id}
                                value={key}
                                onChange={(event) => setKey(event.target.value)}
                                autoComplete="off"
                              />
                              <Button
                                variant="outline"
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
                <RestoreRehearsal data={data} {...owner} />
              </>
            )}
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
              <AlertDialogTitle>{confirmation?.title}</AlertDialogTitle>
              <AlertDialogDescription>{confirmation?.description}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                variant={confirmation?.destructive ? "destructive" : "default"}
                onClick={() => {
                  const action = confirmation?.action;
                  setConfirmation(null);
                  if (action) void act(action);
                }}
              >
                {confirmation?.confirm}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </SystemPage>
  );
}
