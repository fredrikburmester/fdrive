"use client";

import type {
  Chat,
  ChatActionEdits,
  ChatActionProposal,
  ChatActionRequest,
  ChatPart,
} from "@fdrive/contracts";
import { baseName, extensionOf, joinPath } from "@fdrive/core";
import { CheckIcon, FolderIcon, FolderInputIcon, LoaderCircle, Undo2Icon } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { DestinationPicker } from "@/components/files/destination-picker";
import { FileIcon } from "@/components/files/file-icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { applyLabel, hrefForPath } from "@/lib/ai/chat";
import { groupSuggestions, summarizeMoves, undoMoves, withDestination } from "@/lib/ai/organize";
import { useMoveMany } from "@/lib/ai/queries";
import { describeFsError } from "@/lib/files/queries";

type ActionPart = ChatPart & { kind: "action" };
type MoveProposal = Extract<ChatActionProposal, { kind: "move" }>;

export interface ChatActionCardProps {
  readonly chat: Pick<Chat, "id" | "state">;
  readonly part: ActionPart;
  /** True while this card's decision is on its way to the server. */
  readonly busy: boolean;
  readonly onAct: (actionId: string, request: ChatActionRequest) => Promise<void>;
}

const STATE_LABELS: Record<ActionPart["state"], string | null> = {
  pending: null,
  applied: "Applied",
  declined: "Declined",
  failed: "Failed",
};

/**
 * One proposed change, waiting for the person: what would happen, what
 * they can adjust, and Apply or Decline. Once answered, what happened.
 */
export function ChatActionCard({ chat, part, busy, onAct }: ChatActionCardProps) {
  const pending = part.state === "pending";
  const [edits, setEdits] = useState<ChatActionEdits>({});
  const [count, setCount] = useState<number | null>(null);
  const label = STATE_LABELS[part.state];

  async function decide(request: ChatActionRequest) {
    await onAct(part.id, request);
  }

  return (
    <section
      aria-label={part.proposal.summary || "Proposed change"}
      data-state={part.state}
      className="flex flex-col gap-3 rounded-lg border bg-card p-3 text-card-foreground"
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm">{part.proposal.summary}</p>
        {label !== null ? (
          <Badge variant={part.state === "failed" ? "destructive" : "secondary"}>{label}</Badge>
        ) : null}
      </div>
      {part.proposal.kind === "move" ? (
        <MoveBody
          proposal={part.proposal}
          part={part}
          editable={pending && !busy}
          onChange={(next, kept) => {
            setEdits(next);
            setCount(kept);
          }}
        />
      ) : part.proposal.kind === "trash" ? (
        <TrashBody
          proposal={part.proposal}
          part={part}
          editable={pending && !busy}
          onChange={(next, kept) => {
            setEdits(next);
            setCount(kept);
          }}
        />
      ) : (
        <WriteBody
          proposal={part.proposal}
          part={part}
          editable={pending && !busy}
          onChange={(next) => setEdits(next)}
        />
      )}
      {part.outcome ? <p className="text-muted-foreground text-xs">{part.outcome}</p> : null}
      {pending ? (
        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void decide({ decision: "decline" })}
          >
            Decline
          </Button>
          <Button
            size="sm"
            disabled={busy || chat.state === "running" || count === 0}
            onClick={() => void decide({ decision: "apply", edits })}
          >
            {busy ? <LoaderCircle className="animate-spin motion-reduce:animate-none" /> : null}
            {applyLabel(part.proposal, count ?? defaultCount(part))}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function defaultCount(part: ActionPart): number {
  switch (part.proposal.kind) {
    case "move":
      return part.proposal.suggestions.filter((item) => !item.conflict).length;
    case "trash":
      return part.proposal.items.length;
    case "write":
      return 1;
  }
}

function ResultList({ part }: { part: ActionPart }) {
  if (part.results === undefined || part.results.length === 0) return null;
  return (
    <ul className="flex flex-col gap-0.5 text-xs">
      {part.results.map((result) => (
        <li key={result.path} className={result.ok ? "" : "text-destructive"}>
          <span className="font-mono">{result.path}</span>
          {result.ok && result.target !== undefined && result.target !== result.path ? (
            <span className="text-muted-foreground"> → {result.target}</span>
          ) : null}
          {result.message ? (
            <span className="text-muted-foreground"> — {result.message}</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

interface BodyProps<P> {
  readonly proposal: P;
  readonly part: ActionPart;
  readonly editable: boolean;
  readonly onChange: (edits: ChatActionEdits, kept: number) => void;
}

function MoveBody({ proposal, part, editable, onChange }: BodyProps<MoveProposal>) {
  const [checked, setChecked] = useState<ReadonlySet<string>>(
    () => new Set(proposal.suggestions.filter((item) => !item.conflict).map((item) => item.path)),
  );
  const [destinations, setDestinations] = useState<ReadonlyMap<string, string>>(new Map());
  const [editing, setEditing] = useState<string | null>(null);
  const moveMany = useMoveMany();
  const suggestions = useMemo(
    () =>
      proposal.suggestions.map((item) => {
        const destination = destinations.get(item.path);
        return destination === undefined ? item : withDestination(item, destination);
      }),
    [proposal.suggestions, destinations],
  );
  const groups = useMemo(() => groupSuggestions(suggestions), [suggestions]);

  function update(nextChecked: ReadonlySet<string>, nextDestinations: ReadonlyMap<string, string>) {
    setChecked(nextChecked);
    setDestinations(nextDestinations);
    const moves = proposal.suggestions
      .filter((item) => nextChecked.has(item.path))
      .map((item) => {
        const destination = nextDestinations.get(item.path);
        return {
          path: item.path,
          target:
            destination === undefined ? item.target : joinPath(destination, baseName(item.path)),
        };
      });
    onChange({ moves }, moves.length);
  }

  function toggle(paths: readonly string[], next: boolean) {
    const updated = new Set(checked);
    for (const path of paths)
      if (next) updated.add(path);
      else updated.delete(path);
    update(updated, destinations);
  }

  async function undo() {
    const applied = summarizeMoves(
      (part.results ?? [])
        .filter((result) => result.ok)
        .map((result) => ({
          ok: true as const,
          path: result.path,
          target: result.target ?? result.path,
        })),
    );
    const request = undoMoves(applied.moved);
    if (request === null) return;
    try {
      const response = await moveMany.mutateAsync(request);
      const outcome = summarizeMoves(response.results);
      if (outcome.failed.length > 0)
        toast.error(`Could not move ${outcome.failed.length} items back.`);
      else toast.success("Moved back.");
    } catch (error) {
      toast.error(describeFsError(error, "Could not move the items back."));
    }
  }

  if (part.state !== "pending") {
    return (
      <div className="flex flex-col gap-2">
        <ResultList part={part} />
        {part.state === "applied" && (part.results ?? []).some((result) => result.ok) ? (
          <Button
            variant="outline"
            size="xs"
            className="self-start"
            disabled={moveMany.isPending}
            onClick={() => void undo()}
          >
            <Undo2Icon />
            Undo
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {groups.map((group) => {
        const paths = group.suggestions.map((item) => item.path);
        const kept = paths.filter((path) => checked.has(path)).length;
        return (
          <section key={group.destination} aria-label={group.destination} className="flex flex-col">
            <div className="flex items-center gap-2 py-1">
              <Checkbox
                aria-label={`Move all into ${group.destination}`}
                checked={kept === paths.length}
                indeterminate={kept > 0 && kept < paths.length}
                disabled={!editable}
                onCheckedChange={(next) => toggle(paths, next)}
              />
              <FolderIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <a
                href={hrefForPath(group.destination, "dir")}
                className="min-w-0 truncate font-mono text-xs hover:underline"
                title={group.destination}
              >
                {group.destination}
              </a>
              {group.newFolder ? <Badge variant="secondary">New folder</Badge> : null}
            </div>
            <ul className="flex flex-col">
              {group.suggestions.map((item) => {
                const name = baseName(item.path);
                return (
                  <li key={item.path} className="flex items-start gap-2 py-1 pl-6">
                    <Checkbox
                      className="mt-0.5"
                      aria-label={`Move ${name}`}
                      checked={checked.has(item.path)}
                      disabled={!editable}
                      onCheckedChange={(next) => toggle([item.path], next)}
                    />
                    <FileIcon
                      className="mt-0.5"
                      kind={item.kind}
                      ext={item.kind === "dir" ? "" : extensionOf(name)}
                      mime={null}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm" title={item.path}>
                        {name}
                      </p>
                      {item.reason ? (
                        <p className="line-clamp-2 text-muted-foreground text-xs">{item.reason}</p>
                      ) : null}
                      {item.conflict ? (
                        <p className="text-destructive text-xs">
                          Something with this name is already there.
                        </p>
                      ) : null}
                    </div>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Choose another folder for ${name}`}
                      disabled={!editable}
                      onClick={() => setEditing(item.path)}
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
      {proposal.unchanged.length > 0 ? (
        <ul className="flex flex-col gap-0.5 text-muted-foreground text-xs">
          {proposal.unchanged.map((item) => (
            <li key={item.path}>
              <span className="font-mono">{item.path}</span> — {item.reason}
            </li>
          ))}
        </ul>
      ) : null}
      <DestinationPicker
        open={editing !== null}
        mode="move"
        initialPath="/"
        sourcePaths={editing === null ? [] : [editing]}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        onConfirm={(destination) => {
          if (editing === null) return;
          const updated = new Set(checked);
          updated.add(editing);
          update(updated, new Map(destinations).set(editing, destination));
          setEditing(null);
        }}
      />
    </div>
  );
}

function TrashBody({
  proposal,
  part,
  editable,
  onChange,
}: BodyProps<Extract<ActionPart["proposal"], { kind: "trash" }>>) {
  const [checked, setChecked] = useState<ReadonlySet<string>>(
    () => new Set(proposal.items.map((item) => item.path)),
  );
  if (part.state !== "pending") return <ResultList part={part} />;
  function toggle(path: string, next: boolean) {
    const updated = new Set(checked);
    if (next) updated.add(path);
    else updated.delete(path);
    setChecked(updated);
    onChange({ paths: [...updated] }, updated.size);
  }
  return (
    <ul className="flex flex-col">
      {proposal.items.map((item) => {
        const name = baseName(item.path);
        return (
          <li key={item.path} className="flex items-start gap-2 py-1">
            <Checkbox
              className="mt-0.5"
              aria-label={`Trash ${name}`}
              checked={checked.has(item.path)}
              disabled={!editable}
              onCheckedChange={(next) => toggle(item.path, next)}
            />
            <FileIcon
              className="mt-0.5"
              kind={item.kind}
              ext={item.kind === "dir" ? "" : extensionOf(name)}
              mime={null}
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm" title={item.path}>
                {name}
              </p>
              {item.reason ? (
                <p className="line-clamp-2 text-muted-foreground text-xs">{item.reason}</p>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function WriteBody({
  proposal,
  part,
  editable,
  onChange,
}: BodyProps<Extract<ActionPart["proposal"], { kind: "write" }>>) {
  const [name, setName] = useState(baseName(proposal.path));
  const folder = proposal.path.slice(0, proposal.path.length - baseName(proposal.path).length);
  if (part.state !== "pending") return <ResultList part={part} />;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Badge variant="secondary">{proposal.mode === "create" ? "New file" : "Replaces"}</Badge>
        {proposal.mode === "create" ? (
          <>
            <span className="truncate font-mono text-muted-foreground text-xs" title={folder}>
              {folder}
            </span>
            <Input
              aria-label="File name"
              className="h-7 max-w-56 font-mono text-xs"
              value={name}
              disabled={!editable}
              onChange={(event) => {
                setName(event.target.value);
                onChange({ path: `${folder}${event.target.value.trim()}` }, 1);
              }}
            />
          </>
        ) : (
          <a
            href={hrefForPath(proposal.path, "file")}
            className="truncate font-mono text-xs hover:underline"
          >
            {proposal.path}
          </a>
        )}
      </div>
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 p-2 font-mono text-xs">
        {proposal.text}
      </pre>
      {proposal.mode === "replace" ? (
        <p className="flex items-center gap-1 text-muted-foreground text-xs">
          <CheckIcon className="size-3" /> Only applied while the file is unchanged since it was
          read.
        </p>
      ) : null}
    </div>
  );
}
