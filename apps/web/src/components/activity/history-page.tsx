"use client";

import {
  PersonalActivityAction,
  type PersonalActivityEvent,
  type PersonalActivityFilters,
  PersonalActivityOutcome,
  PersonalActivitySource,
} from "@fdrive/contracts";
import { baseName } from "@fdrive/core";
import { Clock3, File, FolderOpen, HelpCircle } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { accountItemHref, identityLabel, navigateAccountItem } from "@/lib/account/identities";
import { useIdentityActions } from "@/lib/account/use-identities";
import { activityFile, activityRequest } from "@/lib/activity/api";
import { activityLabels, activityPath, collapseActivity } from "@/lib/activity/history";
import { useActivityFile, useActivityHistory, useActivityLocations } from "@/lib/activity/queries";
import { useMe } from "@/lib/api/auth-queries";
import { EventMembers } from "./event-members";
import { JourneyDetails } from "./journey-details";

function HistoryFilter({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <Select value={value} items={options} onValueChange={(value) => onChange(value ?? "all")}>
      <SelectTrigger aria-label={label} className="min-h-11 w-full min-w-0">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
function ActivityRow({ event }: { event: PersonalActivityEvent }) {
  const { data: me } = useMe();
  const identities = useIdentityActions();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const path = activityPath(event);
  const Icon =
    event.class === "observation" ? HelpCircle : event.after?.kind === "dir" ? FolderOpen : File;
  async function open(kind: "file" | "reveal") {
    if (!event.fileId || !me) return;
    setBusy(true);
    try {
      const current = await activityFile(event.fileId);
      if (!current.currentPath)
        throw new Error("This file is unavailable. Its recorded journey is still here.");
      await navigateAccountItem(
        me,
        current.identityId,
        accountItemHref(
          kind === "file" && current.kind === "dir" ? "dir" : kind,
          current.currentPath,
        ),
        identities.switch,
        (href) => router.push(href as Route),
      );
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Could not open this file");
    } finally {
      setBusy(false);
    }
  }
  const available = me?.identities.some((identity) => identity.id === event.identityId) ?? false;
  return (
    <li className="flex min-w-0 gap-3 border-b border-border py-4 last:border-0">
      <div className="mt-1 flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted">
        <Icon className="size-4 text-muted-foreground" aria-hidden />
      </div>
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm font-medium">
            {activityLabels[event.action]}
            {event.count > 1 ? ` ${event.count} times` : ""}
          </span>
          <Badge
            variant={
              event.outcome === "failed" || event.outcome === "denied" ? "destructive" : "secondary"
            }
          >
            {event.provisional ? "Recent" : (event.outcome ?? "Started")}
          </Badge>
        </div>
        {path && <p className="break-all text-sm font-medium">{baseName(path) || "Home"}</p>}
        {path && <p className="break-all text-xs text-muted-foreground">{path}</p>}
        {event.before?.path && event.before.path !== path && (
          <p className="break-all text-xs text-muted-foreground">From {event.before.path}</p>
        )}
        <p className="flex flex-wrap gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <time dateTime={event.sortAt}>{new Date(event.sortAt).toLocaleString()}</time>
          <span>{identityLabel(me?.identities ?? [], event.identityId)}</span>
          <span>{event.source}</span>
        </p>
        {event.class === "observation" && (
          <p className="text-xs text-muted-foreground">
            Detected outside a confirmed fdrive action. Who made this change is unknown.
          </p>
        )}
        {event.action === "observation.resolved" && (
          <p className="text-xs text-muted-foreground">
            The location can be read again. Whether this is the earlier file remains unknown; its
            new journey is listed below.
          </p>
        )}
        {event.evidence === "client_reported" && (
          <p className="text-xs text-muted-foreground">Reported by your client</p>
        )}
        {event.fileId && (
          <div className="flex flex-wrap items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="min-h-11"
              disabled={busy || !available || identities.pending}
              onClick={() => void open("file")}
            >
              Open
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="min-h-11"
              disabled={busy || !available || identities.pending}
              onClick={() => void open("reveal")}
            >
              Show in folder
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="min-h-11"
              render={<Link href={`/activity/files/${event.fileId}` as Route} />}
              nativeButton={false}
            >
              File journey
            </Button>
          </div>
        )}
        {event.batchId && (
          <Link
            className="inline-flex min-h-11 items-center text-xs underline"
            href={`/activity/batches/${event.batchId}` as Route}
          >
            View batch
          </Link>
        )}
        <EventMembers event={event} />
        <details className="text-xs text-muted-foreground">
          <summary className="flex min-h-11 cursor-pointer items-center">Details</summary>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 rounded-lg bg-muted p-3">
            <dt>Evidence</dt>
            <dd className="break-words">{event.evidence.replaceAll("_", " ")}</dd>
            <dt>Recorded</dt>
            <dd>{new Date(event.recordedAt).toLocaleString()}</dd>
            {event.lastConfirmedAt && (
              <>
                <dt>Last confirmed</dt>
                <dd>{new Date(event.lastConfirmedAt).toLocaleString()}</dd>
              </>
            )}
            {event.after?.size !== undefined && (
              <>
                <dt>Size</dt>
                <dd>{event.after.size.toLocaleString()} bytes</dd>
              </>
            )}
            {event.errorCode && (
              <>
                <dt>Result</dt>
                <dd>{event.errorCode.replaceAll("_", " ")}</dd>
              </>
            )}
            {event.after?.trashLeaf && (
              <>
                <dt>Trash location</dt>
                <dd className="break-all">{event.after.trashLeaf}</dd>
              </>
            )}
            {(["before", "after"] as const).map((side) => {
              const facts = event[side];
              if (!facts) return null;
              const values = [
                facts.tags && `Tags: ${facts.tags.map((tag) => tag.name).join(", ") || "none"}`,
                facts.favorite !== undefined && `Favorite: ${facts.favorite ? "yes" : "no"}`,
                facts.view && `Folder view: ${facts.view}`,
                facts.permissions && `Share permissions: ${facts.permissions.join(", ")}`,
                facts.expiresAt !== undefined &&
                  `Share expiry: ${facts.expiresAt ? new Date(facts.expiresAt).toLocaleString() : "none"}`,
                facts.completedCount !== undefined && `Completed: ${facts.completedCount}`,
                facts.failedCount !== undefined && `Failed: ${facts.failedCount}`,
              ].filter(Boolean);
              if (!values.length) return null;
              return (
                <div className="col-span-2 space-y-1" key={side}>
                  <dt className="font-medium capitalize">{side}</dt>
                  <dd className="break-all">{values.join(" · ")}</dd>
                </div>
              );
            })}
            {event.firstAt && event.lastAt && (
              <>
                <dt>Time range</dt>
                <dd>
                  {new Date(event.firstAt).toLocaleTimeString()} –{" "}
                  {new Date(event.lastAt).toLocaleTimeString()}
                </dd>
              </>
            )}
          </dl>
        </details>
      </div>
    </li>
  );
}
export function HistoryPage({ fileId, batchId }: { fileId?: string; batchId?: string }) {
  const { data: me } = useMe();
  const locations = useActivityLocations();
  const [filters, setFilters] = useState<Partial<PersonalActivityFilters>>({});
  const [search, setSearch] = useState("");
  const history = useActivityHistory(
    filters,
    fileId ? `/files/${fileId}/events` : batchId ? `/batches/${batchId}/events` : "",
  );
  const [exporting, setExporting] = useState(false);
  const [exportUrl, setExportUrl] = useState<string | null>(null);
  async function exportHistory(format: "json" | "csv") {
    setExporting(true);
    setExportUrl(null);
    try {
      const value = (await activityRequest("/exports", {
        method: "POST",
        body: JSON.stringify({
          format,
          filters: { ...filters, ...(fileId ? { fileId } : {}), ...(batchId ? { batchId } : {}) },
        }),
      })) as { id: string };
      setExportUrl(`/api/v1/activity/exports/${encodeURIComponent(value.id)}/download`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not create export");
    } finally {
      setExporting(false);
    }
  }
  const first = history.data?.pages[0];
  const events = collapseActivity(
    history.data?.pages.flatMap((page) => [...page.provisionalReads, ...page.items]) ?? [],
  );
  function filter(key: "identityId" | "action" | "source" | "outcome", value: string) {
    setFilters((previous) => ({ ...previous, [key]: value === "all" ? undefined : value }));
  }
  return (
    <>
      <PageHeader
        breadcrumbs={
          <span className="truncate font-medium">{fileId ? "File journey" : "My activity"}</span>
        }
      />
      <main className="mx-auto w-full max-w-4xl space-y-5 p-4 sm:p-6" data-slot="personal-activity">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {fileId ? "File journey" : "My activity"}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Your actions across your connected storage.
          </p>
        </div>
        {fileId && <JourneySummary fileId={fileId} />}
        {fileId && <JourneyDetails fileId={fileId} />}
        {batchId && <p className="text-sm text-muted-foreground">Actions from this batch</p>}
        {first?.batchSummary && (
          <p className="text-sm">
            {first.batchSummary.total} operations ·{" "}
            {Object.entries(first.batchSummary.outcomes)
              .map(([outcome, count]) => `${count} ${outcome}`)
              .join(" · ")}
          </p>
        )}
        <form
          className="flex min-w-0 gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            setFilters((prior) => ({ ...prior, q: search }));
          }}
        >
          <Input
            aria-label="Search activity by name or path"
            placeholder="Search names and past locations…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="min-h-11 min-w-0"
          />
          <Button type="submit" variant="secondary" className="min-h-11">
            Search
          </Button>
        </form>
        <details className="rounded-xl border px-3">
          <summary className="flex min-h-11 cursor-pointer items-center text-sm">Filters</summary>
          <div className="grid grid-cols-1 gap-2 min-[380px]:grid-cols-2 sm:grid-cols-4">
            <HistoryFilter
              label="Storage location"
              value={filters.identityId ?? "all"}
              onChange={(value) => filter("identityId", value)}
              options={[
                { value: "all", label: "All locations" },
                ...(me?.identities ?? []).map((identity) => ({
                  value: identity.id,
                  label: identityLabel(me?.identities ?? [], identity.id),
                })),
                ...(locations.data ?? [])
                  .filter(
                    (location) =>
                      !me?.identities.some((identity) => identity.id === location.identityId),
                  )
                  .map((location) => ({
                    value: location.identityId,
                    label: `${location.label} (disconnected)`,
                  })),
              ]}
            />
            <HistoryFilter
              label="Action"
              value={filters.action ?? "all"}
              onChange={(value) => filter("action", value)}
              options={[
                { value: "all", label: "All actions" },
                ...PersonalActivityAction.options.map((action) => ({
                  value: action,
                  label: activityLabels[action],
                })),
              ]}
            />
            <HistoryFilter
              label="Source"
              value={filters.source ?? "all"}
              onChange={(value) => filter("source", value)}
              options={[
                { value: "all", label: "All clients" },
                ...PersonalActivitySource.options.map((source) => ({
                  value: source,
                  label: source,
                })),
              ]}
            />
            <HistoryFilter
              label="Outcome"
              value={filters.outcome ?? "all"}
              onChange={(value) => filter("outcome", value)}
              options={[
                { value: "all", label: "All outcomes" },
                ...PersonalActivityOutcome.options.map((outcome) => ({
                  value: outcome,
                  label: outcome,
                })),
              ]}
            />
          </div>
          <div className="mt-3 mb-3 flex flex-wrap items-end gap-3">
            <label htmlFor="activity-from" className="min-w-0 flex-1 text-xs text-muted-foreground">
              From
              <Input
                type="date"
                id="activity-from"
                aria-label="Activity from date"
                className="mt-1 min-h-11"
                onChange={(event) =>
                  setFilters((prior) => ({
                    ...prior,
                    from: event.target.value
                      ? new Date(`${event.target.value}T00:00:00`).toISOString()
                      : undefined,
                  }))
                }
              />
            </label>
            <label
              htmlFor="activity-through"
              className="min-w-0 flex-1 text-xs text-muted-foreground"
            >
              Through
              <Input
                type="date"
                id="activity-through"
                aria-label="Activity through date"
                className="mt-1 min-h-11"
                onChange={(event) =>
                  setFilters((prior) => ({
                    ...prior,
                    to: event.target.value
                      ? new Date(`${event.target.value}T23:59:59.999`).toISOString()
                      : undefined,
                  }))
                }
              />
            </label>
          </div>
        </details>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            className="min-h-11"
            disabled={exporting}
            onClick={() => void exportHistory("json")}
          >
            Export JSON
          </Button>
          <Button
            variant="outline"
            className="min-h-11"
            disabled={exporting}
            onClick={() => void exportHistory("csv")}
          >
            Export CSV
          </Button>
          {exportUrl && (
            <a href={exportUrl} className="inline-flex min-h-11 items-center text-sm underline">
              Download export
            </a>
          )}
        </div>
        {history.isPending && (
          <p role="status" className="text-sm text-muted-foreground">
            Loading your activity…
          </p>
        )}
        {history.isError && (
          <div role="alert" className="text-sm text-destructive">
            {history.error.message}
            <Button
              variant="ghost"
              className="ml-2 min-h-11"
              onClick={() => void history.refetch()}
            >
              Retry
            </Button>
          </div>
        )}
        {!history.isPending && !history.isError && !events.length && (
          <div className="rounded-xl border border-dashed p-8 text-center">
            <Clock3 className="mx-auto mb-3 size-6 text-muted-foreground" />
            <p className="font-medium">No activity here yet</p>
            <p className="mt-1 text-sm text-muted-foreground">
              New actions will appear here. Earlier Recents have no verified author and are not
              imported.
            </p>
          </div>
        )}
        <ol>
          {events.map((event) => (
            <ActivityRow key={event.id} event={event} />
          ))}
        </ol>
        {history.hasNextPage && (
          <Button
            className="min-h-11 w-full"
            variant="outline"
            disabled={history.isFetchingNextPage}
            onClick={() => void history.fetchNextPage()}
          >
            {history.isFetchingNextPage ? "Loading…" : "Load more"}
          </Button>
        )}
        {first?.historyStartsAt && (
          <p className="text-xs text-muted-foreground">
            History starts {new Date(first.historyStartsAt).toLocaleDateString()}.{" "}
            {first.retainedFrom
              ? `Retained from ${new Date(first.retainedFrom).toLocaleDateString()}.`
              : "Journey metadata is kept without an automatic cutoff."}
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          {first?.coverage.observations === "watcher_and_refresh"
            ? "Changes made outside fdrive appear when the storage watcher or a refresh detects them."
            : first?.coverage.observations === "refresh"
              ? "This storage has no watcher, so changes made outside fdrive appear only when a refresh detects them."
              : "Changes made outside fdrive are not detected here."}{" "}
          Watcher gaps, unavailable storage and cached native opens can leave gaps in the journey.
        </p>
      </main>
    </>
  );
}
function JourneySummary({ fileId }: { fileId: string }) {
  const summary = useActivityFile(fileId);
  const [checking, setChecking] = useState(false);
  async function recheck() {
    setChecking(true);
    try {
      const result = (await activityRequest(`/files/${fileId}/recheck`, { method: "POST" })) as {
        checked: boolean;
      };
      if (!result.checked) toast.error("Could not check this location right now");
      await summary.refetch();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not recheck file");
    } finally {
      setChecking(false);
    }
  }
  if (summary.isPending) return <p role="status">Finding the current location…</p>;
  if (summary.isError) return <p role="alert">{summary.error.message}</p>;
  const file = summary.data;
  return (
    <div className="rounded-xl border bg-muted/30 p-4">
      <div className="flex flex-wrap justify-between gap-2">
        <h2 className="break-all font-medium">{baseName(file.lastKnownPath)}</h2>
        <Badge variant="secondary">{file.availability}</Badge>
      </div>
      <p className="mt-2 break-all text-sm text-muted-foreground">
        {file.currentPath ?? file.lastKnownPath}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        {file.label && `${file.label} · `}Revision records describe changes; earlier file contents
        are not stored.
      </p>
      <Button
        variant="ghost"
        className="mt-2 min-h-11"
        disabled={checking}
        onClick={() => void recheck()}
      >
        {checking ? "Checking…" : "Recheck location"}
      </Button>
    </div>
  );
}
