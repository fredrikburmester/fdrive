"use client";
import { type BackupRecoveryStatus, BackupRecoveryStatus as Status } from "@fdrive/contracts";
import { useCallback, useEffect, useId, useState } from "react";
import { DetailSheet } from "@/components/shell/list-sheet";
import { PageSection, SettingActions, SettingRow } from "@/components/shell/page-layout";
import { Code, FactList } from "@/components/shell/sheet-data";
import { StatusBadge } from "@/components/shell/status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { SystemAlert, SystemLine, SystemNote } from "./system-section";

/**
 * `/restore`: brings a backup into an empty installation. It is drawn outside the app shell,
 * since nobody can sign in yet, as one sheet that fills the page: connect with the host's
 * token, upload the archive, inspect it with the recovery key, then confirm the restore. The
 * step that comes next holds the sheet's one primary button.
 */
export function RecoveryPage() {
  const id = useId();
  const [token, setToken] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [key, setKey] = useState("");
  const [state, setState] = useState<BackupRecoveryStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const request = useCallback(
    async (path: string, body?: RequestInit["body"], json = false) => {
      const response = await fetch(`/api/v1/recovery/${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "x-fdrive-setup-token": token,
          "x-requested-with": "fdrive",
          ...(json ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body } : {}),
      });
      if (!response.ok)
        throw Error(
          response.status === 401
            ? "Enter the current recovery token from the host."
            : "Recovery request failed. Confirm the API is in restore mode and the destination database is empty.",
        );
      return response.json();
    },
    [token],
  );
  const refresh = async () => setState(Status.parse(await request("status")));
  useEffect(() => {
    if (!["inspecting", "restoring"].includes(state?.job?.state ?? "")) return;
    const timer = setInterval(() => {
      void request("status")
        .then((raw) => setState(Status.parse(raw)))
        .catch(() => setError("Recovery status unavailable. Check the host before retrying."));
    }, 2000);
    return () => clearInterval(timer);
  }, [state?.job?.state, request]);
  async function act(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await work();
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Recovery failed");
    } finally {
      setBusy(false);
    }
  }
  const job = state?.job;
  const preview = job?.preview;
  const working = ["inspecting", "restoring"].includes(job?.state ?? "");
  const staged = job?.state === "restored" || state?.paused === true;
  /** The step that comes next, whose button is the primary one. */
  const step = !state
    ? "connect"
    : job?.state === "ready"
      ? "apply"
      : job?.state === "uploaded"
        ? "inspect"
        : "upload";
  const variant = (own: typeof step) => (step === own ? "default" : "outline");
  return (
    <main className="flex min-h-svh flex-col bg-panel max-md:[&_button]:min-h-11 max-md:[&_input]:min-h-11">
      <DetailSheet
        title="Restore fdrive"
        lede="Recover configuration, activity and retained recovery files into an empty installation."
        badges={
          staged ? (
            <StatusBadge tone="success">Restore staged</StatusBadge>
          ) : state ? (
            <StatusBadge>Connected</StatusBadge>
          ) : (
            <StatusBadge tone="off">Not connected</StatusBadge>
          )
        }
        className="mx-auto w-full max-w-3xl md:border-l-0"
      >
        {(error || job?.error) && (
          <SystemAlert className="break-words">{error || job?.error}</SystemAlert>
        )}
        <PageSection
          title="Recovery server"
          description="Start the API with restore mode enabled and a new empty database. Use the host recovery token to continue. The files folder requires its own backup."
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void act(refresh);
            }}
          >
            <SettingRow
              label="Host recovery token"
              htmlFor={`${id}-token`}
              description="The FDRIVE_SETUP_TOKEN set on the host. It expires one hour after the API starts."
            >
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  id={`${id}-token`}
                  className="min-w-0 flex-1 basis-40"
                  type="password"
                  autoComplete="off"
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                  required
                />
                <Button type="submit" variant={variant("connect")} disabled={busy}>
                  Connect to recovery
                </Button>
              </div>
            </SettingRow>
          </form>
        </PageSection>
        {state && !staged && (
          <PageSection
            title="Backup"
            description="The archive is checked in full before anything is restored."
          >
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void act(async () => {
                  if (!file) throw Error("Choose an encrypted backup");
                  await request("archive", file);
                  setKey("");
                  setConfirmation("");
                });
              }}
            >
              <SettingRow
                label="Encrypted backup (.fdrive.age)"
                htmlFor={`${id}-archive`}
                description="The archive you downloaded from fdrive or fetched from a destination."
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    id={`${id}-archive`}
                    className="min-w-0 flex-1 basis-40"
                    type="file"
                    accept=".age"
                    onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                  />
                  <Button
                    type="submit"
                    variant={variant("upload")}
                    disabled={busy || !file || working}
                  >
                    Upload backup
                  </Button>
                </div>
              </SettingRow>
            </form>
            {job?.state === "uploaded" && (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void act(async () => {
                    await request("inspect", JSON.stringify({ key }), true);
                    setKey("");
                  });
                }}
              >
                <SettingRow
                  label="Recovery key from your saved kit"
                  htmlFor={`${id}-key`}
                  description="The trusted recovery server uses the key in memory to verify and restore this archive."
                >
                  <div className="flex flex-col items-end gap-2">
                    <Textarea
                      id={`${id}-key`}
                      value={key}
                      onChange={(event) => setKey(event.target.value)}
                      autoComplete="off"
                    />
                    <Button type="submit" variant={variant("inspect")} disabled={busy || !key}>
                      Inspect backup
                    </Button>
                  </div>
                </SettingRow>
              </form>
            )}
            {working && (
              <SystemLine role="status" className="border-border border-t py-4.5">
                {job?.state === "inspecting"
                  ? "Verifying every archive entry…"
                  : "Restoring into the empty database…"}
              </SystemLine>
            )}
          </PageSection>
        )}
        {preview && (
          <PageSection title="Recovery preview">
            <FactList
              facts={[
                { label: "Captured", value: new Date(preview.createdAt).toLocaleString() },
                {
                  label: "Database records",
                  value: Object.values(preview.tables)
                    .reduce((sum, count) => sum + count, 0)
                    .toLocaleString(),
                },
                { label: "Recovery files", value: preview.blobs.length.toLocaleString() },
                { label: "Snapshot ID", value: <Code>{preview.id}</Code> },
              ]}
            />
            {preview.coverage.length > 0 && (
              <SystemNote className="mt-4.5 text-warning">
                <p className="font-medium">Incomplete coverage</p>
                {preview.coverage.map((item) => (
                  <p className="[overflow-wrap:anywhere]" key={item}>
                    {item}
                  </p>
                ))}
              </SystemNote>
            )}
            {preview.dependencies.length > 0 && (
              <SystemNote className="mt-4.5">
                {preview.dependencies.map((item) => (
                  <p key={item}>{item}</p>
                ))}
              </SystemNote>
            )}
            {job?.state === "ready" && (
              <form
                className="mt-4.5"
                onSubmit={(event) => {
                  event.preventDefault();
                  void act(async () => {
                    await request("apply", JSON.stringify({ snapshotId: confirmation }), true);
                  });
                }}
              >
                <SettingRow
                  label="Paste the snapshot ID to confirm this restore"
                  htmlFor={`${id}-confirm`}
                  description="Providers, schedules and workers stay paused. Tokens are revoked. The restore never overwrites files in the files folder."
                >
                  <Input
                    id={`${id}-confirm`}
                    value={confirmation}
                    onChange={(event) => setConfirmation(event.target.value)}
                    autoComplete="off"
                  />
                </SettingRow>
                <SettingActions>
                  <Button
                    type="submit"
                    variant={variant("apply")}
                    disabled={busy || confirmation !== preview.id}
                  >
                    Restore into empty installation
                  </Button>
                </SettingActions>
              </form>
            )}
          </PageSection>
        )}
        {staged && (
          <PageSection title="Next steps">
            <SystemNote role="status" className="text-foreground">
              <p>
                Restore is staged. Use the host backup CLI to review endpoints and mounts and
                authenticate the owner before resuming. Recovery ZIPs remain available; old native
                operations stay quarantined.
              </p>
            </SystemNote>
          </PageSection>
        )}
      </DetailSheet>
    </main>
  );
}
