"use client";

import type {
  AiProvider,
  FsEntry,
  MoveManyRequest,
  OrganizeProposal,
  OrganizeSuggestion,
} from "@fdrive/contracts";
import { baseName, extensionOf, parentPath, uniqueNumberedName } from "@fdrive/core";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronRightIcon, FolderIcon, FolderInputIcon, LoaderCircle } from "lucide-react";
import { useMemo, useState } from "react";
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
  itemCount,
  type MoveOutcome,
  movesFor,
  providerLabel,
  recentSteps,
  summarizeMoves,
  undoMoves,
} from "@/lib/ai/organize";
import {
  type OrganizeSession,
  type ReviewEdits,
  reviewChecked,
  reviewSuggestions,
} from "@/lib/ai/organize-session";
import { useMoveMany } from "@/lib/ai/queries";
import type { OrganizeController } from "@/lib/ai/use-organize";
import { apiClient } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/keys";
import { describeFsError } from "@/lib/files/queries";

export interface OrganizeSheetProps {
  /** The session to show; the sheet is open while it has one that is open. */
  organize: OrganizeController;
  provider: AiProvider | null;
  /** Called with the new paths once items moved, so the browser can update its selection. */
  onMoved?: (targets: readonly string[]) => void;
}

/**
 * Asks the assistant where the selected items belong, shows its suggestions
 * grouped by destination for review, and moves only what the person keeps
 * checked. A toast offers to undo the moves. Closing the sheet keeps a run
 * or a review going; the session it shows lives in `useOrganize`.
 */
export function OrganizeSheet({ organize, provider, onMoved }: OrganizeSheetProps) {
  const moveMany = useMoveMany();
  const { session } = organize;

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
      open={session?.open === true}
      onOpenChange={(open) => {
        if (!open) organize.hide();
      }}
    >
      <SheetContent side="right" className="gap-0 sm:max-w-2xl">
        {session !== null ? (
          <OrganizeSheetBody
            session={session}
            organize={organize}
            provider={provider}
            applying={moveMany.isPending}
            onApply={apply}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

interface BodyProps {
  session: OrganizeSession;
  organize: OrganizeController;
  provider: AiProvider | null;
  applying: boolean;
  onApply: (request: MoveManyRequest) => Promise<MoveOutcome | null>;
}

function OrganizeSheetBody({ session, organize, provider, applying, onApply }: BodyProps) {
  const { entries, instructions, runId } = session;
  const { run, running } = organize;
  const state = run?.state;
  const runError = organize.runError;
  const title = `Organize ${itemCount(entries.length)}`;
  const proposal = state === "done" ? run?.proposal : undefined;

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
          edits={session.edits}
          onEdit={organize.setEdits}
          applying={applying}
          onApply={onApply}
          onDone={organize.discard}
          onClose={organize.hide}
          onRestart={organize.restart}
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
                    onChange={(event) => organize.setInstructions(event.target.value)}
                  />
                  <FieldDescription>
                    Optional. The selected items' names, sizes, dates and indexed text, and the
                    names of files the assistant looks through elsewhere in your drive, are sent to{" "}
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
                  {(run?.activity.length ?? 0) > 0 ? (
                    <ol aria-label="Progress" className="flex flex-col gap-1 pl-6">
                      {recentSteps(run?.activity ?? []).map((step) => (
                        <li key={step.key} className="text-xs text-muted-foreground">
                          {step.text}
                        </li>
                      ))}
                    </ol>
                  ) : null}
                  <p className="text-xs text-muted-foreground">
                    You can close this and keep working. The suggestions wait for you.
                  </p>
                </div>
              ) : null}
              {state === "failed" ? (
                <p role="alert" className="text-sm text-destructive">
                  {run?.error ?? "Organizing failed."}
                </p>
              ) : null}
              {state === "cancelled" ? (
                <p role="status" className="text-sm text-muted-foreground">
                  Stopped. Nothing was moved.
                </p>
              ) : null}
              {runError !== null && runError !== undefined ? (
                <p role="alert" className="text-sm text-destructive">
                  {describeFsError(runError, "Lost track of this request.")}
                </p>
              ) : null}
            </div>
          </ScrollArea>
          <SheetFooter className="shrink-0 flex-row justify-end gap-2 border-t">
            {running ? (
              <Button
                variant="outline"
                disabled={runId === null || organize.stopping}
                onClick={organize.stop}
              >
                Stop
              </Button>
            ) : state === "failed" ||
              state === "cancelled" ||
              (runError !== null && runError !== undefined) ? (
              <>
                <Button variant="outline" onClick={organize.discard}>
                  Close
                </Button>
                <Button onClick={organize.restart}>Try again</Button>
              </>
            ) : (
              <>
                <Button variant="outline" onClick={organize.discard}>
                  Cancel
                </Button>
                <Button onClick={() => void organize.start()}>Suggest moves</Button>
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
  edits: ReviewEdits;
  onEdit: (edits: ReviewEdits) => void;
  applying: boolean;
  onApply: (request: MoveManyRequest) => Promise<MoveOutcome | null>;
  /** Everything moved: the session is finished. */
  onDone: () => void;
  /** Hides the sheet; the review stays available. */
  onClose: () => void;
  onRestart: () => void;
}

function Review({
  proposal,
  entries,
  edits,
  onEdit,
  applying,
  onApply,
  onDone,
  onClose,
  onRestart,
}: ReviewProps) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<OrganizeSuggestion | null>(null);
  const [naming, setNaming] = useState<string | null>(null);
  const suggestions = useMemo(() => reviewSuggestions(proposal, edits), [proposal, edits]);
  const checked = useMemo(() => reviewChecked(proposal, edits), [proposal, edits]);
  const groups = useMemo(() => groupSuggestions(suggestions), [suggestions]);
  const entriesByPath = useMemo(
    () => new Map(entries.map((entry) => [entry.path, entry])),
    [entries],
  );
  const request = movesFor(suggestions, checked);

  function withChecked(paths: readonly string[], next: boolean): ReadonlySet<string> {
    const updated = new Set(checked);
    for (const path of paths) {
      if (next) updated.add(path);
      else updated.delete(path);
    }
    return updated;
  }

  function toggle(paths: readonly string[], next: boolean) {
    onEdit({ ...edits, checked: withChecked(paths, next) });
  }

  async function submit() {
    if (request === null) return;
    const outcome = await onApply(request);
    if (outcome === null) return;
    if (outcome.failed.length === 0) {
      onDone();
      return;
    }
    const moved = outcome.moved.map((move) => move.path);
    onEdit({
      ...edits,
      checked: withChecked(moved, false),
      moved: new Set([...edits.moved, ...moved]),
      failures: new Map(outcome.failed.map((failure) => [failure.path, failure.message])),
    });
  }

  function choose(suggestion: OrganizeSuggestion, destination: string) {
    const failures = new Map(edits.failures);
    failures.delete(suggestion.path);
    const names = new Map(edits.names);
    names.delete(suggestion.path);
    onEdit({
      ...edits,
      checked: withChecked([suggestion.path], true),
      destinations: new Map(edits.destinations).set(suggestion.path, destination),
      names,
      failures,
    });
  }

  /** Renames the item so it can go next to whatever already has its name. */
  async function keepBoth(suggestion: OrganizeSuggestion) {
    setNaming(suggestion.path);
    try {
      const taken = new Set<string>();
      if (!suggestion.newFolder) {
        const listing = await queryClient.fetchQuery({
          queryKey: queryKeys.fs.list(suggestion.destination),
          queryFn: () => apiClient.list(suggestion.destination),
        });
        for (const entry of listing.entries) taken.add(entry.name);
      }
      // Other suggestions headed for the same folder claim their names too.
      for (const other of suggestions)
        if (other.path !== suggestion.path && parentPath(other.target) === suggestion.destination)
          taken.add(baseName(other.target));
      const name = uniqueNumberedName(baseName(suggestion.path), taken);
      const failures = new Map(edits.failures);
      failures.delete(suggestion.path);
      onEdit({
        ...edits,
        checked: withChecked([suggestion.path], true),
        names: new Map(edits.names).set(suggestion.path, name),
        failures,
      });
    } catch (error) {
      toast.error(describeFsError(error, "Could not look inside that folder."));
    } finally {
      setNaming(null);
    }
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
                        const failure = edits.failures.get(suggestion.path);
                        const renamed = edits.names.get(suggestion.path);
                        const taken =
                          (suggestion.conflict || failure !== undefined) && renamed === undefined;
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
                              {renamed !== undefined ? (
                                <p className="text-xs text-muted-foreground">
                                  Moves as <span className="font-mono">{renamed}</span>
                                </p>
                              ) : null}
                              {taken ? (
                                <Button
                                  variant="outline"
                                  size="xs"
                                  className="mt-1"
                                  disabled={applying || naming !== null}
                                  onClick={() => void keepBoth(suggestion)}
                                >
                                  {naming === suggestion.path ? (
                                    <LoaderCircle className="animate-spin motion-reduce:animate-none" />
                                  ) : null}
                                  Keep both
                                </Button>
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
            Close
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
          choose(editing, destination);
          setEditing(null);
        }}
      />
    </>
  );
}
