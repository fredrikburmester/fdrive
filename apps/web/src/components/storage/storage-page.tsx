"use client";

import type {
  FsEntry,
  StorageDuplicates,
  StorageKind,
  StorageUsageResponse,
} from "@fdrive/contracts";
import { baseName, extensionOf, mimeFromExtension, parentPath } from "@fdrive/core";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "cn";
import {
  FileIcon as FileGenericIcon,
  FileTextIcon,
  FilmIcon,
  FolderOpenIcon,
  HardDriveIcon,
  ImageIcon,
  type LucideIcon,
  MusicIcon,
  Trash2Icon,
} from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { Fragment, useState } from "react";
import { DeleteDialog } from "@/components/files/delete-dialog";
import { FileIcon } from "@/components/files/file-icon";
import { PageHeader } from "@/components/shell/page-header";
import {
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableGroupRow,
  DataTableHead,
  DataTableHeader,
  DataTableRow,
  PageBar,
  PageBody,
  PageEmpty,
  PageSection,
} from "@/components/shell/page-layout";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { describeApiError } from "@/lib/api/errors";
import { queryKeys } from "@/lib/api/keys";
import { useDelete } from "@/lib/files/queries";
import { revealHref } from "@/lib/search/reveal";
import { useStorageUsage } from "@/lib/storage/queries";
import { useFormatters } from "@/lib/use-format-preferences";

const KINDS: Readonly<Record<StorageKind, { label: string; Icon: LucideIcon }>> = {
  images: { label: "Images", Icon: ImageIcon },
  videos: { label: "Videos", Icon: FilmIcon },
  documents: { label: "Documents", Icon: FileTextIcon },
  audio: { label: "Audio", Icon: MusicIcon },
  other: { label: "Other", Icon: FileGenericIcon },
};

/**
 * The folder column where the section is narrow (a phone, or a small window beside the
 * sidebar): kept in the table at no width instead of removed, so a group row's span covers the
 * same four columns at every size.
 */
const FOLDER_COLUMN = "@max-xl:invisible @max-xl:w-0 @max-xl:px-0";

/** A usage line: as tall as a file row, with a hairline under it. */
const USAGE_ROW = "flex min-h-9 items-center gap-3 border-border/60 border-b px-3 text-sm";

/** How the used space splits by kind, and how much of the limit it takes when there is one. */
function UsageSection({ usage }: { usage: StorageUsageResponse }) {
  const { formatBytes } = useFormatters();
  const { used, limit } = usage;
  return (
    <PageSection title="Usage" description="What your folder holds, by kind of file.">
      <ul>
        {limit === null ? null : (
          <li className={USAGE_ROW}>
            <HardDriveIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="w-24 shrink-0">Limit</span>
            <Progress
              className="flex-1"
              value={Math.min(100, (used / limit) * 100)}
              aria-label="Storage used"
            />
            <span className="w-20 shrink-0 text-right text-muted-foreground tabular-nums">
              {formatBytes(limit)}
            </span>
          </li>
        )}
        {usage.kinds.map(({ kind, bytes }) => {
          const { label, Icon } = KINDS[kind];
          return (
            <li key={kind} className={USAGE_ROW}>
              <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="w-24 shrink-0">{label}</span>
              <Progress
                className="flex-1"
                value={used === 0 ? 0 : (bytes / used) * 100}
                aria-label={`${label} share`}
              />
              <span className="w-20 shrink-0 text-right text-muted-foreground tabular-nums">
                {formatBytes(bytes)}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="px-3 py-2.5 text-muted-foreground text-xs">
        Counted from the search index, Trash included, so recent changes can take a moment to show
        and the limit is approximate.
      </p>
    </PageSection>
  );
}

interface FileRowProps {
  readonly path: string;
  readonly size: number;
  /** For a duplicate: moves it to Trash, after the usual confirmation. */
  readonly onRemove?: (path: string) => void;
}

/**
 * One file the page lists: its name, the folder it is in, its size, a way to it and, for a
 * duplicate, out. A narrow page has no room for the folder column, so there the folder sits
 * under the name.
 */
function FileRow({ path, size, onRemove }: FileRowProps) {
  const { formatBytes } = useFormatters();
  const name = baseName(path);
  const ext = extensionOf(name);
  const folder = parentPath(path);
  return (
    <DataTableRow data-slot="storage-file">
      <DataTableCell className="whitespace-normal">
        <div className="flex min-w-0 items-center gap-2">
          <FileIcon kind="file" ext={ext} mime={mimeFromExtension(ext)} />
          <div className="flex min-w-0 flex-col">
            <span className="truncate">{name}</span>
            <span className="truncate text-muted-foreground text-xs @xl:hidden">{folder}</span>
          </div>
        </div>
      </DataTableCell>
      <DataTableCell className={cn("truncate text-muted-foreground", FOLDER_COLUMN)}>
        {folder}
      </DataTableCell>
      <DataTableCell className="text-right text-muted-foreground text-xs tabular-nums">
        {formatBytes(size)}
      </DataTableCell>
      <DataTableCell>
        <div className="flex items-center justify-end gap-0.5">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  nativeButton={false}
                  variant="ghost"
                  size="icon-sm"
                  className="max-md:size-11"
                  aria-label={`Reveal ${name} in folder`}
                  render={<Link href={revealHref(path) as Route} />}
                />
              }
            >
              <FolderOpenIcon />
            </TooltipTrigger>
            <TooltipContent>Reveal in folder</TooltipContent>
          </Tooltip>
          {onRemove === undefined ? null : (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="max-md:size-11"
                    aria-label={`Move ${name} to Trash`}
                    onClick={() => onRemove(path)}
                  />
                }
              >
                <Trash2Icon />
              </TooltipTrigger>
              <TooltipContent>Move to Trash</TooltipContent>
            </Tooltip>
          )}
        </div>
      </DataTableCell>
    </DataTableRow>
  );
}

/**
 * The columns `FileRow` fills, lined up in both of the page's tables. On a phone the last one
 * is as wide as the row's buttons: one to reveal a file, and a second where a copy can also go
 * to Trash.
 */
function FileTableHeader({ removable = false }: { removable?: boolean }) {
  return (
    <DataTableHeader>
      <DataTableRow>
        <DataTableHead>Name</DataTableHead>
        <DataTableHead className={cn("w-2/5", FOLDER_COLUMN)}>Folder</DataTableHead>
        <DataTableHead className="w-24 text-right">Size</DataTableHead>
        <DataTableHead className={cn("w-20", removable ? "max-md:w-28" : "max-md:w-16")}>
          <span className="sr-only">Actions</span>
        </DataTableHead>
      </DataTableRow>
    </DataTableHeader>
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
function DuplicatesSection({ groups: indexed }: { groups: readonly StorageDuplicates[] }) {
  const { formatBytes } = useFormatters();
  const queryClient = useQueryClient();
  const remove = useDelete();
  const [removing, setRemoving] = useState<string | null>(null);
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
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
    <PageSection
      data-section="duplicates"
      title="Duplicates"
      description={
        groups.length === 0
          ? "No identical files in your folder."
          : "Identical files in your folder, most wasted space first."
      }
    >
      {groups.length === 0 ? null : (
        <DataTable className="table-fixed">
          <FileTableHeader removable />
          <DataTableBody>
            {groups.map((group) => (
              <Fragment key={group.paths.join("\n")}>
                <DataTableGroupRow colSpan={4}>
                  {group.paths.length} copies, {formatBytes(group.size * (group.paths.length - 1))}{" "}
                  wasted
                </DataTableGroupRow>
                {group.paths.map((path) => (
                  <FileRow key={path} path={path} size={group.size} onRemove={setRemoving} />
                ))}
              </Fragment>
            ))}
          </DataTableBody>
        </DataTable>
      )}
      <DeleteDialog
        entries={removing === null ? [] : [entryAt(removing)]}
        pending={remove.isPending}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        onConfirm={confirm}
      />
    </PageSection>
  );
}

/**
 * `/storage`: how much the signed-in login's own folder holds, by kind and
 * against its storage limit, its largest files and its duplicates, all from
 * the index. Laid out like the file list: a bar with the total, then flat
 * sections of rows across the whole width.
 */
export function StoragePage() {
  const { formatBytes } = useFormatters();
  const { data, isLoading, isError, error } = useStorageUsage();
  return (
    <>
      <PageHeader breadcrumbs={<h1 className="truncate font-medium text-sm">Storage</h1>} />
      <PageBody>
        <PageBar>
          {data?.indexed === true ? (
            <span className="text-foreground">
              {data.limit === null
                ? `${formatBytes(data.used)} used`
                : `${formatBytes(data.used)} of ${formatBytes(data.limit)} used`}
            </span>
          ) : null}
          <p>What your own folder holds.</p>
        </PageBar>
        {isLoading ? (
          <div className="flex flex-col gap-2 px-3 py-2.5">
            <Skeleton className="h-5 w-full" />
            <Skeleton className="h-5 w-full" />
            <Skeleton className="h-5 w-2/3" />
          </div>
        ) : null}
        {isError ? (
          <p role="alert" className="px-3 py-2.5 text-destructive text-sm">
            {describeApiError(error)}
          </p>
        ) : null}
        {data === undefined ? null : data.indexed ? (
          <>
            <UsageSection usage={data} />
            {data.largest.length > 0 ? (
              <PageSection
                title="Largest files"
                description="Your biggest files outside Trash, largest first."
              >
                <DataTable className="table-fixed">
                  <FileTableHeader />
                  <DataTableBody>
                    {data.largest.map((file) => (
                      <FileRow key={file.path} path={file.path} size={file.size} />
                    ))}
                  </DataTableBody>
                </DataTable>
              </PageSection>
            ) : null}
            <DuplicatesSection groups={data.duplicates} />
          </>
        ) : (
          <PageEmpty
            icon={HardDriveIcon}
            title="No storage numbers yet"
            description="Storage use comes from the search index, which does not cover your files yet."
          />
        )}
      </PageBody>
    </>
  );
}
