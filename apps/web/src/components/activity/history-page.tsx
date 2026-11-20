"use client";

import {
  PersonalActivityAction,
  type PersonalActivityEvent,
  type PersonalActivityFilters,
  PersonalActivityOutcome,
  PersonalActivitySource,
} from "@fdrive/contracts";
import { baseName, extensionOf } from "@fdrive/core";
import { cn } from "cn";
import { ChevronRightIcon, Clock3, HelpCircle, ListFilterIcon } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, type ReactNode, useId, useState } from "react";
import { toast } from "sonner";
import { FileIcon } from "@/components/files/file-icon";
import { PageHeader } from "@/components/shell/page-header";
import {
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeader,
  DataTableRow,
  PageBar,
  PageBody,
  PageEmpty,
  PageSection,
} from "@/components/shell/page-layout";
import { PHONE_TARGET, RowsSkeleton, TruncatedCell } from "@/components/shell/page-rows";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useIsMobile } from "@/hooks/use-mobile";
import { activityFile, activityRequest } from "@/lib/activity/api";
import { activityLabels, activityPath, collapseActivity } from "@/lib/activity/history";
import { useActivityFile, useActivityHistory } from "@/lib/activity/queries";
import { useMe } from "@/lib/api/auth-queries";
import { pathToHref, viewHref } from "@/lib/files/path-url";
import { formatTime } from "@/lib/format";
import { revealHref } from "@/lib/search/reveal";
import { useFormatters } from "@/lib/use-format-preferences";
import { EventMembers } from "./event-members";
import {
  activityFailed,
  activityFolder,
  activityItemName,
  activityOrigin,
  activityResult,
  eventCountLabel,
  groupByDay,
} from "./history-rows";
import { JourneyDetails } from "./journey-details";

/** A link to another activity page, drawn like the buttons beside it. */
const PAGE_LINK = cn(buttonVariants({ variant: "outline", size: "sm" }), PHONE_TARGET);

/**
 * The columns a narrow page drops, by the page's own width (`PageBody` is a size container):
 * the result first shows from `@xl`, the location from `@2xl`, the client from `@4xl`.
 */
const OPTIONAL_COLUMN = {
  location: "hidden @2xl:table-cell",
  client: "hidden @4xl:table-cell",
  result: "hidden @xl:table-cell",
} as const;

/**
 * Empty cells under the optional columns, for a row whose one cell spans the columns that always
 * show. CSS hides the optional ones, so a `colSpan` over all seven would add columns to a narrow
 * table; spanning four and filling the rest keeps the row reaching the table's edge.
 */
function OptionalColumnFillers() {
  return (
    <>
      <td className={OPTIONAL_COLUMN.location} />
      <td className={OPTIONAL_COLUMN.client} />
      <td className={OPTIONAL_COLUMN.result} />
    </>
  );
}

/** A filter control on a phone: a full-width 44px tap target; compact from `md` up. */
const FILTER_CONTROL = "max-md:min-h-11 max-md:w-full md:h-7";

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
      <SelectTrigger aria-label={label} size="sm" className={cn("min-w-0", FILTER_CONTROL)}>
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

/** What an observation leaves uncertain, shown in the row itself so it is never a click away. */
function uncertaintyNotes(event: PersonalActivityEvent): string[] {
  const notes: string[] = [];
  if (event.class === "observation") {
    notes.push("Detected outside a confirmed fdrive action. Who made this change is unknown.");
  }
  if (event.action === "observation.resolved") {
    notes.push(
      "The location can be read again. Whether this is the earlier file remains unknown; its new journey is under Files involved in the details.",
    );
  }
  return notes;
}

/** The recorded facts of one event, as the label and value pairs of its details. */
function eventFacts(event: PersonalActivityEvent, path: string | null): [string, ReactNode][] {
  const facts: [string, ReactNode][] = [];
  if (path) facts.push(["Path", path]);
  if (event.before?.path && event.before.path !== path) facts.push(["From", event.before.path]);
  facts.push(["When", new Date(event.sortAt).toLocaleString()]);
  facts.push(["Client", event.source]);
  facts.push(["Evidence", event.evidence.replaceAll("_", " ")]);
  facts.push(["Recorded", new Date(event.recordedAt).toLocaleString()]);
  if (event.lastConfirmedAt) {
    facts.push(["Last confirmed", new Date(event.lastConfirmedAt).toLocaleString()]);
  }
  if (event.after?.size !== undefined) {
    facts.push(["Size", `${event.after.size.toLocaleString()} bytes`]);
  }
  if (event.errorCode) facts.push(["Result", event.errorCode.replaceAll("_", " ")]);
  if (event.after?.trashLeaf) facts.push(["Trash location", event.after.trashLeaf]);
  for (const side of ["before", "after"] as const) {
    const recorded = event[side];
    if (!recorded) continue;
    const values = [
      recorded.tags && `Tags: ${recorded.tags.map((tag) => tag.name).join(", ") || "none"}`,
      recorded.favorite !== undefined && `Favorite: ${recorded.favorite ? "yes" : "no"}`,
      recorded.view && `Folder view: ${recorded.view}`,
      recorded.permissions && `Share permissions: ${recorded.permissions.join(", ")}`,
      recorded.expiresAt !== undefined &&
        `Share expiry: ${recorded.expiresAt ? new Date(recorded.expiresAt).toLocaleString() : "none"}`,
      recorded.completedCount !== undefined && `Completed: ${recorded.completedCount}`,
      recorded.failedCount !== undefined && `Failed: ${recorded.failedCount}`,
    ].filter(Boolean);
    if (values.length) facts.push([side === "before" ? "Before" : "After", values.join(" · ")]);
  }
  if (event.firstAt && event.lastAt) {
    facts.push([
      "Time range",
      `${new Date(event.firstAt).toLocaleTimeString()} – ${new Date(event.lastAt).toLocaleTimeString()}`,
    ]);
  }
  return facts;
}

/**
 * One event as a table row: when, what happened, the item and where it is, the client and the
 * result. The chevron opens a second row with everything recorded about it and the ways on:
 * open the file, show it in its folder, its journey, and its batch.
 */
function ActivityRows({
  event,
  mobile,
  columns,
  journeyFileId,
}: {
  event: PersonalActivityEvent;
  mobile: boolean;
  /** How many columns always show, for the details row to span. */
  columns: number;
  /** The file whose journey this page shows, which needs no link to itself. */
  journeyFileId: string | undefined;
}) {
  const { data: me } = useMe();
  const { prefs } = useFormatters();
  const router = useRouter();
  const detailsId = useId();
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const path = activityPath(event);
  const name = path ? activityItemName(path) : null;
  const folder = path ? activityFolder(path) : null;
  const origin = path ? activityOrigin(event, path) : null;
  const action = `${activityLabels[event.action]}${event.count > 1 ? ` ${event.count} times` : ""}`;
  const when = new Date(event.sortAt);
  const time = (
    <time dateTime={event.sortAt} title={when.toLocaleString()} className="tabular-nums">
      {formatTime(when, prefs.clock)}
    </time>
  );
  const result = activityResult(event);
  const failed = activityFailed(event);
  const notes = uncertaintyNotes(event);
  async function open(kind: "file" | "reveal") {
    if (!event.fileId) return;
    setBusy(true);
    try {
      const current = await activityFile(event.fileId);
      const path = current.currentPath;
      if (!path) throw new Error("This file is unavailable. Its recorded journey is still here.");
      router.push(
        (kind === "reveal"
          ? revealHref(path)
          : current.kind === "dir"
            ? pathToHref(path)
            : viewHref(path)) as Route,
      );
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Could not open this file");
    } finally {
      setBusy(false);
    }
  }
  // History outlives the login that recorded it; only the signed-in login's files can open.
  const available = event.identityId === me?.identity.id;
  const canOpen = event.fileId !== null && available && !busy;
  const kind = event.after?.kind ?? event.before?.kind ?? "file";
  const icon =
    event.class === "observation" ? (
      <HelpCircle className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
    ) : name === null ? null : (
      <FileIcon kind={kind} ext={kind === "dir" ? "" : extensionOf(name)} mime={null} />
    );
  const toggle = (
    <button
      type="button"
      aria-expanded={expanded}
      aria-controls={expanded ? detailsId : undefined}
      aria-label={`Details for ${action}${name ? ` ${name}` : ""}`}
      onClick={() => setExpanded((open) => !open)}
      className="relative flex size-4 items-center justify-center rounded-sm text-muted-foreground outline-none after:absolute after:-inset-2.5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >
      <ChevronRightIcon
        aria-hidden="true"
        className={cn("size-3.5 transition-transform", expanded && "rotate-90")}
      />
    </button>
  );
  const noteLines = notes.map((note) => (
    <p key={note} className="whitespace-normal text-muted-foreground text-xs">
      {note}
    </p>
  ));
  // A row with notes is taller than its neighbors, so its cells line up along their first line.
  const top = notes.length > 0 ? "py-2 align-top" : undefined;
  return (
    <>
      <DataTableRow
        data-slot="activity-row"
        data-state={expanded ? "selected" : undefined}
        className={cn("data-[state=selected]:bg-muted/40", mobile && "h-14")}
      >
        <DataTableCell className={top}>
          <div className="flex h-5 items-center">{toggle}</div>
        </DataTableCell>
        {mobile ? (
          <DataTableCell className={top}>
            <div className="flex min-w-0 flex-col gap-0.5">
              <div className="flex min-w-0 items-baseline gap-1.5 text-[15px] leading-5">
                <span className="shrink-0 font-medium">{action}</span>
                {name && <span className="truncate">{name}</span>}
              </div>
              <div className="flex min-w-0 items-center gap-1 text-muted-foreground text-xs leading-4">
                {time}
                {folder && <span className="truncate">· {folder}</span>}
                {result !== "success" && (
                  <span className={cn("shrink-0", failed && "font-medium text-destructive")}>
                    · {result}
                  </span>
                )}
              </div>
              {noteLines}
            </div>
          </DataTableCell>
        ) : (
          <>
            <DataTableCell className={cn("text-muted-foreground text-xs leading-5", top)}>
              {time}
            </DataTableCell>
            <TruncatedCell title={action} className={top}>
              <span>{action}</span>
            </TruncatedCell>
            <DataTableCell className={top}>
              <div className="flex min-w-0 items-center gap-2">
                {icon}
                {name === null ? (
                  <span className="text-muted-foreground">--</span>
                ) : canOpen ? (
                  <button
                    type="button"
                    title="Open"
                    onClick={() => void open("file")}
                    className="min-w-0 truncate rounded-sm text-left outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {name}
                  </button>
                ) : (
                  <span className="min-w-0 truncate" title={name}>
                    {name}
                  </span>
                )}
                {origin && (
                  <span
                    className="min-w-0 shrink-[2] truncate text-muted-foreground text-xs"
                    title={event.before?.path}
                  >
                    from {origin}
                  </span>
                )}
              </div>
              {noteLines}
            </DataTableCell>
            <TruncatedCell
              className={cn(
                "text-muted-foreground text-xs leading-5",
                OPTIONAL_COLUMN.location,
                top,
              )}
            >
              {folder === null ? (
                "--"
              ) : canOpen ? (
                <button
                  type="button"
                  title="Show in folder"
                  onClick={() => void open("reveal")}
                  className="max-w-full truncate rounded-sm align-bottom outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {folder}
                </button>
              ) : (
                <span title={folder}>{folder}</span>
              )}
            </TruncatedCell>
            <TruncatedCell
              className={cn("text-muted-foreground text-xs leading-5", OPTIONAL_COLUMN.client, top)}
            >
              {event.source}
            </TruncatedCell>
            <TruncatedCell
              className={cn(
                "text-muted-foreground text-xs leading-5",
                OPTIONAL_COLUMN.result,
                failed && "font-medium text-destructive",
                top,
              )}
            >
              {result}
            </TruncatedCell>
          </>
        )}
      </DataTableRow>
      {expanded && (
        <DataTableRow
          id={detailsId}
          data-slot="activity-details"
          className="bg-muted/20 hover:bg-muted/20"
        >
          <DataTableCell colSpan={columns} className="whitespace-normal py-3">
            <div className="flex min-w-0 flex-col gap-3 pl-7.5 text-xs">
              {(event.fileId || event.batchId) && (
                <div className="flex flex-wrap items-center gap-1.5">
                  {event.fileId && (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        className={PHONE_TARGET}
                        disabled={!canOpen}
                        onClick={() => void open("file")}
                      >
                        Open
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className={PHONE_TARGET}
                        disabled={!canOpen}
                        onClick={() => void open("reveal")}
                      >
                        Show in folder
                      </Button>
                      {event.fileId !== journeyFileId && (
                        <Link
                          href={`/activity/files/${event.fileId}` as Route}
                          className={PAGE_LINK}
                        >
                          File journey
                        </Link>
                      )}
                    </>
                  )}
                  {event.batchId && (
                    <Link
                      href={`/activity/batches/${event.batchId}` as Route}
                      className={PAGE_LINK}
                    >
                      View batch
                    </Link>
                  )}
                </div>
              )}
              {event.evidence === "client_reported" && (
                <p className="text-muted-foreground">Reported by your client</p>
              )}
              <EventMembers event={event} />
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-1">
                {eventFacts(event, path).map(([label, value]) => (
                  <Fragment key={label}>
                    <dt className="text-muted-foreground">{label}</dt>
                    <dd className="break-all">{value}</dd>
                  </Fragment>
                ))}
              </dl>
            </div>
          </DataTableCell>
          {!mobile && <OptionalColumnFillers />}
        </DataTableRow>
      )}
    </>
  );
}

type FilterKey = "action" | "source" | "outcome";

export function HistoryPage({ fileId, batchId }: { fileId?: string; batchId?: string }) {
  const mobile = useIsMobile();
  const [filters, setFilters] = useState<Partial<PersonalActivityFilters>>({});
  const [search, setSearch] = useState("");
  const [dates, setDates] = useState({ from: "", to: "" });
  const [filtersOpen, setFiltersOpen] = useState(false);
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
  const days = groupByDay(events);
  function filter(key: FilterKey, value: string) {
    setFilters((previous) => ({ ...previous, [key]: value === "all" ? undefined : value }));
  }
  /** `from` starts its day and `to` ends it, both in the browser's time zone. */
  function filterDate(key: "from" | "to", value: string) {
    setDates((previous) => ({ ...previous, [key]: value }));
    const time = key === "from" ? "T00:00:00" : "T23:59:59.999";
    setFilters((previous) => ({
      ...previous,
      [key]: value ? new Date(`${value}${time}`).toISOString() : undefined,
    }));
  }
  function clearFilters() {
    setDates({ from: "", to: "" });
    setFilters((previous) => (previous.q === undefined ? {} : { q: previous.q }));
  }
  const activeFilters = [
    filters.action,
    filters.source,
    filters.outcome,
    filters.from,
    filters.to,
  ].filter((value) => value !== undefined).length;
  const title = fileId ? "File journey" : batchId ? "Batch" : "My activity";
  // The columns that always show: the chevron and one of folded text on a phone; the chevron,
  // time, action and item from `md` up. Group and details rows span these.
  const columns = mobile ? 2 : 4;
  return (
    <>
      <PageHeader
        breadcrumbs={
          <div className="flex min-w-0 items-center gap-1.5 text-sm">
            {(fileId || batchId) && (
              <>
                <Link
                  href="/activity"
                  className="shrink-0 rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                >
                  My activity
                </Link>
                <span aria-hidden="true" className="text-muted-foreground">
                  /
                </span>
              </>
            )}
            <h1 className="truncate font-medium">{title}</h1>
          </div>
        }
      />
      <PageBody>
        {/* `PageBody` is a size container: the table drops its least important columns when narrow. */}
        <div data-slot="personal-activity" className="flex min-w-0 flex-1 flex-col">
          {fileId && <JourneySummary fileId={fileId} />}
          {fileId && <JourneyDetails fileId={fileId} />}
          <PageBar>
            {history.data !== undefined && (
              <span className="text-foreground">
                {eventCountLabel(events.length, history.hasNextPage)}
              </span>
            )}
            {batchId && <span>Actions from this batch</span>}
            {first?.batchSummary && (
              <span>
                {first.batchSummary.total} operations ·{" "}
                {Object.entries(first.batchSummary.outcomes)
                  .map(([outcome, count]) => `${count} ${outcome}`)
                  .join(" · ")}
              </span>
            )}
            <form
              className="flex min-w-0 items-center gap-1.5 max-md:w-full"
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
                className="min-w-0 max-md:min-h-11 max-md:flex-1 md:h-7 md:w-64"
              />
              <Button type="submit" variant="secondary" size="sm" className={PHONE_TARGET}>
                Search
              </Button>
              {mobile && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className={PHONE_TARGET}
                  aria-expanded={filtersOpen}
                  onClick={() => setFiltersOpen((open) => !open)}
                >
                  <ListFilterIcon aria-hidden="true" />
                  {activeFilters > 0 ? `Filters (${activeFilters})` : "Filters"}
                </Button>
              )}
            </form>
            {/* Its own line on a phone, right-aligned from `md` up. */}
            <div className="flex max-w-full flex-wrap items-center gap-1.5 md:ml-auto">
              {exportUrl && (
                <a
                  href={exportUrl}
                  className={cn("inline-flex items-center px-1 underline", PHONE_TARGET)}
                >
                  Download export
                </a>
              )}
              <Button
                variant="outline"
                size="sm"
                className={PHONE_TARGET}
                disabled={exporting}
                onClick={() => void exportHistory("json")}
              >
                Export JSON
              </Button>
              <Button
                variant="outline"
                size="sm"
                className={PHONE_TARGET}
                disabled={exporting}
                onClick={() => void exportHistory("csv")}
              >
                Export CSV
              </Button>
            </div>
          </PageBar>
          {(!mobile || filtersOpen) && (
            <PageBar data-slot="activity-filters">
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
              <label
                htmlFor="activity-from"
                className="flex min-w-0 items-center gap-1.5 max-md:w-full"
              >
                <span className="max-md:w-16">From</span>
                <Input
                  type="date"
                  id="activity-from"
                  aria-label="Activity from date"
                  value={dates.from}
                  className={cn("min-w-0 md:w-36", FILTER_CONTROL)}
                  onChange={(event) => filterDate("from", event.target.value)}
                />
              </label>
              <label
                htmlFor="activity-through"
                className="flex min-w-0 items-center gap-1.5 max-md:w-full"
              >
                <span className="max-md:w-16">Through</span>
                <Input
                  type="date"
                  id="activity-through"
                  aria-label="Activity through date"
                  value={dates.to}
                  className={cn("min-w-0 md:w-36", FILTER_CONTROL)}
                  onChange={(event) => filterDate("to", event.target.value)}
                />
              </label>
              {activeFilters > 0 && (
                <Button variant="ghost" size="sm" className={PHONE_TARGET} onClick={clearFilters}>
                  Clear filters
                </Button>
              )}
            </PageBar>
          )}
          {history.isPending && <RowsSkeleton label="Loading your activity…" />}
          {history.isError && (
            <div
              role="alert"
              className="flex flex-wrap items-center gap-2 border-border/60 border-b px-3 py-2 text-destructive text-sm"
            >
              {history.error.message}
              <Button
                variant="outline"
                size="sm"
                className={PHONE_TARGET}
                onClick={() => void history.refetch()}
              >
                Retry
              </Button>
            </div>
          )}
          {!history.isPending && !history.isError && !events.length && (
            <PageEmpty
              icon={Clock3}
              title="No activity here yet"
              description="New actions will appear here. Earlier Recents have no verified author and are not imported."
            />
          )}
          {events.length > 0 && (
            <DataTable className="table-fixed">
              <DataTableHeader>
                <DataTableRow>
                  <DataTableHead className="w-9">
                    <span className="sr-only">Details</span>
                  </DataTableHead>
                  {mobile ? (
                    <DataTableHead>Activity</DataTableHead>
                  ) : (
                    <>
                      <DataTableHead className="w-16">Time</DataTableHead>
                      <DataTableHead className="w-48">Action</DataTableHead>
                      <DataTableHead>Item</DataTableHead>
                      <DataTableHead className={cn("w-[24%]", OPTIONAL_COLUMN.location)}>
                        Location
                      </DataTableHead>
                      <DataTableHead className={cn("w-20", OPTIONAL_COLUMN.client)}>
                        Client
                      </DataTableHead>
                      <DataTableHead className={cn("w-24", OPTIONAL_COLUMN.result)}>
                        Result
                      </DataTableHead>
                    </>
                  )}
                </DataTableRow>
              </DataTableHeader>
              <DataTableBody>
                {days.map((day) => (
                  <Fragment key={day.key}>
                    {/* `DataTableGroupRow` by hand, to end in the fillers a narrow table needs. */}
                    <tr
                      data-slot="table-group-row"
                      className="border-border/60 border-b bg-muted/40"
                    >
                      <th
                        colSpan={columns}
                        scope="colgroup"
                        className="h-8 px-3 text-left align-middle font-medium text-muted-foreground text-xs"
                      >
                        {day.label}
                        <span className="ml-2 font-normal tabular-nums">{day.events.length}</span>
                      </th>
                      {!mobile && <OptionalColumnFillers />}
                    </tr>
                    {day.events.map((event) => (
                      <ActivityRows
                        key={event.id}
                        event={event}
                        mobile={mobile}
                        columns={columns}
                        journeyFileId={fileId}
                      />
                    ))}
                  </Fragment>
                ))}
              </DataTableBody>
            </DataTable>
          )}
          {history.hasNextPage && (
            <div className="border-border/60 border-b">
              <Button
                variant="ghost"
                className="h-9 w-full rounded-none text-muted-foreground text-xs max-md:h-11"
                disabled={history.isFetchingNextPage}
                onClick={() => void history.fetchNextPage()}
              >
                {history.isFetchingNextPage ? "Loading…" : "Load more"}
              </Button>
            </div>
          )}
          <div className="space-y-1 px-3 py-2 text-muted-foreground text-xs">
            {first?.historyStartsAt && (
              <p>
                History starts {new Date(first.historyStartsAt).toLocaleDateString()}.{" "}
                {first.retainedFrom
                  ? `Retained from ${new Date(first.retainedFrom).toLocaleDateString()}.`
                  : "Journey metadata is kept without an automatic cutoff."}
              </p>
            )}
            <p>Changes made outside fdrive appear once the indexer notices them.</p>
          </div>
        </div>
      </PageBody>
    </>
  );
}

/** The file a journey page is about: its name, where it is now, and whether it can be opened. */
function JourneySummary({ fileId }: { fileId: string }) {
  const summary = useActivityFile(fileId);
  if (summary.isPending) {
    return (
      <p role="status" className="border-border border-b px-3 py-2 text-muted-foreground text-xs">
        Finding the current location…
      </p>
    );
  }
  if (summary.isError) {
    return (
      <p role="alert" className="border-border border-b px-3 py-2 text-destructive text-sm">
        {summary.error.message}
      </p>
    );
  }
  const file = summary.data;
  return (
    <PageSection
      title={<span className="break-all">{baseName(file.lastKnownPath)}</span>}
      description={<span className="break-all">{file.currentPath ?? file.lastKnownPath}</span>}
      actions={<Badge variant="secondary">{file.availability}</Badge>}
    >
      <p className="px-3 py-2 text-muted-foreground text-xs">
        {file.label && `${file.label} · `}Revision records describe changes; earlier file contents
        are not stored.
      </p>
    </PageSection>
  );
}
