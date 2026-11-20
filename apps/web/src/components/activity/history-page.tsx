"use client";

import {
  PersonalActivityAction,
  type PersonalActivityEvent,
  type PersonalActivityFilters,
  PersonalActivityOutcome,
  PersonalActivitySource,
} from "@fdrive/contracts";
import { cn } from "cn";
import { ChevronRightIcon, Clock3, ListFilterIcon } from "lucide-react";
import Link from "next/link";
import { Fragment, type Ref, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { SheetDock } from "@/components/shell/list-sheet";
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
} from "@/components/shell/page-layout";
import { PHONE_TARGET, RowsSkeleton, TruncatedCell } from "@/components/shell/page-rows";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useIsMobile } from "@/hooks/use-mobile";
import { activityRequest } from "@/lib/activity/api";
import { activityLabels, activityPath, collapseActivity } from "@/lib/activity/history";
import { useActivityHistory } from "@/lib/activity/queries";
import { formatTime } from "@/lib/format";
import { useFormatters } from "@/lib/use-format-preferences";
import { ActivityItemIcon, EventSheet } from "./event-sheet";
import {
  activityAction,
  activityFailed,
  activityFolder,
  activityItemName,
  activityOrigin,
  activityResult,
  activitySource,
  eventCountLabel,
  eventKey,
  groupByDay,
  sentenceCase,
  uncertaintyNotes,
} from "./history-rows";
import { JourneyFileSheet, JourneySummary } from "./journey-sheet";
import { useOpenActivityFile } from "./open-activity-file";

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
 * show. CSS hides the optional ones, so a `colSpan` over all six would add columns to a narrow
 * table; spanning three and filling the rest keeps the row reaching the table's edge.
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

/**
 * One event as a table row: when, what happened, the item and where it is, the client and the
 * result. Choosing the row (a click, or Enter or Space on it) opens the event's sheet beside the
 * table. The item's name opens the file and its location shows it in its folder.
 */
function ActivityRow({
  event,
  mobile,
  selected,
  onChoose,
  onDismiss,
  rowRef,
}: {
  event: PersonalActivityEvent;
  mobile: boolean;
  /** Whether this row's sheet is the one open. */
  selected: boolean;
  onChoose: () => void;
  /** Escape on the row: closes the sheet that is open, whichever row it belongs to. */
  onDismiss: () => void;
  rowRef: Ref<HTMLTableRowElement>;
}) {
  const { prefs } = useFormatters();
  const { open, canOpen } = useOpenActivityFile(event);
  const path = activityPath(event);
  const name = path ? activityItemName(path) : null;
  const folder = path ? activityFolder(path) : null;
  const origin = path ? activityOrigin(event, path) : null;
  const action = activityAction(event);
  const when = new Date(event.sortAt);
  const time = (
    <time dateTime={event.sortAt} title={when.toLocaleString()} className="tabular-nums">
      {formatTime(when, prefs.clock)}
    </time>
  );
  const result = activityResult(event);
  const failed = activityFailed(event);
  const notes = uncertaintyNotes(event);
  const noteLines = notes.map((note) => (
    <p key={note} className="whitespace-normal text-muted-foreground text-xs">
      {note}
    </p>
  ));
  // A row with notes is taller than its neighbors, so its cells line up along their first line.
  const top = notes.length > 0 ? "py-2 align-top" : undefined;
  return (
    <DataTableRow
      ref={rowRef}
      data-slot="activity-row"
      data-state={selected ? "selected" : undefined}
      aria-selected={selected}
      tabIndex={0}
      className={cn(
        "cursor-pointer focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2",
        mobile && "h-14",
      )}
      onClick={onChoose}
      onKeyDown={(keys) => {
        if (keys.key === "Escape") {
          onDismiss();
          return;
        }
        // Keys on the links inside the row are theirs.
        if (keys.target !== keys.currentTarget) return;
        if (keys.key === "Enter" || keys.key === " ") {
          keys.preventDefault();
          onChoose();
        }
      }}
    >
      {mobile ? (
        <DataTableCell className={top}>
          <div className="flex min-w-0 items-center gap-2">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <div className="flex min-w-0 items-baseline gap-1.5 text-[15px] leading-5">
                <span className="shrink-0 font-medium">{action}</span>
                {name && <span className="truncate">{name}</span>}
              </div>
              <div className="flex min-w-0 items-center gap-1 text-muted-foreground text-xs leading-4">
                {time}
                {folder && <span className="truncate">· {folder}</span>}
                {result !== "Success" && (
                  <span className={cn("shrink-0", failed && "font-medium text-destructive")}>
                    · {result}
                  </span>
                )}
              </div>
              {noteLines}
            </div>
            <ChevronRightIcon
              aria-hidden="true"
              className="size-4 shrink-0 text-muted-foreground/70"
            />
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
              {name === null ? null : <ActivityItemIcon event={event} name={name} />}
              {name === null ? (
                <span className="text-muted-foreground">--</span>
              ) : canOpen ? (
                <button
                  type="button"
                  title="Open"
                  onClick={(click) => {
                    click.stopPropagation();
                    void open("file");
                  }}
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
            className={cn("text-muted-foreground text-xs leading-5", OPTIONAL_COLUMN.location, top)}
          >
            {folder === null ? (
              "--"
            ) : canOpen ? (
              <button
                type="button"
                title="Show in folder"
                onClick={(click) => {
                  click.stopPropagation();
                  void open("reveal");
                }}
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
            {activitySource(event.source)}
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
  );
}

/** What the sheet beside the table shows: one event, or the file a journey page is about. */
type Chosen = { kind: "event"; key: string } | { kind: "file" };

/** The name a chosen thing's row or button is kept under, to give it focus back. */
function triggerOf(chosen: Chosen): string {
  return chosen.kind === "event" ? `event:${chosen.key}` : "file";
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
  // The columns that always show: one of folded text on a phone; time, action and item from
  // `md` up. A day's group row spans these.
  const columns = mobile ? 1 : 3;

  // What the docked sheet shows. Choosing moves focus into the sheet, and closing it gives focus
  // back to the row or button it was opened from.
  const [chosen, setChosen] = useState<Chosen | null>(null);
  const [focusRequests, setFocusRequests] = useState(0);
  const sheetRef = useRef<HTMLElement>(null);
  const triggers = useRef(new Map<string, HTMLElement>());
  const chosenEvent =
    chosen?.kind === "event" ? events.find((event) => eventKey(event) === chosen.key) : undefined;
  // A chosen event the filters no longer show is not chosen any more, so it does not come back
  // open when the filters are cleared.
  const chosenGone = chosen?.kind === "event" && chosenEvent === undefined;
  useEffect(() => {
    if (chosenGone) setChosen(null);
  }, [chosenGone]);
  useEffect(() => {
    if (focusRequests > 0) sheetRef.current?.focus({ preventScroll: true });
  }, [focusRequests]);
  function choose(next: Chosen) {
    setChosen(next);
    setFocusRequests((count) => count + 1);
  }
  /** Closes the sheet and gives focus back to what opened it. */
  function close() {
    if (chosen === null) return;
    setChosen(null);
    triggers.current.get(triggerOf(chosen))?.focus();
  }
  function trigger(name: string) {
    return (node: HTMLElement | null) => {
      if (node === null) return;
      triggers.current.set(name, node);
      return () => {
        triggers.current.delete(name);
      };
    };
  }
  const sheet =
    chosenEvent !== undefined ? (
      <EventSheet
        key={eventKey(chosenEvent)}
        ref={sheetRef}
        event={chosenEvent}
        journeyFileId={fileId}
        onClose={close}
      />
    ) : chosen?.kind === "file" && fileId ? (
      <JourneyFileSheet ref={sheetRef} fileId={fileId} onClose={close} />
    ) : undefined;
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
      <div data-slot="personal-activity" className="flex min-w-0 flex-1">
        <SheetDock sheet={sheet}>
          {/*
            `PageBody` is a size container inside the rows' column, so the table drops its least
            important columns by the room it has left beside the sheet.
          */}
          <PageBody>
            {fileId && (
              <JourneySummary
                fileId={fileId}
                detailsOpen={chosen?.kind === "file"}
                onDetails={() => choose({ kind: "file" })}
                detailsRef={trigger("file")}
              />
            )}
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
                      label: activitySource(source),
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
                      label: sentenceCase(outcome),
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
                    {mobile ? (
                      <DataTableHead>Activity</DataTableHead>
                    ) : (
                      <>
                        <DataTableHead className="w-20">Time</DataTableHead>
                        {/* A share of a narrow table, so the item beside it keeps some room. */}
                        <DataTableHead className="w-[38%] @lg:w-48">Action</DataTableHead>
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
                      {day.events.map((event) => {
                        const key = eventKey(event);
                        return (
                          <ActivityRow
                            key={key}
                            event={event}
                            mobile={mobile}
                            selected={chosenEvent !== undefined && eventKey(chosenEvent) === key}
                            onChoose={() => choose({ kind: "event", key })}
                            onDismiss={() => setChosen(null)}
                            rowRef={trigger(`event:${key}`)}
                          />
                        );
                      })}
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
          </PageBody>
        </SheetDock>
      </div>
    </>
  );
}
