"use client";
import { type BackupRecoveryStatus, BackupRecoveryStatus as Status } from "@fdrive/contracts";
import { useCallback, useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

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
  return (
    <main className="max-sm:[&_button]:min-h-11 max-sm:[&_input]:min-h-11 mx-auto min-h-screen w-full max-w-3xl space-y-8 px-4 py-10 sm:px-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">Restore fdrive</h1>
        <p className="text-muted-foreground">
          Recover configuration, activity and retained recovery files into an empty installation.
        </p>
      </header>
      <p className="rounded-lg border p-4 text-sm">
        Start the API with restore mode enabled and a new empty database. Use the host recovery
        token to continue. Original files and live fileserver configuration require separate
        backups.
      </p>
      {(error || job?.error) && (
        <p role="alert" className="break-words text-sm text-destructive">
          {error || job?.error}
        </p>
      )}
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          void act(refresh);
        }}
      >
        <Label htmlFor={`${id}-token`}>Host recovery token</Label>
        <Input
          id={`${id}-token`}
          type="password"
          autoComplete="off"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          required
        />
        <Button type="submit" disabled={busy}>
          Connect to recovery
        </Button>
      </form>
      {state && !state.paused && job?.state !== "restored" && (
        <section className="space-y-5 rounded-lg border p-4">
          <form
            className="space-y-3"
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
            <Label htmlFor={`${id}-archive`}>Encrypted backup (.fdrive.age)</Label>
            <Input
              id={`${id}-archive`}
              type="file"
              accept=".age"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
            <Button
              type="submit"
              disabled={busy || !file || ["inspecting", "restoring"].includes(job?.state ?? "")}
            >
              Upload backup
            </Button>
          </form>
          {job?.state === "uploaded" && (
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                void act(async () => {
                  await request("inspect", JSON.stringify({ key }), true);
                  setKey("");
                });
              }}
            >
              <Label htmlFor={`${id}-key`}>Recovery key from your saved kit</Label>
              <Textarea
                id={`${id}-key`}
                value={key}
                onChange={(event) => setKey(event.target.value)}
                autoComplete="off"
              />
              <p className="text-xs text-muted-foreground">
                The trusted recovery server uses the key in memory to verify and restore this
                archive.
              </p>
              <Button type="submit" disabled={busy || !key}>
                Inspect backup
              </Button>
            </form>
          )}
          {["inspecting", "restoring"].includes(job?.state ?? "") && (
            <p role="status">
              {job?.state === "inspecting"
                ? "Verifying every archive entry…"
                : "Restoring into the empty database…"}
            </p>
          )}
        </section>
      )}
      {preview && (
        <section className="min-w-0 space-y-3">
          <h2 className="text-lg font-medium">Recovery preview</h2>
          <p className="text-sm">
            Captured {new Date(preview.createdAt).toLocaleString()} ·{" "}
            {Object.values(preview.tables)
              .reduce((sum, count) => sum + count, 0)
              .toLocaleString()}{" "}
            database records · {preview.blobs.length.toLocaleString()} recovery files
          </p>
          <p className="break-all font-mono text-xs">{preview.id}</p>
          {preview.coverage.length > 0 && (
            <div className="rounded-lg border p-3">
              <p className="font-medium">Incomplete coverage</p>
              {preview.coverage.map((item) => (
                <p className="break-words text-sm" key={item}>
                  {item}
                </p>
              ))}
            </div>
          )}
          {preview.dependencies.map((item) => (
            <p key={item} className="text-sm text-muted-foreground">
              {item}
            </p>
          ))}
          {job?.state === "ready" && (
            <form
              className="space-y-3 border-t pt-4"
              onSubmit={(event) => {
                event.preventDefault();
                void act(async () => {
                  await request("apply", JSON.stringify({ snapshotId: confirmation }), true);
                });
              }}
            >
              <p className="text-sm">
                Providers, schedules and workers stay paused. Tokens are revoked. The restore never
                overwrites live files on your fileserver.
              </p>
              <Label htmlFor={`${id}-confirm`}>Paste the snapshot ID to confirm this restore</Label>
              <Input
                id={`${id}-confirm`}
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                autoComplete="off"
              />
              <Button type="submit" disabled={busy || confirmation !== preview.id}>
                Restore into empty installation
              </Button>
            </form>
          )}
        </section>
      )}
      {(job?.state === "restored" || state?.paused) && (
        <p role="status" className="rounded-lg border p-4">
          Restore is staged. Use the host backup CLI to review endpoints and mounts and authenticate
          the owner before resuming. Recovery ZIPs remain available; old native operations stay
          quarantined.
        </p>
      )}
    </main>
  );
}
