"use client";

import type {
  FsEntry,
  StorageDuplicates,
  StorageKind,
  StorageUsageResponse,
} from "@fdrive/contracts";
import { baseName, extensionOf, mimeFromExtension, parentPath } from "@fdrive/core";
import { useQueryClient } from "@tanstack/react-query";
import {
  FileIcon as FileGenericIcon,
  FileTextIcon,
  FilmIcon,
  FolderOpenIcon,
  ImageIcon,
  type LucideIcon,
  MusicIcon,
  Trash2Icon,
} from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { useState } from "react";
import { DeleteDialog } from "@/components/files/delete-dialog";
import { FileIcon } from "@/components/files/file-icon";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useMe } from "@/lib/api/auth-queries";
import { describeApiError } from "@/lib/api/errors";
import { queryKeys } from "@/lib/api/keys";
import { useDelete } from "@/lib/files/queries";
import { revealHref } from "@/lib/search/reveal";
import { useStorageUsage } from "@/lib/storage/queries";
import { trashAvailabilityFor } from "@/lib/trash/format";
import { useFormatters } from "@/lib/use-format-preferences";

const KINDS: Readonly<Record<StorageKind, { label: string; Icon: LucideIcon }>> = {
  images: { label: "Images", Icon: ImageIcon },
  videos: { label: "Videos", Icon: FilmIcon },
  documents: { label: "Documents", Icon: FileTextIcon },
  audio: { label: "Audio", Icon: MusicIcon },
  other: { label: "Other", Icon: FileGenericIcon },
};

/** Used space against the limit, when there is one, and how it splits by kind. */
function UsageCard({ usage }: { usage: StorageUsageResponse }) {
  const { formatBytes } = useFormatters();
  const { used, limit } = usage;
  const summary =
    limit === null
      ? `${formatBytes(used)} used`
      : `${formatBytes(used)} of ${formatBytes(limit)} used`;
  return (
    <Card className="w-full max-w-2xl">
      <CardHeader>
        <CardTitle>Storage</CardTitle>
        <CardDescription>
          {usage.indexed
            ? summary
            : "Storage use comes from the search index, which does not cover your files yet."}
        </CardDescription>
      </CardHeader>
      {usage.indexed ? (
        <CardContent className="flex flex-col gap-4">
          {limit === null ? null : (
            <Progress value={Math.min(100, (used / limit) * 100)} aria-label="Storage used" />
          )}
          <ul className="flex flex-col gap-2.5">
            {usage.kinds.map(({ kind, bytes }) => {
              const { label, Icon } = KINDS[kind];
              return (
                <li key={kind} className="flex items-center gap-3 text-sm">
                  <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="w-24 shrink-0">{label}</span>
                  <Progress
                    className="flex-1"
                    value={used === 0 ? 0 : (bytes / used) * 100}
                    aria-label={`${label} share`}
                  />
                  <span className="w-20 shrink-0 text-right tabular-nums text-muted-foreground">
                    {formatBytes(bytes)}
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="text-xs text-muted-foreground">
            Counted from the search index, Trash included, so recent changes can take a moment to
            show and the limit is approximate.
          </p>
        </CardContent>
      ) : null}
    </Card>
  );
}

interface FileRowProps {
  readonly path: string;
  readonly size: number;
  /** For a duplicate: what removing it is called, and what does it. */
  readonly remove?: { readonly label: string; readonly onRemove: (path: string) => void };
}

/** One file the page lists: where it is, its size, a way to it and, for a duplicate, out. */
function FileRow({ path, size, remove }: FileRowProps) {
  const { formatBytes } = useFormatters();
  const name = baseName(path);
  const ext = extensionOf(name);
  return (
    <li className="flex min-w-0 items-center gap-3 py-2 text-sm">
      <FileIcon kind="file" ext={ext} mime={mimeFromExtension(ext)} />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium">{name}</span>
        <span className="truncate text-xs text-muted-foreground">{parentPath(path)}</span>
      </div>
      <span className="shrink-0 tabular-nums text-muted-foreground">{formatBytes(size)}</span>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              nativeButton={false}
              variant="ghost"
              size="icon-sm"
              aria-label={`Reveal ${name} in folder`}
              render={<Link href={revealHref(path) as Route} />}
            />
          }
        >
          <FolderOpenIcon />
        </TooltipTrigger>
        <TooltipContent>Reveal in folder</TooltipContent>
      </Tooltip>
      {remove === undefined ? null : (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={remove.label === "Delete" ? `Delete ${name}` : `Move ${name} to Trash`}
                onClick={() => remove.onRemove(path)}
              />
            }
          >
            <Trash2Icon />
          </TooltipTrigger>
          <TooltipContent>{remove.label}</TooltipContent>
        </Tooltip>
      )}
    </li>
  );
}

/** The file at `path`, as the delete confirmation names it. */
function entryAt(path: string): FsEntry {
  const name = baseName(path);
  const ext = extensionOf(name);
  return {
    name,
    path,
    kind: "file",
    size: 0,
    modifiedAt: new Date(0).toISOString(),
    ext,
    mime: mimeFromExtension(ext),
  };
}

/**
 * Groups of identical files, each copy with a way to it and to Trash. A copy
 * removed here leaves at once, before the index catches up.
 */
function DuplicatesCard({ groups: indexed }: { groups: readonly StorageDuplicates[] }) {
  const { formatBytes } = useFormatters();
  const { data: me } = useMe();
  const queryClient = useQueryClient();
  const remove = useDelete();
  const [removing, setRemoving] = useState<string | null>(null);
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const trash = trashAvailabilityFor({ trash: me?.trash === true });
  const label = trash === null ? "Delete" : "Move to Trash";
  const groups = indexed
    .map((group) => ({ ...group, paths: group.paths.filter((path) => !removed.has(path)) }))
    .filter((group) => group.paths.length > 1);

  function confirm() {
    if (removing === null) return;
    const path = removing;
    remove.mutate([{ path, kind: "file" }], {
      onSuccess: () => {
        setRemoving(null);
        setRemoved((before) => new Set([...before, path]));
        void queryClient.invalidateQueries({ queryKey: queryKeys.storage.usage() });
      },
    });
  }

  return (
    <Card className="w-full max-w-2xl">
      <CardHeader>
        <CardTitle>Duplicates</CardTitle>
        <CardDescription>
          {groups.length === 0
            ? "No identical files in your folder."
            : "Identical files in your folder, most wasted space first."}
        </CardDescription>
      </CardHeader>
      {groups.length === 0 ? null : (
        <CardContent className="flex flex-col gap-5">
          {groups.map((group) => (
            <section key={group.paths.join("\n")} className="flex flex-col gap-1">
              <h3 className="text-xs text-muted-foreground">
                {group.paths.length} copies, {formatBytes(group.size * (group.paths.length - 1))}{" "}
                wasted
              </h3>
              <ul className="flex flex-col divide-y">
                {group.paths.map((path) => (
                  <FileRow
                    key={path}
                    path={path}
                    size={group.size}
                    remove={{ label, onRemove: setRemoving }}
                  />
                ))}
              </ul>
            </section>
          ))}
        </CardContent>
      )}
      <DeleteDialog
        entries={removing === null ? [] : [entryAt(removing)]}
        trash={trash}
        pending={remove.isPending}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        onConfirm={confirm}
      />
    </Card>
  );
}

/**
 * `/storage`: how much the signed-in login's own folder holds, by kind and
 * against its storage limit, its largest files and its duplicates, all from
 * the index.
 */
export function StoragePage() {
  const { data, isLoading, isError, error } = useStorageUsage();
  return (
    <>
      <PageHeader breadcrumbs={<span className="text-sm font-medium">Storage</span>} />
      <div className="flex flex-1 flex-col items-center gap-4 p-6">
        {isLoading ? <Skeleton className="h-64 w-full max-w-2xl" /> : null}
        {isError ? (
          <p role="alert" className="text-sm text-destructive">
            {describeApiError(error)}
          </p>
        ) : null}
        {data === undefined ? null : <UsageCard usage={data} />}
        {data?.indexed === true && data.largest.length > 0 ? (
          <Card className="w-full max-w-2xl">
            <CardHeader>
              <CardTitle>Largest files</CardTitle>
              <CardDescription>Your biggest files outside Trash, largest first.</CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="flex flex-col divide-y">
                {data.largest.map((file) => (
                  <FileRow key={file.path} path={file.path} size={file.size} />
                ))}
              </ul>
            </CardContent>
          </Card>
        ) : null}
        {data?.indexed === true ? <DuplicatesCard groups={data.duplicates} /> : null}
      </div>
    </>
  );
}
