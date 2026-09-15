"use client";

import type {
  AiProvider,
  FsEntry,
  MoveManyRequest,
  OrganizeProposal,
  OrganizeSuggestion,
} from "@fdrive/contracts";
import { baseName, extensionOf } from "@fdrive/core";
import { ChevronRightIcon, FolderIcon, FolderInputIcon, LoaderCircle } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { DestinationPicker } from "@/components/files/destination-picker";
import { FileIcon } from "@/components/files/file-icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import {
  groupSuggestions,
  initiallyChecked,
  itemCount,
  type MoveOutcome,
  movesFor,
  providerLabel,
  recentSteps,
  summarizeMoves,
  undoMoves,
  withDestination,
} from "@/lib/ai/organize";
import { useCancelOrganize, useMoveMany, useOrganizeRun, useStartOrganize } from "@/lib/ai/queries";
import { describeFsError } from "@/lib/files/queries";

export interface OrganizeSheetProps {
  /** The selection to organize; the sheet is open while this is non-null. */
  entries: readonly FsEntry[] | null;
  provider: AiProvider | null;
  onClose: () => void;
  /** Called with the new paths once items moved, so the browser can update its selection. */
  onMoved?: (targets: readonly string[]) => void;
}

/**
 * Asks the assistant where the selected items belong, shows its suggestions
 * grouped by destination for review, and moves only what the person keeps
 * checked. A toast offers to undo the moves.
 */
export function OrganizeSheet({ entries, provider, onClose, onMoved }: OrganizeSheetProps) {
  const moveMany = useMoveMany();

  async function undo(moved: MoveOutcome["moved"]) {
    const request = undoMoves(moved);
    if (request === null) return;
    try {
      const outcome = summarizeMoves((await moveMany.mutateAsync(request)).results);
      if (outcome.failed.length === 0)
        toast.success(`Moved ${itemCount(outcome.moved.length)} back`);
      else toast.error(`Could not move ${itemCount(outcome.failed.length)} back.`);
    } catch (error) {
      toast.error(describeFsError(error, "Could not undo the moves."));
    }
  }

  async function apply(request: MoveManyRequest): Promise<MoveOutcome | null> {
    try {
      const outcome = summarizeMoves((await moveMany.mutateAsync(request)).results);
      if (outcome.moved.length > 0) {
        toast.success(`Moved ${itemCount(outcome.moved.length)}`, {
          ...(outcome.warnings > 0
            ? {
                description: `Tags or favorites of ${itemCount(outcome.warnings)} could not follow.`,
              }
            : {}),
          action: { label: "Undo", onClick: () => void undo(outcome.moved) },
        });
        onMoved?.(outcome.moved.map((move) => move.target));
      }
      return outcome;
    } catch (error) {
      toast.error(describeFsError(error, "Could not move the items."));
      return null;
    }
  }

  return (
    <Sheet
      open={entries !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent side="right" className="gap-0 sm:max-w-2xl">
        {entries !== null ? (
          <OrganizeSheetBody
            entries={entries}
            provider={provider}
            applying={moveMany.isPending}
            onApply={apply}
            onClose={onClose}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

interface BodyProps {
  entries: readonly FsEntry[];
  provider: AiProvider | null;
  applying: boolean;
  onApply: (request: MoveManyRequest) => Promise<MoveOutcome | null>;
  onClose: () => void;
}

function OrganizeSheetBody({ entries, provider, applying, onApply, onClose }: BodyProps) {
  const [instructions, setInstructions] = useState("");
  const [runId, setRunId] = useState<string | null>(null);
  const start = useStartOrganize();
  const cancel = useCancelOrganize();
  const run = useOrganizeRun(runId);
  const state = run.data?.state;
  const running = start.isPending || state === "running";

  // Closing the sheet mid-run stops the assistant rather than leaving it working unseen.
  const live = useRef({ runId, running: state === "running", cancel: cancel.mutate });
  live.current = { runId, running: state === "running", cancel: cancel.mutate };
  useEffect(
    () => () => {
      const { runId: id, running: stillRunning, cancel: stop } = live.current;
      if (id !== null && stillRunning) stop(id);
    },
    [],
  );

  function begin() {
    start.mutate(
      {
        paths: entries.map((entry) => entry.path),
        ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
      },
      {
        onSuccess: (started) => setRunId(started.id),
        onError: (error) => toast.error(describeFsError(error, "Could not start organizing.")),
      },
    );
  }

  function restart() {
    setRunId(null);
    start.reset();
  }

  const title = `Organize ${itemCount(entries.length)}`;
  const proposal = state === "done" ? run.data?.proposal : undefined;

  return (
    <>
      <SheetHeader className="border-b pr-12">
        <SheetTitle>{title}</SheetTitle>
        <SheetDescription>
          Suggests where the selected items belong in your drive. Nothing moves until you approve
          it.
        </SheetDescription>
      </SheetHeader>

      {proposal !== undefined ? (
        <Review
          proposal={proposal}
          entries={entries}
          applying={applying}
          onApply={onApply}
          onClose={onClose}
          onRestart={restart}
        />
      ) : (
        <>
          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-4 p-4">
              {runId === null || state === undefined ? (
                <Field>
                  <FieldLabel htmlFor="organize-instructions">Instructions</FieldLabel>
                  <Textarea
                    id="organize-instructions"
                    value={instructions}
                    disabled={running}
                    maxLength={2000}
                    placeholder="Put invoices under Finance, photos by year"
                    onChange={(event) => setInstructions(event.target.value)}
                  />
                  <FieldDescription>
                    Optional. Names, sizes, dates and indexed text of the selected items are sent to{" "}
                    {providerLabel(provider)}.
                  </FieldDescription>
                </Field>
              ) : null}
              {running ? (
                <div role="status" className="flex flex-col gap-3">
                  <p className="flex items-center gap-2 text-sm">
                    <LoaderCircle className="size-4 animate-spin text-muted-foreground motion-reduce:animate-none" />
                    Looking for better places…
                  </p>
                  {(run.data?.activity.length ?? 0) > 0 ? (
                    <ol aria-label="Progress" className="flex flex-col gap-1 pl-6">
                      {recentSteps(run.data?.activity ?? []).map((step) => (
                        <li key={step.key} className="text-xs text-muted-foreground">
                          {step.text}
                        </li>
                      ))}
                    </ol>
                  ) : null}
                </div>
              ) : null}
              {state === "failed" ? (
                <p role="alert" className="text-sm text-destructive">
                  {run.data?.error ?? "Organizing failed."}
                </p>
              ) : null}
              {state === "cancelled" ? (
                <p role="status" className="text-sm text-muted-foreground">
                  Stopped. Nothing was moved.
                </p>
              ) : null}
              {run.isError ? (
                <p role="alert" className="text-sm text-destructive">
                  {describeFsError(run.error, "Lost track of this request.")}
                </p>
              ) : null}
            </div>
          </ScrollArea>
          <SheetFooter className="shrink-0 flex-row justify-end gap-2 border-t">
            {running ? (
              <Button
                variant="outline"
                disabled={runId === null || cancel.isPending}
                onClick={() => runId !== null && cancel.mutate(runId)}
              >
                Stop
              </Button>
            ) : state === "failed" || state === "cancelled" || run.isError ? (
              <>
                <Button variant="outline" onClick={onClose}>
                  Close
                </Button>
                <Button onClick={restart}>Try again</Button>
              </>
            ) : (
              <>
                <Button variant="outline" onClick={onClose}>
                  Cancel
                </Button>
                <Button onClick={begin}>Suggest moves</Button>
              </>
            )}
          </SheetFooter>
        </>
      )}
    </>
  );
}

interface ReviewProps {
  proposal: OrganizeProposal;
  entries: readonly FsEntry[];
  applying: boolean;
  onApply: (request: MoveManyRequest) => Promise<MoveOutcome | null>;
  onClose: () => void;
  onRestart: () => void;
}

function Review({ proposal, entries, applying, onApply, onClose, onRestart }: ReviewProps) {
  const [suggestions, setSuggestions] = useState(proposal.suggestions);
  const [checked, setChecked] = useState(() => initiallyChecked(proposal));
  const [failures, setFailures] = useState<ReadonlyMap<string, string>>(new Map());
  const [editing, setEditing] = useState<OrganizeSuggestion | null>(null);
  const groups = useMemo(() => groupSuggestions(suggestions), [suggestions]);
  const entriesByPath = useMemo(
    () => new Map(entries.map((entry) => [entry.path, entry])),
    [entries],
  );
  const request = movesFor(suggestions, checked);

  function toggle(paths: readonly string[], next: boolean) {
    setChecked((previous) => {
      const updated = new Set(previous);
      for (const path of paths) {
        if (next) updated.add(path);
        else updated.delete(path);
      }
      return updated;
    });
  }

  async function submit() {
    if (request === null) return;
    const outcome = await onApply(request);
    if (outcome === null) return;
    if (outcome.failed.length === 0) {
      onClose();
      return;
    }
    const moved = new Set(outcome.moved.map((move) => move.path));
    setSuggestions((previous) => previous.filter((suggestion) => !moved.has(suggestion.path)));
    toggle([...moved], false);
    setFailures(new Map(outcome.failed.map((failure) => [failure.path, failure.message])));
  }

  return (
    <>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-4 p-4">
          {proposal.summary ? <p className="text-sm">{proposal.summary}</p> : null}
          {groups.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No moves suggested. The items below stay where they are.
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              {groups.map((group) => {
                const paths = group.suggestions.map((suggestion) => suggestion.path);
                const count = paths.filter((path) => checked.has(path)).length;
                return (
                  <section key={group.destination} aria-label={group.destination}>
                    <div className="flex items-center gap-2 px-2 py-1.5">
                      <Checkbox
                        aria-label={`Move all into ${group.destination}`}
                        checked={count === paths.length}
                        indeterminate={count > 0 && count < paths.length}
                        disabled={applying}
                        onCheckedChange={(next) => toggle(paths, next)}
                      />
                      <FolderIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                      <span
                        className="min-w-0 truncate font-mono text-xs"
                        title={group.destination}
                      >
                        {group.destination}
                      </span>
                      {group.newFolder ? <Badge variant="secondary">New folder</Badge> : null}
                      <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                        {paths.length}
                      </span>
                    </div>
                    <ul className="flex flex-col">
                      {group.suggestions.map((suggestion) => {
                        const entry = entriesByPath.get(suggestion.path);
                        const name = baseName(suggestion.path);
                        const failure = failures.get(suggestion.path);
                        return (
                          <li
                            key={suggestion.path}
                            className="flex items-start gap-2 rounded-md py-1.5 pr-1 pl-8 hover:bg-muted/50"
                          >
                            <Checkbox
                              className="mt-0.5"
                              aria-label={`Move ${name}`}
                              checked={checked.has(suggestion.path)}
                              disabled={applying}
                              onCheckedChange={(next) => toggle([suggestion.path], next)}
                            />
                            <FileIcon
                              className="mt-0.5"
                              kind={suggestion.kind}
                              ext={
                                entry?.ext ?? (suggestion.kind === "dir" ? "" : extensionOf(name))
                              }
                              mime={entry?.mime ?? null}
                            />
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-sm" title={suggestion.path}>
                                {name}
                              </p>
                              {suggestion.reason ? (
                                <p className="line-clamp-2 text-xs text-muted-foreground">
                                  {suggestion.reason}
                                </p>
                              ) : null}
                              {suggestion.conflict && failure === undefined ? (
                                <p className="text-xs text-destructive">
                                  Something with this name is already there.
                                </p>
                              ) : null}
                              {failure !== undefined ? (
                                <p role="alert" className="text-xs text-destructive">
                                  {failure}
                                </p>
                              ) : null}
                            </div>
                            <Button
                              variant="ghost"
                              size="icon-xs"
                              aria-label={`Choose another folder for ${name}`}
                              title="Choose another folder"
                              disabled={applying}
                              onClick={() => setEditing(suggestion)}
                            >
                              <FolderInputIcon />
                            </Button>
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                );
              })}
            </div>
          )}
          {proposal.unchanged.length > 0 ? (
            <Collapsible>
              <CollapsibleTrigger
                render={
                  <Button variant="ghost" size="sm" className="group/unchanged -ml-2 self-start" />
                }
              >
                <ChevronRightIcon className="transition-transform group-data-[panel-open]/unchanged:rotate-90" />
                {itemCount(proposal.unchanged.length)} stay where they are
              </CollapsibleTrigger>
              <CollapsibleContent>
                <ul className="flex flex-col gap-1 pt-1 pl-6">
                  {proposal.unchanged.map((item) => (
                    <li key={item.path} className="text-xs">
                      <span className="font-mono">{item.path}</span>
                      <span className="text-muted-foreground"> — {item.reason}</span>
                    </li>
                  ))}
                </ul>
              </CollapsibleContent>
            </Collapsible>
          ) : null}
        </div>
      </ScrollArea>
      <SheetFooter className="shrink-0 flex-row items-center justify-between gap-2 border-t">
        <Button variant="ghost" size="sm" disabled={applying} onClick={onRestart}>
          Start over
        </Button>
        <div className="flex gap-2">
          <Button variant="outline" disabled={applying} onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={request === null || applying} onClick={() => void submit()}>
            {applying ? "Moving…" : `Move ${itemCount(request?.items.length ?? 0)}`}
          </Button>
        </div>
      </SheetFooter>
      <DestinationPicker
        open={editing !== null}
        mode="move"
        initialPath={editing === null || editing.newFolder ? "/" : editing.destination}
        sourcePaths={editing === null ? [] : [editing.path]}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        onConfirm={(destination) => {
          if (editing === null) return;
          setSuggestions((previous) =>
            previous.map((suggestion) =>
              suggestion.path === editing.path
                ? withDestination(suggestion, destination)
                : suggestion,
            ),
          );
          toggle([editing.path], true);
          setFailures((previous) => {
            const next = new Map(previous);
            next.delete(editing.path);
            return next;
          });
          setEditing(null);
        }}
      />
    </>
  );
}
