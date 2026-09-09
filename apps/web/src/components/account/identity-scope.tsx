"use client";

import type { IdentityScopeResponse, UnmappedMount } from "@fdrive/contracts";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { describeApiError } from "@/lib/api/errors";
import {
  useIdentityScope,
  useIdentityScopeSuggestions,
  useMountMappings,
  useSetIdentityScope,
  useSetMountMappings,
} from "@/lib/api/scope-queries";
import {
  type AdminScopeStatus,
  describeScopeError,
  fsPrefixProblem,
  mountMappingsWith,
  requestWithMapping,
  requestWithoutPrefix,
  requestWithUnindexed,
  SCOPE_REASON_TEXT,
  type ScopeSaveError,
} from "./scope-model";

export interface IdentityScopeProps {
  readonly identityId: string;
  readonly username: string;
}

/**
 * Index status for one linked login, shown under it on the account page.
 * Everyone sees the status, the virtual paths, and any unmapped mounts; an
 * administrator additionally gets the mapping editor, whose entry point is
 * the unmapped mount itself ("Map it" or "Not indexed") rather than a blank
 * form. "Map it" offers index-derived suggestions and, by default, saves a
 * folder-level mapping that every login mounting the folder adopts
 * (`docs/workflow/P8-FOLDER-MAPPINGS.md`). Physical prefixes and root
 * names only ever come from the administrator response, so a
 * non-administrator never sees them.
 */
export function IdentityScope({ identityId, username }: IdentityScopeProps) {
  const { data, isLoading, error } = useIdentityScope(identityId);

  if (isLoading) return <Skeleton className="h-5 w-48" />;
  if (error !== null || data === undefined) {
    return <p className="text-xs text-destructive">{describeApiError(error)}</p>;
  }
  return <ScopeDetails identityId={identityId} username={username} status={data} />;
}

function ScopeDetails({
  identityId,
  username,
  status,
}: IdentityScopeProps & { readonly status: IdentityScopeResponse }) {
  const available = status.status === "available";
  return (
    <section className="flex flex-col gap-2 text-xs" aria-label={`Index status for ${username}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground">Index</span>
        <Badge variant={available ? "secondary" : "outline"}>
          {available ? "Available" : "Unavailable"}
        </Badge>
        <span className="text-muted-foreground">
          {status.virtualPrefixes.map((prefix) => (
            <code key={prefix} className="mr-1 rounded bg-muted px-1">
              {prefix}
            </code>
          ))}
        </span>
      </div>
      {status.reason === "ok" && status.unverifiedPrefixes.length === 0 ? null : (
        <p className="text-muted-foreground">{SCOPE_REASON_TEXT[status.reason]}</p>
      )}
      {status.unverifiedPrefixes.length > 0 ? (
        <p className="text-muted-foreground">
          Not verified, so excluded from search: {status.unverifiedPrefixes.join(", ")}.
        </p>
      ) : null}
      {status.isAdmin ? (
        <AdminEditor identityId={identityId} status={status} />
      ) : (
        <ReadOnlyMounts mounts={status.unmappedMounts} />
      )}
    </section>
  );
}

function ReadOnlyMounts({ mounts }: { readonly mounts: readonly UnmappedMount[] }) {
  if (mounts.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1">
      {mounts.map((mount) => (
        <li key={mount.virtualPath}>
          <code className="rounded bg-muted px-1">{mount.virtualPath}</code> is not indexed. Ask an
          administrator to map it.
        </li>
      ))}
    </ul>
  );
}

interface MountDraft {
  readonly virtualPrefix: string;
  readonly rootName: string;
  readonly fsPrefix: string;
}

function AdminEditor({
  identityId,
  status,
}: {
  readonly identityId: string;
  readonly status: AdminScopeStatus;
}) {
  const save = useSetIdentityScope(identityId);
  const saveFolder = useSetMountMappings();
  const hasMounts = status.unmappedMounts.length > 0;
  const { data: folderMappings } = useMountMappings(hasMounts);
  const { data: suggestions } = useIdentityScopeSuggestions(identityId, hasMounts);
  const [draft, setDraft] = useState<MountDraft | null>(null);
  const [applyToAll, setApplyToAll] = useState(true);
  const [saveError, setSaveError] = useState<ScopeSaveError | null>(null);
  const [attempted, setAttempted] = useState(false);
  const pending = save.isPending || saveFolder.isPending;

  function run(body: Parameters<typeof save.mutate>[0], onDone?: () => void) {
    setSaveError(null);
    save.mutate(body, {
      onSuccess: () => {
        onDone?.();
      },
      onError: (cause) => setSaveError(describeScopeError(cause)),
    });
  }

  function startMapping(mount: UnmappedMount) {
    setAttempted(false);
    setSaveError(null);
    setApplyToAll(true);
    setDraft({
      virtualPrefix: mount.virtualPath,
      rootName: status.configuredRoots[0] ?? "",
      fsPrefix: "",
    });
  }

  function submitDraft() {
    if (draft === null) return;
    setAttempted(true);
    if (fsPrefixProblem(draft.fsPrefix) !== null || draft.rootName.length === 0) return;
    setSaveError(null);
    if (applyToAll) {
      saveFolder.mutate(mountMappingsWith(folderMappings?.mappings ?? [], draft), {
        onSuccess: () => setDraft(null),
        onError: (cause) => setSaveError(describeScopeError(cause)),
      });
      return;
    }
    run(requestWithMapping(status, draft), () => setDraft(null));
  }

  const draftSuggestions =
    draft === null
      ? []
      : (suggestions?.mounts.find((mount) => mount.virtualPath === draft.virtualPrefix)
          ?.suggestions ?? []);

  const localProblem = draft === null ? null : fsPrefixProblem(draft.fsPrefix);
  const fsPrefixError =
    attempted && localProblem !== null
      ? localProblem
      : saveError?.field === "fsPrefix"
        ? saveError.message
        : null;
  const rootError =
    saveError?.field === "rootName"
      ? saveError.message
      : status.configuredRoots.length === 0
        ? "No indexed roots are configured on this server."
        : null;
  const formError =
    saveError !== null && saveError.field !== "fsPrefix" && saveError.field !== "rootName"
      ? saveError.message
      : null;

  return (
    <div className="flex flex-col gap-2">
      {status.unmappedMounts.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {status.unmappedMounts.map((mount) => (
            <li key={mount.virtualPath} className="flex flex-wrap items-center gap-2">
              <span>
                <code className="rounded bg-muted px-1">{mount.virtualPath}</code> is not indexed.
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={pending || draft?.virtualPrefix === mount.virtualPath}
                onClick={() => startMapping(mount)}
                aria-label={`Map ${mount.virtualPath}`}
              >
                Map it
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={pending}
                onClick={() => run(requestWithUnindexed(status, mount.virtualPath))}
                aria-label={`Mark ${mount.virtualPath} not indexed`}
              >
                Not indexed
              </Button>
            </li>
          ))}
        </ul>
      ) : null}

      {draft !== null ? (
        <form
          className="flex flex-col gap-3 rounded-md border border-border p-3"
          aria-label={`Map ${draft.virtualPrefix}`}
          onSubmit={(event) => {
            event.preventDefault();
            submitDraft();
          }}
        >
          <p className="text-sm font-medium">
            Map <code className="rounded bg-muted px-1">{draft.virtualPrefix}</code>
          </p>
          {draftSuggestions.length > 0 ? (
            <div className="flex flex-col gap-1">
              <p className="text-muted-foreground">
                Indexed locations whose files match this folder's contents:
              </p>
              <div className="flex flex-wrap gap-2">
                {draftSuggestions.map((suggestion) => (
                  <Button
                    key={`${suggestion.rootName}:${suggestion.fsPrefix}`}
                    type="button"
                    variant="outline"
                    size="sm"
                    className="font-mono"
                    disabled={pending}
                    onClick={() =>
                      setDraft({
                        ...draft,
                        rootName: suggestion.rootName,
                        fsPrefix: suggestion.fsPrefix,
                      })
                    }
                    aria-label={`Use ${suggestion.rootName}:${suggestion.fsPrefix}`}
                  >
                    {suggestion.rootName}:{suggestion.fsPrefix}
                  </Button>
                ))}
              </div>
            </div>
          ) : null}
          <Field data-invalid={rootError !== null}>
            <FieldLabel htmlFor={`scope-root-${identityId}`}>Root</FieldLabel>
            <Select
              value={draft.rootName}
              onValueChange={(rootName) => setDraft({ ...draft, rootName: rootName ?? "" })}
              disabled={pending || status.configuredRoots.length === 0}
            >
              <SelectTrigger id={`scope-root-${identityId}`} className="w-full">
                <SelectValue placeholder="Choose a root" />
              </SelectTrigger>
              <SelectContent>
                {status.configuredRoots.map((root) => (
                  <SelectItem key={root} value={root}>
                    {root}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldDescription>The configured index root that holds this folder.</FieldDescription>
            {rootError !== null ? <FieldError>{rootError}</FieldError> : null}
          </Field>
          <Field data-invalid={fsPrefixError !== null}>
            <FieldLabel htmlFor={`scope-fs-${identityId}`}>Physical prefix</FieldLabel>
            <Input
              id={`scope-fs-${identityId}`}
              value={draft.fsPrefix}
              onChange={(event) => setDraft({ ...draft, fsPrefix: event.target.value })}
              placeholder="/_folders/shared"
              className="font-mono"
              disabled={pending}
              aria-invalid={fsPrefixError !== null}
            />
            <FieldDescription>
              The folder's path inside that root, matching its SFTPGo mapped path.
            </FieldDescription>
            {fsPrefixError !== null ? <FieldError>{fsPrefixError}</FieldError> : null}
          </Field>
          <Field orientation="horizontal">
            <Checkbox
              id={`scope-all-${identityId}`}
              checked={applyToAll}
              onCheckedChange={(checked) => setApplyToAll(checked === true)}
              disabled={pending}
            />
            <FieldLabel htmlFor={`scope-all-${identityId}`} className="font-normal">
              Apply to every login that mounts this folder
            </FieldLabel>
          </Field>
          <FieldDescription>
            {applyToAll
              ? "Saved once as a shared folder mapping; a login adopts it only while SFTPGo shows this folder in its files."
              : "Saved for this login only."}
          </FieldDescription>
          {formError !== null ? <p className="text-destructive">{formError}</p> : null}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => setDraft(null)}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={pending}>
              {pending ? "Saving…" : "Save mapping"}
            </Button>
          </div>
        </form>
      ) : null}

      {draft === null && formError !== null ? (
        <p className="text-destructive">{formError}</p>
      ) : null}

      {status.overrides.length > 0 ||
      status.unindexedPrefixes.length > 0 ||
      status.adoptedMappings.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {status.adoptedMappings.map((scope) => (
            <li
              key={`adopted:${scope.virtualPrefix}`}
              className="flex flex-wrap items-center gap-2"
            >
              <code className="rounded bg-muted px-1">{scope.virtualPrefix}</code>
              <span className="text-muted-foreground">
                {scope.rootName}:{scope.fsPrefix}
              </span>
              <span className="text-muted-foreground">
                Shared folder mapping, managed under System › Connection.
              </span>
            </li>
          ))}
          {status.overrides.map((scope) => (
            <li key={scope.virtualPrefix} className="flex flex-wrap items-center gap-2">
              <code className="rounded bg-muted px-1">{scope.virtualPrefix}</code>
              <span className="text-muted-foreground">
                {scope.rootName}:{scope.fsPrefix}
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={pending}
                onClick={() => run(requestWithoutPrefix(status, scope.virtualPrefix))}
                aria-label={`Remove mapping ${scope.virtualPrefix}`}
              >
                Remove
              </Button>
            </li>
          ))}
          {status.unindexedPrefixes.map((prefix) => (
            <li key={prefix} className="flex flex-wrap items-center gap-2">
              <code className="rounded bg-muted px-1">{prefix}</code>
              <span className="text-muted-foreground">Not indexed</span>
              <Button
                variant="ghost"
                size="sm"
                disabled={pending}
                onClick={() => run(requestWithoutPrefix(status, prefix))}
                aria-label={`Remove not indexed ${prefix}`}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      ) : null}

      <p className="text-muted-foreground">{status.warning}</p>
    </div>
  );
}
